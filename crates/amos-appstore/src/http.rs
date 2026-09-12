//! A real networked [`StoreProvider`]: fetches a JSON **catalog** over HTTP and
//! downloads package bytes by URL.
//!
//! Compiled only behind the `live` feature (the default workspace build stays
//! offline-green). It implements the *same* [`StoreProvider`] seam as the
//! [`MockStoreProvider`](crate::provider::MockStoreProvider), so an engine /
//! CLI / Tauri bridge built against the mock drops in the HTTP backend with no
//! caller changes — exactly the provider-swap design of `amos-mail`'s live
//! IMAP/SMTP.
//!
//! # Catalog shape
//!
//! The catalog URL must return JSON in the on-disk publish shape
//! [`MockCatalog`](crate::provider::MockCatalog) — a `{ "name", "apps": [ … ] }`
//! document of [`AppManifest`]s (see `docs/appstore.md` §4.5). Entries that fail
//! [`AppManifest::validate`] are skipped so a malformed remote row can't poison
//! the store.
//!
//! # Blocking inside async
//!
//! `ureq` is a small blocking HTTP client (the same one `amos-ai` uses). Each
//! fetch runs inside [`tokio::task::spawn_blocking`] so the async trait methods
//! never block the executor.

use std::io::Read;
use std::time::Duration;

use async_trait::async_trait;

use crate::error::{Result, StoreError};
use crate::model::AppManifest;
use crate::provider::MockCatalog;
use crate::StoreProvider;

/// Default per-request timeout for catalog + package downloads.
const DEFAULT_TIMEOUT_SECS: u64 = 30;

/// Hard ceiling on any single downloaded body (index, catalog, or package).
///
/// This is a **pre-verification** denial-of-service backstop, not an app-size
/// policy: the engine can only sha256-check bytes it has finished reading, so a
/// server that streams forever would otherwise exhaust memory *before* any
/// integrity check could run. The official F-Droid index is ~61 MB and real
/// packages are at most a few hundred MB, so 2 GiB sits far above any
/// legitimate payload while still being *finite*.
pub(crate) const MAX_BODY_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// A [`Read`] adapter that **fails** once more than `max` bytes have been
/// produced, instead of silently truncating. Truncation would be worse than an
/// error: a hostile oversized body would surface as a confusing mid-document
/// parse failure rather than an explicit limit violation.
struct CappedReader<R> {
    inner: R,
    remaining: u64,
    max: u64,
    url: String,
}

impl<R: Read> CappedReader<R> {
    fn new(inner: R, max: u64, url: impl Into<String>) -> Self {
        Self {
            inner,
            remaining: max,
            max,
            url: url.into(),
        }
    }
}

impl<R: Read> Read for CappedReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            // A body that is exactly `max` bytes long is legal, so probe one
            // more byte: EOF means it fit, anything else is over the cap.
            let mut probe = [0u8; 1];
            return match self.inner.read(&mut probe) {
                Ok(0) => Ok(0),
                Ok(_) => Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("body from {} exceeds the {} byte limit", self.url, self.max),
                )),
                Err(e) => Err(e),
            };
        }
        let want = buf.len().min(self.remaining as usize);
        let n = self.inner.read(&mut buf[..want])?;
        self.remaining -= n as u64;
        Ok(n)
    }
}

/// Blocking GET of `url` returning the raw body bytes, bounded by
/// [`MAX_BODY_BYTES`]. Runs on a blocking thread via [`fetch_async`]; never call
/// from an async context directly.
pub(crate) fn blocking_get_bytes(url: &str, timeout_secs: u64) -> Result<Vec<u8>> {
    blocking_get_bytes_capped(url, timeout_secs, MAX_BODY_BYTES)
}

/// [`blocking_get_bytes`] with an explicit byte ceiling (tests use a tiny one).
pub(crate) fn blocking_get_bytes_capped(
    url: &str,
    timeout_secs: u64,
    max_bytes: u64,
) -> Result<Vec<u8>> {
    let resp = live_agent(url, timeout_secs)
        .get(url)
        .call()
        .map_err(|e| StoreError::Provider(format!("GET {url}: {e}")))?;
    let mut reader = CappedReader::new(resp.into_reader(), max_bytes, url);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|e| StoreError::Provider(format!("read {url}: {e}")))?;
    Ok(bytes)
}

/// A [`StoreProvider`] backed by an HTTP catalog URL + per-package URLs.
///
/// ```text
/// [ GET catalog_url ]  ->  JSON MockCatalog  ->  Vec<AppManifest>
/// [ GET app.package.url ] -> package bytes (verified by the AppStore engine)
/// ```
#[derive(Clone, Debug)]
pub struct HttpStoreProvider {
    catalog_url: String,
    timeout_secs: u64,
}

impl HttpStoreProvider {
    /// Point the provider at a catalog URL (e.g. `https://…/catalog.json`).
    pub fn new(catalog_url: impl Into<String>) -> Self {
        Self {
            catalog_url: catalog_url.into(),
            timeout_secs: DEFAULT_TIMEOUT_SECS,
        }
    }

    /// Override the per-request timeout (default 30 s).
    pub fn with_timeout(mut self, secs: u64) -> Self {
        self.timeout_secs = secs.max(1);
        self
    }

    /// The configured catalog URL (for diagnostics).
    pub fn catalog_url(&self) -> &str {
        &self.catalog_url
    }
}

/// Whether `url`'s **host** is a loopback address (`127.0.0.0/8`, `localhost`,
/// `::1`).
///
/// The match is on the parsed host, never on a substring of the whole URL:
/// `https://proxy.example/127.0.0.1/pkg.tgz` and
/// `https://localhost.evil.test/repo` merely *contain* the text, and treating
/// them as loopback would silently bypass a required egress proxy (an explicit
/// proxy setting must not be defeatable by picking a hostname).
fn is_loopback_url(url: &str) -> bool {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    // The authority runs to the path / query / fragment.
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    // Drop any `user:pass@` prefix.
    let host_port = authority.rsplit('@').next().unwrap_or_default();
    // An IPv6 literal is bracketed (`[::1]:8080`); its colons are not a port.
    let host = match host_port.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or_default(),
        None => host_port.split(':').next().unwrap_or_default(),
    };
    let host = host.to_ascii_lowercase();
    host == "localhost"
        || host == "::1"
        || host
            .parse::<std::net::Ipv4Addr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// The blocking HTTP client for live fetches, with an explicit proxy policy:
///
/// * loopback URLs (`127.0.0.1` / `localhost` / `[::1]` — the tests and local
///   dev servers) never go through a proxy;
/// * otherwise `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` are honored (first
///   hit wins). Explicit beats ureq's implicit env handling on purpose: ureq
///   parses a `socks5://` `ALL_PROXY` even without its `socks-proxy` feature
///   and then fails every connection with "SOCKS feature disabled", so a
///   sandbox with a socks-only `ALL_PROXY` used to break live fetches even
///   when an HTTP proxy was also exported;
/// * no proxy env at all → direct connection.
fn live_agent(url: &str, timeout_secs: u64) -> ureq::Agent {
    let builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(timeout_secs.max(1)));
    if is_loopback_url(url) {
        return builder.build();
    }
    for var in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(value) = std::env::var(var) {
            if let Ok(proxy) = ureq::Proxy::new(value) {
                return builder.proxy(proxy).build();
            }
        }
    }
    builder.build()
}

/// Fetch `url` off the async context via [`spawn_blocking`](tokio::task).
/// Crate-shared: the F-Droid repo provider ([`crate::fdroid`]) reuses this for
/// its index + APK downloads so both live backends time out and error alike.
pub(crate) async fn fetch_async(url: String, timeout_secs: u64) -> Result<Vec<u8>> {
    let display = url.clone();
    let handle = tokio::task::spawn_blocking(move || blocking_get_bytes(&url, timeout_secs));
    handle
        .await
        .map_err(|e| StoreError::Provider(format!("fetch {display} task failed: {e}")))?
}

/// Blocking GET whose body is parsed as JSON **streaming off the response
/// reader**. Large documents (the official F-Droid `index-v1.json` is tens of
/// MB) never need the whole body buffered before parsing, halving peak memory
/// versus fetch-then-parse. The stream is bounded by [`MAX_BODY_BYTES`] so an
/// endless body fails closed instead of exhausting memory.
pub(crate) fn blocking_get_json<T: serde::de::DeserializeOwned>(
    url: &str,
    timeout_secs: u64,
) -> Result<T> {
    blocking_get_json_capped(url, timeout_secs, MAX_BODY_BYTES)
}

/// [`blocking_get_json`] with an explicit byte ceiling (tests use a tiny one).
pub(crate) fn blocking_get_json_capped<T: serde::de::DeserializeOwned>(
    url: &str,
    timeout_secs: u64,
    max_bytes: u64,
) -> Result<T> {
    let resp = live_agent(url, timeout_secs)
        .get(url)
        .call()
        .map_err(|e| StoreError::Provider(format!("GET {url}: {e}")))?;
    serde_json::from_reader(CappedReader::new(resp.into_reader(), max_bytes, url))
        .map_err(|e| StoreError::Provider(format!("parse JSON from {url}: {e}")))
}

/// Async wrapper for [`blocking_get_json`], same contract as [`fetch_async`].
pub(crate) async fn fetch_json_async<T: serde::de::DeserializeOwned + Send + 'static>(
    url: String,
    timeout_secs: u64,
) -> Result<T> {
    let display = url.clone();
    let handle = tokio::task::spawn_blocking(move || blocking_get_json(&url, timeout_secs));
    handle
        .await
        .map_err(|e| StoreError::Provider(format!("fetch {display} task failed: {e}")))?
}

/// Parse catalog JSON (the [`MockCatalog`] publish shape) into its app list,
/// dropping any entry that fails [`AppManifest::validate`].
pub fn parse_catalog(json: &[u8]) -> Result<Vec<AppManifest>> {
    let doc: MockCatalog = serde_json::from_slice(json)
        .map_err(|e| StoreError::Provider(format!("catalog parse: {e}")))?;
    Ok(doc
        .apps
        .into_iter()
        .filter(|m| m.validate().is_ok())
        .collect())
}

#[async_trait]
impl StoreProvider for HttpStoreProvider {
    fn name(&self) -> &'static str {
        "http"
    }

    async fn catalog(&self) -> Result<Vec<AppManifest>> {
        let bytes = fetch_async(self.catalog_url.clone(), self.timeout_secs).await?;
        parse_catalog(&bytes)
    }

    async fn fetch_package(&self, manifest: &AppManifest) -> Result<Vec<u8>> {
        fetch_async(manifest.package.url.clone(), self.timeout_secs).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::AppStore;
    use crate::model::{AppCategory, Checksum, PackageFormat, PackageRef, Version};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn manifest(id: &str, url: &str, checksum: Option<Checksum>) -> AppManifest {
        AppManifest {
            id: id.into(),
            name: "Live App".into(),
            summary: "fetched over HTTP".into(),
            description: String::new(),
            author: "Http Dev".into(),
            version: Version::new(3, 0, 0),
            category: AppCategory::Tools,
            homepage: String::new(),
            icon_url: String::new(),
            package: PackageRef {
                format: PackageFormat::TarGz,
                url: url.into(),
                sha256: checksum,
                size_bytes: None,
            },
            publisher: None,
        }
    }

    // --- Proxy policy: loopback is decided on the host, not a substring ------

    #[test]
    fn loopback_is_decided_on_the_host_not_a_substring_of_the_url() {
        // Genuine loopback hosts keep direct-connect (the tests' own servers).
        for u in [
            "http://127.0.0.1:8080/pkg.tgz",
            "http://127.5.6.7:9/x",
            "https://localhost:3000/index-v1.json",
            "http://localhost/index-v1.json",
            "http://[::1]:8080/index-v1.json",
            "http://user:pass@127.0.0.1/x",
        ] {
            assert!(is_loopback_url(u), "{u} must be treated as loopback");
        }
        // These merely *contain* the text; calling them loopback would bypass a
        // proxy that is explicitly configured (an egress policy hole).
        for u in [
            "https://localhost.evil.test/repo",
            "https://127.0.0.1.evil.test/repo",
            "https://proxy.example/127.0.0.1/pkg.tgz",
            "https://example.test/index-v1.json?host=localhost",
        ] {
            assert!(!is_loopback_url(u), "{u} must NOT be treated as loopback");
        }
    }

    #[test]
    fn parse_catalog_skips_invalid_manifests() {
        let good = manifest("org.amos.good", "https://x/pkg.tgz", None);
        let bad = manifest("bad id with space", "https://x/bad.tgz", None);
        let doc = MockCatalog {
            name: "catalog".into(),
            apps: vec![good, bad],
        };
        let json = serde_json::to_vec(&doc).unwrap();
        let apps = parse_catalog(&json).unwrap();
        assert_eq!(apps.len(), 1, "invalid rows are filtered out");
        assert_eq!(apps[0].id, "org.amos.good");
    }

    /// Minimal HTTP/1.1 loopback server answering `/catalog.json` and `/pkg.tgz`
    /// with `Connection: close`, then returning after `needed` requests.
    async fn serve_loop(
        listener: tokio::net::TcpListener,
        needed: usize,
        cat_json: Vec<u8>,
        pkg: Vec<u8>,
    ) {
        for _ in 0..needed {
            let (mut stream, _) = listener.accept().await.unwrap();
            // Read the request head (up to the blank line).
            let mut buf = Vec::new();
            let mut tmp = [0u8; 256];
            loop {
                let n = stream.read(&mut tmp).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            // First line: METHOD SP PATH SP HTTP/1.1
            let first = buf.split(|b| *b == b'\n').next().unwrap_or_default();
            let path = first
                .split(|b| *b == b' ')
                .nth(1)
                .map(|p| String::from_utf8_lossy(p).into_owned())
                .unwrap_or_default();
            let (status, body, ctype) = match path.as_str() {
                "/catalog.json" => (200, cat_json.clone(), "application/json"),
                "/pkg.tgz" => (200, pkg.clone(), "application/octet-stream"),
                _ => (404, b"not found".to_vec(), "text/plain"),
            };
            let head = format!(
                "HTTP/1.1 {status} {}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                if status == 200 { "OK" } else { "Not Found" },
                body.len()
            );
            stream.write_all(head.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
            let _ = stream.flush().await;
        }
    }

    #[tokio::test]
    async fn http_provider_drives_engine_install_over_loopback() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");

        // Package bytes + the checksum the catalog advertises.
        let pkg: Vec<u8> = b"hello from the http catalog".to_vec();
        let hex = Checksum::sha256_hex(&pkg);
        let mf = manifest(
            "org.amos.live",
            &format!("{base}/pkg.tgz"),
            Some(Checksum::sha256(hex).unwrap()),
        );
        let doc = MockCatalog {
            name: "http-catalog".into(),
            apps: vec![mf],
        };
        let cat_json = serde_json::to_vec(&doc).unwrap();

        // Serve the three requests: explicit catalog + install's catalog + package.
        let server = tokio::spawn(async move {
            serve_loop(listener, 3, cat_json, pkg).await;
        });

        let provider = HttpStoreProvider::new(format!("{base}/catalog.json"));
        let store = AppStore::new(provider);

        // The engine sees the remote catalog…
        let cat = store.catalog().await.unwrap();
        assert_eq!(cat.len(), 1);
        assert_eq!(cat[0].id, "org.amos.live");

        // …and install downloads over HTTP + verifies the sha256 end to end.
        store.install("org.amos.live").await.unwrap();
        assert!(store.is_installed("org.amos.live").unwrap());

        server.await.unwrap();
    }

    #[tokio::test]
    async fn http_provider_refuses_tampered_bytes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");

        // Server serves bytes that do NOT match the advertised checksum.
        let served: Vec<u8> = b"evil bytes".to_vec();
        let hex = Checksum::sha256_hex(b"the real thing");
        let mf = manifest(
            "org.amos.evil",
            &format!("{base}/pkg.tgz"),
            Some(Checksum::sha256(hex).unwrap()),
        );
        let doc = MockCatalog {
            name: "http-catalog".into(),
            apps: vec![mf],
        };
        let cat_json = serde_json::to_vec(&doc).unwrap();
        let server = tokio::spawn(async move {
            serve_loop(listener, 2, cat_json, served).await;
        });

        let store = AppStore::new(HttpStoreProvider::new(format!("{base}/catalog.json")));
        let err = store.install("org.amos.evil").await.unwrap_err();
        assert!(
            matches!(err, crate::error::StoreError::ChecksumMismatch { .. }),
            "tampered download must be refused over HTTP too: {err}"
        );
        assert!(!store.is_installed("org.amos.evil").unwrap());

        server.await.unwrap();
    }

    // --- Download byte cap (pre-verification DoS backstop) ------------------

    #[test]
    fn capped_reader_allows_a_body_exactly_at_the_limit() {
        let src = vec![b'x'; 16];
        let mut r = CappedReader::new(std::io::Cursor::new(src.clone()), 16, "mem://");
        let mut out = Vec::new();
        r.read_to_end(&mut out).unwrap();
        assert_eq!(out, src, "a body exactly at the cap is legal");
    }

    #[test]
    fn capped_reader_fails_closed_past_the_limit() {
        let mut r = CappedReader::new(std::io::Cursor::new(vec![b'x'; 17]), 16, "mem://big");
        let mut out = Vec::new();
        let err = r.read_to_end(&mut out).unwrap_err();
        assert!(
            err.to_string().contains("exceeds the 16 byte limit"),
            "truncation must be an explicit error, not a silent cut: {err}"
        );
    }

    #[tokio::test]
    async fn oversized_body_is_refused_with_a_clear_error_over_loopback() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");
        let server = tokio::spawn(async move {
            serve_loop(listener, 1, Vec::new(), vec![b'x'; 256]).await;
        });
        let url = format!("{base}/pkg.tgz");
        let err = tokio::task::spawn_blocking(move || blocking_get_bytes_capped(&url, 5, 64))
            .await
            .unwrap()
            .unwrap_err();
        assert!(
            err.to_string().contains("exceeds the 64 byte limit"),
            "a server streaming past the cap must fail closed: {err}"
        );
        server.await.unwrap();
    }
}

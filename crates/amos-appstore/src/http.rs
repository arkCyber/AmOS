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

/// Blocking GET of `url` returning the raw body bytes. Runs on a blocking
/// thread via [`fetch_async`]; never call from an async context directly.
fn blocking_get_bytes(url: &str, timeout_secs: u64) -> Result<Vec<u8>> {
    let resp = ureq::get(url)
        .timeout(Duration::from_secs(timeout_secs))
        .call()
        .map_err(|e| StoreError::Provider(format!("GET {url}: {e}")))?;
    let mut reader = resp.into_reader();
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|e| StoreError::Provider(format!("read {url}: {e}")))?;
    Ok(bytes)
}

/// Fetch `url` off the async context via [`spawn_blocking`](tokio::task).
async fn fetch_async(url: String, timeout_secs: u64) -> Result<Vec<u8>> {
    let display = url.clone();
    let handle = tokio::task::spawn_blocking(move || blocking_get_bytes(&url, timeout_secs));
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
}

//! End-to-end test of the **remote PWA opener** (Gap 6).
//!
//! The chain exercised here is the real one a device runs, minus TLS transport:
//!
//! ```text
//!  ManifestFetcher ─► open_remote_pwa_with ─► PwaManifest::parse+validate
//!                                              └─► persist to <index>/apps/<id>.toml
//!                                                   └─► PwaIndex::from_dir ─► serve_index
//! ```
//!
//! ## What is *not* exercised here — stated plainly
//!
//! The HTTPS transport itself. `open_remote_pwa` uses the `live`-gated
//! `HttpsFetcher`, which is a one-line delegation to
//! `crate::http::blocking_get_bytes_capped`; that function's own loopback tests
//! (`crates/amos-appstore/src/http.rs`) cover the real socket path, its byte cap
//! and its timeout. Standing up a *TLS* server in this test would require
//! shipping a test certificate + a rustls client config into the test harness —
//! more test infrastructure than the code under test, and it would still not
//! prove anything about `HttpsFetcher` beyond "ureq works". So the transport is
//! covered by the crate's existing HTTP tests, and this test injects the
//! [`ManifestFetcher`] seam to drive the validation + install half over real
//! files. The scheme/host refusals (including cleartext `http://`) *are* covered
//! here, because they happen before any transport is chosen.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use amos_appstore::pwa::{open_remote_pwa_with, serve_index, ManifestFetcher, PwaIndex};
use amos_appstore::{Result, StoreError};

/// A fetcher that serves one canned body and records every URL it was asked for.
struct CannedFetcher {
    body: String,
    seen: Mutex<Vec<String>>,
}

impl CannedFetcher {
    fn serving(body: impl Into<String>) -> Self {
        Self {
            body: body.into(),
            seen: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.seen.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

impl ManifestFetcher for CannedFetcher {
    fn fetch(&self, url: &str, _timeout_secs: u64, max_bytes: u64) -> Result<Vec<u8>> {
        self.seen
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(url.to_string());
        let bytes = self.body.as_bytes();
        if bytes.len() as u64 > max_bytes {
            return Err(StoreError::Provider(format!(
                "body from {url} exceeds the {max_bytes} byte limit"
            )));
        }
        Ok(bytes.to_vec())
    }
}

fn temp_dir(tag: &str) -> PathBuf {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("amos-pwa-e2e-{tag}-{}-{seq}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("apps")).unwrap();
    dir
}

/// A remote manifest in the documented shape, with a configurable id, tool name
/// and action — so one helper drives both the positive and the negative control.
fn manifest_toml(id: &str, tool: &str, action: &str) -> String {
    format!(
        r##"
[app]
id = "{id}"
name = "Remote Weather"
version = "2.1.0"
description = "A remotely installed PWA"

[display]
url = "https://apps.example.org"
mode = "standalone"
orientation = "any"
theme_color = "#112233"

[[mcp_tools]]
name = "{tool}"
description = "look up the forecast"

    [mcp_tools.inputSchema]
    type = "object"
    required = ["city"]

    [mcp_tools.inputSchema.properties.city]
    type = "string"
    description = "the city to look up"

    [mcp_tools.execution]
    action = "{action}"
    url_template = "https://apps.example.org/forecast?city={{city}}"

[permissions.network]
allowed_domains = ["apps.example.org", "cdn.example.org"]
"##
    )
}

#[test]
fn a_remote_manifest_opens_installs_and_is_served_by_the_index() {
    let dir = temp_dir("happy");
    let allow = vec!["apps.example.org".to_string()];
    let fetcher = CannedFetcher::serving(manifest_toml(
        "org.amos.remote.weather",
        "remote_weather",
        "url_redirect",
    ));

    let manifest = open_remote_pwa_with(
        &fetcher,
        &allow,
        "https://apps.example.org/amos-app.toml",
        Some(&dir),
    )
    .expect("an allow-listed host serving a valid manifest installs");

    // The fetch went to exactly the URL asked for, once.
    assert_eq!(
        fetcher.calls(),
        vec!["https://apps.example.org/amos-app.toml"]
    );
    assert_eq!(manifest.app.id, "org.amos.remote.weather");
    assert_eq!(manifest.mcp_tools[0].name, "remote_weather");

    // It persisted under the documented `apps/<id>.toml` name.
    let persisted = dir.join("apps").join("org.amos.remote.weather.toml");
    assert!(
        persisted.is_file(),
        "{} was not written",
        persisted.display()
    );

    // And the served index namespace returns it — the end of the chain the
    // System UI actually reads. (`PwaIndex::to_json_pretty` is deterministic, so
    // asserting on the document text is exact, not incidental.)
    let served = serve_index(Some(&dir), "/apps.json").expect("index serves");
    let json = String::from_utf8(served.bytes.clone()).expect("index JSON is UTF-8");
    assert!(
        json.contains("\"id\": \"org.amos.remote.weather\""),
        "{json}"
    );
    assert!(json.contains("\"name\": \"remote_weather\""), "{json}");
    // The tool dictionary the AI daemon injects is derived from the same index.
    let index = PwaIndex::from_dir(&dir).expect("index compiles");
    assert_eq!(
        index.app_for_tool("remote_weather"),
        Some("org.amos.remote.weather")
    );
    // The index namespace runs nothing.
    assert!(served
        .csp
        .as_deref()
        .unwrap_or_default()
        .contains("default-src 'none'"));

    // A second, distinct app also installs and both compile together.
    let second = open_remote_pwa_with(
        &CannedFetcher::serving(manifest_toml(
            "org.amos.remote.sports",
            "remote_sports",
            "url_redirect",
        )),
        &allow,
        "https://apps.example.org/amos-app.toml",
        Some(&dir),
    )
    .expect("a second distinct app installs");
    assert_eq!(second.app.id, "org.amos.remote.sports");
    let index = PwaIndex::from_dir(&dir).expect("both apps compile");
    assert_eq!(index.apps.len(), 2);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_negative_control_an_eval_js_manifest_is_refused_by_name_and_installs_nothing() {
    let dir = temp_dir("eval-js");
    let allow = vec!["apps.example.org".to_string()];

    // `eval_js` has no executor in AmOS, so serde refuses the variant outright
    // and names it — the operator sees the field, not a generic failure.
    let err = open_remote_pwa_with(
        &CannedFetcher::serving(manifest_toml(
            "org.amos.remote.evil",
            "remote_evil",
            "eval_js",
        )),
        &allow,
        "https://apps.example.org/amos-app.toml",
        Some(&dir),
    )
    .expect_err("eval_js must be refused");
    let msg = err.to_string();
    assert!(msg.contains("eval_js"), "the field must be named: {msg}");
    assert!(msg.contains("url_redirect"), "{msg}");

    // Nothing was written: a refused install leaves no half-app behind.
    assert!(!dir.join("apps").join("org.amos.remote.evil.toml").exists());
    let index = PwaIndex::from_dir(&dir).expect("the empty index still compiles");
    assert!(index.apps.is_empty());
    assert!(index.tool_dictionary().is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_positive_control_installing_twice_refuses_the_duplicate_rather_than_overwriting() {
    let dir = temp_dir("duplicate");
    let allow = vec!["apps.example.org".to_string()];
    let body = manifest_toml("org.amos.remote.once", "remote_once", "url_redirect");

    open_remote_pwa_with(
        &CannedFetcher::serving(body.clone()),
        &allow,
        "https://apps.example.org/amos-app.toml",
        Some(&dir),
    )
    .expect("first install succeeds");

    let err = open_remote_pwa_with(
        &CannedFetcher::serving(body),
        &allow,
        "https://apps.example.org/amos-app.toml",
        Some(&dir),
    )
    .expect_err("a second install of the same id must be refused");
    assert!(err.to_string().contains("duplicate app id"), "{err}");

    assert_eq!(PwaIndex::from_dir(&dir).unwrap().apps.len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn transport_refusals_happen_before_any_fetch() {
    // The scheme/host gate is not transport-dependent: a cleartext URL or an
    // unlisted host is refused without the fetcher ever being called.
    let allow = vec!["apps.example.org".to_string()];
    for url in [
        "http://apps.example.org/amos-app.toml",
        "https://unlisted.example.org/amos-app.toml",
        "https://notapps.example.org/amos-app.toml",
    ] {
        let fetcher = CannedFetcher::serving(manifest_toml(
            "org.amos.remote.n",
            "remote_n",
            "url_redirect",
        ));
        assert!(
            open_remote_pwa_with(&fetcher, &allow, url, None).is_err(),
            "{url} must be refused"
        );
        assert!(
            fetcher.calls().is_empty(),
            "{url} must be refused before any fetch"
        );
    }
}

#[test]
fn validate_only_installs_nothing() {
    // `index_dir = None` is the "check this manifest" path: it validates and
    // returns the manifest without touching the filesystem.
    let allow = vec!["apps.example.org".to_string()];
    let manifest = open_remote_pwa_with(
        &CannedFetcher::serving(manifest_toml(
            "org.amos.remote.check",
            "remote_check",
            "url_redirect",
        )),
        &allow,
        "https://apps.example.org/amos-app.toml",
        None,
    )
    .expect("validates");
    assert_eq!(manifest.app.id, "org.amos.remote.check");
    // The returned manifest is the same app an on-disk manifest of that text is:
    // the remote path adds no extra fields and drops none.
    assert_eq!(
        manifest,
        amos_appstore::pwa::PwaManifest::parse(&manifest_toml(
            "org.amos.remote.check",
            "remote_check",
            "url_redirect"
        ))
        .expect("the same text parses directly")
    );
}

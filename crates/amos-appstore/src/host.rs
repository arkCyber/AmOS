//! `amos-app://` custom-protocol host for installed web-bundles.
//!
//! The store docs describe a future web host that turns a request like
//! `amos-app://<id>/assets/app.js` into a served file *inside* that app's own
//! install directory. [`serve`] already provides the safe per-directory resolver
//! (`resolve_request`, canonicalization + path-traversal guards). This module is
//! the missing **URI → (app, request path)** layer plus a convenience that reads
//! the resolved file's bytes, so a Tauri/custom-protocol handler can serve it
//! with the right MIME + `nosniff` — and the whole thing stays unit-testable.
//!
//! Security invariants (kept honest, no pretending):
//! * The netloc must be a **valid app id** ([`crate::model`]'s slug rule) — an id
//!   like `..`, containing `/`, `\`, `:` or whitespace can never address a path.
//! * Only `<id>` under the install root is ever opened; [`serve::resolve_request`]
//!   still rejects `..`/absolute/path-escapes and missing files.

use std::fs;
use std::path::Path;

use crate::error::{Result, StoreError};
use crate::serve::resolve_request;
use crate::webinstall::WebInstaller;

/// The URI scheme this host serves.
pub const SCHEME: &str = "amos-app";

/// The reserved netloc that addresses the **system index** instead of an
/// installed app: `amos-app://index/apps.json` ([`crate::pwa::serve_index`]).
///
/// Reserved, not merely conventional: an app whose id is literally `index` is
/// valid under the slug rule, so [`serve_uri`] resolves this netloc to the index
/// *before* it ever looks in the install root. Such an app could therefore never
/// be reached — hence [`crate::pwa`]'s file-naming rule plus this constant being
/// the single definition of the reserved name.
pub const INDEX_NETLOC: &str = "index";

/// True when `id` is an acceptable app slug (the same rule `AppManifest` uses).
/// Hosts call this to validate an `id` *before* touching the filesystem, so a
/// value like `..` or `../secret` can never become a directory under the root.
pub fn is_valid_app_id(id: &str) -> bool {
    crate::model::valid_id(id)
}

/// True when `netloc` is reserved by the protocol itself ([`INDEX_NETLOC`], the
/// PWA index) and can therefore **never** address an installed app.
///
/// This is not a duplicate of the routing check — it is the guard that stops a
/// caller handing out a URL that can never work. `index` is a **valid app slug**,
/// so a bundle filed under `<root>/index/` would look perfectly installable while
/// [`serve_uri`] routes every `amos-app://index/…` request to the index. A host
/// that resolved such an app's entry URL would produce `amos-app://index/index.html`
/// — a plausible-looking address whose only possible outcome is the index
/// gateway's refusal text rendered inside an "app" frame.
pub fn is_reserved_netloc(netloc: &str) -> bool {
    netloc == INDEX_NETLOC
}

/// A file read out of an installed web-bundle, ready to hand to a responder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServedBundle {
    /// Raw file bytes (html/js/css/image/…).
    pub bytes: Vec<u8>,
    /// Content type derived from the file extension (see `serve::content_type_for`).
    pub content_type: &'static str,
    /// Always `true`: never let a responder sniff a third-party file as HTML/JS.
    pub nosniff: bool,
    /// The `Content-Security-Policy` this response must carry, if any.
    ///
    /// Carried on the **response** because a CSP is enforced per document: a
    /// hosted bundle is its own document at its own origin, so nothing the shell
    /// configures can constrain it. See [`crate::pwa::bundle_csp`].
    pub csp: Option<String>,
}

/// Parse an `amos-app://` URL into `(app_id, request_path)`.
///
/// * `amos-app://org.amos.pomodoro` / `amos-app://org.amos.pomodoro/` →
///   `("org.amos.pomodoro", "")` (an empty path resolves to `index.html`).
/// * `amos-app://org.amos.pomodoro/assets/app.js` →
///   `("org.amos.pomodoro", "/assets/app.js")`.
///
/// The request path is returned **root-relative** so callers can pass it to
/// [`resolve_request`], which does the canonicalization/traversal checks.
/// Returns `Err` for a wrong scheme, an invalid/unsafe id, or a missing host.
pub fn parse_bundle_uri(uri: &str) -> Result<(String, String)> {
    let rest = uri
        .strip_prefix(&format!("{SCHEME}://"))
        .ok_or_else(|| StoreError::Provider(format!("not an {SCHEME} URL: {uri}")))?;
    let (netloc, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if !crate::model::valid_id(netloc) {
        return Err(StoreError::InvalidAppId(netloc.to_string()));
    }
    // Trim a trailing slash; an empty path means the bundle root (→ index.html).
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        Ok((netloc.to_string(), String::new()))
    } else {
        Ok((netloc.to_string(), trimmed.to_string()))
    }
}

/// Serve one `amos-app://` request against the install `root`: validates the id,
/// resolves the (traversal-safe) file inside that app's bundle dir, and returns
/// its bytes + MIME + `nosniff`. A host (custom protocol / future webview) just
/// writes these bytes with the given content type.
pub fn serve_bundle(root: &Path, uri: &str) -> Result<ServedBundle> {
    let (id, request) = parse_bundle_uri(uri)?;
    let dir = WebInstaller::new(root).dir_for(&id);
    // The bundle's own declaration decides its policy, so it is read **before**
    // anything is served: a bundle with no readable `amos-app.json` has no known
    // policy, and serving it under a guessed one would be the wrong answer. This
    // is also why the declaration travels inside the (checksummed, optionally
    // signed) archive rather than beside it.
    let meta = crate::webinstall::read_bundle_meta(&dir)
        .map_err(|e| StoreError::Provider(format!("{SCHEME}://{id}/{request}: {e}")))?;
    let served = resolve_request(&dir, &request)
        .map_err(|e| StoreError::Provider(format!("{SCHEME}://{id}/{request}: {e}")))?;
    let bytes = fs::read(&served.path)
        .map_err(|e| StoreError::Provider(format!("read {} failed: {e}", served.path.display())))?;
    Ok(ServedBundle {
        bytes,
        content_type: served.content_type,
        nosniff: served.nosniff,
        csp: Some(crate::pwa::bundle_csp(&meta.allowed_domains)),
    })
}

/// Whether `uri` addresses the reserved system-index namespace
/// (`amos-app://index/…`) rather than an installed app.
///
/// The protocol handler uses this to decide whether a response may carry
/// `Access-Control-Allow-Origin: *`: the index is public, an installed app's
/// bundle is not — and a wildcard there would let one sandboxed app read
/// another's files with `fetch`.
pub fn is_index_uri(uri: &str) -> bool {
    match uri.strip_prefix(&format!("{SCHEME}://")) {
        Some(rest) => rest.split('/').next().unwrap_or("") == INDEX_NETLOC,
        None => false,
    }
}

/// Serve **any** `amos-app://` URI: the two namespaces the host exposes.
///
/// * `amos-app://index/…` → the compiled PWA index + its icons
///   ([`crate::pwa::serve_index`]). `index_dir` is the operator-supplied index
///   directory, or `None` for the manifests embedded in the build.
/// * `amos-app://<app-id>/…` → that app's installed web-bundle
///   ([`serve_bundle`]), out of `install_root`.
///
/// `install_root` is `None` when the process was started without a web-install
/// directory: the index namespace still answers, and any *app* request is
/// refused by name rather than dereferencing a root that does not exist.
///
/// This is the single entry point a Tauri `register_uri_scheme_protocol` handler
/// (or any other host) needs: one call, one `(bytes, MIME, nosniff)` triple.
/// Routing lives here rather than in the Tauri layer so the whole surface —
/// including the reserved-netloc rule — is testable without a WebView.
pub fn serve_uri(
    install_root: Option<&Path>,
    index_dir: Option<&Path>,
    uri: &str,
) -> Result<ServedBundle> {
    let rest = uri
        .strip_prefix(&format!("{SCHEME}://"))
        .ok_or_else(|| StoreError::Provider(format!("not an {SCHEME} URL: {uri}")))?;
    let (netloc, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if netloc == INDEX_NETLOC {
        return crate::pwa::serve_index(index_dir, path);
    }
    let root = install_root.ok_or_else(|| {
        StoreError::Provider(format!(
            "no web-install directory is configured (AMOS_APPSTORE_INSTALL_DIR is unset): \
             {SCHEME}://{netloc} has no bundle to serve"
        ))
    })?;
    serve_bundle(root, uri)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AppCategory, AppManifest, PackageFormat, PackageRef, Version};

    fn manifest(id: &str) -> AppManifest {
        AppManifest {
            id: id.into(),
            name: "Host App".into(),
            summary: "s".into(),
            description: String::new(),
            author: "Amos Labs".into(),
            version: Version::new(1, 0, 0),
            category: AppCategory::Tools,
            homepage: String::new(),
            icon_url: String::new(),
            package: PackageRef {
                format: PackageFormat::TarGz,
                url: "https://x/a.tgz".into(),
                sha256: None,
                size_bytes: None,
            },
            publisher: None,
        }
    }

    fn gz_bundle(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut tar = tar::Builder::new(&mut enc);
            for (name, bytes) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                tar.append_data(&mut header, *name, *bytes).unwrap();
            }
            tar.finish().unwrap();
        }
        enc.finish().unwrap()
    }

    /// Unpack a small web-bundle under a fresh temp install root; returns the root.
    fn install_bundle(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("amos-appstore-host-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let gz = gz_bundle(&[
            (
                "amos-app.json",
                br#"{"id":"org.amos.web","name":"Host App","start":"index.html"}"#.as_slice(),
            ),
            (
                "index.html",
                b"<!doctype html><h1>hello bundle</h1>".as_slice(),
            ),
            ("assets/app.js", b"console.log('hi')".as_slice()),
        ]);
        let installer = WebInstaller::new(&dir);
        installer
            .install(&manifest("org.amos.web"), &gz)
            .expect("installs");
        dir
    }

    #[test]
    fn parse_bundle_uri_extracts_id_and_path_and_validates() {
        let (id, p) = parse_bundle_uri("amos-app://org.amos.web/assets/app.js").unwrap();
        assert_eq!(id, "org.amos.web");
        assert_eq!(p, "/assets/app.js");

        let (id2, p2) = parse_bundle_uri("amos-app://org.amos.web").unwrap();
        assert_eq!(id2, "org.amos.web");
        assert_eq!(p2, "", "empty path -> index.html");

        // Wrong scheme / unsafe *id* must be refused at parse time…
        assert!(parse_bundle_uri("http://org.amos.web/x").is_err());
        assert!(parse_bundle_uri("amos-app://../secret").is_err());
        assert!(parse_bundle_uri("amos-app://A b/x").is_err());
        // …while a `..` in the *path* is a valid id + raw path here (traversal is
        // rejected later by serve::resolve_request — see the serve tests).
        let (id3, p3) = parse_bundle_uri("amos-app://org.amos.web/../../etc").unwrap();
        assert_eq!(id3, "org.amos.web");
        assert_eq!(p3, "/../../etc");
    }

    #[test]
    fn serve_bundle_reads_entry_and_assets_inside_the_app_dir() {
        let root = install_bundle("serve");
        let entry = serve_bundle(&root, "amos-app://org.amos.web/").unwrap();
        assert!(entry.nosniff);
        assert!(String::from_utf8_lossy(&entry.bytes).contains("hello bundle"));

        let js = serve_bundle(&root, "amos-app://org.amos.web/assets/app.js").unwrap();
        assert_eq!(js.content_type, "text/javascript; charset=utf-8");
        assert!(String::from_utf8_lossy(&js.bytes).contains("console.log"));

        // Missing file / unknown app -> Err (no panic, nothing served).
        assert!(serve_bundle(&root, "amos-app://org.amos.web/nope.js").is_err());
        assert!(serve_bundle(&root, "amos-app://not.installed/index.html").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn is_reserved_netloc_marks_only_the_protocols_own_namespace() {
        assert!(is_reserved_netloc("index"));
        // An app that merely *starts* with it is a normal app.
        assert!(!is_reserved_netloc("indexical"));
        assert!(!is_reserved_netloc("org.amos.index"));
        assert!(!is_reserved_netloc(""));
        assert!(!is_reserved_netloc("INDEX"));
    }

    #[test]
    fn a_served_bundle_carries_the_policy_its_own_declaration_earned() {
        // The enforcement link, at the layer that can be tested: the declaration
        // inside the bundle → the `Content-Security-Policy` on its responses.
        let root = std::env::temp_dir().join(format!("amos-csp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("org.amos.web");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("amos-app.json"),
            br#"{"id":"org.amos.web","name":"Web","start":"index.html","allowed_domains":["api.example.com"]}"#,
        )
        .unwrap();
        std::fs::write(dir.join("index.html"), b"<html></html>").unwrap();

        let served = serve_bundle(&root, "amos-app://org.amos.web/").unwrap();
        let csp = served.csp.expect("a bundle response carries a policy");
        assert!(
            csp.contains("connect-src 'self' https://api.example.com"),
            "{csp}"
        );
        assert!(csp.contains("script-src 'self';"), "{csp}");

        // A bundle that declares nothing gets the same policy with no extra hosts:
        // the declaration only ever *widens* `connect-src`/`form-action`.
        std::fs::write(
            dir.join("amos-app.json"),
            br#"{"id":"org.amos.web","name":"Web","start":"index.html"}"#,
        )
        .unwrap();
        let served = serve_bundle(&root, "amos-app://org.amos.web/").unwrap();
        let csp = served.csp.unwrap();
        assert!(csp.contains("connect-src 'self';"), "{csp}");
        assert!(!csp.contains("https://"), "{csp}");

        // **Fail closed**: a directory with no readable declaration has no known
        // policy, so nothing is served from it under a guessed one.
        std::fs::remove_file(dir.join("amos-app.json")).unwrap();
        let err = serve_bundle(&root, "amos-app://org.amos.web/").expect_err("no declaration");
        assert!(format!("{err}").contains("amos-app.json"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn serve_uri_routes_the_reserved_index_netloc_away_from_installed_bundles() {
        let root = install_bundle("uri");

        // The reserved netloc addresses the system index, never the install root
        // (even though `index` is itself a valid app slug).
        let index = serve_uri(Some(&root), None, "amos-app://index/apps.json").unwrap();
        assert_eq!(index.content_type, "application/json; charset=utf-8");
        assert!(String::from_utf8_lossy(&index.bytes).contains("\"apps\""));

        // Every other netloc takes the installed-bundle path, unchanged.
        let entry = serve_uri(Some(&root), None, "amos-app://org.amos.web/").unwrap();
        assert!(String::from_utf8_lossy(&entry.bytes).contains("hello bundle"));

        // A wrong scheme, an unknown app and an index path that is not served are
        // all errors — never a panic and never someone else's bytes.
        assert!(serve_uri(Some(&root), None, "https://evil.test/x").is_err());
        assert!(serve_uri(Some(&root), None, "amos-app://nope.installed/").is_err());
        assert!(serve_uri(Some(&root), None, "amos-app://index/etc/passwd").is_err());

        // With no install root the *index* still answers (it needs no bundles),
        // while an app request names the missing knob instead of guessing a path.
        let index = serve_uri(None, None, "amos-app://index/apps.json").unwrap();
        assert_eq!(index.content_type, "application/json; charset=utf-8");
        let err = serve_uri(None, None, "amos-app://org.amos.web/").expect_err("no install root");
        assert!(
            format!("{err}").contains("AMOS_APPSTORE_INSTALL_DIR"),
            "{err}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn is_index_uri_marks_only_the_reserved_namespace() {
        assert!(is_index_uri("amos-app://index/apps.json"));
        assert!(is_index_uri("amos-app://index"));
        assert!(!is_index_uri("amos-app://org.amos.web/"));
        assert!(!is_index_uri("amos-app://indexical/x"));
        assert!(!is_index_uri("https://index/apps.json"));
    }

    #[test]
    fn serve_bundle_refuses_path_escapes_even_via_uri() {
        let root = install_bundle("escape");
        // .. that would climb out of the app dir is refused by resolve_request.
        assert!(serve_bundle(&root, "amos-app://org.amos.web/../../secret").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}

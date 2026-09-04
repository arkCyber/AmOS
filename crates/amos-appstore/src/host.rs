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

/// True when `id` is an acceptable app slug (the same rule `AppManifest` uses).
/// Hosts call this to validate an `id` *before* touching the filesystem, so a
/// value like `..` or `../secret` can never become a directory under the root.
pub fn is_valid_app_id(id: &str) -> bool {
    crate::model::valid_id(id)
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
    let served = resolve_request(&dir, &request)
        .map_err(|e| StoreError::Provider(format!("{SCHEME}://{id}/{request}: {e}")))?;
    let bytes = fs::read(&served.path)
        .map_err(|e| StoreError::Provider(format!("read {} failed: {e}", served.path.display())))?;
    Ok(ServedBundle {
        bytes,
        content_type: served.content_type,
        nosniff: served.nosniff,
    })
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
    fn serve_bundle_refuses_path_escapes_even_via_uri() {
        let root = install_bundle("escape");
        // .. that would climb out of the app dir is refused by resolve_request.
        assert!(serve_bundle(&root, "amos-app://org.amos.web/../../secret").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}

//! Safe file serving for installed web-bundles.
//!
//! A web host (future custom protocol / webview) turns a request like
//! `amos-app://<id>/assets/app.js` into a call to [`resolve_request`], which
//! maps it to a real file **inside** that bundle's install directory — never
//! outside it — and reports the content type / `nosniff` to set. It is the
//! server-side gate that keeps third-party apps from reading or writing
//! anything but their own unpacked bundle.
//!
//! Rules:
//! * `..` / absolute / prefixed paths are refused (path traversal).
//! * An empty request or one pointing at a directory resolves to `index.html`.
//! * Only files already inside `<dir>` (verified via canonicalization) are served.
//! * The resolved path is returned for the host to read; `nosniff` is always on.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::error::{Result, StoreError};

/// A file ready to be served (host reads `path`; sets `content_type` + nosniff).
#[derive(Clone, Debug)]
pub struct ServedFile {
    pub path: PathBuf,
    pub content_type: &'static str,
    pub nosniff: bool,
}

/// MIME type for a served path by extension (a small whitelist; everything else
/// is served opaque with `nosniff` so it can't be sniffed as HTML/JS).
pub fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
    {
        Some(e) => match e.as_str() {
            "html" | "htm" => "text/html; charset=utf-8",
            "js" | "mjs" => "text/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "json" => "application/json; charset=utf-8",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "svg" => "image/svg+xml",
            "webp" => "image/webp",
            "ico" => "image/x-icon",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            "ttf" => "font/ttf",
            "wasm" => "application/wasm",
            _ => "application/octet-stream",
        },
        None => "application/octet-stream",
    }
}

/// Resolve a (web-host) request path against an installed bundle `dir`.
pub fn resolve_request(dir: &Path, request: &str) -> Result<ServedFile> {
    let dir_c = fs::canonicalize(dir)
        .map_err(|e| StoreError::Provider(format!("bundle dir {} missing: {e}", dir.display())))?;

    let rel = sanitize(request)?;
    let abs = dir_c.join(&rel);
    let abs_c = fs::canonicalize(&abs)
        .map_err(|_| StoreError::Provider(format!("not found in bundle: {request}")))?;
    if !abs_c.starts_with(&dir_c) {
        return Err(StoreError::Provider("path escapes bundle".into()));
    }

    let target = if abs_c.is_dir() {
        let idx = abs_c.join("index.html");
        fs::canonicalize(&idx)
            .map_err(|_| StoreError::Provider(format!("no index inside directory: {request}")))?
    } else {
        abs_c
    };

    Ok(ServedFile {
        content_type: content_type_for(&target),
        nosniff: true,
        path: target,
    })
}

/// Turn a raw request path into a safe, relative path inside the bundle.
/// Empty/`/` becomes `index.html` (the web-bundle convention); `..`/absolute
/// are refused.
fn sanitize(request: &str) -> Result<PathBuf> {
    let trimmed = request.trim_start_matches('/').trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(PathBuf::from("index.html"));
    }
    let p = PathBuf::from(trimmed);
    for c in p.components() {
        if matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(StoreError::Provider(format!(
                "unsafe bundle path: {request}"
            )));
        }
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AppCategory, PackageFormat, PackageRef, Version};
    use crate::webinstall::WebInstaller;

    fn manifest(id: &str) -> crate::model::AppManifest {
        crate::model::AppManifest {
            id: id.into(),
            name: "Serve App".into(),
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

    fn bundle_bytes() -> Vec<u8> {
        fn gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            {
                let mut ar = tar::Builder::new(&mut gz);
                for (name, data) in entries {
                    let mut h = tar::Header::new_gnu();
                    h.set_entry_type(tar::EntryType::file());
                    h.set_size(data.len() as u64);
                    h.set_mode(0o644);
                    h.set_cksum();
                    ar.append_data(&mut h, name, *data).unwrap();
                }
                ar.finish().unwrap();
            }
            gz.finish().unwrap()
        }
        gz(&[
            (
                "amos-app.json",
                b"{\"id\":\"org.amos.serve\",\"name\":\"Serve\",\"start\":\"index.html\"}",
            ),
            ("index.html", b"<html>hi</html>"),
            ("assets/app.js", b"console.log(1)"),
            ("style.css", b"body{}"),
        ])
    }

    fn installed_dir() -> PathBuf {
        let root = std::env::temp_dir().join(format!("amos-serve-{}", std::process::id()));
        let installer = WebInstaller::new(&root);
        let mf = manifest("org.amos.serve");
        installer.install(&mf, &bundle_bytes()).unwrap();
        installer.dir_for(&mf.id)
    }

    #[test]
    fn resolves_index_asset_and_content_type() {
        let dir = installed_dir();

        let idx = resolve_request(&dir, "").unwrap();
        assert_eq!(idx.content_type, "text/html; charset=utf-8");
        assert!(idx.path.ends_with("index.html"));

        let js = resolve_request(&dir, "/assets/app.js").unwrap();
        assert_eq!(js.content_type, "text/javascript; charset=utf-8");
        assert!(js.path.ends_with("assets/app.js"));

        let css = resolve_request(&dir, "style.css").unwrap();
        assert_eq!(css.content_type, "text/css; charset=utf-8");
        assert!(css.nosniff);

        // A sub-directory without an index is not servable.
        assert!(resolve_request(&dir, "assets").is_err());
    }

    #[test]
    fn refuses_escaping_or_missing_paths() {
        let dir = installed_dir();
        for bad in [
            "../secret",
            "/../secret",
            "a/../../secret",
            "/etc/passwd",
            "..%2f..",
        ] {
            assert!(
                resolve_request(&dir, bad).is_err(),
                "{bad:?} must be refused"
            );
        }
        assert!(resolve_request(&dir, "/nope.js").is_err(), "missing file");
    }
}

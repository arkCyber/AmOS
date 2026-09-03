//! Web-bundle installer: extract a verified app archive (`tar.gz`) into an
//! install directory on disk.
//!
//! A **web-bundle** is what a store app actually ships as a runnable third-party
//! app: a `tar.gz` containing
//!
//! * `index.html` (+ any static assets: js/css/img), and
//! * an `amos-app.json` manifest (`{ "id", "name", "start" }`).
//!
//! The [`AppStore`](crate::client::AppStore) engine already verifies the
//! archive bytes against the manifest's sha256 **before** this runs; the
//! installer then lays them out on disk under `<root>/<app-id>/`, copies the
//! verified [`AppManifest`] to `manifest.json`, and validates the result so a
//! later web host has a concrete, on-disk bundle to serve.
//!
//! The `tar` crate's `unpack` refuses `..` / absolute paths (path-traversal
//! protection); re-installing replaces the previous bundle for that id.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use tar::Archive;

use crate::error::{Result, StoreError};
use crate::model::AppManifest;

/// The on-disk `amos-app.json` a web-bundle carries (identity + entry).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WebBundleMeta {
    pub id: String,
    pub name: String,
    /// Entry html relative to the bundle root (default `index.html`).
    #[serde(default = "default_start")]
    pub start: String,
}

fn default_start() -> String {
    "index.html".to_string()
}

/// A per-app web install on disk.
#[derive(Clone, Debug)]
pub struct WebInstall {
    /// Directory holding the unpacked bundle + `manifest.json`.
    pub dir: PathBuf,
}

/// Extracts `tar.gz` web-bundles under a root directory.
#[derive(Clone, Debug)]
pub struct WebInstaller {
    root: PathBuf,
}

impl WebInstaller {
    /// Installer rooted at `root` (one subdirectory per app id).
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The install root directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Path where `id`'s bundle lives (not yet guaranteed to exist).
    pub fn dir_for(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    /// Verify + extract `archive` (a `tar.gz` web-bundle) for `manifest` into
    /// `<root>/<id>/`, validate the result, and write `manifest.json`.
    ///
    /// `archive` must already be integrity-checked by the caller (sha256).
    pub fn install(&self, manifest: &AppManifest, archive: &[u8]) -> Result<WebInstall> {
        manifest.validate()?;
        let dir = self.dir_for(&manifest.id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| io_err("remove old install", &dir, &e))?;
        }
        fs::create_dir_all(&dir).map_err(|e| io_err("create install dir", &dir, &e))?;

        // tar::unpack refuses `..` / absolute paths, so a malicious archive can't
        // escape `dir`.
        let gz = GzDecoder::new(archive);
        let mut ar = Archive::new(gz);
        ar.unpack(&dir)
            .map_err(|e| StoreError::Provider(format!("extract {}: {e}", manifest.id)))?;

        validate_bundle(&dir)?;

        // Persist the verified manifest next to the unpacked files.
        let meta_path = dir.join("manifest.json");
        let bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|e| StoreError::Provider(format!("serialize manifest: {e}")))?;
        fs::write(&meta_path, bytes).map_err(|e| io_err("write manifest", &meta_path, &e))?;

        Ok(WebInstall { dir })
    }

    /// Remove `id`'s install directory (a no-op when absent).
    pub fn uninstall(&self, id: &str) -> Result<()> {
        let dir = self.dir_for(id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| io_err("remove install", &dir, &e))?;
        }
        Ok(())
    }
}

/// Require the two files a runnable web-bundle must expose.
fn validate_bundle(dir: &Path) -> Result<()> {
    let meta_path = dir.join("amos-app.json");
    let raw = fs::read(&meta_path)
        .map_err(|e| StoreError::Provider(format!("bundle missing amos-app.json: {e}")))?;
    let meta: WebBundleMeta = serde_json::from_slice(&raw)
        .map_err(|e| StoreError::Provider(format!("bad amos-app.json: {e}")))?;
    let entry = dir.join(&meta.start);
    if !entry.is_file() {
        return Err(StoreError::Provider(format!(
            "bundle entry {} not found",
            meta.start
        )));
    }
    Ok(())
}

/// Read helper wrapper into a StoreError::Provider (so error lines stay short).
fn io_err(action: &str, path: &Path, err: &std::io::Error) -> StoreError {
    StoreError::Provider(format!("{action} {}: {err}", path.display()))
}

/// Read a small in-memory file (used by tests / hosts to load index.html).
pub fn read_file(dir: &Path, rel: &str) -> Result<Vec<u8>> {
    let p = dir.join(rel);
    let mut f = fs::File::open(&p).map_err(|e| io_err("open", &p, &e))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| io_err("read", &p, &e))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AppCategory, PackageFormat, PackageRef, Version};

    fn manifest() -> AppManifest {
        AppManifest {
            id: "org.amos.demo".into(),
            name: "Demo Web".into(),
            summary: "a web bundle".into(),
            description: String::new(),
            author: "Amos Labs".into(),
            version: Version::new(1, 0, 0),
            category: AppCategory::Tools,
            homepage: String::new(),
            icon_url: String::new(),
            package: PackageRef {
                format: PackageFormat::TarGz,
                url: "https://x/demo.tgz".into(),
                sha256: None,
                size_bytes: None,
            },
            publisher: None,
        }
    }

    /// Build an in-memory `tar.gz` with the given entries.
    fn gz_bundle(entries: &[(&str, &[u8])]) -> Vec<u8> {
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

    fn web_meta(id: &str) -> Vec<u8> {
        format!(r#"{{"id":"{id}","name":"Demo","start":"index.html"}}"#).into_bytes()
    }

    #[test]
    fn install_unpacks_writes_manifest_and_uninstalls() {
        let root = std::env::temp_dir().join(format!("amos-webinst-{}", std::process::id()));
        let installer = WebInstaller::new(&root);

        let mf = manifest();
        let bytes = gz_bundle(&[
            ("amos-app.json", &web_meta(&mf.id)),
            ("index.html", b"<html>hi</html>"),
            ("assets/app.js", b"console.log('ok')"),
        ]);
        let inst = installer.install(&mf, &bytes).unwrap();
        assert!(inst.dir.join("index.html").is_file());
        assert!(inst.dir.join("assets/app.js").is_file());
        assert!(inst.dir.join("manifest.json").is_file());
        assert_eq!(
            read_file(&inst.dir, "index.html").unwrap(),
            b"<html>hi</html>"
        );

        // Re-installing replaces cleanly.
        installer.install(&mf, &bytes).unwrap();
        assert!(installer.dir_for(&mf.id).join("index.html").is_file());

        installer.uninstall(&mf.id).unwrap();
        assert!(!installer.dir_for(&mf.id).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_archives_without_entry_or_missing_file() {
        let root = std::env::temp_dir().join(format!("amos-webinst-bad-{}", std::process::id()));
        let installer = WebInstaller::new(&root);
        let mf = manifest();

        // Missing amos-app.json.
        let no_meta = gz_bundle(&[("index.html", b"<html>x</html>")]);
        assert!(installer.install(&mf, &no_meta).is_err());

        // amos-app.json present but its start file missing.
        let bad_start = gz_bundle(&[("amos-app.json", &web_meta(&mf.id))]);
        assert!(installer.install(&mf, &bad_start).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tar_refuses_dotdot_and_install_rejects_corrupt_gzip() {
        // Defense in depth: the tar builder refuses `..` at packaging time, so a
        // traversal archive can't even be produced through it.
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut ar = tar::Builder::new(&mut gz);
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(tar::EntryType::file());
            h.set_size(1);
            h.set_cksum();
            let data: &[u8] = b"x";
            assert!(
                ar.append_data(&mut h, "../evil.txt", data).is_err(),
                "building a `..` entry must fail"
            );
        }

        let root = std::env::temp_dir().join(format!("amos-webinst-evil-{}", std::process::id()));
        let installer = WebInstaller::new(&root);
        let mf = manifest();
        // Not a gzip at all → install is rejected (Provider error), not panic.
        assert!(installer.install(&mf, b"definitely not a tar.gz").is_err());

        let _ = std::fs::remove_dir_all(&root);
    }
}

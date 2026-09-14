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
//! protection) — but **not links**: a symlink entry would be extracted verbatim
//! and followed by every later read, letting a bundle reach any host file the
//! user can read. Link entries are therefore refused up front
//! ([`reject_link_entries`]); a web bundle is regular files and directories.
//! Re-installing replaces the previous bundle for that id.

use std::fs;
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use tar::Archive;

use crate::error::{Result, StoreError};
use crate::model::AppManifest;

/// The on-disk `amos-app.json` a web-bundle carries (identity + entry + egress).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WebBundleMeta {
    pub id: String,
    pub name: String,
    /// Entry html relative to the bundle root (default `index.html`).
    #[serde(default = "default_start")]
    pub start: String,
    /// Hosts this bundle is allowed to reach, in the **same grammar** the PWA
    /// index uses (`pwa::validate_domain_pattern`): bare hosts, which cover the
    /// host and every subdomain; there is no wildcard form.
    ///
    /// This is a **declaration that gets enforced** — the host folds it into the
    /// `Content-Security-Policy` of every response it serves for this bundle
    /// (`pwa::bundle_csp`), so an empty list means "this app talks to nobody".
    /// It lives *inside* the archive on purpose: the archive is what the sha256
    /// (and any publisher signature) covers, so the declaration cannot be swapped
    /// for a more permissive one after signing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_domains: Vec<String>,
}

fn default_start() -> String {
    "index.html".to_string()
}

/// Reject an archive that carries a symlink or hard-link entry.
///
/// This is the one thing `tar::unpack` does not defend against: its `..` /
/// absolute-path checks constrain *names*, not link targets, and the extracted
/// link is then followed by every ordinary `open`. A web bundle is regular files
/// and directories, so the honest answer is to refuse the archive rather than
/// silently strip an entry the publisher meant to ship.
fn reject_link_entries(manifest: &AppManifest, archive: &[u8]) -> Result<()> {
    let mut ar = Archive::new(GzDecoder::new(archive));
    let entries = ar
        .entries()
        .map_err(|e| StoreError::Provider(format!("read bundle {}: {e}", manifest.id)))?;
    for entry in entries {
        let entry =
            entry.map_err(|e| StoreError::Provider(format!("read bundle {}: {e}", manifest.id)))?;
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            let name = entry
                .path()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "<unreadable path>".to_string());
            return Err(StoreError::Provider(format!(
                "bundle {} contains a {} entry ({name}); a web bundle must be regular files",
                manifest.id,
                if kind.is_symlink() {
                    "symlink"
                } else {
                    "hard link"
                }
            )));
        }
    }
    Ok(())
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

        // `tar::unpack` refuses `..` / absolute paths, but it does **not** refuse
        // *links*: a symlink entry is created verbatim, and every later read goes
        // through it — `read_file` (and the asset host built on it) follows
        // symlinks, so `leak -> /etc/passwd` would let the sandboxed webview read
        // host files; a symlinked *directory* would let a later entry write
        // through it. A web bundle is regular files and directories, so link
        // entries are refused outright (fail closed, naming the entry) **before**
        // anything is extracted.
        reject_link_entries(manifest, archive)?;

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

/// The on-disk `amos-app.json` of an extracted bundle, **read and validated**.
///
/// The bundle's entry (`meta.start`) comes from inside the archive (a plain JSON
/// field), so the `tar` crate's own `..`-rejection does not apply to it — this
/// checks that it really resolves to a file **inside** `dir` before anyone serves
/// it. Returns the meta so a host can point at the bundle's real entry instead of
/// assuming `index.html`.
pub fn read_bundle_meta(dir: &Path) -> Result<WebBundleMeta> {
    let meta_path = dir.join("amos-app.json");
    let raw = fs::read(&meta_path).map_err(|e| {
        StoreError::Provider(format!(
            "bundle {} has no amos-app.json: {e}",
            dir.display()
        ))
    })?;
    let meta: WebBundleMeta = serde_json::from_slice(&raw)
        .map_err(|e| StoreError::Provider(format!("bad amos-app.json: {e}")))?;
    let entry = safe_join(dir, &meta.start)?;
    if !entry.is_file() {
        return Err(StoreError::Provider(format!(
            "bundle entry {} not found",
            meta.start
        )));
    }
    // The declared egress is validated here, with the **same** grammar the PWA
    // index uses, and a bad pattern is refused rather than dropped: a pattern the
    // WebView would never match is a rule that silently does nothing, and a
    // pattern that *did* get through unchecked would be granted in the CSP.
    for pattern in &meta.allowed_domains {
        crate::pwa::validate_domain_pattern(pattern)
            .map_err(|e| StoreError::Provider(format!("bundle {}: {e}", dir.display())))?;
    }
    Ok(meta)
}

/// Require the two files a runnable web-bundle must expose.
fn validate_bundle(dir: &Path) -> Result<()> {
    read_bundle_meta(dir).map(|_| ())
}

/// Read helper wrapper into a StoreError::Provider (so error lines stay short).
fn io_err(action: &str, path: &Path, err: &std::io::Error) -> StoreError {
    StoreError::Provider(format!("{action} {}: {err}", path.display()))
}

/// Whether `rel` is a safe **relative** path with only normal components — i.e.
/// no absolute path, no `..`/`.`/empty segments, no Windows prefix and no NUL.
///
/// This guards the *post-unpack* paths that come from inside an archive (the
/// bundle's `start` entry) and from host asset requests, where the `tar`
/// crate's own `..`-rejection does **not** apply (it only protects the archive
/// entries themselves, not a path string parsed out of a JSON file afterwards).
fn safe_relative(rel: &str) -> bool {
    use std::path::Component;
    if rel.is_empty() || rel.contains('\0') {
        return false;
    }
    let p = Path::new(rel);
    !p.is_absolute() && p.components().all(|c| matches!(c, Component::Normal(_)))
}

/// `dir.join(rel)` but only for a [`safe_relative`] path, so a bundle/host can
/// never escape the install directory via a crafted relative path.
fn safe_join(dir: &Path, rel: &str) -> Result<PathBuf> {
    if !safe_relative(rel) {
        return Err(StoreError::Provider(format!(
            "unsafe relative path {rel:?} (path traversal refused)"
        )));
    }
    Ok(dir.join(rel))
}

/// Read a small in-memory file (used by tests / hosts to load index.html).
///
/// Resolves through the **same hardened resolver the request host uses**
/// ([`crate::serve::resolve_request`]) instead of `safe_join` + `File::open`:
/// the latter constrains the requested *name* only, so a symlink already sitting
/// in the bundle — whatever put it there — would be followed straight out of the
/// install dir. One resolver means the two read paths cannot disagree.
pub fn read_file(dir: &Path, rel: &str) -> Result<Vec<u8>> {
    let served = crate::serve::resolve_request(dir, rel)?;
    fs::read(&served.path).map_err(|e| io_err("read", &served.path, &e))
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

    #[test]
    fn rejects_manifest_start_that_traverses_out_of_dir() {
        // A malicious bundle can put `../..` in its *JSON* `start` field: the tar
        // crate's `..`-rejection does not apply to a path parsed out afterwards,
        // so the installer must reject it itself (it must not even probe is_file
        // outside the install dir).
        let base = std::env::temp_dir().join(format!("amos-webinst-tt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let root = base.join("install"); // installer root
                                         // A decoy that an unguarded `dir.join("../../...")` would happily hit.
        let decoy = base.join("decoy.txt");
        std::fs::write(&decoy, b"secret").unwrap();

        let installer = WebInstaller::new(&root);
        let mf = manifest();
        let start = format!("../../{}", decoy.file_name().unwrap().to_string_lossy());
        let meta = format!(r#"{{"id":"{}","name":"Evil","start":"{start}"}}"#, mf.id);
        let bytes = gz_bundle(&[("amos-app.json", meta.as_bytes())]);

        let err = installer.install(&mf, &bytes).unwrap_err();
        assert!(
            err.to_string().contains("unsafe relative path"),
            "traversal start must be refused with a clear message: {err}"
        );
        // The out-of-dir decoy is untouched — nothing was read or written through
        // the traversal. (install() pre-creates the per-app dir before the final
        // validation, so that dir may exist empty; the escape itself is refused.)
        assert_eq!(std::fs::read(&decoy).unwrap(), b"secret");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_file_refuses_path_traversal_and_absolute_paths() {
        let root = std::env::temp_dir().join(format!("amos-webinst-rf-{}", std::process::id()));
        let installer = WebInstaller::new(&root);
        let mf = manifest();
        let bytes = gz_bundle(&[
            ("amos-app.json", &web_meta(&mf.id)),
            ("index.html", b"<html>hi</html>"),
            ("assets/app.js", b"x"),
        ]);
        let inst = installer.install(&mf, &bytes).unwrap();

        // Normal in-dir reads (including a subdirectory) still work.
        assert_eq!(
            read_file(&inst.dir, "index.html").unwrap(),
            b"<html>hi</html>"
        );
        assert!(read_file(&inst.dir, "assets/app.js").is_ok());
        // Anything that would escape `dir` is refused outright.
        assert!(read_file(&inst.dir, "..").is_err());
        assert!(read_file(&inst.dir, "../decoy.txt").is_err());
        assert!(
            read_file(&inst.dir, "/etc/hostname").is_err(),
            "absolute paths refused"
        );
        assert!(
            read_file(&inst.dir, "index.html\u{0}").is_err(),
            "NUL refused"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Build an in-memory `tar.gz` whose entries are regular files **plus** one
    /// link entry (the shape `gz_bundle` deliberately cannot produce).
    fn gz_bundle_with_link(link: &str, target: &str, hard: bool) -> Vec<u8> {
        let mf = manifest();
        let meta = web_meta(&mf.id);
        let html = b"<html>x</html>";
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut ar = tar::Builder::new(&mut gz);
            for (name, data) in [("amos-app.json", &meta[..]), ("index.html", &html[..])] {
                let mut h = tar::Header::new_gnu();
                h.set_entry_type(tar::EntryType::file());
                h.set_size(data.len() as u64);
                h.set_mode(0o644);
                h.set_cksum();
                ar.append_data(&mut h, name, data).unwrap();
            }
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(if hard {
                tar::EntryType::hard_link()
            } else {
                tar::EntryType::symlink()
            });
            h.set_size(0);
            h.set_mode(0o777);
            h.set_cksum();
            ar.append_link(&mut h, link, target).unwrap();
            ar.finish().unwrap();
        }
        gz.finish().unwrap()
    }

    #[test]
    fn refuses_a_bundle_that_carries_a_symlink() {
        // `tar::unpack` extracts a symlink entry verbatim, and every ordinary read
        // follows it — so a bundle could point `leak.txt` at any host file and have
        // the sandboxed webview served its contents through the asset host.
        let base =
            std::env::temp_dir().join(format!("amos-webinst-symlink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let root = base.join("install");
        let secret = base.join("secret.txt");
        std::fs::write(&secret, b"TOP-SECRET").unwrap();

        let mf = manifest();
        let bytes = gz_bundle_with_link("leak.txt", &secret.to_string_lossy(), false);

        let installer = WebInstaller::new(&root);
        let err = installer.install(&mf, &bytes).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("symlink") && msg.contains("leak.txt"),
            "the refusal must name the offending entry: {msg}"
        );
        // The out-of-dir file is untouched, and nothing was extracted.
        assert_eq!(std::fs::read(&secret).unwrap(), b"TOP-SECRET");
        assert!(!installer.dir_for(&mf.id).join("leak.txt").exists());
        assert!(
            !installer.dir_for(&mf.id).join("index.html").exists(),
            "a refused bundle must not be partially extracted"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn refuses_a_bundle_that_carries_a_hard_link() {
        let root = std::env::temp_dir().join(format!("amos-webinst-hard-{}", std::process::id()));
        let installer = WebInstaller::new(&root);
        let mf = manifest();
        let bytes = gz_bundle_with_link("hard.txt", "index.html", true);

        let err = installer.install(&mf, &bytes).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("hard link") && msg.contains("hard.txt"),
            "a hard link is refused the same way: {msg}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_symlinked_directory_cannot_be_written_through() {
        // Defence in depth behind `refuses_a_bundle_that_carries_a_symlink`: it was
        // *measured*, not assumed, that even reaching `unpack` with a symlinked
        // directory cannot write outside the destination (the crate refuses
        // "trying to unpack outside of destination path"). Pinned so a future tar
        // upgrade cannot quietly remove that second line of defence.
        let base = std::env::temp_dir().join(format!("amos-webinst-wt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let outside = base.join("outside");
        let dir = base.join("install");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&dir).unwrap();

        let mf = manifest();
        let meta = web_meta(&mf.id);
        let payload = b"PWNED";
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut ar = tar::Builder::new(&mut gz);
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(tar::EntryType::file());
            h.set_size(meta.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            ar.append_data(&mut h, "amos-app.json", &meta[..]).unwrap();
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(tar::EntryType::symlink());
            h.set_size(0);
            h.set_mode(0o777);
            h.set_cksum();
            ar.append_link(&mut h, "d", &outside).unwrap();
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(tar::EntryType::file());
            h.set_size(payload.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            ar.append_data(&mut h, "d/pwned.txt", &payload[..]).unwrap();
            ar.finish().unwrap();
        }
        let bytes = gz.finish().unwrap();

        let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(&bytes[..]));
        let _ = ar.unpack(&dir);
        assert!(
            !outside.join("pwned.txt").exists(),
            "no entry may be written outside the bundle dir"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_symlink_cannot_be_read_out_of_the_bundle() {
        // Install-time link rejection is the chokepoint; this pins the *read* layer
        // independently, so a symlink that arrived some other way (or a future code
        // path that populates the dir) still cannot leak a host file.
        let base =
            std::env::temp_dir().join(format!("amos-webinst-planted-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("install");
        let secret = base.join("secret.txt");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(&secret, b"TOP-SECRET").unwrap();

        let mf = manifest();
        let bytes = gz_bundle(&[
            ("amos-app.json", &web_meta(&mf.id)),
            ("index.html", b"<html>x</html>"),
        ]);
        let inst = WebInstaller::new(&root).install(&mf, &bytes).unwrap();
        std::os::unix::fs::symlink(&secret, inst.dir.join("leak.txt")).unwrap();

        assert!(
            read_file(&inst.dir, "leak.txt").is_err(),
            "read_file must not follow a symlink out of the bundle"
        );
        let uri = format!("{}://{}/leak.txt", crate::host::SCHEME, mf.id);
        assert!(
            crate::host::serve_bundle(&root, &uri).is_err(),
            "the request host must not follow it either"
        );
        // The honest path still works.
        assert_eq!(
            read_file(&inst.dir, "index.html").unwrap(),
            b"<html>x</html>"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A bundle directory written directly, so the meta can be any shape.
    fn meta_dir(tag: &str, meta: &str) -> std::path::PathBuf {
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "amos-bundlemeta-{tag}-{}-{seq}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("amos-app.json"), meta).unwrap();
        std::fs::write(dir.join("index.html"), b"<html></html>").unwrap();
        dir
    }

    #[test]
    fn the_declared_egress_is_read_and_validated() {
        let dir = meta_dir(
            "ok",
            r#"{"id":"org.amos.demo","name":"D","start":"index.html","allowed_domains":["api.example.com","cdn.example.org"]}"#,
        );
        let meta = read_bundle_meta(&dir).unwrap();
        assert_eq!(
            meta.allowed_domains,
            vec!["api.example.com", "cdn.example.org"]
        );

        // An omitted list is an empty list — "this app talks to nobody" — not a
        // parse error (a bundle that needs no network is the normal case).
        let dir = meta_dir(
            "none",
            r#"{"id":"org.amos.demo","name":"D","start":"index.html"}"#,
        );
        assert!(read_bundle_meta(&dir).unwrap().allowed_domains.is_empty());

        // A pattern the guard-matcher/WebView could never match is **refused**
        // rather than stored: a rule that silently does nothing is the defect this
        // grammar exists to prevent, and an unchecked one would be *granted* in
        // the CSP.
        for bad in [
            r#"{"id":"org.amos.demo","name":"D","start":"index.html","allowed_domains":["*.example.com"]}"#,
            r#"{"id":"org.amos.demo","name":"D","start":"index.html","allowed_domains":["example"]}"#,
            r#"{"id":"org.amos.demo","name":"D","start":"index.html","allowed_domains":["https://example.com"]}"#,
            r#"{"id":"org.amos.demo","name":"D","start":"index.html","allowed_domains":["Example.com"]}"#,
        ] {
            let dir = meta_dir("bad", bad);
            let err = read_bundle_meta(&dir).expect_err("a bad pattern is refused");
            assert!(err.to_string().contains("allowed domain"), "{bad}: {err}");
        }
    }
}

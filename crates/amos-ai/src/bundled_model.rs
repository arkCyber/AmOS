//! Bundled / user-installed GGUF model resolution (Gap 4, F-AI-016/017).
//!
//! The daemon used to default to the deterministic mock when `AMOS_BACKEND` was
//! unset, so a phone shipped with an engine that *looks* like AI but answers
//! with placeholders. This module is the single, testable resolution chain that
//! replaces that guesswork: if a real model is staged anywhere on the chain the
//! daemon serves a **real** `ggml` engine; if none is, it reports an explicit
//! `unconfigured` backend (see `inference::real::UnconfiguredBackend`) and
//! **never** silently falls back to the mock.
//!
//! Resolution order (`resolve_model_path`):
//!
//! 1. **`AMOS_MODEL_PATH`** — operator override (`AMOS_MODEL_PATH_ENV`);
//! 2. **Bundled assets** — `${AMOS_BUNDLE_ASSETS_DIR}/models/<file>`, then the
//!    fixed on-device roots in [`DEFAULT_BUNDLE_ASSET_DIRS`] (the AOSP image
//!    stages the model under `/data/amos` or `/system/share/amos`);
//! 3. **User-installed** — `$AMOS_USER_MODELS_DIR/<file>` or
//!    `~/.amos/models/<file>`.
//!
//! Every env value is bounded by [`MAX_MODEL_PATH_BYTES`] and validated before
//! it becomes a `PathBuf`; a blank or over-long value is ignored with a warning,
//! never truncated into a surprising path. The module never panics.

use std::path::PathBuf;

/// Env: operator override for the local model file (highest priority).
pub const AMOS_MODEL_PATH_ENV: &str = "AMOS_MODEL_PATH";
/// Env: root directory the AOSP image stages bundled assets under.
pub const BUNDLE_ASSETS_DIR_ENV: &str = "AMOS_BUNDLE_ASSETS_DIR";
/// Env: explicit user-installed model directory (overrides `~/.amos/models`).
pub const USER_MODELS_DIR_ENV: &str = "AMOS_USER_MODELS_DIR";

/// File name of the bundled chat model.
pub const BUNDLED_MODEL_FILENAME: &str = "qwen2.5-0.5b-q4_k_m.gguf";
/// Path of the bundled model relative to a bundle asset root.
pub const BUNDLED_MODEL_REL_PATH: &str = "models/qwen2.5-0.5b-q4_k_m.gguf";
/// The documented bundled-model location template (see
/// `docs/ai-model-bundling.md`). Kept as a string because `${BUNDLE_ASSETS_DIR}`
/// is substituted at image-build time, not by the daemon.
pub const BUNDLED_MODEL_PATH: &str = "${BUNDLE_ASSETS_DIR}/models/qwen2.5-0.5b-q4_k_m.gguf";

/// Fixed bundle asset roots tried when [`BUNDLE_ASSETS_DIR_ENV`] is unset.
pub const DEFAULT_BUNDLE_ASSET_DIRS: &[&str] =
    &["/data/amos", "/system/share/amos", "/system/etc/amos"];

/// Upper bound on any operator-supplied model path. An env value is untrusted
/// input at a seam; a real filesystem path is far below this.
pub const MAX_MODEL_PATH_BYTES: usize = 4096;

/// Validate + bound an operator-supplied model path string. `None` for blank or
/// over-cap input (never a silent truncation).
pub fn validate_model_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_MODEL_PATH_BYTES {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// Read a bounded env path, warning (and returning `None`) when the value is
/// present but blank/over-cap/non-Unicode so the operator sees *why* it was
/// ignored. A **blank** value is a real operator intent that this chain discards —
/// as audible as an over-cap one (F-AI-025) — so both are warned about here; only a
/// genuinely *unset* variable is silent.
fn env_path(key: &str) -> Option<PathBuf> {
    // `std::env::var` answers `Err` for *two* facts — `NotPresent` (genuinely unset,
    // the one silent case) and `NotUnicode` (set, but unreadable here). `.ok()?`
    // erased that difference, so a non-Unicode override was dropped as silently as an
    // unset one: the blank arm's defect, one input over (REQ-A1892 / F-AI-026).
    // `var_os` keeps both facts, and `user_candidates`' `HOME` read already uses it
    // for this reason.
    let raw = std::env::var_os(key)?;
    let Some(raw) = raw.to_str() else {
        tracing::warn!("env {key} is not valid Unicode; ignoring it");
        return None;
    };
    match validate_model_path(raw) {
        Some(p) => Some(p),
        None => {
            tracing::warn!(
                "env {key} is blank or exceeds {MAX_MODEL_PATH_BYTES} bytes; ignoring it"
            );
            None
        }
    }
}

/// The operator's `AMOS_MODEL_PATH` **verbatim** (bounded), whether or not it
/// exists. Used when the operator explicitly asked for `ggml`: a typo must
/// surface as an honest "model file not found", not a silent different model.
pub fn operator_env_path() -> Option<PathBuf> {
    env_path(AMOS_MODEL_PATH_ENV)
}

/// Bundle asset roots: the env override first (when set), then the fixed
/// on-device roots.
fn bundle_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = env_path(BUNDLE_ASSETS_DIR_ENV) {
        roots.push(root);
    }
    roots.extend(DEFAULT_BUNDLE_ASSET_DIRS.iter().map(PathBuf::from));
    roots
}

/// Candidate bundled model *file* paths, in order.
fn bundled_candidates() -> Vec<PathBuf> {
    bundle_roots()
        .into_iter()
        .map(|root| root.join(BUNDLED_MODEL_REL_PATH))
        .collect()
}

/// Candidate user-installed model *file* paths, in order.
fn user_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = env_path(USER_MODELS_DIR_ENV) {
        out.push(dir.join(BUNDLED_MODEL_FILENAME));
    }
    if let Some(home) = std::env::var_os("HOME") {
        out.push(
            PathBuf::from(home)
                .join(".amos")
                .join("models")
                .join(BUNDLED_MODEL_FILENAME),
        );
    }
    out
}

/// The primary bundled model path (first bundle root + the relative path), used
/// as the final fallback of [`bundled_model_resolver`]. May not exist.
fn primary_bundled_path() -> PathBuf {
    bundle_roots()
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from(DEFAULT_BUNDLE_ASSET_DIRS[0]))
        .join(BUNDLED_MODEL_REL_PATH)
}

/// Resolve a model file that **exists** on disk: `AMOS_MODEL_PATH` → bundled
/// asset roots → user-installed dirs. `None` means "no model is staged", which
/// the caller must surface as `unconfigured` — never as the mock.
pub fn resolve_model_path() -> Option<PathBuf> {
    if let Some(p) = operator_env_path() {
        if p.is_file() {
            return Some(p);
        }
        tracing::warn!(
            "AMOS_MODEL_PATH={} does not name a readable file; falling through the chain",
            p.display()
        );
    }
    if let Some(p) = bundled_candidates().into_iter().find(|p| p.is_file()) {
        return Some(p);
    }
    user_candidates().into_iter().find(|p| p.is_file())
}

/// The model path the daemon should hand to a local `ggml` engine: the operator
/// override first (returned even when missing, so a typo is reported as a missing
/// file), then any real bundled/user-installed model, and finally the primary
/// bundled template path when nothing at all is staged.
pub fn bundled_model_resolver() -> PathBuf {
    if let Some(p) = operator_env_path() {
        return p;
    }
    if let Some(p) = resolve_model_path() {
        return p;
    }
    primary_bundled_path()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    /// Counts WARN events, so an assertion is on the *observable* diagnostic rather
    /// than on a re-statement of the code (the module's own comment). Shared by the
    /// two silent-drop tests, which must both watch the same signal.
    struct WarnProbe(Arc<AtomicU64>);
    impl tracing::Subscriber for WarnProbe {
        fn enabled(&self, _m: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _s: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _id: &tracing::span::Id, _r: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _a: &tracing::span::Id, _b: &tracing::span::Id) {}
        fn event(&self, ev: &tracing::Event<'_>) {
            if ev.metadata().level() == &tracing::Level::WARN {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
        fn enter(&self, _id: &tracing::span::Id) {}
        fn exit(&self, _id: &tracing::span::Id) {}
    }

    /// Every env var the chain reads, so a test can wipe/restore all of them.
    const KEYS: &[&str] = &[
        AMOS_MODEL_PATH_ENV,
        BUNDLE_ASSETS_DIR_ENV,
        USER_MODELS_DIR_ENV,
        "HOME",
    ];

    struct EnvGuard(Vec<(&'static str, Option<String>)>);
    impl EnvGuard {
        fn wipe(keys: &[&'static str]) -> Self {
            let mut saved = Vec::with_capacity(keys.len());
            for k in keys {
                saved.push((*k, std::env::var(k).ok()));
                std::env::remove_var(k);
            }
            Self(saved)
        }
        fn set(&mut self, key: &'static str, value: &str) {
            std::env::set_var(key, value);
        }
        fn unset(key: &'static str) {
            std::env::remove_var(key);
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in self.0.drain(..) {
                match v {
                    Some(s) => std::env::set_var(k, s),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "amos-model-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Test 4.3-1: the operator override is returned first, even before any
    /// bundled root is consulted.
    #[test]
    #[serial_test::serial(model_env_lock)]
    fn bundled_model_resolver_with_env_override_returns_env_path_first() {
        let dir = temp_root("env-first");
        let model = dir.join("custom.gguf");
        std::fs::write(&model, b"stub gguf").unwrap();

        let mut env = EnvGuard::wipe(KEYS);
        env.set(AMOS_MODEL_PATH_ENV, model.to_str().unwrap());
        env.set(BUNDLE_ASSETS_DIR_ENV, dir.to_str().unwrap());

        assert_eq!(bundled_model_resolver(), model);
        assert_eq!(resolve_model_path().as_deref(), Some(model.as_path()));

        drop(env);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Test 4.3-2: with no override and no bundled model, the user-installed
    /// `~/.amos/models/<file>` is used.
    #[test]
    #[serial_test::serial(model_env_lock)]
    fn bundled_model_resolver_falls_back_to_user_installed_dir() {
        let home = temp_root("user-home");
        let models = home.join(".amos").join("models");
        std::fs::create_dir_all(&models).unwrap();
        let model = models.join(BUNDLED_MODEL_FILENAME);
        std::fs::write(&model, b"stub gguf").unwrap();

        let mut env = EnvGuard::wipe(KEYS);
        env.set("HOME", home.to_str().unwrap());
        // Point the bundle root at an empty dir so no bundled model exists.
        env.set(BUNDLE_ASSETS_DIR_ENV, home.join("empty").to_str().unwrap());

        assert_eq!(bundled_model_resolver(), model);
        assert_eq!(
            resolve_model_path().as_deref(),
            Some(model.as_path()),
            "the user-installed dir is the third link in the chain"
        );

        drop(env);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A bundled asset root carrying the model is preferred over the user dir.
    #[test]
    #[serial_test::serial(model_env_lock)]
    fn bundled_asset_root_beats_the_user_dir() {
        let root = temp_root("bundle-root");
        let bundled = root.join(BUNDLED_MODEL_REL_PATH);
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"stub gguf").unwrap();

        let home = temp_root("user-home-2");
        let user_models = home.join(".amos").join("models");
        std::fs::create_dir_all(&user_models).unwrap();
        std::fs::write(user_models.join(BUNDLED_MODEL_FILENAME), b"stub gguf").unwrap();

        let mut env = EnvGuard::wipe(KEYS);
        env.set("HOME", home.to_str().unwrap());
        env.set(BUNDLE_ASSETS_DIR_ENV, root.to_str().unwrap());

        assert_eq!(
            resolve_model_path().as_deref(),
            Some(bundled.as_path()),
            "the bundled asset root is the second link in the chain"
        );

        drop(env);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Negative control: nothing staged → `None` (the caller turns this into an
    /// honest `unconfigured`, never the mock), and a blank/over-cap override is
    /// ignored rather than becoming a bogus path.
    #[test]
    #[serial_test::serial(model_env_lock)]
    fn no_staged_model_resolves_to_none() {
        let empty = temp_root("nothing");
        let mut env = EnvGuard::wipe(KEYS);
        env.set(BUNDLE_ASSETS_DIR_ENV, empty.to_str().unwrap());
        env.set("HOME", empty.join("home").to_str().unwrap());

        assert_eq!(
            resolve_model_path(),
            None,
            "nothing staged is honestly None"
        );

        // Over-cap and blank overrides are ignored, not truncated.
        let huge = "a".repeat(MAX_MODEL_PATH_BYTES + 1);
        env.set(AMOS_MODEL_PATH_ENV, &huge);
        assert_eq!(validate_model_path(&huge), None);
        assert_eq!(operator_env_path(), None);
        EnvGuard::unset(AMOS_MODEL_PATH_ENV);
        env.set(AMOS_MODEL_PATH_ENV, "   ");
        assert_eq!(operator_env_path(), None);
        EnvGuard::unset(AMOS_MODEL_PATH_ENV);
        assert_eq!(resolve_model_path(), None);

        drop(env);
        let _ = std::fs::remove_dir_all(&empty);
    }

    /// A **blank** env override is a real operator intent that this chain drops,
    /// and the module contract (`//!`: "a blank or over-long value is ignored
    /// **with a warning**") is that the drop is *audible*. The pre-fix
    /// `if !raw.trim().is_empty()` guard suppressed exactly this case, so
    /// `AMOS_MODEL_PATH="  "` — an unexpanded shell variable, a stray space —
    /// fell silently through to whatever model was staged next, and the operator
    /// never learned their override was ignored (REQ-A1884 / F-AI-025).
    #[test]
    #[serial_test::serial(model_env_lock)]
    fn a_blank_env_override_is_reported_not_silently_dropped() {
        let mut env = EnvGuard::wipe(KEYS);
        // Positive control for the *value*: whitespace names no path.
        env.set(AMOS_MODEL_PATH_ENV, "   ");
        let warns = Arc::new(AtomicU64::new(0));
        {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            assert_eq!(operator_env_path(), None, "a blank override names no path");
        }
        assert_eq!(
            warns.load(Ordering::Relaxed),
            1,
            "a blank override must be reported; dropping it in silence is the F-AI-025 defect"
        );

        // Disjointness control: a genuinely *unset* variable is not operator
        // intent, so it must stay silent — an over-broad "warn whenever we return
        // None" fix would be the other defect.
        EnvGuard::unset(AMOS_MODEL_PATH_ENV);
        {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            assert_eq!(operator_env_path(), None);
        }
        assert_eq!(
            warns.load(Ordering::Relaxed),
            1,
            "an unset variable must not warn — only a present-but-blank one does"
        );
        drop(env);
    }

    /// The **sibling input** of the blank case above, and the same defect:
    /// `std::env::var` answers `Err` for *two* different facts — `NotPresent`
    /// (genuinely unset) and `NotUnicode` (the operator *did* set a value, one this
    /// chain cannot read) — and the `.ok()?` that reached `env_path` erased the
    /// difference, so a non-Unicode override fell through as silently as an unset
    /// one. The module contract is explicit that only a genuinely *unset* variable
    /// is silent, and a non-Unicode path is reachable on any Unix (an unexpanded
    /// shell variable, a file name in a non-UTF-8 locale). Fixing the blank arm
    /// while leaving this one is the same class of defect, one input over
    /// (REQ-A1892 / F-AI-026).
    #[cfg(unix)]
    #[test]
    #[serial_test::serial(model_env_lock)]
    fn a_non_unicode_env_override_is_reported_not_silently_dropped() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let env = EnvGuard::wipe(KEYS);
        // A present-but-not-UTF-8 value names no path this chain can use.
        std::env::set_var(AMOS_MODEL_PATH_ENV, OsStr::from_bytes(b"/tmp/\xff.gguf"));

        let warns = Arc::new(AtomicU64::new(0));
        {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            assert_eq!(
                operator_env_path(),
                None,
                "a non-Unicode override names no usable path"
            );
        }
        assert_eq!(
            warns.load(Ordering::Relaxed),
            1,
            "a present-but-non-Unicode override must be reported; dropping it as silently \
             as an unset variable is the F-AI-025 shape, one input over"
        );

        drop(env);
    }

    /// A missing override still names the operator's intent (an honest
    /// "model file not found" later) instead of silently picking another file.
    #[test]
    #[serial_test::serial(model_env_lock)]
    fn missing_override_is_returned_verbatim_as_intent() {
        let mut env = EnvGuard::wipe(KEYS);
        env.set(AMOS_MODEL_PATH_ENV, "/nonexistent/amos/model-407.gguf");
        assert_eq!(
            operator_env_path().as_deref(),
            Some(std::path::Path::new("/nonexistent/amos/model-407.gguf")),
            "the operator's path is echoed back so the failure is about *their* path"
        );
        assert_eq!(resolve_model_path(), None, "but it is not a usable model");

        drop(env);
    }
}

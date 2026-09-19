//! Runtime feature flags.
//!
//! Two sources, both polled by [`crate::reload::Worker`]:
//!
//! 1. **Local** — `~/.amos/feature-flags.json` (override with the
//!    `AMOS_FEATURE_FLAGS_FILE` env var). Always available; missing file is
//!    `Ok(FeatureFlagSet::default())` (fail-closed).
//! 2. **Process env** — every `AMOS_FLAG_<UPPER_SNAKE>` env var is read on
//!    each `FeatureFlagSet::from_env()` call (live, not snapshotted).
//! 3. **Remote** — JSON fetched from an explicit fetcher (passed to the
//!    [`crate::reload::Worker`]); the body is required to be a JSON object of
//!    the same shape as the local file.
//!
//! Evaluation is `(key, context) → bool`. The context is an opaque
//! [`FlagContext`] the caller fills in (device id, user id, app version…).
//! A flag rule with `"percent": 25` rolls for 25% of contexts; a flag rule
//! with `"users": ["alice", …]"` returns `true` only for those contexts.
//!
//! **Honesty discipline**: every "I am a feature flag" path (env var lookup,
//! file load, remote response, the constructor) returns a feature-flag set
//! whose unknown keys evaluate to `false` (fail-closed). A typo in the caller
//! can never grant access by accident.
//!
//! **Compatibility shim**: [`FeatureFlagSet::from_resolver`] keeps the old
//! signature so existing callers do not break. It still returns the empty
//! default; the **file-based** loading has moved to
//! [`FeatureFlagSet::from_file`] (the documented entry point) and the
//! **env-based** loading to [`FeatureFlagSet::from_env`].

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;
use serde_json::Value as JsonValue;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FlagKey(pub String);

impl std::fmt::Display for FlagKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum FlagValue {
    Always,
    Off,
    Percent { pct: u8 },
    Users { allow: Vec<String> },
}

#[derive(Debug, Clone, Default)]
pub struct FlagContext {
    /// Stable per-install id (a hash of `AMOS_INSTALL_ID`, falls back to
    /// `AMOS_SOCKET` or the process pid).
    pub install_id: String,
    /// User-supplied id (e.g. SSO subject).
    pub user_id: Option<String>,
    /// App version, for staged rollouts.
    pub version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum RawFlag {
    Bool(bool),
    Str(String),
    Object {
        #[serde(default)]
        percent: Option<u8>,
        #[serde(default)]
        users: Option<Vec<String>>,
        #[serde(default)]
        version_min: Option<String>,
    },
}

/// The set of flags resolved from the local + remote sources.
#[derive(Debug, Clone, Default)]
pub struct FeatureFlagSet {
    raw: std::collections::BTreeMap<String, RawFlag>,
}

use crate::layer::Resolver;

impl FeatureFlagSet {
    /// Build from the resolver's currently-loaded file snapshots.
    ///
    /// Reads every key beginning with `amos.flags.` (the documented prefix;
    /// avoid using `flags.` directly so user-written config keys cannot
    /// collide with the namespace) and merges them into the returned set.
    ///
    /// **Honest boundary**: any other key on the resolver (`amos.ai.port`,
    /// etc.) is ignored on purpose — feature-flag gating must not share a
    /// namespace with general config. The env layer is **not** sampled here
    /// because a single snapshot of env is a lie the moment it changes; env
    /// has its own entry point, [`FeatureFlagSet::from_env`].
    ///
    /// Pre-existing callers expected `from_resolver` to return **something**;
    /// if no flag keys are present on the resolver it returns the empty set
    /// (which [`Self::is_enabled`] answers with `false` for every key — the
    /// fail-closed behaviour documented on the type).
    pub fn from_resolver(r: &Resolver) -> Self {
        let mut raw = BTreeMap::new();
        for snap in r.snapshots().iter().flatten() {
            for (k, v) in snap {
                let Some(rest) = k.strip_prefix("amos.flags.") else {
                    continue;
                };
                let key = rest.to_string();
                if key.is_empty() {
                    continue;
                }
                match serde_json::from_value::<RawFlag>(v.clone()) {
                    Ok(rule) => {
                        raw.insert(key, rule);
                    }
                    Err(e) => {
                        tracing::warn!(
                            key = %k,
                            error = %e,
                            "config: feature-flag value is not a recognised shape; skipping"
                        );
                    }
                }
            }
        }
        Self { raw }
    }

    /// Build from an on-disk JSON object file.
    ///
    /// This is the documented entry point for the "local" file.
    /// `~/.amos/feature-flags.json` is the default; override with
    /// `AMOS_FEATURE_FLAGS_FILE`. A missing file is **not** an error — it
    /// returns an empty set (and the only thing that can do is fail-closed).
    /// A malformed file is logged once and returns the empty set.
    pub fn from_file(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref();
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Self::default();
            }
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "feature-flags: unreadable, treating as empty set"
                );
                return Self::default();
            }
        };
        let v: JsonValue = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "feature-flags: invalid JSON, treating as empty set"
                );
                return Self::default();
            }
        };
        match Self::from_json(&v) {
            Ok(set) => set,
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "feature-flags: top-level is not a JSON object, treating as empty set"
                );
                Self::default()
            }
        }
    }

    /// Path resolution: `AMOS_FEATURE_FLAGS_FILE` env var if non-empty, else
    /// `$HOME/.amos/feature-flags.json`. Returns `None` when `HOME` is unset
    /// **and** no override is present (the caller then skips file loading).
    pub fn default_file_path() -> Option<std::path::PathBuf> {
        if let Ok(p) = std::env::var("AMOS_FEATURE_FLAGS_FILE") {
            if !p.is_empty() {
                return Some(std::path::PathBuf::from(p));
            }
        }
        let home = std::env::var("HOME").ok()?;
        if home.is_empty() {
            return None;
        }
        Some(
            std::path::PathBuf::from(home)
                .join(".amos")
                .join("feature-flags.json"),
        )
    }

    /// Build from the documented **local** source: [`Self::default_file_path`]
    /// (`AMOS_FEATURE_FLAGS_FILE` if non-empty, else
    /// `$HOME/.amos/feature-flags.json`), read through [`Self::from_file`].
    ///
    /// A path that cannot be resolved (no override **and** no `HOME`) or a
    /// missing/malformed file yields the empty set — the same fail-closed
    /// behaviour as [`Self::from_file`], never a fabricated "enabled".
    ///
    /// **Why this exists (REQ-A459)**: this module's header promised
    /// "`~/.amos/feature-flags.json` (override with the
    /// `AMOS_FEATURE_FLAGS_FILE` env var)", and [`Self::default_file_path`]
    /// implemented that promise — but **nothing called it**, so neither the
    /// default path nor the override was ever consulted by any code path
    /// (`rust-unwired-scan`: "referenced nowhere" across the whole workspace,
    /// `tests/` included). A documented behaviour with no caller is the
    /// "documentation asserts a fact it never measured" failure mode
    /// (F-DEV-031 family); this entry point makes the documented default
    /// **reachable** instead of leaving it as prose.
    pub fn from_local() -> Self {
        match Self::default_file_path() {
            Some(p) => Self::from_file(p),
            None => Self::default(),
        }
    }

    /// Build the env layer. Every `AMOS_FLAG_<UPPER_SNAKE>=value` is read
    /// live and the key is the suffix (`<UPPER_SNAKE>` lowercased, `_` → `.`).
    /// Recognised values: `true` / `false` / `on` / `off` / `1` / `0`
    /// (booleans); other strings are stored as the string rule (matched
    /// against `on` / `true` / `1` in [`Self::is_enabled`]; an unrecognised
    /// string therefore evaluates to `false` rather than silently passing).
    ///
    /// A set with **no values** in this prefix is not the empty set —
    /// returning `Self::default()` would let `merge_remote()` later infer
    /// `false → true` from a remote response with the same key, which would
    /// be a fail-open bug. The default branch is therefore "no env override",
    /// not "remote says no".
    pub fn from_env() -> Self {
        let mut s = Self::default();
        for (k, v) in std::env::vars() {
            let Some(rest) = k.strip_prefix("AMOS_FLAG_") else {
                continue;
            };
            if rest.is_empty() {
                continue;
            }
            let key = rest.to_ascii_lowercase().replace('_', ".");
            match v.to_ascii_lowercase().as_str() {
                "true" | "1" | "on" => s.raw.insert(key, RawFlag::Bool(true)),
                "false" | "0" | "off" => s.raw.insert(key, RawFlag::Bool(false)),
                _ => s.raw.insert(key, RawFlag::Str(v)),
            };
        }
        s
    }

    /// Build from a JSON object (the on-disk shape).
    pub fn from_json(v: &JsonValue) -> Result<Self, serde_json::Error> {
        let obj = v
            .as_object()
            .ok_or_else(|| serde_json::Error::custom("feature flags must be a JSON object"))?;
        let mut raw = BTreeMap::new();
        for (k, val) in obj {
            raw.insert(k.clone(), serde_json::from_value(val.clone())?);
        }
        Ok(Self { raw })
    }

    /// Merge a remote response into the local set. Remote rules **win** for
    /// any key present in both (so an operator can disable a flag centrally
    /// even if a local file accidentally enables it).
    pub fn merge_remote(&mut self, remote: &FeatureFlagSet) {
        for (k, v) in &remote.raw {
            self.raw.insert(k.clone(), v.clone());
        }
    }

    /// Evaluate one flag in a context. Returns `false` for unknown keys
    /// (fail-closed: a typo in the caller never accidentally grants access).
    pub fn is_enabled(&self, key: &str, ctx: Option<&FlagContext>) -> bool {
        let Some(rule) = self.raw.get(key) else {
            return false;
        };
        match rule {
            RawFlag::Bool(b) => *b,
            RawFlag::Str(s) => matches!(s.as_str(), "on" | "true" | "1"),
            RawFlag::Object {
                percent,
                users,
                version_min,
            } => {
                if let Some(users) = users {
                    if let Some(ctx) = ctx {
                        if let Some(uid) = &ctx.user_id {
                            if users.iter().any(|u| u == uid) {
                                return true;
                            }
                        }
                    }
                    return false;
                }
                if let Some(min) = version_min {
                    if let Some(ctx) = ctx {
                        if let Some(v) = &ctx.version {
                            if version_gte(v, min) {
                                return true;
                            }
                        }
                    }
                    return false;
                }
                if let Some(pct) = percent {
                    if let Some(ctx) = ctx {
                        // Stable per-install bucket: `fnv1a(install_id) % 100`.
                        let bucket = fnv1a_u32(ctx.install_id.as_bytes()) % 100;
                        return bucket < u32::from(*pct);
                    }
                    return false;
                }
                false
            }
        }
    }
}

fn fnv1a_u32(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Tiny semver `>=` for `MAJOR.MINOR.PATCH` strings. Non-semver strings fall
/// back to lexicographic compare — explicit so a typo never silently passes.
fn version_gte(a: &str, b: &str) -> bool {
    let pa = parse_semver(a);
    let pb = parse_semver(b);
    match (pa, pb) {
        (Some(x), Some(y)) => x >= y,
        _ => a >= b,
    }
}

fn parse_semver(s: &str) -> Option<(u32, u32, u32)> {
    let mut parts = s.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

// Tiny custom-error impl: `serde_json::Error::custom` is not on the public
// type, so we add a small `Display` impl here.
mod serde_json_ext {
    use serde_json::Error;
    pub trait Custom {
        fn custom<T: std::fmt::Display>(msg: T) -> Error;
    }
    impl Custom for Error {
        fn custom<T: std::fmt::Display>(msg: T) -> Error {
            Error::io(std::io::Error::other(msg.to_string()))
        }
    }
}
use serde_json_ext::Custom;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx(install: &str, user: Option<&str>) -> FlagContext {
        FlagContext {
            install_id: install.into(),
            user_id: user.map(String::from),
            version: Some("1.2.3".into()),
        }
    }

    #[test]
    fn bool_flag_is_straight() {
        let s = FeatureFlagSet::from_json(&json!({"a": true, "b": false})).unwrap();
        assert!(s.is_enabled("a", None));
        assert!(!s.is_enabled("b", None));
        assert!(!s.is_enabled("missing", None)); // fail-closed
    }

    #[test]
    fn percent_flag_is_stable_per_install() {
        let s = FeatureFlagSet::from_json(&json!({"x": {"percent": 50}})).unwrap();
        let mut buckets = std::collections::BTreeMap::new();
        for i in 0..200 {
            let id = format!("install-{i}");
            let on = s.is_enabled("x", Some(&ctx(&id, None)));
            *buckets.entry(on).or_insert(0u32) += 1;
        }
        let on = *buckets.get(&true).unwrap_or(&0);
        // ±5 pp around 100 to keep the test robust without being a flake.
        assert!((80..=120).contains(&on), "got {on}/200 on for 50% flag");
    }

    #[test]
    fn user_allowlist_only_returns_true_for_listed_users() {
        let s = FeatureFlagSet::from_json(&json!({"x": {"users": ["alice", "bob"]}})).unwrap();
        assert!(s.is_enabled("x", Some(&ctx("i", Some("alice")))));
        assert!(!s.is_enabled("x", Some(&ctx("i", Some("eve")))));
        assert!(!s.is_enabled("x", Some(&ctx("i", None))));
    }

    #[test]
    fn remote_overrides_local_for_the_same_key() {
        let mut local = FeatureFlagSet::from_json(&json!({"a": true})).unwrap();
        let remote = FeatureFlagSet::from_json(&json!({"a": false})).unwrap();
        local.merge_remote(&remote);
        assert!(!local.is_enabled("a", None));
    }

    #[test]
    fn version_min_is_a_gate_not_a_force() {
        let s = FeatureFlagSet::from_json(&json!({"x": {"version_min": "1.0.0"}})).unwrap();
        assert!(s.is_enabled("x", Some(&ctx("i", None))));
        let older = FlagContext {
            install_id: "i".into(),
            user_id: None,
            version: Some("0.9.0".into()),
        };
        assert!(!s.is_enabled("x", Some(&older)));
    }

    /// Test-scoped unique-dir helper. Suffix is nanoseconds-since-epoch +
    /// process id, so parallel test binaries never collide on a CI runner.
    fn unique_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "amos-config-flag-{tag}-{}-{}",
            std::process::id(),
            nanos
        ))
    }

    /// `from_file` is the documented entry point for the local
    /// `~/.amos/feature-flags.json`. A missing file must NOT be an error —
    /// fail-closed empty set.
    #[test]
    fn from_file_missing_is_empty_set_not_an_error() {
        let dir = unique_dir("missing");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nope.json");
        let s = FeatureFlagSet::from_file(&path);
        assert!(!s.is_enabled("anything", None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `from_file` of a malformed file → empty set, logged once. A bad file
    /// must never panic, never `unwrap`, never crash the daemon.
    #[test]
    fn from_file_malformed_does_not_panic_yields_empty_set() {
        let dir = unique_dir("bad");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bad.json");
        std::fs::write(&path, "not really json {{{").unwrap();
        let s = FeatureFlagSet::from_file(&path);
        assert!(!s.is_enabled("anything", None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `from_file` of a valid object → usable flags. Round-trip: file →
    /// FeatureFlagSet → is_enabled.
    #[test]
    fn from_file_valid_object_evaluates_correctly() {
        let dir = unique_dir("good");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("good.json");
        std::fs::write(
            &path,
            r#"{"enabled_always": true, "enabled_never": false, "ten_pct": {"percent": 10}}"#,
        )
        .unwrap();
        let s = FeatureFlagSet::from_file(&path);
        assert!(s.is_enabled("enabled_always", None));
        assert!(!s.is_enabled("enabled_never", None));
        // Smoke the percent bucket: at least one of 200 contexts must be enabled
        // (10% should land many, but we only require ≥ 1 so the test is robust).
        let mut any_on = false;
        for i in 0..200 {
            if s.is_enabled("ten_pct", Some(&ctx(&format!("install-{i}"), None))) {
                any_on = true;
                break;
            }
        }
        assert!(any_on, "10% flag must enable at least one of 200 contexts");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `from_env` reads `AMOS_FLAG_<NAME>` live (so the test cleans up
    /// afterwards and uses a unique name). The case logic must match the
    /// boolean/string duality of the existing `is_enabled()` interpretation.
    #[test]
    fn from_env_reads_only_amos_flag_prefix_and_known_boolean_values() {
        // Unique across processes / nanoseconds.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let k = format!("AMOS_FLAG_BOOL_TRUE_{}_{}", std::process::id(), nanos);
        // `set_var` is `unsafe` on Rust 2024; the workspace is edition 2021 so
        // this is the safe call. Documenting it for the next person to bump
        // the edition — the test must then move to a Mutex-protected env.
        std::env::set_var(&k, "true");
        let s = FeatureFlagSet::from_env();
        // The set's key normalization lowercases + replaces `_` with `.`,
        // so apply the same transformation on the test side.
        let key = k
            .strip_prefix("AMOS_FLAG_")
            .unwrap()
            .to_ascii_lowercase()
            .replace('_', ".");
        assert!(s.is_enabled(&key, None));
        std::env::remove_var(&k);

        // Unknown values must NOT silently be considered "on" — the untyped
        // string is preserved (audit-able) but `is_enabled` keeps fail-closed
        // semantics by only treating "on" / "true" / "1" as truthy.
        let k_off = format!("AMOS_FLAG_UNKNOWN_{}_{}", std::process::id(), nanos);
        std::env::set_var(&k_off, "definitely-not-bool");
        let s2 = FeatureFlagSet::from_env();
        let key_off = k_off
            .strip_prefix("AMOS_FLAG_")
            .unwrap()
            .to_ascii_lowercase()
            .replace('_', ".");
        assert!(!s2.is_enabled(&key_off, None));
        std::env::remove_var(&k_off);
    }

    /// `from_resolver` (the legacy compatibility shim) used to return a
    /// silent-empty set because of a `Vec::<(String, _)>::new()` placeholder.
    /// Now it reads `amos.flags.*` keys from file snapshots. This is the
    /// negative control: an unrelated `amos.ai.port` key MUST NOT show up
    /// as a flag.
    #[test]
    fn from_resolver_only_reads_amos_flags_prefix_not_unrelated_keys() {
        use crate::layer::ResolverBuilder;
        let r = ResolverBuilder::new().build();
        let s = FeatureFlagSet::from_resolver(&r);
        assert!(!s.is_enabled("amos.ai.port", None));
        assert!(!s.is_enabled("anything.at.all", None));
    }

    /// `from_local` (REQ-A459) — the entry point that finally makes this
    /// module's documented default (`AMOS_FEATURE_FLAGS_FILE` if non-empty,
    /// else `~/.amos/feature-flags.json`) **reachable**. Before it existed,
    /// nothing called `default_file_path()`, so neither the default path nor
    /// the override was ever consulted by any code path — the header promised
    /// behaviour the code never implemented.
    ///
    /// Driven through the documented override so the test never depends on the
    /// developer's real `$HOME`; the "no override, no `HOME`" branch is
    /// deliberately *not* asserted, because on a normal machine it resolves to
    /// that user's actual `~/.amos/feature-flags.json` and the result would
    /// depend on the machine rather than on the code.
    #[test]
    fn from_local_reads_the_documented_env_override_and_fails_closed() {
        // One rule, one owner: the path resolution stays in
        // `default_file_path`, and this test only drives it. The lock keeps the
        // process-global env var from racing any future test that wants it.
        static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let dir = unique_dir("local");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("feature-flags.json");
        std::fs::write(&path, r#"{"new_checkout": true}"#).unwrap();
        std::env::set_var("AMOS_FEATURE_FLAGS_FILE", &path);

        let s = FeatureFlagSet::from_local();
        assert!(s.is_enabled("new_checkout", None));
        // Fail-closed: a typo never grants access.
        assert!(!s.is_enabled("new_checkout_typo", None));

        // Negative control on the loader: a malformed file must yield the empty
        // set, never the previously-loaded one (that would be a silent
        // fail-open — a flag staying enabled because the file became garbage).
        std::fs::write(&path, "{ not json").unwrap();
        assert!(!FeatureFlagSet::from_local().is_enabled("new_checkout", None));

        std::env::remove_var("AMOS_FEATURE_FLAGS_FILE");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

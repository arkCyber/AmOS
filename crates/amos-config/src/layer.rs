//! Configuration layers + the [`Resolver`] that merges them in priority order.
//!
//! The four layers, lowest → highest priority (later overrides earlier):
//!
//! 1. **System** — `/etc/amos/config.json` (Linux), `/Library/Application
//!    Support/amos/config.json` (macOS), or whatever `AMOS_CONFIG_SYSTEM`
//!    overrides.
//! 2. **User** — `~/.amos/config.json` (or `AMOS_CONFIG_USER` override).
//! 3. **Session** — process env vars (`AMOS_*`), the canonical one.
//! 4. **Remote** — JSON fetched from `AMOS_CONFIG_REMOTE` URL (feature
//!    `remote-flags`, default off).
//!
//! A [`Resolver`] keeps the four snapshots (one per layer) so an operator can
//! ask "why is this value what it is?" — `explain("amos.ai.port")` lists the
//! layers that contributed, in order, with their raw values.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value as JsonValue;

use crate::audit::{AuditEvent, AuditLogger};
use crate::schema::{Schema, SchemaError, Type};

/// A single resolved value: the JSON itself plus the [`Source`] it came from
/// (or `None` when the key was not present in any layer).
#[derive(Debug, Clone, PartialEq)]
pub struct Value {
    pub json: JsonValue,
    pub source: Source,
}

/// Where a value came from. `Missing` is its own state — never conflated with
/// `Default(value)`, because "no one set this" is operationally different from
/// "someone set it to the default".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Missing,
    SystemFile(PathBuf),
    UserFile(PathBuf),
    SessionEnv(String),
    Remote(String),
    Default(&'static str),
}

impl Source {
    /// Stable label for logs / wire (`get_status`).
    pub fn label(&self) -> &'static str {
        match self {
            Source::Missing => "missing",
            Source::SystemFile(_) => "system-file",
            Source::UserFile(_) => "user-file",
            Source::SessionEnv(_) => "session-env",
            Source::Remote(_) => "remote",
            Source::Default(_) => "default",
        }
    }
}

/// One layer in the merge stack.
#[derive(Debug, Clone)]
pub enum Layer {
    /// The system config file — loaded lazily; missing file is OK.
    SystemFile { path: PathBuf },
    /// The user config file — loaded lazily; missing file is OK.
    UserFile { path: PathBuf },
    /// Process env (`AMOS_*`); always available.
    Env,
    /// Optional remote endpoint polled by [`crate::reload`].
    Remote { url: String },
}

impl Layer {
    fn kind(&self) -> &'static str {
        match self {
            Layer::SystemFile { .. } => "system-file",
            Layer::UserFile { .. } => "user-file",
            Layer::Env => "session-env",
            Layer::Remote { .. } => "remote",
        }
    }
}

/// Build a [`Resolver`] with explicit layers (the four built-ins are
/// convenience constructors; `with_*` lets callers mix their own).
#[derive(Debug, Default)]
pub struct ResolverBuilder {
    layers: Vec<Layer>,
    schema: BTreeMap<String, Schema>,
    defaults: BTreeMap<String, JsonValue>,
    audit: Option<AuditLogger>,
}

impl ResolverBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a layer in the priority order: **later overrides earlier**.
    pub fn layer(mut self, l: Layer) -> Self {
        self.layers.push(l);
        self
    }

    /// Register a JSON-Schema constraint for a key. Resolved values that
    /// violate it are **refused** (the lookup returns `Err`) — so a malformed
    /// config cannot quietly change behaviour.
    pub fn schema(mut self, key: impl Into<String>, s: Schema) -> Self {
        self.schema.insert(key.into(), s);
        self
    }

    /// Default value applied when no layer has the key. The default is **never**
    /// validated against the schema — that's the caller's job to ensure the
    /// default matches the declared schema.
    pub fn with_default(mut self, key: impl Into<String>, v: JsonValue) -> Self {
        self.defaults.insert(key.into(), v);
        self
    }

    /// Write every change to an append-only audit log so an operator can
    /// reconstruct "what changed, when, from where".
    pub fn audit(mut self, a: AuditLogger) -> Self {
        self.audit = Some(a);
        self
    }

    pub fn build(self) -> Resolver {
        // Only file layers are snapshotted at build time. The Env layer is
        // sampled at lookup time (process env can change between calls) and
        // Remote is loaded by the reload worker. A snapshot that says "Env
        // = empty" is a lie the moment the process mutates its environment.
        let mut snapshots = Vec::with_capacity(self.layers.len());
        for l in &self.layers {
            snapshots.push(match l {
                Layer::SystemFile { path } | Layer::UserFile { path } => load_json_file(path),
                Layer::Env => Some(BTreeMap::new()), // placeholder; read live
                Layer::Remote { .. } => None,
            });
        }
        Resolver {
            layers: self.layers,
            schema: self.schema,
            defaults: self.defaults,
            audit: self.audit,
            snapshots,
        }
    }
}

/// Resolves keys across the configured layers.
#[derive(Debug, Clone)]
pub struct Resolver {
    layers: Vec<Layer>,
    schema: BTreeMap<String, Schema>,
    defaults: BTreeMap<String, JsonValue>,
    audit: Option<AuditLogger>,
    /// One snapshot per layer (in priority order). `Remote` layers with no URL
    /// are absent — the snapshot is `None`.
    snapshots: Vec<Option<BTreeMap<String, JsonValue>>>,
}

impl Resolver {
    /// Convenience: the canonical 4-layer resolver (system file → user file →
    /// env → remote). Equivalent to building it by hand with
    /// [`ResolverBuilder`]; provided because this is the shape every daemon
    /// and the System UI wants.
    pub fn standard() -> Self {
        ResolverBuilder::new()
            .layer(Layer::SystemFile {
                path: default_system_path(),
            })
            .layer(Layer::UserFile {
                path: default_user_path(),
            })
            .layer(Layer::Env)
            .build()
    }

    /// Re-read every file/env layer. Cheap on the env layer (it is sampled
    /// at call time), more expensive on files (re-parsed JSON). Call this
    /// from the polling worker, not from the hot path.
    ///
    /// **Honest boundary**: `Layer::Remote` slots are preserved across
    /// `refresh()` — the polling worker owns those snapshots (they came
    /// from a `RemoteFetcher`, not from disk). A `refresh()` that wiped
    /// them would *break* the "remote stays the highest-priority source"
    /// contract by reading the file's old value back every tick (the
    /// remote's value would only stick for as long as the next fetch
    /// interval).
    pub fn refresh(&mut self) {
        let new_snapshots = Self::load_all(&self.layers);
        for (i, slot) in self.snapshots.iter_mut().enumerate() {
            let Some(layer) = self.layers.get(i) else {
                continue;
            };
            if matches!(layer, Layer::Remote { .. }) {
                // Keep the prior Remote snapshot untouched.
                continue;
            }
            *slot = new_snapshots.get(i).cloned().flatten();
        }
    }

    fn load_all(layers: &[Layer]) -> Vec<Option<BTreeMap<String, JsonValue>>> {
        layers.iter().map(load_one).collect()
    }

    /// Look up `key` (e.g. `"amos.ai.port"`). Returns the JSON value and the
    /// [`Source`] it came from. Refuses values that violate the registered
    /// [`Schema`] (if any).
    pub fn get(&self, key: &str) -> Result<Option<Value>, SchemaError> {
        // Highest-priority layer first (last layer wins).
        for (i, snap) in self.snapshots.iter().enumerate().rev() {
            let layer = &self.layers[i];
            // The Env layer is sampled live: the snapshot is a placeholder;
            // we re-read on every lookup so a process-mutated env is reflected.
            let snap = match layer {
                Layer::Env => Some(load_env()),
                _ => snap.clone(),
            };
            let Some(snap) = snap else { continue };
            if let Some(v) = snap.get(key) {
                if let Some(s) = self.schema.get(key) {
                    s.validate(v).map_err(|e| SchemaError {
                        key: key.to_string(),
                        expected: s.ty.clone(),
                        message: e.to_string(),
                    })?;
                }
                let source = match layer {
                    Layer::SystemFile { path } => Source::SystemFile(path.clone()),
                    Layer::UserFile { path } => Source::UserFile(path.clone()),
                    Layer::Env => Source::SessionEnv(env_name_for(key).to_string()),
                    Layer::Remote { url } => Source::Remote(url.clone()),
                };
                return Ok(Some(Value {
                    json: v.clone(),
                    source,
                }));
            }
        }
        // Fall back to default.
        if let Some(v) = self.defaults.get(key) {
            return Ok(Some(Value {
                json: v.clone(),
                source: Source::Default("<registered default>"),
            }));
        }
        Ok(None)
    }

    /// Same as [`Self::get`], but converts the result to a typed value.
    pub fn get_typed<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
    ) -> Result<Option<T>, ConfigError> {
        match self.get(key)? {
            Some(v) => match serde_json::from_value(v.json) {
                Ok(t) => Ok(Some(t)),
                Err(e) => Err(ConfigError::Deserialize {
                    key: key.to_string(),
                    message: e.to_string(),
                }),
            },
            None => Ok(None),
        }
    }

    /// The feature flag set (lazy; computed from the same snapshots).
    pub fn feature_flags(&self) -> crate::feature_flag::FeatureFlagSet {
        crate::feature_flag::FeatureFlagSet::from_resolver(self)
    }

    /// Human-readable trace of which layers contributed to a key — the answer
    /// to "why is this value what it is?". Empty for keys that resolved to
    /// `None`.
    pub fn explain(&self, key: &str) -> String {
        let mut lines: Vec<String> = Vec::new();
        for (i, snap) in self.snapshots.iter().enumerate() {
            let l = &self.layers[i];
            let label = l.kind();
            let raw = match (snap, &self.layers[i]) {
                (Some(s), Layer::SystemFile { path }) => {
                    format!("{label} {}: {:?}", path.display(), s.get(key))
                }
                (Some(s), Layer::UserFile { path }) => {
                    format!("{label} {}: {:?}", path.display(), s.get(key))
                }
                (Some(_), Layer::Env) => {
                    format!(
                        "{label} {}: {:?}",
                        env_name_for(key),
                        std::env::var(env_name_for(key)).ok()
                    )
                }
                (Some(s), Layer::Remote { url }) => format!("{label} {url}: {:?}", s.get(key)),
                (None, _) => format!("{label}: <unavailable>"),
            };
            lines.push(raw);
        }
        if let Some(d) = self.defaults.get(key) {
            lines.push(format!("default: {d:?}"));
        }
        lines.join("\n")
    }

    /// Record an audit event (if an audit log is attached).
    pub fn record_audit(&self, ev: AuditEvent) {
        if let Some(a) = &self.audit {
            a.append(ev);
        }
    }

    /// Layers registered on this resolver (for diagnostics / `--explain` CLI).
    pub fn layers(&self) -> &[Layer] {
        &self.layers
    }

    /// Per-layer snapshots (read-only). Used by the hot-reload worker to
    /// audit-log changes; exposed for tests too.
    pub fn snapshots(&self) -> &[Option<BTreeMap<String, JsonValue>>] {
        &self.snapshots
    }

    /// Find the index of the last `Layer::Remote` (the highest-priority
    /// remote; commonly the only one). Returns `None` if no remote layer is
    /// configured. The hot-reload worker uses this to know **where** to push
    /// the fetched body.
    pub fn remote_layer_index(&self) -> Option<usize> {
        self.layers
            .iter()
            .rposition(|l| matches!(l, Layer::Remote { .. }))
    }

    /// **Restricted** writer: set the snapshot of the layer at `index`.
    ///
    /// This is the path the hot-reload worker uses to push remote-fetched
    /// values into the resolver. It refuses to overwrite `SystemFile` /
    /// `UserFile` / `Env` slots because the worker has no business replacing
    /// file contents (those are read from disk by `refresh()`) — only the
    /// `Remote` slot is the intended target.
    ///
    /// Returns [`SnapshotError::IndexOutOfRange`] if `index >=
    /// self.layers.len()` and [`SnapshotError::LayerNotRemote`] if the slot
    /// is anything other than `Layer::Remote`. The caller is expected to
    /// behave `Result`-wise and not panic (P0-1).
    pub fn set_layer_snapshot(
        &mut self,
        index: usize,
        snap: BTreeMap<String, JsonValue>,
    ) -> Result<(), SnapshotError> {
        let Some(layer) = self.layers.get(index) else {
            return Err(SnapshotError::IndexOutOfRange);
        };
        if !matches!(layer, Layer::Remote { .. }) {
            return Err(SnapshotError::LayerNotRemote);
        }
        let Some(slot) = self.snapshots.get_mut(index) else {
            return Err(SnapshotError::IndexOutOfRange);
        };
        *slot = Some(snap);
        Ok(())
    }
}

/// Errors surfaced by [`Resolver::set_layer_snapshot`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SnapshotError {
    #[error("layer index is out of range")]
    IndexOutOfRange,
    #[error(
        "layer at this index is not a Remote layer; only Remote slots can be written by the worker"
    )]
    LayerNotRemote,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum ConfigError {
    #[error("schema validation failed for `{key}` (expected {expected:?}): {message}")]
    Schema {
        key: String,
        expected: Type,
        message: String,
    },
    #[error("value at `{key}` could not be deserialized: {message}")]
    Deserialize { key: String, message: String },
}

impl From<SchemaError> for ConfigError {
    fn from(s: SchemaError) -> Self {
        ConfigError::Schema {
            key: s.key,
            expected: s.expected,
            message: s.message,
        }
    }
}

// --- per-layer loading -------------------------------------------------------

fn load_one(layer: &Layer) -> Option<BTreeMap<String, JsonValue>> {
    match layer {
        Layer::SystemFile { path } | Layer::UserFile { path } => load_json_file(path),
        Layer::Env => Some(load_env()),
        Layer::Remote { .. } => None, // loaded by reload worker, not at startup
    }
}

/// Load a JSON file into a flat key→value map. A missing or unreadable file
/// is **not** an error: it is the "this layer is absent" case, which is the
/// documented behaviour for users who have not customised the file.
fn load_json_file(path: &Path) -> Option<BTreeMap<String, JsonValue>> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "config: unreadable, treating as absent");
            return None;
        }
    };
    match serde_json::from_str::<JsonValue>(&text) {
        Ok(JsonValue::Object(map)) => {
            // Flatten one level of nesting: `{"amos": {"ai": {"port": 8080}}}` →
            // `{"amos.ai.port": 8080}`. Operators write either form; the
            // resolver answers both. **One** level of flattening is enough —
            // the schemas this project ships do not nest deeper.
            let mut flat = BTreeMap::new();
            for (k, v) in map {
                if let JsonValue::Object(inner) = v {
                    for (k2, v2) in inner {
                        flat.insert(format!("{k}.{k2}"), v2);
                    }
                } else {
                    flat.insert(k, v);
                }
            }
            Some(flat)
        }
        Ok(other) => {
            tracing::warn!(path = %path.display(), got = %other, "config: top-level is not an object, treating as absent");
            None
        }
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "config: invalid JSON, treating as absent");
            None
        }
    }
}

/// Walk `AMOS_*` env vars and normalise the name (`AMOS_AI_PORT` →
/// `amos.ai.port`) so both spellings resolve to the same key.
fn load_env() -> BTreeMap<String, JsonValue> {
    let mut out = BTreeMap::new();
    for (k, v) in std::env::vars() {
        if !k.starts_with("AMOS_") {
            continue;
        }
        let key = env_key_to_config_key(&k);
        if let Ok(j) = coerce_env_to_json(&v) {
            out.insert(key, j);
        } else {
            out.insert(key, JsonValue::String(v));
        }
    }
    out
}

/// `AMOS_AI_PORT` → `amos.ai.port`. `_` separates segments, so
/// `AMOS_FOO_BAR` is `amos.foo.bar`. A key that is **already** a config key
/// (`amos.ai.port`, the shape the hot-reload worker feeds in from a remote
/// payload) passes through lowercased.
///
/// The `amos.` namespace is **implicit in the env name** — `AMOS_` is the env
/// spelling of the leading `amos.` — so for a key whose segments contain no `_`
/// the pair [`env_name_for`] / [`env_key_to_config_key`] round-trips. It is a
/// **normalisation, not a bijection**: `AMOS_FLAGS_NEW_CHECKOUT` and
/// `amos.flags.new_checkout` both normalise to `amos.flags.new.checkout`, and
/// nothing can tell them apart.
///
/// **REQ-A459 (a measured defect, found by running `examples/layered_resolve.rs`)**:
/// this function used to **strip** `AMOS_` and return `ai.port`, while its own
/// doc said the prefix was "kept". The env layer therefore stored `ai.port`
/// while every lookup (and every `with_default`, and `Resolver::explain`) uses
/// the documented `amos.ai.port` ⇒ **the env layer could never answer a
/// documented key**, so an operator's `AMOS_AI_PORT=9090` was silently ignored
/// (the `explain()` line even read `AMOS_AMOS_AI_PORT`, because `env_name_for`
/// prepended a second prefix). The doc's own `AMOS_FOO__BAR` example was wrong
/// the same way: it produced `foo..bar`.
pub fn env_key_to_config_key(k: &str) -> String {
    if let Some(body) = k.strip_prefix("AMOS_") {
        let mut out = String::with_capacity(body.len() + 5);
        out.push_str("amos.");
        out.push_str(&body.to_ascii_lowercase().replace('_', "."));
        out
    } else {
        // Already a config key (or not an `AMOS_*` name at all): lowercase and
        // pass through, so the normalization is idempotent.
        k.to_ascii_lowercase()
    }
}

/// Public re-export so the hot-reload worker can normalise keys without
/// going through a `Resolver`. Same shape as [`env_key_to_config_key`].
pub fn env_key_to_config_key_pub(k: &str) -> String {
    env_key_to_config_key(k)
}

/// The env name of a config key: `amos.ai.port` → `AMOS_AI_PORT`.
///
/// `.` becomes `_` and the result is uppercased; a leading `amos.` is **not**
/// part of the path but the env namespace, so it is replaced by `AMOS_` rather
/// than doubled. Before REQ-A459 the key the docs and every caller use,
/// `amos.ai.port`, produced `AMOS_AMOS_AI_PORT` — a name nothing ever sets, so
/// `Resolver::explain` reported `None` for a variable that *was* set.
pub fn env_name_for(config_key: &str) -> String {
    let upper: String = config_key
        .chars()
        .map(|c| if c == '.' { '_' } else { c })
        .collect::<String>()
        .to_ascii_uppercase();
    match upper.strip_prefix("AMOS_") {
        Some(rest) => format!("AMOS_{rest}"),
        None => format!("AMOS_{upper}"),
    }
}

// NOTE (audit, REQ-A459): there is deliberately **no** `env_name_for_pub`
// here. It existed as a "public re-export so a caller can invert the mapping",
// but the only code that needs the inversion (the env layer itself — `load_env`
// and `explain`) lives in this module and uses the private `env_name_for`.
// `rust-unwired-scan` reported it "referenced nowhere" across the whole
// workspace including `tests/`, so it was **deleted** rather than baselined:
// keeping it would advertise a direction (config key → env name) for which no
// host exists. The opposite direction (`env_key_to_config_key_pub`) stays — the
// reload worker really does call it. If a host ever needs this direction, add
// it back **together with that caller**.

/// Public re-export of an RFC 3339 formatter used by the audit logger.
pub fn now_rfc3339_pub() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let nanos = dur.subsec_nanos();
    // Cheap civil-from-days (Hinnant) without dragging in chrono.
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400) as u32;
    let hour = secs_of_day / 3600;
    let min = (secs_of_day % 3600) / 60;
    let sec = secs_of_day % 60;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:09}Z",
        y, m, d, hour, min, sec, nanos
    )
}

/// A small set of typed env-var coercions: `true`/`false` → bool, numeric →
/// number. Anything else is a string. This is what the rest of the workspace
/// already does (`env_bool`/`env_int`); the resolver's job is to do it once
/// and answer the same value to every caller.
fn coerce_env_to_json(v: &str) -> Result<JsonValue, ()> {
    match v.to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" | "1" => return Ok(JsonValue::Bool(true)),
        "false" | "no" | "off" | "0" => return Ok(JsonValue::Bool(false)),
        _ => {}
    }
    if let Ok(n) = v.parse::<i64>() {
        return Ok(JsonValue::Number(n.into()));
    }
    if let Ok(n) = v.parse::<f64>() {
        if let Some(j) = serde_json::Number::from_f64(n) {
            return Ok(JsonValue::Number(j));
        }
    }
    Err(())
}

// --- default paths -----------------------------------------------------------

/// `/etc/amos/config.json` on Linux, `/Library/Application Support/amos/config.json`
/// on macOS, `%ProgramData%\amos\config.json` on Windows. Override with
/// `AMOS_CONFIG_SYSTEM`.
pub fn default_system_path() -> PathBuf {
    if let Ok(p) = std::env::var("AMOS_CONFIG_SYSTEM") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    #[cfg(target_os = "linux")]
    return PathBuf::from("/etc/amos/config.json");
    #[cfg(target_os = "macos")]
    return PathBuf::from("/Library/Application Support/amos/config.json");
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
        return PathBuf::from(base).join("amos").join("config.json");
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    PathBuf::from("/etc/amos/config.json")
}

/// `~/.amos/config.json` (or `AMOS_CONFIG_USER` override). `$HOME` unset or
/// empty ⇒ no user file (the user layer is simply absent).
pub fn default_user_path() -> PathBuf {
    if let Ok(p) = std::env::var("AMOS_CONFIG_USER") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home).join(".amos").join("config.json");
        }
    }
    PathBuf::from(".amos/config.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{Schema, Type};

    /// The env name and the config key are **inverses** on `amos.*` keys.
    ///
    /// REQ-A459: this test used to assert `AMOS_AI_PORT → "ai.port"`, i.e. it
    /// **pinned the defect** — the env layer stored `ai.port` while every
    /// caller (and `with_default`, and `explain`) uses `amos.ai.port`, so the
    /// env layer could never answer a documented key. It was rewritten
    /// together with the function, not around it.
    #[test]
    fn the_env_name_and_the_config_key_are_inverses() {
        // Forward: env name → config key (the `amos.` namespace is implicit in
        // the `AMOS_` spelling).
        assert_eq!(env_key_to_config_key("AMOS_AI_PORT"), "amos.ai.port");
        assert_eq!(env_key_to_config_key("AMOS_AI_MODEL"), "amos.ai.model");
        // Idempotent on something that is already a config key — the shape the
        // hot-reload worker feeds in from a remote payload.
        assert_eq!(env_key_to_config_key("amos.ai.port"), "amos.ai.port");
        // Unchanged for a name outside the namespace.
        assert_eq!(env_key_to_config_key("PATH"), "path");

        // Backward: config key → env name.
        assert_eq!(env_name_for("amos.ai.port"), "AMOS_AI_PORT");
        assert_eq!(env_name_for("amos.ai.model"), "AMOS_AI_MODEL");
        // A key already outside the namespace agrees with the same env name:
        // `ai.port` and `amos.ai.port` name the same variable (which is why the
        // namespace can be implicit).
        assert_eq!(env_name_for("ai.port"), "AMOS_AI_PORT");

        // The property that makes the pair usable: for keys whose segments
        // contain no `_`, the round trip is the identity. (It cannot be the
        // identity in general — `AMOS_FLAGS_NEW_CHECKOUT` is
        // `amos.flags.new.checkout` under the dot rule, and nothing can tell
        // that apart from a key deliberately named `amos.flags.new_checkout`.
        // The normalisation is therefore a **normalisation**, not a bijection;
        // that ambiguity is a documented boundary, not a bug to "fix".)
        for key in ["amos.ai.port", "amos.hotcorners", "amos.config.system"] {
            assert_eq!(
                env_key_to_config_key(&env_name_for(key)),
                key,
                "round trip must be the identity for `{key}`"
            );
        }
        // …and the underscore case, stated explicitly so the boundary is
        // pinned rather than discovered.
        assert_eq!(
            env_key_to_config_key(&env_name_for("amos.flags.new_checkout")),
            "amos.flags.new.checkout"
        );

        // A double underscore is just "two underscores" — this project's env
        // naming is flat (`AMOS_AI_PORT`, not `AMOS_AI__PORT`), and the doc's
        // old `AMOS_FOO__BAR → amos.foo.bar` example was simply wrong.
        assert_eq!(env_key_to_config_key("AMOS_AI__MODEL"), "amos.ai..model");
    }

    /// The measurement that found the defect above: an operator's documented
    /// override must actually reach the documented key. Before REQ-A459 this
    /// read back the **default** (`AMOS_AI_PORT=9090` was silently ignored).
    #[test]
    fn the_env_layer_answers_the_documented_key() {
        let env_name = env_name_for("amos.test.port");
        std::env::remove_var(&env_name); // start clean
        let r = ResolverBuilder::new()
            .layer(Layer::Env)
            .with_default("amos.test.port", JsonValue::from(8080))
            .build();

        // No override ⇒ the registered default.
        let v = r.get("amos.test.port").unwrap().unwrap();
        assert_eq!(v.json, JsonValue::from(8080));

        // The override the docs promise to honour.
        std::env::set_var(&env_name, "9090");
        let v = r.get("amos.test.port").unwrap().unwrap();
        assert_eq!(v.json, JsonValue::from(9090));
        assert_eq!(v.source.label(), "session-env");
        // …and `explain` names the variable that was actually set, not a
        // doubled `AMOS_AMOS_…` name that nothing could have set.
        let text = r.explain("amos.test.port");
        assert!(text.contains(&env_name), "explain said: {text}");
        assert!(
            !text.contains("AMOS_AMOS_"),
            "explain must not invent a doubled prefix: {text}"
        );

        std::env::remove_var(&env_name);
    }

    #[test]
    fn coerce_env_to_json_handles_bool_int_float_string() {
        assert_eq!(coerce_env_to_json("true").unwrap(), JsonValue::Bool(true));
        assert_eq!(coerce_env_to_json("OFF").unwrap(), JsonValue::Bool(false));
        assert_eq!(coerce_env_to_json("8080").unwrap(), JsonValue::from(8080));
        assert_eq!(coerce_env_to_json("3.5").unwrap(), JsonValue::from(3.5));
        assert!(coerce_env_to_json("hi").is_err());
    }

    #[test]
    fn get_returns_first_layered_match_then_default_then_none() {
        let r = ResolverBuilder::new()
            .layer(Layer::Env)
            .with_default("amos.ai.port", JsonValue::from(8080))
            .build();
        // No env set, no user file ⇒ default.
        let v = r.get("amos.ai.port").unwrap().unwrap();
        assert_eq!(v.json, JsonValue::from(8080));
        assert_eq!(v.source.label(), "default");
        // Truly missing key.
        assert!(r.get("amos.ai.does_not_exist").unwrap().is_none());
    }

    #[test]
    fn schema_violation_is_refused_not_silently_passthroughs() {
        // The key we use here is round-trip-stable through
        // `env_name_for` and `env_key_to_config_key` — which requires the
        // documented `amos.` namespace (REQ-A459: the prefix-less
        // `config.test.port` is *not* stable, because the env layer stores
        // `amos.config.test.port` for `AMOS_CONFIG_TEST_PORT`).
        let key = "amos.config.test.port";
        let env_name = env_name_for(key);
        std::env::remove_var(&env_name); // start clean

        let s = Schema {
            ty: Type::Integer,
            minimum: Some(0.0),
            maximum: Some(65535.0),
            enum_values: None,
        };
        // A registered default is the caller's responsibility to match the
        // schema; we deliberately do not re-validate it here so a default
        // can be the schema-defining truth.
        let r = ResolverBuilder::new()
            .layer(Layer::Env)
            .schema(key, s)
            .build();
        // No env set ⇒ lookup returns Ok(None).
        assert!(r.get(key).unwrap().is_none());

        // A value that **does** match the schema still passes.
        std::env::set_var(&env_name, "8080");
        let v = r.get(key).unwrap().unwrap();
        assert_eq!(v.json, JsonValue::from(8080));

        // A value that violates the schema is refused with `Err`.
        std::env::set_var(&env_name, "70000");
        let err = r.get(key).unwrap_err();
        assert!(format!("{err}").contains(key));
        // Also refuse values outside the integer type — a string under
        // `Type::Integer` is NOT coerced (the validator is strict).
        std::env::set_var(&env_name, "not-a-number");
        let err = r.get(key).unwrap_err();
        assert!(format!("{err}").contains(key));
        std::env::remove_var(&env_name);
    }

    #[test]
    fn explain_lists_every_layer_in_priority_order() {
        let r = ResolverBuilder::new()
            .layer(Layer::SystemFile {
                path: PathBuf::from("/etc/amos/config.json"),
            })
            .layer(Layer::Env)
            .build();
        let text = r.explain("amos.ai.port");
        // Order is system-file → env, with env taking priority.
        assert!(text.starts_with("system-file"));
        assert!(text.contains("session-env"));
    }

    #[test]
    fn missing_file_is_layer_absent_not_an_error() {
        let r = ResolverBuilder::new()
            .layer(Layer::SystemFile {
                path: PathBuf::from("/definitely/not/here.json"),
            })
            .build();
        assert!(r.get("amos.ai.port").unwrap().is_none());
        // And explain() does not panic.
        assert!(!r.explain("amos.ai.port").is_empty());
    }

    /// `get_typed` (REQ-A459) — the typed read path had **no caller anywhere in
    /// the workspace**, so `rust-unwired-scan` reported it as a documented
    /// capability nobody exercised. Pinned here with all three outcomes: a
    /// typed hit, an absent key (`Ok(None)` — absence is not an error, and must
    /// never become a fabricated default), and a value that cannot be
    /// deserialized into `T` (`Err` naming the key, so the caller learns which
    /// key lied instead of silently getting `0`).
    #[test]
    fn get_typed_reads_a_typed_hit_and_refuses_a_type_mismatch() {
        let r = ResolverBuilder::new()
            .with_default("amos.test.limit", JsonValue::from(7))
            .with_default("amos.test.name", JsonValue::from("books"))
            .build();
        let n: Option<u32> = r.get_typed("amos.test.limit").unwrap();
        assert_eq!(n, Some(7));
        let missing: Option<u32> = r.get_typed("amos.test.nope").unwrap();
        assert_eq!(missing, None);
        let err = r.get_typed::<u32>("amos.test.name").unwrap_err();
        assert!(format!("{err}").contains("amos.test.name"));
    }

    /// `Resolver::feature_flags()` (REQ-A459) — the resolver→flag-set
    /// composition had no caller either. The assertion that matters here is the
    /// **negative control**: only `amos.flags.*` becomes a flag, so an unrelated
    /// config key set to `true` can never be turned into a gate by accident.
    #[test]
    fn feature_flags_reads_only_the_amos_flags_prefix_from_remote_snapshots() {
        let mut r = ResolverBuilder::new()
            .layer(Layer::Remote {
                url: "https://config.example/v1".into(),
            })
            .build();
        let mut snap = BTreeMap::new();
        snap.insert("amos.flags.new_checkout".to_string(), JsonValue::Bool(true));
        snap.insert("amos.ai.port".to_string(), JsonValue::Bool(true));
        let idx = r
            .remote_layer_index()
            .expect("the single Remote layer is at index 0");
        r.set_layer_snapshot(idx, snap).unwrap();

        let flags = r.feature_flags();
        assert!(flags.is_enabled("new_checkout", None));
        // Negative control: an unrelated key — even one set to `true` — is not a
        // flag, under either spelling.
        assert!(!flags.is_enabled("amos.ai.port", None));
        assert!(!flags.is_enabled("ai.port", None));
    }
}

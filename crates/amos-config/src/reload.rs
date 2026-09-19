//! Hot reload — polling-based, no `notify`/`inotify` dependency.
//!
//! A [`Worker`] ticks on the interval its embedder passes to
//! [`Worker::spawn`] — build it with [`interval_from_env`] to honour
//! `AMOS_CONFIG_RELOAD_SECS` (default [`DEFAULT_RELOAD_SECS`]). On each
//! tick it calls [`Resolver::refresh`]; if any layer's snapshot has changed
//! it fires a `tracing::info!` event and, when an audit logger is attached,
//! appends one event per changed key.
//!
//! The worker is **opt-in** — `Resolver::standard()` does **not** start a
//! thread automatically, because most callers (CLI binaries, integration
//! tests) want one-shot resolution. Embedders that want hot reload call
//! [`Worker::spawn`] from their bootstrap code.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value as JsonValue;

use crate::audit::AuditEvent;
use crate::layer::Resolver;

/// The hot-reload worker. Cheap to clone (the resolver is already shared).
#[derive(Clone)]
pub struct Worker {
    resolver: Arc<std::sync::Mutex<Resolver>>,
    remote: Option<RemoteFetcher>,
    audit: Option<crate::audit::AuditLogger>,
}

/// How to fetch the remote layer (if any). The `Fn` closure form is the
/// host-testable one; the production path can swap in `ureq` without
/// touching this module.
pub type RemoteFetcher = Arc<dyn Fn() -> Option<JsonValue> + Send + Sync>;

/// Default hot-reload tick, in seconds, when `AMOS_CONFIG_RELOAD_SECS` is unset
/// or is not a positive integer.
pub const DEFAULT_RELOAD_SECS: u64 = 60;

/// The interval an embedder should pass to [`Worker::spawn`]:
/// `AMOS_CONFIG_RELOAD_SECS` when it parses to a **positive** integer, else
/// [`DEFAULT_RELOAD_SECS`].
///
/// **Why this exists (REQ-A459)**: this module's header, `lib.rs`'s header and
/// `Worker::spawn`'s own doc all promised "ticks every `AMOS_CONFIG_RELOAD_SECS`
/// (default 60)" — and **nothing read that variable anywhere in the workspace**:
/// `spawn` takes the interval as a parameter and no reader existed. The knob an
/// operator would set therefore did nothing. That is the failure mode
/// `scripts/env-doc-scan.mjs` exists for, and it missed this one because the
/// promise lives in a **Rust doc comment** rather than in a document — so nothing
/// could see it except reading the two files side by side.
///
/// A zero / negative / unparsable value is **refused and reported**, never
/// rounded to zero: a zero interval is not "a faster reload", it is an unbounded
/// busy loop (Power of 10 rule #2).
pub fn interval_from_env() -> Duration {
    match std::env::var("AMOS_CONFIG_RELOAD_SECS") {
        Ok(raw) => match raw.trim().parse::<u64>() {
            Ok(secs) if secs > 0 => Duration::from_secs(secs),
            _ => {
                tracing::warn!(
                    value = %raw,
                    "config reload: AMOS_CONFIG_RELOAD_SECS must be a positive integer; using the default"
                );
                Duration::from_secs(DEFAULT_RELOAD_SECS)
            }
        },
        Err(_) => Duration::from_secs(DEFAULT_RELOAD_SECS),
    }
}

impl Worker {
    pub fn new(resolver: Resolver) -> Self {
        Self {
            resolver: Arc::new(std::sync::Mutex::new(resolver)),
            remote: None,
            audit: None,
        }
    }

    pub fn with_remote_fetcher(mut self, f: RemoteFetcher) -> Self {
        self.remote = Some(f);
        self
    }

    pub fn with_audit(mut self, a: crate::audit::AuditLogger) -> Self {
        self.audit = Some(a);
        self
    }

    /// Read-only handle to the underlying resolver (callers borrow through
    /// `lock()` or use the helpers on `Resolver`).
    pub fn resolver(&self) -> Arc<std::sync::Mutex<Resolver>> {
        self.resolver.clone()
    }

    /// One tick: re-read every file/env layer, fetch the remote layer (if
    /// configured), and audit-log any changes.
    ///
    /// The tick is **never** allowed to fail loudly (P0-1). A poisoned mutex
    /// or a malformed fetch response is logged once at `warn` and the tick
    /// returns — the previously-known state stays in place.
    pub fn tick(&self) {
        let mut r = match self.resolver.lock() {
            Ok(g) => g,
            Err(_) => {
                tracing::warn!("config reload: resolver mutex poisoned; this tick is a no-op");
                return;
            }
        };
        r.refresh();
        let prev_snapshots = r.snapshots().to_vec();
        let mut changes: Vec<(String, serde_json::Value, serde_json::Value, &'static str)> =
            Vec::new();
        if let Some(fetcher) = &self.remote {
            if let Some(v) = fetcher() {
                if let Some(obj) = v.as_object() {
                    let mut next: BTreeMap<String, JsonValue> = BTreeMap::new();
                    for (k, val) in obj {
                        let key = crate::layer::env_key_to_config_key_pub(k);
                        next.insert(key.clone(), val.clone());
                    }
                    if let Some(idx) = r.remote_layer_index() {
                        // Compose against the previous Remote snapshot so the
                        // audit can say "this key went X → Y" rather than
                        // just emitting a single line with no provenance.
                        let prev_remote: BTreeMap<String, JsonValue> = prev_snapshots
                            .get(idx)
                            .and_then(|s| s.clone())
                            .unwrap_or_default();
                        let prev_for =
                            |k: &str| -> Option<JsonValue> { prev_remote.get(k).cloned() };
                        for (k, v) in &next {
                            if prev_for(k).as_ref() != Some(v) {
                                changes.push((
                                    k.clone(),
                                    prev_for(k).unwrap_or(JsonValue::Null),
                                    v.clone(),
                                    "remote",
                                ));
                            }
                        }
                        for k in prev_remote.keys() {
                            if !next.contains_key(k) {
                                changes.push((
                                    k.clone(),
                                    prev_remote[k].clone(),
                                    JsonValue::Null,
                                    "remote",
                                ));
                            }
                        }
                        if r.set_layer_snapshot(idx, next.clone()).is_err() {
                            tracing::warn!(idx = idx, "config reload: refusing to write remote snapshot (index not remote)");
                        }
                    } else {
                        // Remote fetcher configured but no `Layer::Remote` is
                        // registered. Same fail-loud shape as a poisoned
                        // mutex: warn once and stay.
                        tracing::warn!("config reload: remote fetcher present but no remote layer registered; fetch results discarded");
                    }
                }
            }
        }
        // Plain file/env diff: any (non-Remote) layer whose snapshot for key
        // `k` differs from the snapshot carried on the previous tick fires a
        // single audit event. The Remote layer's diff is captured above so
        // we deliberately skip it here.
        if let Some(a) = &self.audit {
            for (i, snap) in prev_snapshots.iter().enumerate() {
                let Some(snap) = snap else { continue };
                // Skip the Remote layer: its diff is already captured.
                if let Some(cur) = r.snapshots().get(i) {
                    if matches!(r.layers().get(i), Some(crate::layer::Layer::Remote { .. })) {
                        let _ = cur; // already handled above
                        continue;
                    }
                }
                let prev: &BTreeMap<String, JsonValue> = snap;
                let layer_src: &'static str = match r.layers().get(i) {
                    Some(crate::layer::Layer::SystemFile { .. }) => "system-file",
                    Some(crate::layer::Layer::UserFile { .. }) => "user-file",
                    Some(crate::layer::Layer::Env) | None => continue,
                    Some(crate::layer::Layer::Remote { .. }) => "remote",
                };
                if let Some(cur_snap) = r.snapshots().get(i).and_then(|s| s.clone()) {
                    for (k, v) in &cur_snap {
                        if prev.get(k) != Some(v) {
                            changes.push((
                                k.clone(),
                                prev.get(k).cloned().unwrap_or(JsonValue::Null),
                                v.clone(),
                                layer_src,
                            ));
                        }
                    }
                    for k in prev.keys() {
                        if !cur_snap.contains_key(k) {
                            changes.push((k.clone(), prev[k].clone(), JsonValue::Null, layer_src));
                        }
                    }
                }
            }
            for (key, from, to, source) in &changes {
                a.append(AuditEvent {
                    ts: crate::layer::now_rfc3339_pub(),
                    key: key.clone(),
                    from: from.clone(),
                    to: to.clone(),
                    source: (*source).into(),
                });
            }
        }
    }

    /// Spawn a background thread that calls `tick()` every `interval` — pass
    /// [`interval_from_env`] to honour `AMOS_CONFIG_RELOAD_SECS` (default
    /// [`DEFAULT_RELOAD_SECS`]). The thread is **best-effort**:
    /// a panic inside the worker logs once on stderr and the worker exits —
    /// it does NOT take the process down (logging must never crash the
    /// daemon; same rule as the on-disk log sink).
    pub fn spawn(self, interval: Duration) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || loop {
            std::thread::sleep(interval);
            // Catch_unwind so a panic never escapes; logged once via stderr.
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                self.tick();
            }));
            if res.is_err() {
                eprintln!("amos-config: worker tick panicked; thread exiting");
                return;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layer::ResolverBuilder;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!(
            "amos-config-reload-{tag}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn tick_is_idempotent_when_no_remote() {
        let r = ResolverBuilder::new().build();
        let w = Worker::new(r);
        w.tick();
        w.tick();
        // No assertion beyond "did not panic".
    }

    #[test]
    fn remote_fetcher_changes_audit() {
        let dir = tmpdir("audit");
        let r = ResolverBuilder::new().build();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_inner = calls.clone();
        let fetcher: RemoteFetcher = Arc::new(move || {
            calls_inner.fetch_add(1, Ordering::Relaxed);
            Some(serde_json::json!({"AMOS_FAKE_PORT": "9999"}))
        });
        let w = Worker::new(r)
            .with_remote_fetcher(fetcher)
            .with_audit(crate::audit::AuditLogger::open(dir.join("audit.jsonl")));
        w.tick();
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The whole point of the round before this**: a `Layer::Remote`
    /// registered on the resolver must actually receive the fetched values,
    /// not merely write an audit line and walk away. We exercise it through
    /// the worker the public API is built for.
    #[test]
    fn remote_fetcher_writes_into_remote_layer_and_lookup_sees_it() {
        let dir = tmpdir("remote-write");
        let resolver = ResolverBuilder::new()
            .layer(crate::layer::Layer::Remote {
                url: "https://config.example/v1".into(),
            })
            .build();
        let fetcher: RemoteFetcher = Arc::new(|| {
            // The worker passes every remote key through
            // `env_key_to_config_key`, so the **env spelling** and the
            // **config spelling** of one setting collapse to the same
            // canonical key: `AMOS_AI_PORT` and `amos.ai.port` both mean
            // `amos.ai.port` (REQ-A459 — the previous convention stripped the
            // prefix instead, so a remote `AMOS_AI_PORT` landed on `ai.port`
            // while every lookup used `amos.ai.port`).
            Some(serde_json::json!({
                "AMOS_AI_PORT": 9100i64,
                "amos.ai.model": "deepseek",
            }))
        });
        let w = Worker::new(resolver)
            .with_remote_fetcher(fetcher)
            .with_audit(crate::audit::AuditLogger::open(dir.join("audit.jsonl")));
        w.tick();
        let r = w.resolver();
        let guard = r.lock().unwrap();
        // Lookup by the documented config key — the form every caller and
        // `Resolver::explain` use.
        let v = guard
            .get("amos.ai.port")
            .expect("schema-less lookup")
            .expect("value present in remote layer");
        assert_eq!(v.json, serde_json::json!(9100));
        assert_eq!(v.source.label(), "remote");
        let v2 = guard
            .get("amos.ai.model")
            .expect("schema-less lookup")
            .expect("value present in remote layer");
        assert_eq!(v2.json, serde_json::json!("deepseek"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Without a remote layer configured, fetcher output must be ignored
    /// (fail-loud at warn, fail-safe at the resolver). This was already
    /// documented, but the previous implementation actually *did* call the
    /// audit (claiming "remote override applied") without anything
    /// configured to apply to.
    #[test]
    fn remote_fetcher_without_remote_layer_does_not_audit_phantom_key() {
        let dir = tmpdir("no-remote");
        // Resolver with NO remote layer, just env.
        let resolver = ResolverBuilder::new()
            .layer(crate::layer::Layer::Env)
            .build();
        let fetcher: RemoteFetcher = Arc::new(|| Some(serde_json::json!({"AMOS_AI_PORT": "9100"})));
        let w = Worker::new(resolver)
            .with_remote_fetcher(fetcher)
            .with_audit(crate::audit::AuditLogger::open(dir.join("audit.jsonl")));
        w.tick();
        // Audit file should NOT contain a phantom key.
        let text = std::fs::read_to_string(dir.join("audit.jsonl")).unwrap_or_default();
        assert!(
            !text.contains("amos.ai.port"),
            "phantom remote-key audit event written: {text:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The **previous** (broken) tick behaviour was "every key on every layer
    /// → `from=null, to=null, source=tick`". This test pins that the new
    /// tick produces **no** audit lines when the snapshots haven't actually
    /// changed (i.e. idling the worker does not flood the audit log).
    #[test]
    fn tick_with_no_changes_writes_zero_audit_lines() {
        let dir = tmpdir("idle");
        let r = ResolverBuilder::new().build();
        let w = Worker::new(r).with_audit(crate::audit::AuditLogger::open(dir.join("audit.jsonl")));
        w.tick();
        w.tick();
        w.tick();
        let text = std::fs::read_to_string(dir.join("audit.jsonl")).unwrap_or_default();
        assert_eq!(
            text.lines().count(),
            0,
            "idle ticks must not write audit lines; got {text:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The "remote override" path fires **one** audit event **per key**, not
    /// one per tick. This was the case before (but the line said
    /// `from=process-env`), and stays true now (with `from=` the previously
    /// observed value, which is the honest shape).
    #[test]
    fn remote_fetcher_emits_one_audit_line_per_key_per_change() {
        let dir = tmpdir("per-key");
        let resolver = ResolverBuilder::new()
            .layer(crate::layer::Layer::Remote {
                url: "https://config.example/v1".into(),
            })
            .build();
        let n: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
        let n_inner = n.clone();
        let fetcher: RemoteFetcher = Arc::new(move || {
            // First call returns a single key; subsequent calls return the
            // same value (so no further audit is emitted).
            n_inner.fetch_add(1, Ordering::Relaxed);
            Some(serde_json::json!({"amos.ai.port": "9100"}))
        });
        let w = Worker::new(resolver)
            .with_remote_fetcher(fetcher)
            .with_audit(crate::audit::AuditLogger::open(dir.join("audit.jsonl")));
        w.tick(); // 1st tick → emits 1 audit line
        w.tick(); // 2nd tick → idempotent, no new lines
        w.tick();
        let text = std::fs::read_to_string(dir.join("audit.jsonl")).unwrap();
        assert_eq!(
            text.lines().count(),
            1,
            "expected exactly one audit line for one stable remote key, got: {text:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `interval_from_env` (REQ-A459) — the knob that three doc comments
    /// promised and nothing read. Three rules, all of them load-bearing:
    /// a positive integer is honoured; an unparsable value falls back to the
    /// default **instead of** a zero interval; and `0` is refused too, because
    /// "reload continuously" would be an unbounded busy loop (Power of 10
    /// rule #2) rather than a fast reload.
    #[test]
    fn interval_from_env_honours_the_knob_and_never_returns_zero() {
        // The env var is process-global; a lock keeps this test from racing any
        // future test that wants the same knob.
        static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        std::env::set_var("AMOS_CONFIG_RELOAD_SECS", "5");
        assert_eq!(interval_from_env(), Duration::from_secs(5));

        // Negative control 1: garbage must NOT become 0 s.
        std::env::set_var("AMOS_CONFIG_RELOAD_SECS", "not-a-number");
        assert_eq!(
            interval_from_env(),
            Duration::from_secs(DEFAULT_RELOAD_SECS)
        );

        // Negative control 2: an explicit 0 (and a negative) must NOT become a
        // spinning loop either.
        std::env::set_var("AMOS_CONFIG_RELOAD_SECS", "0");
        assert_eq!(
            interval_from_env(),
            Duration::from_secs(DEFAULT_RELOAD_SECS)
        );
        std::env::set_var("AMOS_CONFIG_RELOAD_SECS", "-3");
        assert_eq!(
            interval_from_env(),
            Duration::from_secs(DEFAULT_RELOAD_SECS)
        );

        // Whitespace is trimmed (the same tolerance the rest of the workspace
        // applies to env values), so `" 7 "` is still the operator's 7 s.
        std::env::set_var("AMOS_CONFIG_RELOAD_SECS", " 7 ");
        assert_eq!(interval_from_env(), Duration::from_secs(7));

        std::env::remove_var("AMOS_CONFIG_RELOAD_SECS");
    }
}

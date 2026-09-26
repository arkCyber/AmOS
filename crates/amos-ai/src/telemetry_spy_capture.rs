//! `telemetry-spy-audit`-feature only — the **daemon-side capture producer**.
//!
//! Opens a data interface via `amos-telemetry-spy`'s `audit` pnet seam and
//! forwards every decoded+scanned [`EgressMatch`] onto the *same* shared
//! [`TelemetrySpySvc`] that `serve()` mounts, so a real device hit reaches the
//! System UI's `Watch` stream (docs/telemetry-spy.md §“daemon 侧 feed seam”).
//!
//! Honest gates (no-fake-success, mirrors the crate's rules):
//! * This module only compiles under `--features telemetry-spy-audit` (pnet +
//!   tokio); the default build stays pure-`std` and quiet.
//! * The producer starts **only** when BOTH an interface ([`ENV_IFACE`]) and at
//!   least one watch identifier ([`ENV_IDS`]) are configured. Scanning with an
//!   empty watch-list would “run” yet never fire — a fabricated audit — so that
//!   is refused with a logged warning.
//! * Opening a raw datalink channel needs a rooted / AmOS-AOSP slot; missing
//!   interface or privilege fails explicitly at start (never a silent empty
//!   stream). Compiling is **not** proof the device gate works — running it is a
//!   device bring-up step.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use amos_telemetry_spy::capture::{spawn_stream, CaptureCfg};
use amos_telemetry_spy::identifier::Identifier;
use amos_telemetry_spy::identity::StaticIdentity;
use amos_telemetry_spy::DeviceIdentity;
use anyhow::Context;

use crate::telemetry_spy_service::TelemetrySpySvc;

/// Env var naming the data interface to sniff (e.g. `rmnet_data0` on device,
/// `en0` on a macOS host demo). Absent → no capture (quiet by default).
pub const ENV_IFACE: &str = "AMOS_SPY_IFACE";
/// Env switch for IPv4 network-layer capture (for L3 `rmnet`-style interfaces).
pub const ENV_LAYER3: &str = "AMOS_SPY_LAYER3";
/// Env var carrying the comma-separated `kind=value` identifiers to watch for
/// (kinds `serial` | `imei` | `cell_id` / `cellid`). Must be non-empty for the
/// producer to start.
pub const ENV_IDS: &str = "AMOS_SPY_IDS";

/// A resolved, validated capture plan ready to open the interface.
pub struct CapturePlan {
    pub iface: String,
    /// IPv4 network-layer capture (`true` for `rmnet`-style L3 interfaces).
    pub layer3: bool,
    /// The concrete device-bound identifiers to scan outbound payloads for.
    pub ids: Vec<Identifier>,
}

/// The tokens a bool flag accepts as **true** / **false** — the same two sets
/// `energy::parse_flag` documents as the repo-wide convention.
const TRUE_TOKENS: [&str; 4] = ["1", "true", "yes", "on"];
const FALSE_TOKENS: [&str; 4] = ["0", "false", "no", "off"];

/// Parse a bool env flag **strictly**: `true` for a truthy token, `false` for a
/// falsy one, and `false` **with a `warn!`** for a value present but outside
/// both sets (a typo, a blank-but-set value, a non-Unicode one). Only a
/// genuinely *unset* variable is silent — the documented default.
///
/// The warning is the point for a flag like [`ENV_LAYER3`], which does not
/// merely gate capture: it selects IPv4 network-layer framing for an `rmnet`
/// interface. Reading a mistyped value as a bare `false` does not leave the
/// capture off, it silently frames it at L2 — so an operator who wrote
/// `AMOS_SPY_LAYER3=enable` gets a stream that misses exactly the packets they
/// asked for, with nothing said. (REQ-A1903 / F-AI-027.)
fn env_flag(key: &str) -> bool {
    let Some(raw) = std::env::var_os(key) else {
        return false; // unset = the documented default, quiet
    };
    let Some(raw) = raw.to_str() else {
        tracing::warn!(
            key,
            "{key} is set but not valid Unicode; treating it as false"
        );
        return false;
    };
    let token = raw.trim().to_ascii_lowercase();
    if TRUE_TOKENS.contains(&token.as_str()) {
        return true;
    }
    if FALSE_TOKENS.contains(&token.as_str()) {
        return false;
    }
    tracing::warn!(
        key,
        value = %raw,
        "{key} is set to a value this flag does not recognise — treating it as false \
         (expected 1/true/yes/on or 0/false/no/off)"
    );
    false
}

/// Parse an `AMOS_SPY_IDS` value (`kind=value,kind=value`) into watch
/// identifiers. Empty / unset / blank yields an empty vec (never an error).
pub fn env_identifiers(raw: Option<String>) -> anyhow::Result<Vec<Identifier>> {
    let raw = match raw {
        Some(r) if !r.trim().is_empty() => r,
        _ => return Ok(Vec::new()),
    };
    let mut pairs: Vec<(&str, String)> = Vec::new();
    for tok in raw.split(',') {
        let tok = tok.trim();
        if tok.is_empty() {
            continue;
        }
        let (kind, value) = tok
            .split_once('=')
            .with_context(|| format!("{ENV_IDS} entry must be `kind=value`: `{tok}`"))?;
        pairs.push((kind.trim(), value.trim().to_string()));
    }
    if pairs.is_empty() {
        return Ok(Vec::new());
    }
    // StaticIdentity::parse validates the kind keys and rejects empty values.
    Ok(StaticIdentity::parse(&pairs)
        .map_err(|e| anyhow::anyhow!("bad {ENV_IDS}: {e}"))?
        .identifiers())
}

/// Pure decision logic (kept separate so it is unit-testable without the daemon
/// runtime): return `None` when the producer should stay quiet.
pub fn plan_from_env_values(
    iface: Option<String>,
    layer3: bool,
    ids_raw: Option<String>,
) -> anyhow::Result<Option<CapturePlan>> {
    let iface = match iface {
        Some(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => return Ok(None), // no interface configured → quiet
    };
    let ids = env_identifiers(ids_raw)?;
    if ids.is_empty() {
        // no-fake: an empty watch-list would run yet never audit.
        tracing::warn!(
            "{ENV_IFACE}={iface} is set but {ENV_IDS} has no watch identifiers; \
             telemetry-spy capture NOT started (would never audit)"
        );
        return Ok(None);
    }
    Ok(Some(CapturePlan { iface, layer3, ids }))
}

/// Resolve a capture plan from the current process environment.
pub fn plan_from_env() -> anyhow::Result<Option<CapturePlan>> {
    plan_from_env_values(
        std::env::var(ENV_IFACE).ok(),
        env_flag(ENV_LAYER3),
        std::env::var(ENV_IDS).ok(),
    )
}

/// Open `plan`'s interface and pump every `EgressMatch` into the shared service's
/// `Watch` fan-out. Returns the handle of the pump task (the blocking pnet loop
/// lives on its own `spawn_blocking` task inside [`spawn_stream`]). Must be called
/// from within a Tokio runtime. Fails synchronously if the interface cannot be
/// opened (no fabricated success).
fn open_and_pump(
    svc: TelemetrySpySvc,
    plan: CapturePlan,
    stop: Arc<AtomicBool>,
) -> anyhow::Result<tokio::task::JoinHandle<()>> {
    let mut cfg = CaptureCfg::new(plan.iface.as_str())?;
    if plan.layer3 {
        cfg = cfg.layer3_ipv4();
    }
    let mut rx = spawn_stream(cfg, stop, plan.ids)?;
    Ok(tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            svc.ingest_match(&m);
        }
    }))
}

/// Start the on-device capture producer if the environment configures one;
/// otherwise stay quiet. Returns the pump handle, or `None` when not configured
/// / refused (each refusal is logged — never a silent fake success).
pub fn spawn_configured(
    svc: TelemetrySpySvc,
    stop: Arc<AtomicBool>,
) -> Option<tokio::task::JoinHandle<()>> {
    match plan_from_env() {
        Ok(Some(plan)) => {
            let iface = plan.iface.clone();
            match open_and_pump(svc, plan, stop) {
                Ok(handle) => {
                    tracing::info!(
                        "telemetry-spy capture started on {iface} \
                         (feed -> TelemetrySpySvc Watch stream)"
                    );
                    Some(handle)
                }
                Err(e) => {
                    tracing::warn!("telemetry-spy capture failed to start on {iface}: {e:#}");
                    None
                }
            }
        }
        Ok(None) => {
            tracing::debug!("telemetry-spy capture not configured (quiet)");
            None
        }
        Err(e) => {
            tracing::warn!("telemetry-spy capture config error: {e:#}");
            None
        }
    }
}

/// Best-effort halt for the blocking pnet loop (call on shutdown). The pump task
/// itself is aborted by the caller; this flag is what actually stops the pnet
/// receiver's `spawn_blocking` task.
pub fn stop_request(stop: &AtomicBool) {
    stop.store(true, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_telemetry_spy::identifier::IdentifierKind;

    fn kinds(plan: Option<&CapturePlan>) -> Vec<IdentifierKind> {
        plan.map(|p| p.ids.iter().map(|i| i.kind).collect())
            .unwrap_or_default()
    }

    #[test]
    fn no_iface_means_quiet() {
        let p = plan_from_env_values(None, false, Some("imei=490154203237518".into())).unwrap();
        assert!(p.is_none());
    }

    #[test]
    fn ids_required_to_start() {
        // Interface present but no identifiers → refused (would never audit).
        let p = plan_from_env_values(Some("rmnet_data0".into()), false, None).unwrap();
        assert!(p.is_none());
        let p = plan_from_env_values(Some("rmnet_data0".into()), false, Some("  ".into())).unwrap();
        assert!(p.is_none());
    }

    #[test]
    fn parses_kind_value_ids() {
        let raw = Some("imei=490154203237518, serial=SN-ABC, CELLID=42".into());
        let p = plan_from_env_values(Some("rmnet_data0".into()), false, raw)
            .unwrap()
            .expect("configured plan");
        assert_eq!(p.iface, "rmnet_data0");
        assert!(!p.layer3);
        let ks = kinds(Some(&p));
        assert!(ks.contains(&IdentifierKind::Imei));
        assert!(ks.contains(&IdentifierKind::Serial));
        assert!(ks.contains(&IdentifierKind::CellId));
    }

    #[test]
    fn layer3_flag_surfaces() {
        let p = plan_from_env_values(
            Some("rmnet_data0".into()),
            true,
            Some("imei=000000000000000".into()),
        )
        .unwrap()
        .expect("configured plan");
        assert!(p.layer3);
    }

    #[test]
    fn rejects_malformed_entry() {
        let raw = Some("imei".into()); // no '='
        assert!(plan_from_env_values(Some("en0".into()), false, raw).is_err());
        let raw = Some("bogus=123".into()); // unknown kind
        assert!(plan_from_env_values(Some("en0".into()), false, raw).is_err());
    }

    /// Counts WARN events so the assertion is on the *observable* diagnostic, not
    /// on a re-statement of the code. Deliberately a third copy of the same
    /// test-only probe (`bundled_model::tests`, `notifier_sink::tests`) instead of
    /// one shared `#[cfg(test)]` home: a shared helper would have to compile with
    /// **every** feature combination the three modules are gated by, and the
    /// combinations where a module is absent would make it dead code — which
    /// `-D warnings` refuses (the CI gate compiles a different target set than a
    /// local `cargo test`, see F-DEV-155).
    struct WarnProbe(std::sync::Arc<std::sync::atomic::AtomicU64>);
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
                self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
        fn enter(&self, _id: &tracing::span::Id) {}
        fn exit(&self, _id: &tracing::span::Id) {}
    }

    /// Count the WARN events `f` emits on this thread.
    fn warns_during(f: impl FnOnce()) -> u64 {
        let warns = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            f();
        }
        warns.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Set `AMOS_SPY_LAYER3` for the duration of one test and restore it after.
    struct Layer3Env(Option<String>);
    impl Layer3Env {
        fn set(value: Option<&str>) -> Self {
            let prev = std::env::var(ENV_LAYER3).ok();
            match value {
                Some(v) => std::env::set_var(ENV_LAYER3, v),
                None => std::env::remove_var(ENV_LAYER3),
            }
            Self(prev)
        }
    }
    impl Drop for Layer3Env {
        fn drop(&mut self) {
            match &self.0 {
                Some(v) => std::env::set_var(ENV_LAYER3, v),
                None => std::env::remove_var(ENV_LAYER3),
            }
        }
    }

    /// This flag is not an on/off gate — it selects **IPv4 network-layer framing**
    /// for an `rmnet`-style L3 interface, so reading a mistyped value as `false`
    /// does not merely leave the capture off: it silently frames the capture at
    /// L2 instead, and an operator who wrote `AMOS_SPY_LAYER3=enable` gets a
    /// stream that misses exactly the packets they asked for. The reader used
    /// `std::env::var(..).ok()` + a truthy `matches!`, which collapsed "unset",
    /// "explicitly off" and "a value I do not understand" into the same silent
    /// `false`; only an unset variable (the documented L2 default) and the
    /// documented off spellings are quiet now (REQ-A1903 / F-AI-027).
    #[test]
    #[serial_test::serial(spy_env_lock)]
    fn an_unrecognised_layer3_value_is_reported_not_silently_read_as_l2() {
        for val in ["enable", "2", "l3", " " /* blank-but-set */] {
            let _e = Layer3Env::set(Some(val));
            let mut layer3 = true;
            let warns = warns_during(|| layer3 = env_flag(ENV_LAYER3));
            assert!(
                !layer3,
                "AMOS_SPY_LAYER3={val:?} is not a truthy token, so L2 stays the framing"
            );
            assert_eq!(
                warns, 1,
                "AMOS_SPY_LAYER3={val:?} is present but unreadable — the operator must \
                 learn the L3 request was dropped"
            );
        }
    }

    /// Disjointness controls: unset is the documented `→ L2-default` and the
    /// explicit off spellings are a deliberate off, so neither may warn; the
    /// truthy tokens are the only values that arm L3.
    #[test]
    #[serial_test::serial(spy_env_lock)]
    fn unset_and_explicit_off_layer3_values_stay_silent() {
        let _e = Layer3Env::set(None);
        let mut layer3 = true;
        assert_eq!(
            warns_during(|| layer3 = env_flag(ENV_LAYER3)),
            0,
            "unset is the documented L2 default — silent, not a misread"
        );
        assert!(!layer3);

        for val in ["0", "false", "no", "off"] {
            let _e = Layer3Env::set(Some(val));
            let mut layer3 = true;
            assert_eq!(
                warns_during(|| layer3 = env_flag(ENV_LAYER3)),
                0,
                "AMOS_SPY_LAYER3={val:?} is a recognised off — it must not warn"
            );
            assert!(!layer3);
        }
    }

    #[test]
    #[serial_test::serial(spy_env_lock)]
    fn the_layer3_truthy_tokens_arm_l3() {
        for val in ["1", "true", "yes", "on", " On "] {
            let _e = Layer3Env::set(Some(val));
            let mut layer3 = false;
            assert_eq!(
                warns_during(|| layer3 = env_flag(ENV_LAYER3)),
                0,
                "AMOS_SPY_LAYER3={val:?} is a recognised on value"
            );
            assert!(layer3, "AMOS_SPY_LAYER3={val:?} must select L3 framing");
        }
    }
}

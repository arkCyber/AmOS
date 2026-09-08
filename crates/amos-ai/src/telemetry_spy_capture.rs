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

/// Parse a bool env flag (`1`/`true`/`yes`/`on`); anything else is `false`.
fn env_flag(key: &str) -> bool {
    matches!(
        std::env::var(key)
            .ok()
            .map(|v| v.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
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
}

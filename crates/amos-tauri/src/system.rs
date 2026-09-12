//! Tauri <-> daemon system working-status bridge.
//!
//! The WebView's settings/diagnostics call `system_health`; it opens an
//! `AiAgentClient` over the OS daemon's Unix Domain Socket (the same socket that
//! carries `AiAgent` + `AndroidManager` + `Telephony` + `Sensor`), runs the unary
//! `GetStatus` RPC, and returns a serializable mirror of the reply's `system`
//! block (prost types don't impl `Serialize`). If the daemon is absent the command
//! fails with a descriptive error (the UI shows a "daemon not connected" state
//! rather than crashing).
//!
//! Mirrors the `sensors`/telephony bridge shape; the source of the `system` block
//! is `amos-ai` `get_status.system` (see `docs/system-monitor.md`). Absent fields
//! mean "unknown" — never a fabricated reading.

use amos_proto::ai_agent::ai_agent_client::AiAgentClient;
use amos_proto::ai_agent::{StatusRequest, SystemHealth as WireSystemHealth};
use serde::Serialize;

use crate::ai_bridge::with_client_id;

async fn build_channel() -> Result<crate::daemon::DaemonChannel, String> {
    crate::daemon::channel().await
}

/// Serializable mirror of the daemon `get_status.system` block. Option fields are
/// "unknown" (never fabricated); `running`/`cached`/`stopped` are process tiers.
#[derive(Clone, Debug, Default, Serialize)]
pub struct SystemStatus {
    /// Sampler backend that produced the reading: linux-proc | mock | android | ...
    pub sampler: String,
    /// Mean CPU busy% over the sampler's last window (absent on the first read).
    pub cpu_busy_pct: Option<f64>,
    pub mem_total_bytes: Option<u64>,
    pub mem_available_bytes: Option<u64>,
    pub battery_level_pct: Option<f64>,
    pub battery_charging: Option<bool>,
    pub live_power_mw: Option<f64>,
    pub running: u32,
    pub cached: u32,
    pub stopped: u32,
    /// Per-app processes the daemon's governor tracks (empty when none registered).
    pub apps: Vec<AppProc>,
    /// Live resource-governor decision (mode/reason/caps/DVFS/dropped), when the
    /// daemon carried one on the same reply. None when the governor has no block.
    pub governor: Option<SystemGovernor>,
}

/// One tracked app/process: its id and lifecycle tier.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AppProc {
    pub id: String,
    pub state: String,
}

/// Serializable mirror of `get_status.governor` (`GovernorMetrics`): what the
/// energy→lifecycle→scheduler closed loop is doing right now.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct SystemGovernor {
    /// performance | balanced | power_save.
    pub mode: String,
    /// charging | healthy | battery_low | power_draw | thermal | ...
    pub reason: String,
    /// Governor recommends capping / deferring inference.
    pub cap_inference: bool,
    /// Governor recommends deferring background work.
    pub throttle_background: bool,
    /// observe ticks so far (>0 ⇒ the loop has run).
    pub ticks: u64,
    /// Total DVFS scaling_max_freq writes applied.
    pub dvfs_applied: u64,
    /// Total DVFS write failures.
    pub dvfs_failed: u64,
    /// Deferred jobs whose window expired (never ran) on the last tick.
    pub dropped: u64,
}

impl SystemStatus {
    /// A completely "nothing known" status (daemon responded but had no system
    /// block / a source that reports nothing).
    pub fn unknown() -> Self {
        Self::default()
    }
}

/// Fold the daemon's `SystemHealth` (prost) into a serializable [`SystemStatus`].
/// Pure + unit-testable; absent optionals stay absent.
pub fn system_status(s: &WireSystemHealth) -> SystemStatus {
    let load = s.load.as_ref();
    let b = s.battery.as_ref();
    let p = s.processes.as_ref();
    SystemStatus {
        sampler: s.sampler.clone(),
        cpu_busy_pct: load.and_then(|l| l.cpu_busy_pct),
        mem_total_bytes: load.and_then(|l| l.mem_total_bytes),
        mem_available_bytes: load.and_then(|l| l.mem_available_bytes),
        battery_level_pct: b.and_then(|x| x.level_pct),
        battery_charging: b.and_then(|x| x.charging),
        live_power_mw: b.and_then(|x| x.live_power_mw),
        running: p.map(|x| x.running).unwrap_or(0),
        cached: p.map(|x| x.cached).unwrap_or(0),
        stopped: p.map(|x| x.stopped).unwrap_or(0),
        apps: s
            .apps
            .iter()
            .map(|a| AppProc {
                id: a.id.clone(),
                state: a.state.clone(),
            })
            .collect(),
        governor: None,
    }
}

/// Fold the daemon's `GovernorMetrics` (prost) into a serializable [`SystemGovernor`].
pub fn governor_status(g: &amos_proto::ai_agent::GovernorMetrics) -> SystemGovernor {
    SystemGovernor {
        mode: g.sensor_mode.clone(),
        reason: g.reason.clone(),
        cap_inference: g.cap_inference,
        throttle_background: g.throttle_background,
        ticks: g.ticks,
        dvfs_applied: g.dvfs_applied,
        dvfs_failed: g.dvfs_failed,
        dropped: g.dropped,
    }
}

/// Tauri command: return the daemon's system working status (or a descriptive
/// error when the daemon is unreachable).
#[tauri::command]
pub async fn system_health() -> Result<SystemStatus, String> {
    let mut client = AiAgentClient::new(build_channel().await?);
    let reply = client
        .get_status(with_client_id(StatusRequest {}))
        .await
        .map_err(|e| format!("system status request failed: {e}"))?
        .into_inner();
    // Attach the live resource-governor decision (mode/reason/caps/DVFS/dropped)
    // from the same reply so one `system_health` call carries the full
    // "system + power" diagnostic picture.
    let mut st = match reply.system {
        Some(h) => system_status(&h),
        None => SystemStatus::unknown(),
    };
    st.governor = reply.governor.as_ref().map(governor_status);
    Ok(st)
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_proto::ai_agent::{ProcessCounts, SystemBattery, SystemLoad};

    fn wire(sampler: &str, cpu: Option<f64>, battery_level: Option<f64>) -> WireSystemHealth {
        WireSystemHealth {
            load: Some(SystemLoad {
                cpu_busy_pct: cpu,
                mem_total_bytes: Some(8_000_000_000),
                mem_available_bytes: Some(2_000_000_000),
            }),
            battery: Some(SystemBattery {
                level_pct: battery_level,
                charging: Some(true),
                live_power_mw: None,
            }),
            processes: Some(ProcessCounts {
                running: 5,
                cached: 2,
                stopped: 1,
            }),
            sampler: sampler.to_string(),
            apps: Vec::new(),
        }
    }

    #[test]
    fn maps_a_full_system_block() {
        let s = system_status(&wire("linux-proc", Some(43.5), Some(60.0)));
        assert_eq!(s.sampler, "linux-proc");
        assert_eq!(s.cpu_busy_pct, Some(43.5));
        assert_eq!(s.mem_total_bytes, Some(8_000_000_000));
        assert_eq!(s.mem_available_bytes, Some(2_000_000_000));
        assert_eq!(s.battery_level_pct, Some(60.0));
        assert_eq!(s.battery_charging, Some(true));
        assert_eq!(s.running, 5);
        assert_eq!(s.cached, 2);
        assert_eq!(s.stopped, 1);
    }

    #[test]
    fn absent_optionals_stay_absent_not_zero() {
        // No CPU baseline, no battery level, but memory + process tiers present.
        let s = system_status(&wire("linux-proc", None, None));
        assert_eq!(s.cpu_busy_pct, None);
        assert_eq!(s.battery_level_pct, None);
        assert_eq!(s.mem_total_bytes, Some(8_000_000_000), "mem still present");
        assert_eq!(s.running, 5);
    }

    #[test]
    fn missing_subblocks_are_unknown_not_panicking() {
        let s = system_status(&WireSystemHealth {
            load: None,
            battery: None,
            processes: None,
            sampler: "mock".to_string(),
            apps: Vec::new(),
        });
        assert_eq!(s.cpu_busy_pct, None);
        assert_eq!(s.mem_total_bytes, None);
        assert_eq!(s.live_power_mw, None);
        assert_eq!(s.running, 0);
        assert_eq!(s.sampler, "mock");
        assert!(s.apps.is_empty());
    }

    #[test]
    fn maps_the_per_app_list() {
        let h = WireSystemHealth {
            processes: Some(ProcessCounts {
                running: 1,
                cached: 0,
                stopped: 0,
            }),
            apps: vec![
                amos_proto::ai_agent::AppProcess {
                    id: "com.amos.photos".to_string(),
                    state: "foreground".to_string(),
                },
                amos_proto::ai_agent::AppProcess {
                    id: "com.amos.maps".to_string(),
                    state: "cached".to_string(),
                },
            ],
            ..wire("linux-proc", Some(20.0), None)
        };
        let s = system_status(&h);
        assert_eq!(s.apps.len(), 2);
        assert_eq!(s.apps[0].id, "com.amos.photos");
        assert_eq!(s.apps[0].state, "foreground");
        assert_eq!(s.apps[1].state, "cached");
    }

    #[test]
    fn unknown_constructor_has_no_fabrications() {
        let s = SystemStatus::unknown();
        assert_eq!(s.cpu_busy_pct, None);
        assert_eq!(s.sampler, "");
        assert!(s.governor.is_none(), "no governor block when nothing known");
    }

    #[test]
    fn maps_governor_metrics() {
        use amos_proto::ai_agent::GovernorMetrics;
        let g = governor_status(&GovernorMetrics {
            sensor_mode: "power_save".to_string(),
            reason: "battery_low".to_string(),
            cap_inference: true,
            throttle_background: true,
            ticks: 12,
            dvfs_applied: 7,
            dvfs_failed: 1,
            dropped: 2,
        });
        assert_eq!(g.mode, "power_save");
        assert_eq!(g.reason, "battery_low");
        assert!(g.cap_inference && g.throttle_background);
        assert_eq!(g.ticks, 12);
        assert_eq!(g.dvfs_applied, 7);
        assert_eq!(g.dvfs_failed, 1);
        assert_eq!(g.dropped, 2);
    }
}

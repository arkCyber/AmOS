//! `host_battery.rs` — read the REAL host (desktop) OS battery for the status bar.
//!
//! Why: the daemon's `system_health.battery_level_pct` is authoritative on an
//! Android/Linux *device* (`amos-monitor`), but on a desktop dev host — e.g. macOS,
//! where there is no `/proc` battery — the daemon honestly reports `null`, so the
//! top bar previously showed an empty "—" even though the laptop is full of real
//! battery. This module closes that gap by reading the **host** battery directly:
//!
//!   • macOS — parse `pmset -g batt` (no FFI, no extra crate, real readings).
//!   • Linux — parse `/sys/class/power_supply/BAT*` (`capacity` + `status`).
//!   • everything else (Windows / Android-on-device builds) → `None` = honest
//!     "unknown"; the UI falls back to the browser Battery API / empty glyph.
//!
//! Safe Rust only. Reading is layered from the UI as a source BELOW the daemon's
//! device reading (see `frontend-ts` `lib/batteryStatus.ts`).

use serde::Serialize;

/// A single host battery reading. `None` fields = unknown (never fabricated).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HostBattery {
    /// 0..100 state of charge.
    pub level_pct: Option<f64>,
    /// True while plugged/charging; false while draining; null when unknown.
    pub charging: Option<bool>,
}

impl HostBattery {
    pub fn unknown() -> Self {
        Self::default()
    }
}

/// Clamp a level into 0..100 and keep only finite values.
///
/// Used by the macOS/Linux readers; also compiled under `test` so the pure unit
/// test can run on any host. Without the gate the Android/Windows builds (where
/// neither reader is compiled) would warn `dead_code`.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn clamp_level(level: f64) -> Option<f64> {
    if !level.is_finite() {
        return None;
    }
    Some(level.clamp(0.0, 100.0))
}

/// Map a sysfs `status` word onto the charging flag; `None` when ambiguous.
///
/// `Full` / `Not charging` both mean the battery is **plugged in** (just not
/// taking current — e.g. a charge limit), which is what the flag is documented to
/// mean; only `Charging`/`Discharging` are unambiguous otherwise. An unrecognised
/// word stays `None` (unknown), never a guess.
///
/// Compiled on Linux (its only caller) **and** under `test` — the same gate
/// [`clamp_level`] uses — so the mapping is actually exercised on the dev host
/// instead of being unverifiable until a Linux build runs.
#[cfg(any(target_os = "linux", test))]
fn charging_from_status(status: &str) -> Option<bool> {
    match status.trim() {
        "Charging" => Some(true),
        "Discharging" => Some(false),
        "Full" | "Not charging" => Some(true),
        _ => None,
    }
}

/// Tauri command: read the REAL host (desktop) OS battery, or `null` when this
/// platform has no battery / reader (honest unknown, never fabricated). The UI
/// layers this below the daemon's authoritative on-device `system_health`.
#[tauri::command]
pub fn system_host_battery() -> Option<HostBattery> {
    read_host_battery()
}

/// Read the host battery, or `None` when this platform has no battery / no
/// reader (honest unknown — never invent a reading).
pub fn read_host_battery() -> Option<HostBattery> {
    #[cfg(target_os = "macos")]
    {
        crate::host_battery::macos::read()
    }
    #[cfg(target_os = "linux")]
    {
        crate::host_battery::linux::read("/sys/class/power_supply")
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = ();
        None
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::HostBattery;

    /// Parse `pmset -g batt` into a [`HostBattery`]. Pure + unit-testable.
    ///
    /// Real output looks like:
    /// ```text
    /// Now drawing from 'Battery Power'
    ///  -InternalBattery-0 (id=22610019)\t75%; discharging; 6:16 remaining present: true
    /// ```
    /// and, while plugged:
    /// ```text
    /// Now drawing from 'AC Power'
    ///  -InternalBattery-0 (id=...)   100%; charged; 0:00 remaining present: true
    /// ```
    pub fn parse_pmset(out: &str) -> Option<HostBattery> {
        let drawing_ac = out.contains("AC Power");
        let line = out.lines().find(|l| l.contains('%'))?;
        let pct = line
            .split('%')
            .next()?
            .rsplit(|c: char| !c.is_ascii_digit())
            .next()?;
        let pct: f64 = pct.parse().ok()?;
        let charging = if line.contains("discharging") {
            Some(false)
        } else if line.contains("charging") || line.contains("charged") || drawing_ac {
            Some(true)
        } else {
            None
        };
        Some(HostBattery {
            level_pct: super::clamp_level(pct),
            charging,
        })
    }

    /// Run `pmset -g batt`; returns `None` on any failure / no battery line.
    pub fn read() -> Option<HostBattery> {
        let out = std::process::Command::new("pmset")
            .args(["-g", "batt"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        parse_pmset(&String::from_utf8_lossy(&out.stdout))
    }
}

/// Linux `/sys/class/power_supply` reader.
///
/// Compiled on Linux (its only caller) **and** under `test`, so the whole reader —
/// the directory walk and the pure mapping — is exercised on the dev host rather
/// than being a Linux-CI-only blind spot (same gate as [`clamp_level`]).
#[cfg(any(target_os = "linux", test))]
mod linux {
    use std::path::Path;

    use super::{charging_from_status, HostBattery};

    /// True when a power-supply entry is a real battery (vs AC/adapter).
    fn is_battery_type(kind: &str) -> bool {
        kind.trim() == "Battery"
    }

    /// Read the first real battery under `root` (default `/sys/class/power_supply`).
    ///
    /// An entry that cannot be read is **skipped**, never fatal: a real
    /// `/sys/class/power_supply` holds entries that are not batteries and may not
    /// carry a `type` file at all, and one unreadable entry must not hide a battery
    /// that *is* readable (the old `?` aborted the whole directory and the caller
    /// reported "unknown" — an observation silently lost).
    pub fn read(root: &str) -> Option<HostBattery> {
        let base = Path::new(root);
        for entry in std::fs::read_dir(base).ok()? {
            let Ok(entry) = entry else { continue };
            let dir = entry.path();
            let Ok(kind) = std::fs::read_to_string(dir.join("type")) else {
                continue;
            };
            if !is_battery_type(&kind) {
                continue;
            }
            // A battery with no readable capacity is not a reading; keep looking
            // (another battery may be fine) rather than giving up on the device.
            let Some(capacity) = std::fs::read_to_string(dir.join("capacity"))
                .ok()
                .and_then(|c| c.trim().parse::<f64>().ok())
            else {
                continue;
            };
            let status = std::fs::read_to_string(dir.join("status")).unwrap_or_default();
            return Some(HostBattery {
                level_pct: super::clamp_level(capacity),
                charging: charging_from_status(&status),
            });
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_level_bounds_and_drops_nan() {
        assert_eq!(clamp_level(80.0), Some(80.0));
        assert_eq!(clamp_level(150.0), Some(100.0));
        assert_eq!(clamp_level(-5.0), Some(0.0));
        assert_eq!(clamp_level(f64::NAN), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_parses_discharging_battery() {
        let out = "Now drawing from 'Battery Power'\n \
            -InternalBattery-0 (id=22610019)\t75%; discharging; 6:16 remaining present: true";
        let b = macos::parse_pmset(out).unwrap();
        assert_eq!(b.level_pct, Some(75.0));
        assert_eq!(b.charging, Some(false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_parses_charging_on_ac() {
        let out = "Now drawing from 'AC Power'\n \
            -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true";
        let b = macos::parse_pmset(out).unwrap();
        assert_eq!(b.level_pct, Some(100.0));
        assert_eq!(b.charging, Some(true));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_returns_none_without_battery_line() {
        // A desktop without a battery: pmset prints only the AC drawing line.
        assert_eq!(macos::parse_pmset("Now drawing from 'AC Power'\n"), None);
    }

    #[cfg(any(target_os = "linux", test))]
    #[test]
    fn sysfs_charging_status_maps_only_observed_states() {
        assert_eq!(charging_from_status("Charging"), Some(true));
        assert_eq!(charging_from_status("Discharging"), Some(false));
        assert_eq!(charging_from_status("Full"), Some(true));
        // Plugged but not taking current (charge limit / driver quirk) is still an
        // *observed* plugged state: mapping it to `None` would silently drop the
        // battery area from the care report (`BatteryReading::care` needs the flag).
        assert_eq!(charging_from_status("Not charging"), Some(true));
        // Trailing whitespace is normal in sysfs files.
        assert_eq!(charging_from_status("Discharging\n"), Some(false));
        // An unrecognised word is unknown — never a guess.
        assert_eq!(charging_from_status("Unknown"), None);
        assert_eq!(charging_from_status("Something New"), None);
    }

    #[cfg(any(target_os = "linux", test))]
    #[test]
    fn linux_reads_battery_from_a_real_tree() {
        let dir = std::env::temp_dir().join(format!("amos-host-bat-{}", std::process::id()));
        // Decoy entries FIRST, as a real `/sys/class/power_supply` has them: one that
        // is not a battery, and ones with **no `type` file at all**. They must be
        // skipped — the previous `?` aborted the whole directory instead, silently
        // losing the readable battery added below. (Decoys are created before the
        // battery so a directory-order walk hits one of them first.)
        std::fs::create_dir_all(dir.join("AC")).unwrap();
        std::fs::write(dir.join("AC/type"), "Mains\n").unwrap();
        std::fs::create_dir_all(dir.join("ADP1")).unwrap();
        std::fs::create_dir_all(dir.join("zz_typoless")).unwrap();
        let bat = dir.join("BAT0");
        std::fs::create_dir_all(&bat).unwrap();
        std::fs::write(bat.join("type"), "Battery\n").unwrap();
        std::fs::write(bat.join("capacity"), "87\n").unwrap();
        std::fs::write(bat.join("status"), "Discharging\n").unwrap();
        let b = linux::read(dir.to_str().unwrap()).expect("the battery is still found");
        assert_eq!(b.level_pct, Some(87.0));
        assert_eq!(b.charging, Some(false));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(any(target_os = "linux", test))]
    #[test]
    fn linux_reports_unknown_when_no_battery_is_readable() {
        // Only decoys: the honest answer is `None` (unknown), never a fabricated
        // reading — and a battery whose `capacity` cannot be parsed is not a reading.
        let dir = std::env::temp_dir().join(format!("amos-host-nobat-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("AC")).unwrap();
        std::fs::write(dir.join("AC/type"), "Mains\n").unwrap();
        let broken = dir.join("BAT0");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("type"), "Battery\n").unwrap();
        std::fs::write(broken.join("capacity"), "not-a-number\n").unwrap();
        assert_eq!(linux::read(dir.to_str().unwrap()), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

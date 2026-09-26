//! Cellular signal-strength bridge — the missing host half of the honest
//! "signal bars" tile.
//!
//! The touch shell's Notification Center has modelled cellular service state
//! honestly since `lib/cellularService.ts`: `RadioSignal { present, signal }` is
//! *the* seam, and its default is `{ present: false, signal: null }` because the
//! host path had no modem source at all. Nothing ever flipped it — the seeder
//! (`svelte/cellularRadio.ts::setCellularRadio`) had **no production caller**, so
//! the tile stayed hidden forever even on a real Android phone with a SIM. That
//! is a capability the UI cannot reach, not a boundary: `TelephonyManager` is
//! public API and the glue already holds the app `Context` at boot.
//!
//! This module owns the three real probes and the pure fold that turns them into
//! the frontend's [`CellularSignalPayload`]. The device half lives in
//! `TelephonyGlue.kt` (the same object that already answers the ROLE_DIALER
//! questions), reached through `real_dial`'s stored `Context` + class loader.
//!
//! Three distinct facts, deliberately not one flag:
//!
//! * `supported` — this device is a phone at all (`FEATURE_TELEPHONY`). A tablet
//!   reports `false`, and the UI says "no cellular service" rather than drawing
//!   bars that could never fill.
//! * `present` — a SIM/modem is actually there (`SIM_STATE_READY`). An ejected
//!   SIM is `supported && !present`: the honest "no radio" the tile's default
//!   was standing in for.
//! * `signal` — the real `1..=4` level, or `None` when the device reports `0`
//!   (no usable signal), reports nothing, or the level could not be read at all
//!   (no `READ_PHONE_STATE` grant, API < 28). The frontend's "no-signal" line
//!   covers all of them, because to a user they are the same fact: there are no
//!   bars to draw.
//!
//! Desktop / CI have no telephony stack: `supported` is `false`, so the tile is
//! hidden exactly as before — but now that is a *measured* absence rather than an
//! unimplemented seam.

use serde::Serialize;

/// Answer to `cellular_signal`: the three device facts the bars tile needs.
///
/// Field names are the `RadioSignal` seam's (`present` / `signal`) plus
/// `supported`, so the frontend can spread this straight into
/// `setCellularRadio` with no re-shaping — the same one-shape rule the role
/// surfaces follow.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellularSignalPayload {
    /// This device has a cellular radio at all (a tablet answers `false`).
    pub supported: bool,
    /// A SIM is present and ready — the radio can carry service right now.
    pub present: bool,
    /// The real `1..=4` level when the device reported one; `None` when it
    /// reported none, reported `0`, or could not be read at all.
    pub signal: Option<u8>,
}

/// Fold the three device probes into a [`CellularSignalPayload`]. Pure, so every
/// arm is unit-tested without a JVM.
///
/// The rules:
/// * `!supported` → nothing else is claimed: a device that cannot have cellular
///   has no `present`/`signal` either, so all three say so together.
/// * `!present` → `supported` but no SIM: `signal` stays `None` (there is
///   nothing to measure — never a fabricated `0`).
/// * a `level` outside `1..=4` → `None`. `SignalStrength#getLevel()` documents
///   `0..=4`; `0` is "no usable signal" and anything else is a platform contract
///   violation we have no scale for. Both mean the same thing on screen — no bars
///   — which is why they fold together rather than into an invented value.
pub fn cellular_signal_from(supported: bool, present: bool, level: i32) -> CellularSignalPayload {
    if !supported {
        return CellularSignalPayload {
            supported: false,
            present: false,
            signal: None,
        };
    }
    if !present {
        return CellularSignalPayload {
            supported: true,
            present: false,
            signal: None,
        };
    }
    let signal = u8::try_from(level).ok().filter(|l| (1..=4).contains(l));
    CellularSignalPayload {
        supported: true,
        present: true,
        signal,
    }
}

/// Device: ask the bound Kotlin `TelephonyGlue`.
///
/// Each probe answers `Err` when there is no glue at all (a build without the
/// `android` native feature, or `bind` has not run), and the fold takes the
/// honest direction — `false` / no reading — rather than promoting an
/// unreachable probe into a device claim.
#[cfg(feature = "android")]
fn probe() -> CellularSignalPayload {
    use crate::real_dial::android_impl::{call_static_bool, call_static_int};
    cellular_signal_from(
        call_static_bool("cellularSupportedBound").unwrap_or(false),
        call_static_bool("cellularPresentBound").unwrap_or(false),
        call_static_int("cellularSignalLevelBound").unwrap_or(-1),
    )
}

/// Host default: there is no telephony stack (and no glue to reach), so the
/// honest answer is "not supported" — the same `false` a tablet gives.
#[cfg(not(feature = "android"))]
fn probe() -> CellularSignalPayload {
    cellular_signal_from(false, false, -1)
}

/// Tauri command: read the device's real cellular presence + signal level.
///
/// Cheap (three JNI calls on device, none on desktop) and I/O-free, so the shell
/// may ask it once on mount — the same contract `rotation_get` and
/// `telephony_real_dial_status` have.
#[tauri::command]
pub fn cellular_signal() -> CellularSignalPayload {
    probe()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phone_with_a_sim_and_signal_reports_bars() {
        let p = cellular_signal_from(true, true, 3);
        assert_eq!(
            p,
            CellularSignalPayload {
                supported: true,
                present: true,
                signal: Some(3),
            }
        );
    }

    #[test]
    fn the_full_1_to_4_band_survives_unchanged() {
        for level in 1..=4 {
            assert_eq!(
                cellular_signal_from(true, true, level).signal,
                Some(level as u8),
                "level {level} must reach the UI as itself"
            );
        }
    }

    #[test]
    fn a_tablet_reports_nothing_rather_than_dead_bars() {
        // Unsupported wins over everything: a device that cannot have cellular must
        // not be told "present" even if a probe answered otherwise, or the tile
        // would draw bars that can never fill.
        assert_eq!(
            cellular_signal_from(false, true, 4),
            CellularSignalPayload {
                supported: false,
                present: false,
                signal: None,
            }
        );
    }

    #[test]
    fn a_phone_with_no_sim_is_supported_but_not_present() {
        // The ejected-SIM case: the tile may say "no service", and `signal` is None —
        // never a fabricated 0 to go with the missing radio.
        // `level: 4` is deliberately the *strong* reading: a present-but-unreadable
        // mismatch must not leak a level through a radio that is not there.
        let p = cellular_signal_from(true, false, 4);
        assert_eq!(
            p,
            CellularSignalPayload {
                supported: true,
                present: false,
                signal: None,
            }
        );
    }

    #[test]
    fn a_level_of_zero_is_no_usable_signal_not_a_filled_bar() {
        assert_eq!(cellular_signal_from(true, true, 0).signal, None);
    }

    #[test]
    fn an_out_of_contract_level_is_unreadable_rather_than_the_maximum() {
        // `getLevel()` documents 0..=4. A 5 is a contract violation we have no scale
        // for; rounding it up to 4 would print a number the device never reported.
        // (The negative control for the clamp someone would reach for here.)
        assert_eq!(cellular_signal_from(true, true, 5).signal, None);
        assert_eq!(cellular_signal_from(true, true, -1).signal, None);
    }

    #[test]
    fn a_desktop_host_reports_no_cellular_stack() {
        // Without the `android` feature `probe()` is the desktop arm; its answer must
        // match the fold's unsupported arm so the two cannot drift.
        assert_eq!(probe(), cellular_signal_from(false, false, -1));
        assert!(!probe().supported && !probe().present && probe().signal.is_none());
    }

    /// The Kotlin glue spells the three method names and the host calls them by
    /// string; a rename on **either** side would not fail the build — it would make
    /// `call_static_bool`/`call_static_int` answer `Err`, which the fold turns into
    /// `false` / `-1`, i.e. silently "this phone has no cellular" on a phone that has
    /// one. This binds each name the Rust side calls to a `fun <name>(` declaration in
    /// the tracked glue source, so a drift is red instead of invisible.
    ///
    /// Deliberately **one-directional** (every name the host calls must be declared;
    /// the glue may export more, e.g. the ROLE_DIALER probes this module never asks).
    #[test]
    fn the_glue_declares_every_method_the_host_calls() {
        const GLUE: &str = include_str!("../android-glue/com/amos/ai/glue/TelephonyGlue.kt");
        for method in [
            "cellularSupportedBound",
            "cellularPresentBound",
            "cellularSignalLevelBound",
        ] {
            assert!(
                GLUE.contains(&format!("fun {method}(")),
                "TelephonyGlue.kt no longer declares `fun {method}(`, but `probe()` calls it by \
                 name — on device that reads as Err, which this module folds into \"no cellular\" \
                 on a phone that has one"
            );
        }
    }

    #[test]
    fn the_payload_is_camel_case_on_the_wire() {
        let v = serde_json::to_value(cellular_signal_from(true, true, 2)).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"supported": true, "present": true, "signal": 2})
        );
        // `null` (not a missing key) when there is no reading: the frontend's
        // `signal === null` branch is what selects the "no-signal" line.
        let v = serde_json::to_value(cellular_signal_from(true, true, 0)).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"supported": true, "present": true, "signal": null})
        );
    }
}

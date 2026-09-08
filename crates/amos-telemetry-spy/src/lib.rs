//! `amos-telemetry-spy` — AmOS **passive egress telemetry-spy** domain core.
//!
//! A no-block, async audit layer that watches one data interface (e.g.
//! `rmnet_data0` on a 12GB physical device) for device-bound identifiers —
//! hardware **serial**, **IMEI**, and the serving base-station **cell ID** —
//! leaking inside outbound payloads, and emits a high-severity [`EgressMatch`]
//! audit event for a daemon → System UI gRPC warning path.
//!
//! Honest scope (mirrors `docs/anti-telemetry-egress-guard.md`):
//! * Live capture on a data interface sees the **AP / app data plane only**. It
//!   cannot see the modem/baseband's own backhaul (a separate trust domain).
//! * A plaintext substring match is a **brittle, low-confidence heuristic** —
//!   encrypted flows hide it and naive scanning over-reports. Events therefore
//!   carry a graded [`Confidence`], never the claim of a confirmed leak.
//! * Live pnet capture needs a rooted / AmOS-AOSP slot and is feature-gated
//!   behind `audit`; it is **not** part of the default build or the CI gate.
//!
//! Crate layout (pure `std` by default, host-testable):
//! * [`identifier`] — the device-bound identifier model + byte tokens.
//! * [`scanner`] — the pure payload-scanning heuristic + [`Confidence`].
//! * [`packet`] — a minimal pure-`std` IP/TCP/UDP parser ([`packet::Flow`]).
//! * [`analyze`] — pure decode→scan→[`EgressMatch`] glue ([`match_frame`]).
//! * [`signal`] — the [`EgressMatch`] audit event.
//! * [`identity`] — the [`DeviceIdentity`] seam (host uses static/mock).
//! * [`capture`] — **`audit` feature only**: live pnet sniffing that feeds
//!   frames into [`match_frame`] on a Tokio `spawn_blocking` task.
//!
//! Feature gates:
//! * `audit` — live capture via `pnet` on a data interface + a Tokio async
//!   bridge. Compiling (`cargo check --features audit`) is not proof it runs on
//!   a device.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod analyze;
pub mod error;
pub mod identifier;
pub mod identity;
pub mod packet;
pub mod scanner;
pub mod signal;

#[cfg(feature = "audit")]
pub mod capture;

pub use analyze::match_frame;
pub use error::{Error, Result};
pub use identifier::{Identifier, IdentifierKind};
pub use identity::{DeviceIdentity, MockIdentity, StaticIdentity};
pub use scanner::{scan, scan_payload, Confidence, ScanHit};
pub use signal::{Direction, EgressMatch, IdentifierEvidence, Protocol, Severity};

#[cfg(feature = "audit")]
pub use capture::CaptureCfg;

use std::time::{SystemTime, UNIX_EPOCH};

/// Wall-clock UTC milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_ms_is_roughly_epoch() {
        // 2020-01-01 == 1577836800000ms; today is far larger.
        assert!(now_ms() > 1_577_836_800_000);
    }

    #[test]
    fn reexports_line_up() {
        let ids = [Identifier::ascii(IdentifierKind::Serial, "SER-1234567890").unwrap()];
        let hits = scan_payload(&ids, b"x SER-1234567890 x");
        assert_eq!(hits.len(), 1);
        let typed = scan(&ids, b"x").unwrap();
        assert!(typed.is_empty());
        let mock = MockIdentity;
        assert!(!mock.identifiers().is_empty());
    }
}

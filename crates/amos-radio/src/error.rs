//! Error type and result alias for the radio domain core.

use crate::state::RadioMode;
use thiserror::Error;

/// Errors surfaced by the radio manager and its providers.
#[derive(Error, Debug, PartialEq, Eq)]
pub enum RadioError {
    /// A non-airplane radio was enabled while Airplane mode is active.
    #[error("airplane mode is on; turn it off before enabling {0:?}")]
    AirplaneActive(RadioMode),

    /// A provider (real or mock) reported a backend failure.
    #[error("radio provider failure: {0}")]
    Provider(String),

    /// The active provider cannot serve this request at all — e.g. asking the
    /// offline [`crate::MockRadioProvider`] for the Bluetooth adapter's name.
    /// Distinct from [`RadioError::Provider`]: nothing was attempted on a device,
    /// so the caller must fall back to its own remembered value (and say so)
    /// rather than report a failure the user can act on (REQ-A199).
    #[error("this radio provider does not support {0}")]
    Unsupported(String),

    /// The **platform** owns this switch, so no app on this device can flip it
    /// (REQ-A202): Android removed the app-facing Wi-Fi switch in API 29 and the
    /// Bluetooth one in API 33, and the airplane bit needs `WRITE_SECURE_SETTINGS`.
    ///
    /// Distinct from [`RadioError::Provider`] on purpose: a provider failure means
    /// "the device refused *this* attempt", while this means "nothing was attempted
    /// and nothing can be" — the manager refuses **before** touching anything (so an
    /// Airplane cascade cannot be left half-applied) and the screen's job is to hand
    /// the user to `surface` rather than to retry.
    #[error(
        "the platform manages {radio:?} — an app cannot switch it ({reason}); open `{surface}` instead"
    )]
    PlatformManaged {
        radio: RadioMode,
        /// What the user can open to reach the real switch.
        surface: crate::provider::SystemSurface,
        /// A stable code for *why* (the UI owns the wording).
        reason: crate::provider::PlatformReason,
    },
}

impl RadioError {
    /// The stable **machine token** for this failure's kind (REQ-A203).
    ///
    /// The screen switches on this token to pick its own localised sentence; the
    /// free-form [`std::fmt::Display`] text stays diagnostic (ledger) copy. Tokens:
    /// `airplane_active` (the cascade guard), `platform_managed` (no app may flip
    /// it), `provider_refused` (the device refused *this* attempt — retry or the
    /// system surface may still help), `unsupported` (nobody here can serve it).
    pub fn kind(&self) -> &'static str {
        match self {
            RadioError::AirplaneActive(_) => "airplane_active",
            RadioError::Provider(_) => "provider_refused",
            RadioError::Unsupported(_) => "unsupported",
            RadioError::PlatformManaged { .. } => "platform_managed",
        }
    }

    /// The radio this refusal names, when it names one. A cascade refuses on a
    /// member's behalf, so the screen must be able to say *which* switch the
    /// platform owns — not just that "something" was refused (REQ-A203).
    pub fn radio(&self) -> Option<RadioMode> {
        match self {
            RadioError::AirplaneActive(radio) => Some(*radio),
            RadioError::PlatformManaged { radio, .. } => Some(*radio),
            // A provider failure carries no structured radio: its string may even
            // concern a cascade step the manager chose, so claiming one would be a
            // guess dressed up as a fact.
            RadioError::Provider(_) | RadioError::Unsupported(_) => None,
        }
    }
}

/// Result alias used throughout the radio core.
pub type Result<T> = std::result::Result<T, RadioError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_is_constructible_and_displayable() {
        let e = RadioError::AirplaneActive(RadioMode::Wifi);
        assert!(e.to_string().contains("airplane"));
        assert!(e.to_string().contains("Wifi"));
        assert_eq!(e, RadioError::AirplaneActive(RadioMode::Wifi));
    }

    #[test]
    fn unsupported_is_distinguishable_from_a_provider_failure() {
        // The two must not compare equal: the UI falls back to its own remembered
        // value for `Unsupported` and reports a failure for `Provider` (REQ-A199).
        let unsupported = RadioError::Unsupported("reading the adapter name".into());
        assert!(unsupported.to_string().contains("does not support"));
        assert_ne!(unsupported, RadioError::Provider("boom".into()));
    }

    #[test]
    fn a_platform_managed_switch_is_distinguishable_from_a_plain_refusal() {
        // The three failures mean three different things to the caller (REQ-A202):
        // `Provider` = the device refused this attempt (retry may help), `Unsupported` =
        // nobody here can serve the request, `PlatformManaged` = no app may flip it, so
        // the screen must offer the system surface instead of a retry.
        use crate::provider::{PlatformReason, SystemSurface};
        let managed = RadioError::PlatformManaged {
            radio: RadioMode::Bluetooth,
            surface: SystemSurface::BluetoothSettings,
            reason: PlatformReason::SwitchRemoved,
        };
        let text = managed.to_string();
        assert!(text.contains("Bluetooth"), "{text}");
        assert!(text.contains("bluetooth_settings"), "{text}");
        assert!(text.contains("switch_removed"), "{text}");
        assert_ne!(managed, RadioError::Provider("refused".into()));
        assert_ne!(
            managed,
            RadioError::PlatformManaged {
                radio: RadioMode::Wifi,
                surface: SystemSurface::BluetoothSettings,
                reason: PlatformReason::SwitchRemoved,
            },
            "the radio is part of the fact"
        );
    }

    #[test]
    fn every_failure_kind_has_one_stable_token() {
        // The screen switches its wording on these tokens (REQ-A203): a token that
        // drifts silently reroutes user-facing sentences, so the values are pinned
        // here — exactly like `PlatformReason::code()` and `SystemSurface::key()`.
        use crate::provider::{PlatformReason, SystemSurface};
        assert_eq!(
            RadioError::AirplaneActive(RadioMode::Wifi).kind(),
            "airplane_active"
        );
        assert_eq!(
            RadioError::Provider("setWifiEnabled returned false".into()).kind(),
            "provider_refused"
        );
        assert_eq!(
            RadioError::Unsupported("renaming the adapter".into()).kind(),
            "unsupported"
        );
        assert_eq!(
            RadioError::PlatformManaged {
                radio: RadioMode::Bluetooth,
                surface: SystemSurface::BluetoothSettings,
                reason: PlatformReason::SwitchRemoved,
            }
            .kind(),
            "platform_managed"
        );
    }

    #[test]
    fn a_named_refusal_names_its_radio_an_anonymous_one_names_none() {
        // `AirplaneActive(wifi)` and `PlatformManaged{radio: bluetooth, ..}` know the
        // radio they refuse; a `Provider` string may be about a cascade step the
        // manager chose — inventing a radio there would be a guess, so it is `None`.
        use crate::provider::{PlatformReason, SystemSurface};
        assert_eq!(
            RadioError::AirplaneActive(RadioMode::Wifi).radio(),
            Some(RadioMode::Wifi)
        );
        assert_eq!(
            RadioError::PlatformManaged {
                radio: RadioMode::Bluetooth,
                surface: SystemSurface::BluetoothSettings,
                reason: PlatformReason::SwitchRemoved,
            }
            .radio(),
            Some(RadioMode::Bluetooth)
        );
        assert_eq!(RadioError::Provider("boom".into()).radio(), None);
        assert_eq!(RadioError::Unsupported("x".into()).radio(), None);
    }
}

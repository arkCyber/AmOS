//! Which provider actually backs a [`crate::service::TelephonyService`].
//!
//! This is the service's **honesty channel**. `Dial` answers a `CallIdMsg` the same way
//! whether a real carrier placed the call or an in-process mock invented one, so the
//! return value alone cannot tell a caller which happened. A caller that needs a *real*
//! call — above all one placing an emergency number — must be able to ask, or it will
//! draw a simulated call as a real one (the failure this type exists to prevent).
//!
//! The load-bearing distinction is [`BackendKind::is_real`]: only `Android` means `Dial`
//! reaches the platform telephony stack. `Mock` and `Unconfigured` both mean it does not.

use amos_proto::amos_telephony::BackendKind as ProtoBackendKind;

/// The provider behind a telephony service.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendKind {
    /// In-process simulation: no SIM, no Telecom, no network. Dev/demo only.
    Mock,
    /// Real platform telephony over the Android stack.
    Android,
    /// No provider wired: `Dial` is refused honestly rather than simulated.
    Unconfigured,
}

impl BackendKind {
    /// The wire/DIAGNOSTIC token (mirrors the `BackendKind` proto enum's lowercased arms).
    pub fn as_str(self) -> &'static str {
        match self {
            BackendKind::Mock => "mock",
            BackendKind::Android => "android",
            BackendKind::Unconfigured => "unconfigured",
        }
    }

    /// Does `Dial` reach the platform telephony stack on this backend?
    ///
    /// The one question a caller must not get wrong: a mock *does* answer `Dial`, so
    /// "the RPC succeeded" is not evidence a call exists.
    pub fn is_real(self) -> bool {
        matches!(self, BackendKind::Android)
    }

    /// The backend's own words about itself, for the operator log and the UI.
    pub fn detail(self) -> &'static str {
        match self {
            BackendKind::Mock => {
                "in-process mock: Dial does not reach the platform telephony stack"
            }
            BackendKind::Android => "Android platform telephony",
            BackendKind::Unconfigured => {
                "no telephony provider wired: Dial is refused, never simulated"
            }
        }
    }

    /// Map onto the wire enum the gRPC `GetBackend` reply carries.
    pub fn to_proto(self) -> ProtoBackendKind {
        match self {
            BackendKind::Mock => ProtoBackendKind::BackendMock,
            BackendKind::Android => ProtoBackendKind::BackendAndroid,
            BackendKind::Unconfigured => ProtoBackendKind::BackendUnconfigured,
        }
    }

    /// Parse the diagnostic token back. An unrecognized token is `None`, never a
    /// rounded-up guess — a caller that cannot classify a backend must not assume it is
    /// real.
    ///
    /// Named `parse_token`, not `from_str`: an inherent `from_str` would shadow the
    /// `std::str::FromStr` convention (`clippy::should_implement_trait`).
    pub fn parse_token(s: &str) -> Option<Self> {
        match s {
            "mock" => Some(BackendKind::Mock),
            "android" => Some(BackendKind::Android),
            "unconfigured" => Some(BackendKind::Unconfigured),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::BackendKind;

    #[test]
    fn only_android_is_real() {
        assert!(BackendKind::Android.is_real());
        // The mock answers `Dial` happily; that is exactly why `is_real` must not be
        // derived from "the RPC succeeded".
        assert!(!BackendKind::Mock.is_real());
        assert!(!BackendKind::Unconfigured.is_real());
    }

    #[test]
    fn token_round_trips() {
        for k in [
            BackendKind::Mock,
            BackendKind::Android,
            BackendKind::Unconfigured,
        ] {
            assert_eq!(BackendKind::parse_token(k.as_str()), Some(k));
        }
    }

    #[test]
    fn an_unknown_token_is_not_rounded_up_to_a_real_backend() {
        // The negative control for "we could not classify it": an unrecognized token
        // must be `None`, so the caller is forced to treat it as not-real.
        assert_eq!(BackendKind::parse_token(""), None);
        assert_eq!(BackendKind::parse_token("MOCK"), None);
        assert_eq!(BackendKind::parse_token("real"), None);
    }

    #[test]
    fn proto_mapping_is_total_and_distinct() {
        let m = BackendKind::Mock.to_proto();
        let a = BackendKind::Android.to_proto();
        let u = BackendKind::Unconfigured.to_proto();
        assert_ne!(m, a);
        assert_ne!(a, u);
        assert_ne!(m, u);
    }
}

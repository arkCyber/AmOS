//! Emergency routing — the single place that decides, from the recognized
//! [`EmergencyMap`] and a validated [`Number`], which hard path a dial must take.
//!
//! This is the policy heart of the "EmergencyMap 短路通路": every provider backend
//! (the deterministic `MockTelephonyProvider` on the desktop, the
//! `AndroidTelephonyProvider`/`AndroidEmergencyTelephonyProvider` over Binder
//! on-device) enforces the **same** decision, so a recognized emergency number can
//! never be silently placed on the ordinary SIM/telecom path and an ordinary number
//! can never sneak onto the privileged emergency path (where ordinary safeguards
//! like rate-limiting and recording policy are deliberately bypassed).
//!
//! The decision itself is a thin, VM-free layer over [`Number::kind`] so it is fully
//! unit-testable on the host — no Android VM / `/dev/binder` required — while the
//! actual dialing happens behind the provider seams.

use crate::error::{Result, TelephonyError};
use crate::number::{EmergencyMap, Number, NumberKind};

/// Which privileged path a dial must take.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DialRoute {
    /// A recognized emergency code (110/112/911/999…) → the privileged,
    /// never-rate-limited emergency path (separate provider, never recorded).
    Emergency,
    /// An ordinary number → the regular SIM/telecom path.
    Regular,
}

/// Decide the hard path for `number` under `map`.
pub fn route(map: &EmergencyMap, number: &Number) -> DialRoute {
    match number.kind(map) {
        NumberKind::Emergency => DialRoute::Emergency,
        NumberKind::Regular => DialRoute::Regular,
    }
}

/// Guard for the **ordinary** provider: a recognized emergency number must never go
/// through the regular SIM/telecom dial path — it is forced onto the emergency one
/// (mirrors the "an emergency number is rejected so it is forced onto the emergency
/// path" contract, `docs/telephony.md` §5).
pub fn guard_regular(map: &EmergencyMap, number: &Number) -> Result<()> {
    if route(map, number) == DialRoute::Emergency {
        return Err(TelephonyError::MustUseEmergencyPath(number.digits()));
    }
    Ok(())
}

/// Guard for the **emergency** provider: only a recognized emergency code may use the
/// privileged path. An ordinary number is refused rather than silently placed where
/// ordinary safeguards (rate-limiting, recording policy) are off by design.
pub fn guard_emergency(map: &EmergencyMap, number: &Number) -> Result<()> {
    if route(map, number) != DialRoute::Emergency {
        return Err(TelephonyError::NotEmergency(number.digits()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cn() -> EmergencyMap {
        EmergencyMap::for_region("CN")
    }

    #[test]
    fn route_classifies_emergency_and_regular() {
        let map = cn();
        assert_eq!(
            route(&map, &Number::new("110").unwrap()),
            DialRoute::Emergency,
            "110 is a CN emergency code"
        );
        assert_eq!(
            route(&map, &Number::new("112").unwrap()),
            DialRoute::Emergency,
            "the international 112 is always emergency"
        );
        assert_eq!(
            route(&map, &Number::new("13800138000").unwrap()),
            DialRoute::Regular
        );
    }

    #[test]
    fn route_is_region_aware_not_global() {
        // 110 is not a US emergency code → US map routes it to the ordinary path.
        let us = EmergencyMap::for_region("US");
        assert_eq!(
            route(&us, &Number::new("110").unwrap()),
            DialRoute::Regular,
            "US does not recognize 110 as emergency"
        );
        assert_eq!(
            route(&cn(), &Number::new("110").unwrap()),
            DialRoute::Emergency
        );
    }

    #[test]
    fn separators_do_not_defeat_routing() {
        let map = cn();
        assert_eq!(
            route(&map, &Number::new("1 1 0").unwrap()),
            DialRoute::Emergency,
            "dial-string separators are normalized before routing"
        );
    }

    #[test]
    fn ordinary_guard_rejects_emergency_with_explicit_error() {
        let map = cn();
        assert!(matches!(
            guard_regular(&map, &Number::new("112").unwrap()),
            Err(TelephonyError::MustUseEmergencyPath(ref d)) if d == "112"
        ));
        // A regular number passes the ordinary guard.
        assert!(guard_regular(&map, &Number::new("13800138000").unwrap()).is_ok());
    }

    #[test]
    fn emergency_guard_rejects_regular_numbers() {
        let map = cn();
        assert!(matches!(
            guard_emergency(&map, &Number::new("13800138000").unwrap()),
            Err(TelephonyError::NotEmergency(_))
        ));
        assert!(guard_emergency(&map, &Number::new("119").unwrap()).is_ok());
    }

    #[test]
    fn guards_are_region_consistent() {
        // In the US an ordinary provider is *allowed* to dial 110; only the CN map
        // treats it as emergency, so the two guards must reflect that region.
        let us = EmergencyMap::for_region("US");
        assert!(guard_regular(&us, &Number::new("110").unwrap()).is_ok());
        assert!(guard_emergency(&us, &Number::new("110").unwrap()).is_err());
        let cn = cn();
        assert!(guard_regular(&cn, &Number::new("110").unwrap()).is_err());
        assert!(guard_emergency(&cn, &Number::new("110").unwrap()).is_ok());
    }

    #[test]
    fn unknown_region_fallback_never_locks_emergency_out() {
        // An un-assembled/unknown region falls back to the broad global set, so the
        // universal 112/911 stay emergency and the guards never dead-end them.
        let map = EmergencyMap::for_region("ZZ");
        assert_eq!(
            guard_emergency(&map, &Number::new("112").unwrap()),
            Ok(()),
            "universal 112 must always pass the emergency guard"
        );
        assert_eq!(guard_emergency(&map, &Number::new("911").unwrap()), Ok(()));
    }
}

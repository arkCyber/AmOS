//! The folded **care report** — four inputs, one honest grade.
//!
//! `assess` turns the raw signals a phone manager can actually observe into a
//! [`CareReport`]: a 0–100 score, a letter grade and a deterministic finding
//! list. Two rules keep it honest (the audit's P0-3 discipline):
//!
//! * **Unknown is not healthy.** Every input is optional. An area without data
//!   is *not* assessed, is left out of [`CareReport::assessed`], and must be
//!   rendered as "unknown" — the score is only meaningful for what was seen.
//! * **No invented judgement.** The domain has no per-app usage history, so it
//!   never claims a permission is "unused". It only reports a *count* crossing a
//!   documented threshold.
//!
//! Penalties are additive constants (below), so the grade is reproducible from
//! the findings alone — no hidden state, no wall clock.

use crate::spec::{CareArea, CareFinding, CareGrade, CareReport, Severity};

/// Reclaimable storage at or above this is a warning (2 GiB).
pub const STORAGE_WARNING_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Battery at or below this (and not charging) is critical.
pub const BATTERY_CRITICAL_PCT: u8 = 5;
/// Battery at or below this (and not charging) is a warning.
pub const BATTERY_LOW_PCT: u8 = 20;
/// Holding at least this many distinct sensitive grants is worth a nudge.
pub const MANY_SENSITIVE_GRANTS: usize = 20;

/// The battery facts the care report needs (coupled, so a partial state — e.g.
/// a level with no charging flag — cannot be constructed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BatteryCare {
    /// Reported level; values above 100 are clamped when assessed.
    pub level_pct: u8,
    pub charging: bool,
    pub thermal_throttled: bool,
}

/// Everything `assess` may be given. All fields optional: absent = unobserved.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CareInput {
    /// Reclaimable bytes from a junk scan ([`crate::JunkReport::reclaimable_bytes`]).
    pub storage_reclaimable_bytes: Option<u64>,
    pub battery: Option<BatteryCare>,
    /// Distinct granted `(app, resource)` pairs
    /// ([`crate::permissions::granted_resource_count`]).
    pub sensitive_grants: Option<usize>,
    /// Installed user apps the manager would offer for review
    /// (see [`crate::UninstallGuard::selectable`]).
    pub reviewable_apps: Option<usize>,
}

/// Fold the inputs into a care report.
pub fn assess(input: &CareInput) -> CareReport {
    let mut findings: Vec<CareFinding> = Vec::new();
    let mut assessed: Vec<CareArea> = Vec::new();
    let mut penalty: u32 = 0;

    if let Some(bytes) = input.storage_reclaimable_bytes {
        assessed.push(CareArea::Storage);
        if bytes >= STORAGE_WARNING_BYTES {
            penalty += 20;
            findings.push(storage_finding(
                Severity::Warning,
                "care.storage.reclaimableHigh",
                bytes,
            ));
        } else if bytes > 0 {
            penalty += 5;
            findings.push(storage_finding(
                Severity::Suggestion,
                "care.storage.reclaimable",
                bytes,
            ));
        }
    }

    if let Some(b) = input.battery {
        assessed.push(CareArea::Battery);
        let level = b.level_pct.min(100);
        if !b.charging && level <= BATTERY_CRITICAL_PCT {
            penalty += 30;
            findings.push(CareFinding {
                area: CareArea::Battery,
                severity: Severity::Critical,
                key: "care.battery.critical".to_string(),
                detail: Some(level.to_string()),
                reclaimable_bytes: 0,
            });
        } else if !b.charging && level <= BATTERY_LOW_PCT {
            penalty += 15;
            findings.push(CareFinding {
                area: CareArea::Battery,
                severity: Severity::Warning,
                key: "care.battery.low".to_string(),
                detail: Some(level.to_string()),
                reclaimable_bytes: 0,
            });
        }
        if b.thermal_throttled {
            penalty += 10;
            findings.push(CareFinding {
                area: CareArea::Battery,
                severity: Severity::Warning,
                key: "care.battery.thermal".to_string(),
                detail: None,
                reclaimable_bytes: 0,
            });
        }
    }

    if let Some(n) = input.sensitive_grants {
        assessed.push(CareArea::Permissions);
        if n >= MANY_SENSITIVE_GRANTS {
            penalty += 10;
            findings.push(CareFinding {
                area: CareArea::Permissions,
                severity: Severity::Suggestion,
                key: "care.permissions.many".to_string(),
                detail: Some(n.to_string()),
                reclaimable_bytes: 0,
            });
        }
    }

    if let Some(n) = input.reviewable_apps {
        assessed.push(CareArea::Apps);
        if n > 0 {
            // Informational: reviewing apps is good hygiene, never a fault.
            findings.push(CareFinding {
                area: CareArea::Apps,
                severity: Severity::Info,
                key: "care.apps.reviewable".to_string(),
                detail: Some(n.to_string()),
                reclaimable_bytes: 0,
            });
        }
    }

    // Most severe first, then by key, then by area — fully deterministic.
    findings.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then_with(|| a.key.cmp(&b.key))
            .then_with(|| a.area.cmp(&b.area))
    });

    // `CareReport::assessed` is documented as being in `CareArea` order, so sort
    // it rather than leaking the order the areas happen to be *probed* in
    // (Storage, Battery, Permissions, Apps ≠ the enum order).
    assessed.sort();

    let score = 100u32.saturating_sub(penalty).min(100) as u8;
    CareReport {
        score,
        grade: CareGrade::from_score(score),
        findings,
        assessed,
    }
}

fn storage_finding(severity: Severity, key: &str, bytes: u64) -> CareFinding {
    CareFinding {
        area: CareArea::Storage,
        severity,
        key: key.to_string(),
        detail: Some(bytes.to_string()),
        reclaimable_bytes: bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn battery(level_pct: u8, charging: bool, thermal: bool) -> BatteryCare {
        BatteryCare {
            level_pct,
            charging,
            thermal_throttled: thermal,
        }
    }

    #[test]
    fn no_data_is_explicitly_unassessed() {
        let r = assess(&CareInput::default());
        assert!(!r.has_data());
        assert!(r.assessed.is_empty());
        assert!(r.is_empty());
        // The score is vacuous; the UI must read `has_data()` before showing it.
        assert_eq!(r.score, 100);
    }

    #[test]
    fn zero_reclaimable_storage_is_healthy_but_assessed() {
        let r = assess(&CareInput {
            storage_reclaimable_bytes: Some(0),
            ..CareInput::default()
        });
        assert!(r.has_data());
        assert!(r.assessed_area(CareArea::Storage));
        assert!(r.is_empty());
        assert_eq!(r.score, 100);
        assert_eq!(r.grade, CareGrade::A);
    }

    #[test]
    fn storage_over_two_gib_is_a_warning() {
        let r = assess(&CareInput {
            storage_reclaimable_bytes: Some(STORAGE_WARNING_BYTES),
            ..CareInput::default()
        });
        assert_eq!(r.score, 80);
        assert_eq!(r.grade, CareGrade::B);
        let f = &r.findings[0];
        assert_eq!(f.severity, Severity::Warning);
        assert_eq!(f.key, "care.storage.reclaimableHigh");
        assert_eq!(f.reclaimable_bytes, STORAGE_WARNING_BYTES);
    }

    #[test]
    fn small_reclaimable_storage_is_only_a_suggestion() {
        let r = assess(&CareInput {
            storage_reclaimable_bytes: Some(1024),
            ..CareInput::default()
        });
        assert_eq!(r.score, 95);
        assert_eq!(r.grade, CareGrade::A);
        assert_eq!(r.findings[0].severity, Severity::Suggestion);
    }

    #[test]
    fn critical_battery_replaces_the_low_warning() {
        let r = assess(&CareInput {
            battery: Some(battery(3, false, false)),
            ..CareInput::default()
        });
        assert_eq!(r.findings.len(), 1);
        assert_eq!(r.findings[0].key, "care.battery.critical");
        assert_eq!(r.score, 70);
        assert_eq!(r.grade, CareGrade::C);
    }

    #[test]
    fn a_low_battery_warning_sits_between_critical_and_healthy() {
        let r = assess(&CareInput {
            battery: Some(battery(BATTERY_LOW_PCT, false, false)),
            ..CareInput::default()
        });
        assert_eq!(r.findings[0].key, "care.battery.low");
        assert_eq!(r.score, 85);
    }

    #[test]
    fn charging_suppresses_the_low_battery_finding() {
        let r = assess(&CareInput {
            battery: Some(battery(2, true, false)),
            ..CareInput::default()
        });
        assert!(r.is_empty());
        assert_eq!(r.score, 100);
        assert!(r.assessed_area(CareArea::Battery));
    }

    #[test]
    fn thermal_throttling_alone_is_a_warning() {
        let r = assess(&CareInput {
            battery: Some(battery(80, true, true)),
            ..CareInput::default()
        });
        assert_eq!(r.findings.len(), 1);
        assert_eq!(r.findings[0].key, "care.battery.thermal");
        assert_eq!(r.score, 90);
        assert_eq!(r.grade, CareGrade::A);
    }

    #[test]
    fn level_above_100_is_clamped() {
        let r = assess(&CareInput {
            battery: Some(battery(200, false, false)),
            ..CareInput::default()
        });
        // Clamped to 100 ⇒ not low ⇒ no finding.
        assert!(r.is_empty());
    }

    #[test]
    fn many_sensitive_grants_is_a_suggestion() {
        let below = assess(&CareInput {
            sensitive_grants: Some(MANY_SENSITIVE_GRANTS - 1),
            ..CareInput::default()
        });
        assert!(below.is_empty());
        let at = assess(&CareInput {
            sensitive_grants: Some(MANY_SENSITIVE_GRANTS),
            ..CareInput::default()
        });
        assert_eq!(at.findings[0].key, "care.permissions.many");
        assert_eq!(at.score, 90);
        assert!(at.assessed_area(CareArea::Permissions));
    }

    #[test]
    fn reviewable_apps_is_informational_and_never_lowers_the_score() {
        let r = assess(&CareInput {
            reviewable_apps: Some(12),
            ..CareInput::default()
        });
        assert_eq!(r.score, 100);
        assert_eq!(r.grade, CareGrade::A);
        assert_eq!(r.findings.len(), 1);
        assert_eq!(r.findings[0].severity, Severity::Info);
        assert_eq!(r.findings[0].key, "care.apps.reviewable");
        assert_eq!(r.findings[0].detail.as_deref(), Some("12"));
    }

    #[test]
    fn findings_are_sorted_most_severe_first() {
        let r = assess(&CareInput {
            storage_reclaimable_bytes: Some(STORAGE_WARNING_BYTES),
            battery: Some(battery(3, false, true)),
            sensitive_grants: Some(MANY_SENSITIVE_GRANTS),
            reviewable_apps: Some(4),
        });
        let severities: Vec<Severity> = r.findings.iter().map(|f| f.severity).collect();
        assert_eq!(
            severities,
            vec![
                Severity::Critical,   // battery below critical level
                Severity::Warning,    // thermal throttling
                Severity::Warning,    // storage over threshold
                Severity::Suggestion, // many sensitive grants
                Severity::Info,       // apps available for review
            ]
        );
        assert_eq!(r.at_least(Severity::Critical).count(), 1);
    }

    #[test]
    fn the_worst_case_folds_to_a_poor_grade() {
        let r = assess(&CareInput {
            storage_reclaimable_bytes: Some(STORAGE_WARNING_BYTES),
            battery: Some(battery(1, false, true)),
            sensitive_grants: Some(MANY_SENSITIVE_GRANTS),
            reviewable_apps: Some(1),
        });
        // 20 (storage) + 30 (battery) + 10 (thermal) + 10 (grants) = 70.
        assert_eq!(r.score, 30);
        assert_eq!(r.grade, CareGrade::D);
    }

    #[test]
    fn grade_boundaries_match_the_documented_thresholds() {
        assert_eq!(CareGrade::from_score(100), CareGrade::A);
        assert_eq!(CareGrade::from_score(90), CareGrade::A);
        assert_eq!(CareGrade::from_score(89), CareGrade::B);
        assert_eq!(CareGrade::from_score(75), CareGrade::B);
        assert_eq!(CareGrade::from_score(74), CareGrade::C);
        assert_eq!(CareGrade::from_score(60), CareGrade::C);
        assert_eq!(CareGrade::from_score(59), CareGrade::D);
        assert_eq!(CareGrade::from_score(0), CareGrade::D);
    }

    #[test]
    fn assess_is_deterministic() {
        let input = CareInput {
            storage_reclaimable_bytes: Some(4096),
            battery: Some(battery(10, false, false)),
            sensitive_grants: Some(3),
            reviewable_apps: Some(2),
        };
        assert_eq!(assess(&input), assess(&input));
    }

    #[test]
    fn assessed_areas_are_reported_in_care_area_order() {
        // `CareReport::assessed` is documented as being in `CareArea` order, which
        // is NOT the order the areas are probed in — so it must be sorted, not
        // leaked. (Storage, Apps, Battery, Permissions.)
        let r = assess(&CareInput {
            storage_reclaimable_bytes: Some(1),
            battery: Some(battery(50, false, false)),
            sensitive_grants: Some(1),
            reviewable_apps: Some(1),
        });
        assert_eq!(
            r.assessed,
            vec![
                CareArea::Storage,
                CareArea::Apps,
                CareArea::Battery,
                CareArea::Permissions
            ]
        );
        // A partial observation keeps the same relative order.
        let only_battery = assess(&CareInput {
            battery: Some(battery(50, false, false)),
            ..CareInput::default()
        });
        assert_eq!(only_battery.assessed, vec![CareArea::Battery]);
    }
}

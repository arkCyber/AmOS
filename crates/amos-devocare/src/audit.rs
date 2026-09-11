//! Audit-**event construction** for device-care actions.
//!
//! Pure: this module decides *what* a clean / uninstall records, never where it
//! goes. The Tauri bridge turns these into the daemon's wire `AuditRecord` and
//! the daemon appends them to the **unified durable sink**
//! (`amos-ai::audit::AuditFile`, the same JSON-lines file the privacy decisions
//! are mirrored to), so "who removed what, and did it work" ends up in one
//! trail instead of a second, private one.
//!
//! Keeping the decision here (rather than in the bridge) means the audit content
//! is offline-testable, and the Tauri layer stays a thin transport.

use crate::spec::{CleanOutcome, JunkKind, UninstallVerdict};

/// The acting principal recorded for every device-care action.
pub const ACTOR: &str = "com.amos.devocare";
/// One batch clean (the aggregate result).
pub const OP_CLEAN: &str = "devcare.clean";
/// One item a clean could not remove.
pub const OP_CLEAN_ITEM: &str = "devcare.clean.item";
/// One app uninstall — including an attempt the policy **refused**.
pub const OP_UNINSTALL: &str = "app.uninstall";
/// One memory boost (the aggregate result: what was asked, what was accepted).
pub const OP_BOOST: &str = "devcare.boost";
/// One app a boost could not reclaim.
pub const OP_BOOST_ITEM: &str = "devcare.boost.item";

/// The wire outcome keys (mirror of `amos-ai::audit::Outcome`'s lowercase form).
pub const OUTCOME_SUCCESS: &str = "success";
pub const OUTCOME_REJECTED: &str = "rejected";
pub const OUTCOME_ERROR: &str = "error";

/// Maximum per-item failure records one clean may emit (bounded trail: a clean
/// that fails on 5 000 items must not write 5 000 audit rows).
pub const MAX_ITEM_RECORDS: usize = 50;
/// Maximum length of an audited `resource` (a path / package id), in chars.
pub const MAX_RESOURCE_CHARS: usize = 200;
/// Maximum length of audited free-form details, in chars.
pub const MAX_DETAILS_CHARS: usize = 300;

/// One normalized device-care audit event (transport-agnostic).
///
/// `principal`/`op`/`resource`/`outcome`/`details` mirror the daemon's
/// `AuditRecord` fields 1:1 so the bridge needs no mapping logic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CareAuditEvent {
    pub principal: String,
    pub op: String,
    pub resource: String,
    pub outcome: String,
    pub details: String,
}

/// Truncate to `max` **chars** (never bytes — this must not split a UTF-8
/// sequence) and mark that it happened.
fn bounded(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// The audit trail for one clean run: an aggregate record plus one record per
/// failure (bounded by [`MAX_ITEM_RECORDS`]).
///
/// The aggregate outcome is `success` only when **nothing** failed; a partially
/// failed clean is `error`, so the trail can never describe a broken clean as a
/// success. `planned` uses [`CleanOutcome::attempted`] (the invariant is that
/// every planned item is accounted for).
pub fn clean_events(
    actor: &str,
    requested: &[JunkKind],
    outcome: &CleanOutcome,
) -> Vec<CareAuditEvent> {
    let kinds = requested
        .iter()
        .map(|k| k.key())
        .collect::<Vec<_>>()
        .join(",");

    let aggregate = CareAuditEvent {
        principal: actor.to_string(),
        op: OP_CLEAN.to_string(),
        resource: bounded(&kinds, MAX_RESOURCE_CHARS),
        outcome: if outcome.failures.is_empty() {
            OUTCOME_SUCCESS
        } else {
            OUTCOME_ERROR
        }
        .to_string(),
        details: format!(
            "planned={} freed_bytes={} removed={} failed={}",
            outcome.attempted(),
            outcome.freed_bytes,
            outcome.removed_count(),
            outcome.failed_count()
        ),
    };

    let mut events = Vec::with_capacity(1 + outcome.failures.len().min(MAX_ITEM_RECORDS));
    events.push(aggregate);
    for f in outcome.failures.iter().take(MAX_ITEM_RECORDS) {
        events.push(CareAuditEvent {
            principal: actor.to_string(),
            op: OP_CLEAN_ITEM.to_string(),
            resource: bounded(&f.uri, MAX_RESOURCE_CHARS),
            outcome: OUTCOME_ERROR.to_string(),
            details: bounded(&f.message, MAX_DETAILS_CHARS),
        });
    }
    events
}

/// The audit record for an uninstall the policy **refused**.
///
/// Recorded as a `rejected` attempt (not as a success) so a refusal is visible
/// in the trail — that is the whole point of auditing a protected package.
pub fn uninstall_refused(
    actor: &str,
    package_id: &str,
    verdict: UninstallVerdict,
) -> CareAuditEvent {
    CareAuditEvent {
        principal: actor.to_string(),
        op: OP_UNINSTALL.to_string(),
        resource: bounded(package_id, MAX_RESOURCE_CHARS),
        outcome: OUTCOME_REJECTED.to_string(),
        details: verdict.key().to_string(),
    }
}

/// The audit record for an uninstall that was actually attempted.
pub fn uninstall_performed(
    actor: &str,
    package_id: &str,
    ok: bool,
    message: &str,
) -> CareAuditEvent {
    CareAuditEvent {
        principal: actor.to_string(),
        op: OP_UNINSTALL.to_string(),
        resource: bounded(package_id, MAX_RESOURCE_CHARS),
        outcome: if ok { OUTCOME_SUCCESS } else { OUTCOME_ERROR }.to_string(),
        details: bounded(message, MAX_DETAILS_CHARS),
    }
}

/// The outcome of **one** reclaim request a boost sent to the governor.
///
/// The bridge records one of these per requested app, in request order, so the
/// trail can describe a partial boost item by item — the same honesty rule as
/// [`crate::CleanOutcome::failures`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoostReclaim {
    /// The app id that was named in the reclaim request.
    pub id: String,
    /// Whether the governor accepted the request.
    pub ok: bool,
    /// The governor's error for a refused request (unused when `ok`).
    pub message: String,
}

/// The audit trail for one memory boost: an aggregate record plus one record
/// per **failed** reclaim (bounded by [`MAX_ITEM_RECORDS`]).
///
/// The aggregate outcome is `success` only when **nothing** failed **and**
/// every requested app was actually attempted (`attempts.len() ==
/// requested.len()`); a partial boost — or a boost whose bookkeeping lost an
/// app — is `error`, so the trail can never describe a broken boost as a
/// success — the same rule as [`clean_events`] (whose `planned` comes from
/// [`crate::CleanOutcome::attempted`]). Every count is derived from the inputs
/// themselves (`requested.len()` and the `ok` flags), so the aggregate cannot
/// disagree with its own item records. An unattempted app gets **no** item
/// record (fabricating a governor message would be its own lie); the
/// `requested=N attempted=A` gap in the details is what makes it visible.
pub fn boost_events(
    actor: &str,
    requested: &[String],
    attempts: &[BoostReclaim],
) -> Vec<CareAuditEvent> {
    let reclaimed = attempts.iter().filter(|a| a.ok).count();
    let failed = attempts.len() - reclaimed;

    let aggregate = CareAuditEvent {
        principal: actor.to_string(),
        op: OP_BOOST.to_string(),
        resource: bounded(requested.join(",").as_str(), MAX_RESOURCE_CHARS),
        outcome: if failed == 0 && attempts.len() == requested.len() {
            OUTCOME_SUCCESS
        } else {
            OUTCOME_ERROR
        }
        .to_string(),
        details: format!(
            "requested={} attempted={} reclaimed={} failed={}",
            requested.len(),
            attempts.len(),
            reclaimed,
            failed
        ),
    };

    let failures = attempts.iter().filter(|a| !a.ok);
    let mut events = Vec::with_capacity(1 + failures.clone().count().min(MAX_ITEM_RECORDS));
    events.push(aggregate);
    for f in failures.take(MAX_ITEM_RECORDS) {
        events.push(CareAuditEvent {
            principal: actor.to_string(),
            op: OP_BOOST_ITEM.to_string(),
            resource: bounded(&f.id, MAX_RESOURCE_CHARS),
            outcome: OUTCOME_ERROR.to_string(),
            details: bounded(&f.message, MAX_DETAILS_CHARS),
        });
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::{CleanFailure, CleanOutcome, JunkItem};

    fn ok_items(n: usize) -> Vec<JunkItem> {
        (0..n)
            .map(|i| JunkItem::new(format!("ok{i}"), JunkKind::AppCache, 1))
            .collect()
    }

    fn fail(uri: &str, msg: &str) -> CleanFailure {
        CleanFailure {
            uri: uri.to_string(),
            kind: JunkKind::LogFile,
            size_bytes: 1,
            message: msg.to_string(),
        }
    }

    fn outcome(removed: usize, freed: u64, failures: Vec<CleanFailure>) -> CleanOutcome {
        CleanOutcome {
            removed: ok_items(removed),
            freed_bytes: freed,
            failures,
        }
    }

    #[test]
    fn a_clean_with_no_failures_is_exactly_one_success_record() {
        let o = outcome(3, 512, vec![]);
        let events = clean_events(ACTOR, &[JunkKind::AppCache, JunkKind::LogFile], &o);
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.principal, ACTOR);
        assert_eq!(e.op, OP_CLEAN);
        assert_eq!(e.resource, "app_cache,log_file");
        assert_eq!(e.outcome, OUTCOME_SUCCESS);
        assert_eq!(e.details, "planned=3 freed_bytes=512 removed=3 failed=0");
    }

    #[test]
    fn a_partial_clean_is_error_plus_one_record_per_failure() {
        let o = outcome(1, 10, vec![fail("/x/a", "locked"), fail("/x/b", "gone")]);
        let events = clean_events(ACTOR, &[JunkKind::AppCache], &o);
        assert_eq!(events.len(), 3, "aggregate + 2 item records");
        // The aggregate must never describe a broken clean as a success.
        assert_eq!(events[0].outcome, OUTCOME_ERROR);
        assert_eq!(
            events[0].details,
            "planned=3 freed_bytes=10 removed=1 failed=2"
        );
        assert_eq!(events[1].op, OP_CLEAN_ITEM);
        assert_eq!(events[1].resource, "/x/a");
        assert_eq!(events[1].outcome, OUTCOME_ERROR);
        assert_eq!(events[1].details, "locked");
        assert_eq!(events[2].resource, "/x/b");
    }

    #[test]
    fn per_item_records_are_bounded() {
        let failures: Vec<CleanFailure> = (0..MAX_ITEM_RECORDS + 25)
            .map(|i| fail(&format!("/x/{i}"), "boom"))
            .collect();
        let count = failures.len();
        let events = clean_events(ACTOR, &[JunkKind::LogFile], &outcome(0, 0, failures));
        assert_eq!(events.len(), 1 + MAX_ITEM_RECORDS, "the trail is bounded");
        // The aggregate still reports the true failure count.
        assert!(events[0].details.contains(&format!("failed={count}")));
    }

    #[test]
    fn long_paths_and_messages_are_truncated_on_char_boundaries() {
        // Multi-byte chars: a byte-wise truncation would produce invalid UTF-8.
        let long_path = "日".repeat(MAX_RESOURCE_CHARS + 50);
        let long_msg = "语".repeat(MAX_DETAILS_CHARS + 50);
        let o = outcome(0, 0, vec![fail(&long_path, &long_msg)]);
        let events = clean_events(ACTOR, &[JunkKind::LogFile], &o);
        assert_eq!(
            events[1].resource.chars().count(),
            MAX_RESOURCE_CHARS + 1,
            "truncated + marker"
        );
        assert!(events[1].resource.ends_with('…'));
        assert_eq!(events[1].details.chars().count(), MAX_DETAILS_CHARS + 1);
        assert!(events[1].details.ends_with('…'));
        // A short value is passed through untouched.
        let short = clean_events(
            ACTOR,
            &[JunkKind::LogFile],
            &outcome(0, 0, vec![fail("/a", "m")]),
        );
        assert_eq!(short[1].resource, "/a");
        assert_eq!(short[1].details, "m");
    }

    #[test]
    fn a_refused_uninstall_is_a_rejected_record() {
        let e = uninstall_refused(ACTOR, "com.android.settings", UninstallVerdict::Protected);
        assert_eq!(e.op, OP_UNINSTALL);
        assert_eq!(e.resource, "com.android.settings");
        assert_eq!(e.outcome, OUTCOME_REJECTED, "a refusal is visible");
        assert_eq!(e.details, "protected");
    }

    #[test]
    fn a_performed_uninstall_maps_ok_to_success() {
        let ok = uninstall_performed(ACTOR, "com.example.game", true, "removed");
        assert_eq!(ok.outcome, OUTCOME_SUCCESS);
        assert_eq!(ok.details, "removed");

        let bad = uninstall_performed(ACTOR, "com.example.game", false, "io error");
        assert_eq!(bad.outcome, OUTCOME_ERROR);
        assert_eq!(bad.details, "io error");
    }

    #[test]
    fn the_trail_is_deterministic() {
        let o = outcome(1, 5, vec![fail("/x/a", "m")]);
        let a = clean_events(ACTOR, &[JunkKind::AppCache, JunkKind::LogFile], &o);
        let b = clean_events(ACTOR, &[JunkKind::AppCache, JunkKind::LogFile], &o);
        assert_eq!(a, b);
    }

    fn boost(id: &str, ok: bool, msg: &str) -> BoostReclaim {
        BoostReclaim {
            id: id.to_string(),
            ok,
            message: msg.to_string(),
        }
    }

    #[test]
    fn a_boost_with_no_failures_is_exactly_one_success_record() {
        let requested = vec!["com.a".to_string(), "com.b".to_string()];
        let attempts = vec![boost("com.a", true, ""), boost("com.b", true, "")];
        let events = boost_events(ACTOR, &requested, &attempts);
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.principal, ACTOR);
        assert_eq!(e.op, OP_BOOST);
        assert_eq!(e.resource, "com.a,com.b");
        assert_eq!(e.outcome, OUTCOME_SUCCESS);
        assert_eq!(e.details, "requested=2 attempted=2 reclaimed=2 failed=0");
    }

    #[test]
    fn a_partial_boost_is_error_plus_one_record_per_failure() {
        let requested = vec![
            "com.a".to_string(),
            "com.b".to_string(),
            "com.c".to_string(),
        ];
        let attempts = vec![
            boost("com.a", true, ""),
            boost("com.b", false, "governor refused"),
            boost("com.c", true, ""),
        ];
        let events = boost_events(ACTOR, &requested, &attempts);
        assert_eq!(events.len(), 2, "aggregate + 1 failed item");
        // The aggregate must never describe a broken boost as a success.
        assert_eq!(events[0].outcome, OUTCOME_ERROR);
        assert_eq!(
            events[0].details,
            "requested=3 attempted=3 reclaimed=2 failed=1"
        );
        assert_eq!(events[1].op, OP_BOOST_ITEM);
        assert_eq!(events[1].resource, "com.b");
        assert_eq!(events[1].outcome, OUTCOME_ERROR);
        assert_eq!(events[1].details, "governor refused");
    }

    #[test]
    fn a_boost_that_did_not_attempt_every_request_is_never_a_success() {
        // Bookkeeping lost an app (2 attempts for 3 requests): the trail must
        // not read as a full success, and the gap must be visible in the
        // details — without fabricating an item record for the unattempted app.
        let requested = vec![
            "com.a".to_string(),
            "com.b".to_string(),
            "com.c".to_string(),
        ];
        let attempts = vec![boost("com.a", true, ""), boost("com.b", true, "")];
        let events = boost_events(ACTOR, &requested, &attempts);
        assert_eq!(events.len(), 1, "no fabricated failure records");
        assert_eq!(events[0].outcome, OUTCOME_ERROR);
        assert_eq!(
            events[0].details,
            "requested=3 attempted=2 reclaimed=2 failed=0"
        );
        assert!(events[0].resource.contains("com.c"), "the request is named");
    }

    #[test]
    fn an_attempt_beyond_the_request_is_visible_and_not_a_success() {
        let requested = vec!["com.a".to_string()];
        let attempts = vec![boost("com.a", true, ""), boost("com.ghost", true, "")];
        let events = boost_events(ACTOR, &requested, &attempts);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].outcome, OUTCOME_ERROR);
        assert_eq!(
            events[0].details,
            "requested=1 attempted=2 reclaimed=2 failed=0"
        );
    }

    #[test]
    fn a_boost_with_nothing_to_reclaim_is_one_honest_success_record() {
        let events = boost_events(ACTOR, &[], &[]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].outcome, OUTCOME_SUCCESS);
        assert_eq!(
            events[0].details,
            "requested=0 attempted=0 reclaimed=0 failed=0"
        );
    }

    #[test]
    fn boost_item_records_are_bounded_and_truncated_on_char_boundaries() {
        let long_id = "日".repeat(MAX_RESOURCE_CHARS + 50);
        let long_msg = "语".repeat(MAX_DETAILS_CHARS + 50);
        let count = MAX_ITEM_RECORDS + 25;
        let attempts: Vec<BoostReclaim> = (0..count)
            .map(|i| {
                if i == 0 {
                    boost(&long_id, false, &long_msg)
                } else {
                    boost(&format!("com.f{i}"), false, "boom")
                }
            })
            .collect();
        let requested: Vec<String> = (0..count).map(|i| format!("com.r{i}")).collect();
        let events = boost_events(ACTOR, &requested, &attempts);
        assert_eq!(events.len(), 1 + MAX_ITEM_RECORDS, "the trail is bounded");
        // The aggregate still reports the true attempted/failure counts.
        assert!(events[0].details.contains(&format!("attempted={count}")));
        assert!(events[0].details.contains(&format!("failed={count}")));
        // Multi-byte ids/messages truncate on char boundaries, not bytes.
        assert!(events[1].resource.ends_with('…'));
        assert_eq!(events[1].resource.chars().count(), MAX_RESOURCE_CHARS + 1);
        assert!(events[1].details.ends_with('…'));
        assert_eq!(events[1].details.chars().count(), MAX_DETAILS_CHARS + 1);
    }

    #[test]
    fn the_boost_trail_is_deterministic() {
        let requested = vec!["com.a".to_string(), "com.b".to_string()];
        let attempts = vec![boost("com.a", true, ""), boost("com.b", false, "m")];
        let a = boost_events(ACTOR, &requested, &attempts);
        let b = boost_events(ACTOR, &requested, &attempts);
        assert_eq!(a, b);
    }
}

//! Container **ActivityManager observer → OnActivity folding** (the seam between
//! a real Android task's per-activity lifecycle and the LMK-proxy's `OnActivity`
//! wire). This module owns the purely-algorithmic, fully-offline-testable core;
//! the on-device hook (reading ActivityManager / `dumpsys` / binder and turning
//! each callback into an [`ActivityState`] here) is the remaining device seam.
//!
//! Contract (matches `service.rs::dispatch_activity`):
//! - a stable `activity_id` from the Activity's `ComponentName` + instance;
//! - `onStart`  → `ActivityEvent::Started(id)`  (register alive; never demotes);
//! - `onResume` → `ActivityEvent::Resume(id)`   (this activity becomes the top);
//! - `onPause` → forwarded only when `id` is the task's top *after* the update;
//! - `onStop` → forwarded when the stopping activity **was** the task's top
//!   (a foreground top going `Stopped` backgrounds the whole package even when
//!   nothing is visible afterwards), but a stopped "sibling" below a still-top
//!   activity must not demote it — the proxy gates this too, so the observer
//!   being conservative is safe;
//! - `onDestroy` → `ActivityEvent::Destroy(id)` (task torn down only on its last
//!   live activity, per the proxy's `destroy_last`).

use std::collections::BTreeMap;

use amos_proto::android_compat::{ActivityEvent, ActivityEventRequest};

use crate::lmk::ActivityState;

/// Build a stable, opaque activity identity from a `ComponentName` and a per-task
/// instance counter. `component` is e.g. `com.tencent.mm/.ui.LauncherUI`; two
/// instances of the same component in one task get distinct ids.
pub fn activity_id(component: &str, instance: u64) -> String {
    format!("{component}#{instance}")
}

/// Split an id produced by [`activity_id`] back into `(component, instance)`.
pub fn activity_id_parts(id: &str) -> Option<(&str, u64)> {
    let (c, inst) = id.rsplit_once('#')?;
    Some((c, inst.parse().ok()?))
}

/// Per-package observer that folds a raw per-activity lifecycle into the
/// `OnActivity` request stream (with the top-gating contract above).
#[derive(Debug, Default)]
pub struct FoldingObserver {
    package_name: String,
    /// activity_id -> its current lifecycle state.
    activities: BTreeMap<String, ActivityState>,
    /// Activity ids ordered by recency (most recently active first).
    order: Vec<String>,
}

impl FoldingObserver {
    /// New observer for `package_name`.
    pub fn new(package_name: impl Into<String>) -> Self {
        Self {
            package_name: package_name.into(),
            ..Default::default()
        }
    }

    /// The id currently driving the task's *importance* (the top): the most
    /// recent activity that is resumed, else the most recent that is still
    /// on-stage (created/started/paused). `None` when none is visible.
    pub fn top(&self) -> Option<&str> {
        for id in &self.order {
            let st = self
                .activities
                .get(id)
                .copied()
                .unwrap_or(ActivityState::Destroyed);
            if st == ActivityState::Resumed {
                return Some(id);
            }
        }
        for id in &self.order {
            let st = self
                .activities
                .get(id)
                .copied()
                .unwrap_or(ActivityState::Destroyed);
            if matches!(
                st,
                ActivityState::Created | ActivityState::Started | ActivityState::Paused
            ) {
                return Some(id);
            }
        }
        None
    }

    /// Fold one observed per-activity lifecycle transition and return the
    /// `OnActivity` requests to send for `package_name`.
    pub fn observe(
        &mut self,
        activity_id: &str,
        state: ActivityState,
    ) -> Vec<ActivityEventRequest> {
        let mut out = Vec::new();
        // Destroy removes the activity entirely (task membership ends).
        if state == ActivityState::Destroyed {
            self.activities.remove(activity_id);
            self.order.retain(|id| id != activity_id);
            out.push(self.req(ActivityEvent::Destroy, activity_id));
            return out;
        }

        let was_tracked = self.activities.contains_key(activity_id);
        // Was this activity the one driving the task's *importance* before this
        // transition (the resumed top, else the most-recent still-visible one)?
        // Capture it *before* the insert: once we store `Stopped` below, a top
        // that just stopped is no longer "visible" (`top()` -> `None`), but its
        // Stop must still be forwarded so the package drops to background.
        let was_top = self.top() == Some(activity_id);
        self.activities.insert(activity_id.to_string(), state);
        self.order.retain(|id| id != activity_id);
        self.order.insert(0, activity_id.to_string());

        // A brand-new live activity is always registered (liveness), even if it
        // is not the top — a later Destroy of it must decrement correctly.
        if !was_tracked {
            out.push(self.req(ActivityEvent::Started, activity_id));
        }

        // Importance transitions. Resume/Pause are forwarded only when the
        // activity is the task's top after this update. A *Stop* is forwarded
        // when the stopping activity was the task's driver — a foreground top
        // going `Stopped` backgrounds the whole package even though nothing is
        // visible afterwards — whereas a stopped "sibling" below a still-top
        // activity must not demote it (matches the proxy's `stop_activity`).
        let is_top = self.top() == Some(activity_id);
        match state {
            ActivityState::Resumed => {
                if is_top {
                    out.push(self.req(ActivityEvent::Resume, activity_id));
                }
            }
            ActivityState::Paused => {
                if is_top {
                    out.push(self.req(ActivityEvent::Pause, activity_id));
                }
            }
            ActivityState::Stopped => {
                if was_top || is_top {
                    out.push(self.req(ActivityEvent::Stop, activity_id));
                }
            }
            // Started is a liveness registration (already pushed above), not an
            // importance event.
            ActivityState::Started | ActivityState::Created | ActivityState::Destroyed => {}
        }
        out
    }

    fn req(&self, event: ActivityEvent, activity_id: &str) -> ActivityEventRequest {
        ActivityEventRequest {
            package_name: self.package_name.clone(),
            event: event as i32,
            activity_id: activity_id.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(reqs: &[ActivityEventRequest]) -> Vec<ActivityEvent> {
        reqs.iter()
            .filter_map(|r| ActivityEvent::try_from(r.event).ok())
            .collect()
    }
    fn ids(reqs: &[ActivityEventRequest]) -> Vec<&str> {
        reqs.iter().map(|r| r.activity_id.as_str()).collect()
    }

    #[test]
    fn activity_id_round_trips() {
        let id = activity_id("com.tencent.mm/.ui.LauncherUI", 3);
        assert_eq!(id, "com.tencent.mm/.ui.LauncherUI#3");
        assert_eq!(
            activity_id_parts(&id),
            Some(("com.tencent.mm/.ui.LauncherUI", 3))
        );
        assert_eq!(activity_id_parts("nohash"), None);
    }

    #[test]
    fn start_then_resume_registers_liveness_and_foreground() {
        let mut o = FoldingObserver::new("com.tencent.mm");
        let id = activity_id("com.tencent.mm/.ui.LauncherUI", 1);
        let started = o.observe(&id, ActivityState::Started);
        assert_eq!(kinds(&started), vec![ActivityEvent::Started]);
        let resumed = o.observe(&id, ActivityState::Resumed);
        assert_eq!(kinds(&resumed), vec![ActivityEvent::Resume]);
        assert_eq!(o.top(), Some(id.as_str()));
    }

    #[test]
    fn stopping_the_foreground_top_backgrounds_the_task() {
        // The whole-app-to-background path: a single foreground Activity gets
        // onPause (still visible -> Pause), then onStop. That final Stop must be
        // forwarded even though, after the transition, nothing is visible any
        // more (`top()` == None) — otherwise the package never drops to
        // `Background` and LMK can never reclaim it.
        let mut o = FoldingObserver::new("com.app");
        let a = activity_id("com.app/A", 1);
        o.observe(&a, ActivityState::Started);
        o.observe(&a, ActivityState::Resumed); // A foreground
        let paused = o.observe(&a, ActivityState::Paused);
        assert_eq!(kinds(&paused), vec![ActivityEvent::Pause]);
        let stopped = o.observe(&a, ActivityState::Stopped);
        assert_eq!(kinds(&stopped), vec![ActivityEvent::Stop]);
        assert_eq!(
            o.top(),
            None,
            "nothing visible once the only activity stops"
        );
        // A duplicate Stop of the already-stopped top must not re-fire.
        assert!(o.observe(&a, ActivityState::Stopped).is_empty());
    }

    #[test]
    fn top_stop_while_a_sibling_is_still_resumed_is_suppressed() {
        // A paused-then-stopped *lower* activity must not demote a sibling that
        // is still the resumed top — even when the stopping one was foregrounded
        // first. Only the current driver's own stop demotes.
        let mut o = FoldingObserver::new("com.app");
        let a = activity_id("com.app/A", 1);
        let b = activity_id("com.app/B", 2);
        o.observe(&a, ActivityState::Started);
        o.observe(&a, ActivityState::Resumed); // A foreground
        o.observe(&b, ActivityState::Started); // B alive below
        o.observe(&a, ActivityState::Paused); // A pauses (still driver -> Pause)
        o.observe(&b, ActivityState::Resumed); // B becomes the top driver
                                               // A now stops below the still-resumed B: must NOT demote B.
        let a_stop = o.observe(&a, ActivityState::Stopped);
        assert!(a_stop.is_empty());
        assert_eq!(o.top(), Some(b.as_str()));
    }

    #[test]
    fn non_top_stop_is_not_forwarded_as_package_stop() {
        let mut o = FoldingObserver::new("com.app");
        let a = activity_id("com.app/A", 1);
        let b = activity_id("com.app/B", 2);
        o.observe(&a, ActivityState::Started);
        o.observe(&a, ActivityState::Resumed); // A foreground
        o.observe(&b, ActivityState::Started); // B alive below (liveness only)
        o.observe(&b, ActivityState::Resumed); // B becomes top
                                               // A is a stopped sibling below B: its onStop must NOT be forwarded as a
                                               // package Stop (which would demote the still-foreground B).
        let a_stop = o.observe(&a, ActivityState::Stopped);
        assert!(a_stop.is_empty());
        assert_eq!(o.top(), Some(b.as_str()));
    }

    #[test]
    fn destroy_of_top_keeps_lower_sibling_alive() {
        let mut o = FoldingObserver::new("com.app");
        let a = activity_id("com.app/A", 1);
        let b = activity_id("com.app/B", 2);
        o.observe(&a, ActivityState::Started);
        o.observe(&a, ActivityState::Resumed); // A top
        o.observe(&b, ActivityState::Started);
        o.observe(&b, ActivityState::Resumed); // B top
                                               // B (top) finishes -> A is still alive; only a Destroy(B) is emitted.
        let destroy_b = o.observe(&b, ActivityState::Destroyed);
        assert_eq!(kinds(&destroy_b), vec![ActivityEvent::Destroy]);
        assert_eq!(ids(&destroy_b), vec![b.as_str()]);
        assert_eq!(o.top(), Some(a.as_str())); // A is the surviving top
    }
}

//! The [`AppLifecycle`] registry: tracks each process's [`AppState`], keeps an
//! LRU ordering (every transition bumps a monotonic sequence) and exposes a
//! deterministic memory-pressure **reclaim** selector (the LMK-proxy).

use std::collections::BTreeMap;

use crate::error::{LifecycleError, Result};
use crate::spec::{AppId, AppState};

/// One tracked process: its id, current lifecycle state and last-active sequence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessRecord {
    pub id: AppId,
    pub state: AppState,
    /// Monotonic "last active" sequence — larger = more recently used.
    pub seq: u64,
}

impl ProcessRecord {
    pub fn state(&self) -> AppState {
        self.state
    }
}

/// The per-process lifecycle registry.
pub struct AppLifecycle {
    records: BTreeMap<AppId, ProcessRecord>,
    /// Monotonic clock for LRU ordering (bumped on every state change).
    counter: u64,
}

impl Default for AppLifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl AppLifecycle {
    pub fn new() -> Self {
        Self {
            records: BTreeMap::new(),
            counter: 0,
        }
    }

    /// Number of tracked processes.
    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// Whether a process with `id` is tracked.
    pub fn contains(&self, id: &AppId) -> bool {
        self.records.contains_key(id)
    }

    /// Whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// The current state of `id`; [`LifecycleError::Unknown`] if not tracked.
    pub fn state(&self, id: &AppId) -> Result<AppState> {
        self.records
            .get(id)
            .map(|r| r.state)
            .ok_or_else(|| LifecycleError::Unknown(id.to_string()))
    }

    /// All tracked ids (stable order).
    pub fn ids(&self) -> Vec<AppId> {
        self.records.keys().cloned().collect()
    }

    /// A copy of the record for `id`.
    pub fn record(&self, id: &AppId) -> Option<ProcessRecord> {
        self.records.get(id).cloned()
    }

    /// Launch (or bring to front) `id` into [`AppState::Foreground`]. Creates the
    /// record when it is not yet tracked; cheap-relaunches a `Stopped`/`Cached`
    /// process that kept its saved state.
    pub fn launch(&mut self, id: AppId) -> Result<()> {
        self.move_to(id, AppState::Foreground, true)
    }

    /// Bring an existing, tracked process to the foreground.
    pub fn go_foreground(&mut self, id: AppId) -> Result<()> {
        self.move_to(id, AppState::Foreground, false)
    }

    /// Move an existing process to the background (it lost the user's focus).
    pub fn go_background(&mut self, id: AppId) -> Result<()> {
        self.move_to(id, AppState::Background, false)
    }

    /// Freeze a background process into the `Cached` tombstone (state saved, no
    /// work scheduled) — typically under memory / energy pressure.
    pub fn freeze(&mut self, id: AppId) -> Result<()> {
        self.move_to(id, AppState::Cached, false)
    }

    /// Un-freeze a `Cached` process back to `Background` (partial resume).
    pub fn thaw(&mut self, id: AppId) -> Result<()> {
        self.move_to(id, AppState::Background, false)
    }

    /// Promote an existing process to a user-perceptible foreground service.
    pub fn start_service(&mut self, id: AppId) -> Result<()> {
        self.move_to(id, AppState::ForegroundService, false)
    }

    /// Demote a foreground service back to a plain background process.
    pub fn stop_service(&mut self, id: AppId) -> Result<()> {
        self.move_to(id, AppState::Background, false)
    }

    /// Stop (kill) a running process but **keep its saved-state record** so a
    /// later [`Self::launch`] is a cheap resume.
    pub fn stop(&mut self, id: AppId) -> Result<()> {
        self.move_to(id, AppState::Stopped, false)
    }

    /// Remove a process from the registry entirely (dropped, no saved state).
    pub fn kill(&mut self, id: &AppId) -> bool {
        self.records.remove(id).is_some()
    }

    /// The shared low-level transition: set `id` to `to`, erroring when the id is
    /// not tracked and `create_if_missing` is false. Every change bumps the LRU
    /// sequence (the process becomes "most recently used").
    fn move_to(&mut self, id: AppId, to: AppState, create_if_missing: bool) -> Result<()> {
        if !self.records.contains_key(&id) && !create_if_missing {
            return Err(LifecycleError::Unknown(id.to_string()));
        }
        self.counter += 1;
        self.records.insert(
            id.clone(),
            ProcessRecord {
                id,
                state: to,
                seq: self.counter,
            },
        );
        Ok(())
    }

    /// Reclaim-candidates under memory/energy pressure: up to `budget` processes
    /// drawn from the reclaimable tiers (`Cached` first, then `Background`),
    /// **least-recently-used first** within a tier. Protected states
    /// (foreground/visible/foreground-service) are never returned, and `Stopped`
    /// records are not running so they are not returned either.
    ///
    /// Deterministic (depends only on the records) — the caller kills the victims.
    pub fn reclaim_candidates(&self, budget: usize) -> Vec<AppId> {
        if budget == 0 {
            return Vec::new();
        }
        // Collect reclaimable records; order so that the highest rank (least
        // important) comes first, and among equal rank the LRU (smallest seq).
        let mut reclaimable: Vec<&ProcessRecord> = self
            .records
            .values()
            .filter(|r| r.state.is_reclaimable())
            .collect();
        reclaimable.sort_by(|a, b| {
            // Cached (4) sorts before Background (3) → descending rank first.
            b.state
                .rank()
                .cmp(&a.state.rank())
                .then_with(|| a.seq.cmp(&b.seq))
        });
        reclaimable
            .into_iter()
            .take(budget)
            .map(|r| r.id.clone())
            .collect()
    }

    /// Per-state process counts (for a UI / diagnostics "running / cached" tile).
    pub fn counts(&self) -> BTreeMap<AppState, usize> {
        let mut m: BTreeMap<AppState, usize> = BTreeMap::new();
        for r in self.records.values() {
            *m.entry(r.state).or_insert(0) += 1;
        }
        m
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(s: &str) -> AppId {
        AppId::new(s)
    }

    #[test]
    fn launch_creates_in_foreground_and_bumps_lru() {
        let mut lm = AppLifecycle::new();
        lm.launch(id("a")).unwrap();
        assert_eq!(lm.state(&id("a")).unwrap(), AppState::Foreground);
        assert_eq!(lm.len(), 1);
        assert_eq!(lm.record(&id("a")).unwrap().seq, 1);
    }

    #[test]
    fn moving_through_lifecycle_states() {
        let mut lm = AppLifecycle::new();
        lm.launch(id("a")).unwrap();
        lm.go_background(id("a")).unwrap();
        assert_eq!(lm.state(&id("a")).unwrap(), AppState::Background);
        lm.freeze(id("a")).unwrap();
        assert_eq!(lm.state(&id("a")).unwrap(), AppState::Cached);
        lm.thaw(id("a")).unwrap();
        assert_eq!(lm.state(&id("a")).unwrap(), AppState::Background);
        lm.go_foreground(id("a")).unwrap();
        assert_eq!(lm.state(&id("a")).unwrap(), AppState::Foreground);
    }

    #[test]
    fn unknown_process_is_an_error() {
        let mut lm = AppLifecycle::new();
        assert_eq!(
            lm.go_background(id("nope")),
            Err(LifecycleError::Unknown("nope".to_string()))
        );
        assert_eq!(
            lm.state(&id("nope")).unwrap_err().to_string(),
            "no such process: nope"
        );
    }

    #[test]
    fn stop_keeps_record_but_kill_removes() {
        let mut lm = AppLifecycle::new();
        lm.launch(id("a")).unwrap();
        lm.stop(id("a")).unwrap();
        assert_eq!(lm.state(&id("a")).unwrap(), AppState::Stopped);
        assert!(lm.contains(&id("a"))); // saved-state record survives
        lm.launch(id("a")).unwrap(); // cheap resume
        assert_eq!(lm.state(&id("a")).unwrap(), AppState::Foreground);
        assert!(lm.kill(&id("a")));
        assert!(!lm.contains(&id("a")));
        assert!(!lm.kill(&id("a")));
    }

    #[test]
    fn service_promotion_protects_from_reclaim() {
        let mut lm = AppLifecycle::new();
        lm.launch(id("music")).unwrap(); // Foreground
        lm.start_service(id("music")).unwrap();
        assert_eq!(lm.state(&id("music")).unwrap(), AppState::ForegroundService);
        // Reclaim never returns a foreground service.
        assert!(lm.reclaim_candidates(10).is_empty());
        lm.stop_service(id("music")).unwrap();
        assert_eq!(lm.state(&id("music")).unwrap(), AppState::Background);
        assert_eq!(lm.reclaim_candidates(10), vec![id("music")]);
    }

    #[test]
    fn counts_reflect_each_state() {
        let mut lm = AppLifecycle::new();
        lm.launch(id("fg")).unwrap();
        lm.launch(id("bg")).unwrap();
        lm.go_background(id("bg")).unwrap();
        lm.launch(id("svc")).unwrap();
        lm.freeze(id("svc")).unwrap();
        let c = lm.counts();
        assert_eq!(c.get(&AppState::Foreground), Some(&1));
        assert_eq!(c.get(&AppState::Background), Some(&1));
        assert_eq!(c.get(&AppState::Cached), Some(&1));
        assert_eq!(lm.len(), 3);
        assert_eq!(lm.ids().len(), 3);
    }
}

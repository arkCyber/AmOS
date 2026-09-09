//! Activity/Task lifecycle state machine + Low-Memory-Kill proxy (**LMK-proxy**).
//!
//! AmOS never lets the Waydroid / Android container's own `lmkd` silently decide
//! which legacy app gets killed behind the Tauri surface. This module is the
//! AmOS-side authority that **proxies** that decision: it keeps one record per
//! launched package (its container surface id / `window_id`, the top-Activity
//! lifecycle, an optional foreground-service flag, a frozen/`Cached` marker and
//! an LRU recency sequence), derives the process importance tier, and under
//! memory pressure decides which tasks to **freeze** (`Background -> Cached`
//! tombstone) or **kill** (reclaim). Physically killing the container process /
//! tearing down the surface stays a caller-side seam (the daemon / System UI
//! turns an [`LmkAction::Kill`] into `am force-stop` + `amos-wm` teardown).
//!
//! # Why its own registry (not `amos_applife::AppLifecycle`)
//!
//! Importance is expressed with [`amos_applife::AppState`] **only** for the type,
//! so the `key()`s and rank ladder match the host resource governor
//! (`proto/governor.proto`, `amos-ai::ResourceGovernor`) and a future bridge can
//! feed this container view into the daemon's `MoveApp` with zero vocabulary
//! drift. The registry itself is deliberately separate from
//! `amos_applife::AppLifecycle`: that models the **AmOS host** process model,
//! where `Visible` is *derived from surface visibility* and is not a settable
//! state; this models the **Android container** process importance, where a top
//! Activity that is `Paused` (still visible, e.g. split / overlay) must stay in a
//! protected tier and must never become a reclaim candidate. Design & honest
//! boundaries: `docs/lmk-proxy.md`.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use amos_applife::{AppId, AppState};

/// Lifecycle of the *top* Activity in a task (a launcher surface). Only the
/// states needed to derive process importance are tracked; a real container
/// adapter folds per-Activity signals into the top Activity's state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ActivityState {
    /// `onCreate` ran; not yet `onStart`.
    Created,
    /// `onStart` ran; visible-ish but not focused.
    Started,
    /// `onResume` ran — the top, focused Activity.
    Resumed,
    /// `onPause` ran — lost focus but still visible (split / overlay).
    Paused,
    /// `onStop` ran — hidden from the user.
    Stopped,
    /// `onDestroy` ran — task torn down.
    Destroyed,
}

impl ActivityState {
    /// Stable key (for logs / wire mapping).
    pub fn key(self) -> &'static str {
        match self {
            ActivityState::Created => "created",
            ActivityState::Started => "started",
            ActivityState::Resumed => "resumed",
            ActivityState::Paused => "paused",
            ActivityState::Stopped => "stopped",
            ActivityState::Destroyed => "destroyed",
        }
    }
}

/// Memory-pressure level fed into the proxy (mirrors Android `lmkd` thresholds).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum MemoryPressure {
    /// No reclaim requested (the proxy does nothing).
    #[default]
    None,
    /// Freeze LRU `Background` apps to `Cached` (no kills).
    Low,
    /// Reclaim (kill) LRU `Cached` then `Background` apps.
    Critical,
}

impl MemoryPressure {
    pub fn key(self) -> &'static str {
        match self {
            MemoryPressure::None => "none",
            MemoryPressure::Low => "low",
            MemoryPressure::Critical => "critical",
        }
    }
}

/// What the proxy decided for one victim task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LmkAction {
    /// `Background -> Cached` tombstone (freeze); keep surface + saved state.
    Freeze,
    /// Kill the process and tear down its surface.
    Kill,
}

impl LmkAction {
    pub fn key(self) -> &'static str {
        match self {
            LmkAction::Freeze => "freeze",
            LmkAction::Kill => "kill",
        }
    }
}

/// A *host* resource-governor decision about a container-managed app that must
/// be applied **back to the container** (the reverse half of the bridge, §8):
/// the daemon froze/thawed/reclaimed the app in its own registry, so the
/// container must be told to keep the two sides coherent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostAction {
    /// Host froze the app to `Cached` → freeze the container task too.
    Freeze,
    /// Host thawed the app back to `Background` → thaw the container task.
    Thaw,
    /// Host reclaimed (killed) the app → force-stop the container process.
    Reclaim,
}

impl HostAction {
    pub fn key(self) -> &'static str {
        match self {
            HostAction::Freeze => "freeze",
            HostAction::Thaw => "thaw",
            HostAction::Reclaim => "reclaim",
        }
    }
}

/// One victim chosen under pressure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LmkVictim {
    pub package_name: String,
    pub window_id: Option<String>,
    pub action: LmkAction,
}

/// The outcome of running the proxy under a given pressure.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LmkDecision {
    pub victims: Vec<LmkVictim>,
    /// `Cached`-tier apps after the round.
    pub cached_now: usize,
    /// `Background`-tier apps after the round.
    pub background_now: usize,
}

/// A read-only view of one tracked task (for a diagnostics / launcher tile).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskSnapshot {
    pub package_name: String,
    pub window_id: Option<String>,
    pub activity: ActivityState,
    pub state: AppState,
}

/// A lifecycle-operation failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LmkError {
    /// The package is not tracked (no running task / process record).
    Unknown(String),
}

impl fmt::Display for LmkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LmkError::Unknown(pkg) => write!(f, "no such running task: {pkg}"),
        }
    }
}

impl std::error::Error for LmkError {}

/// Convenience result alias.
pub type Result<T> = std::result::Result<T, LmkError>;

/// Map a container importance tier to the value a *host* registry
/// (`amos_applife::AppLifecycle` / daemon `ResourceGovernor`) can actually hold.
///
/// The host model has **no settable `Visible`** — it is derived from surface
/// visibility (`governor_service.rs`). A container top Activity that is on
/// screen but not focused (`Visible`) must still be *protected* from the host's
/// freeze/reclaim, so it is reported as host `Foreground`; the authoritative
/// per-surface `visible` tier stays in the container [`LmkProxy`] and is served
/// by `GetLmkSnapshot`. All other tiers map one-to-one.
pub fn host_state(state: AppState) -> AppState {
    if state == AppState::Visible {
        AppState::Foreground
    } else {
        state
    }
}

/// A sink for reporting container lifecycle/importance changes up to a *host*
/// resource governor — the bridge that keeps the container [`LmkProxy`] and the
/// daemon `ResourceGovernor` (`amos-ai`) in one coherent view.
///
/// `report_state` upserts a task's importance (the container has launched or
/// moved tier, including to `Stopped` when a task is destroyed but keeps saved
/// state); `report_killed` says the container LMK force-stopped the app (no
/// saved state — drop it from the host too).
pub trait LmkHost: Send + Sync {
    /// Upsert `package_name` at `state` (already mapped via [`host_state`]).
    fn report_state(&self, package_name: &str, state: AppState);
    /// The container removed `package_name` (LMK kill / no saved state).
    fn report_killed(&self, package_name: &str);
}

/// No-op sink used when no host bridge is installed (plain launcher / tests).
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopLmkHost;

impl LmkHost for NoopLmkHost {
    fn report_state(&self, _package_name: &str, _state: AppState) {}
    fn report_killed(&self, _package_name: &str) {}
}

#[derive(Clone, Debug)]
struct Record {
    window_id: Option<String>,
    activity: ActivityState,
    /// A user-perceptible foreground service is running for this process.
    service: bool,
    /// Frozen marker: `Background -> Cached` tombstone (never picked for work).
    cached: bool,
    /// Monotonic "last active" sequence — larger = more recently used.
    seq: u64,
    /// Opaque identities of the activities currently alive in this task (task
    /// membership). Empty when the caller uses the legacy whole-task model.
    /// A task is torn down only on the Destroy of its **last** live activity.
    live: BTreeSet<String>,
    /// The activity identity currently driving this task's *importance* (the
    /// top). `None` in legacy whole-task mode (the single implicit activity).
    /// Only Resume/Stop/Pause addressed at this top change importance; lifecycle
    /// of non-top ("stopped sibling") activities must not demote the package.
    top: Option<String>,
}

impl Record {
    /// Derived process importance from {top-Activity, foreground service,
    /// frozen/cached}. A `Cached` override always wins; a resumed Activity beats
    /// a service; a hidden Activity with a service stays in the protected
    /// `ForegroundService` tier; only a hidden, service-less Activity falls to
    /// the reclaimable `Background` tier.
    fn importance(&self) -> AppState {
        if self.cached {
            return AppState::Cached;
        }
        match self.activity {
            ActivityState::Resumed => AppState::Foreground,
            ActivityState::Created | ActivityState::Started | ActivityState::Paused => {
                AppState::Visible
            }
            ActivityState::Stopped | ActivityState::Destroyed => {
                if self.service {
                    AppState::ForegroundService
                } else {
                    AppState::Background
                }
            }
        }
    }
}

/// The container-side Activity/Task lifecycle + LMK authority.
///
/// Pure `std`, deterministic and fully offline-testable: the real container
/// event feed and the kill/teardown executor stay caller-side seams.
#[derive(Default)]
pub struct LmkProxy {
    records: BTreeMap<AppId, Record>,
    counter: u64,
}

impl LmkProxy {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of tracked running tasks.
    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// Whether any task is tracked.
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Whether `package_name` currently has a tracked running task.
    pub fn contains(&self, package_name: &str) -> bool {
        self.records.contains_key(&AppId::new(package_name))
    }

    /// Packages currently tracked (stable, sorted order).
    pub fn packages(&self) -> Vec<String> {
        self.records.keys().map(|id| id.0.clone()).collect()
    }

    /// Current importance tier of `package_name`.
    pub fn importance(&self, package_name: &str) -> Result<AppState> {
        self.records
            .get(&AppId::new(package_name))
            .map(Record::importance)
            .ok_or_else(|| LmkError::Unknown(package_name.to_string()))
    }

    /// The `window_id` (launcher surface) currently bound to `package_name`, if a
    /// tracked task has one.
    pub fn window_id(&self, package_name: &str) -> Option<String> {
        self.records
            .get(&AppId::new(package_name))?
            .window_id
            .clone()
    }

    /// Launch (create) a task for `package_name` into the foreground, or bring
    /// an existing one to the front (clearing any cached tombstone). `window_id`
    /// records the launcher surface when supplied (may be `None` before a real
    /// surface is bound).
    pub fn launch(&mut self, package_name: &str, window_id: Option<String>) -> Result<AppState> {
        let id = AppId::new(package_name);
        let rec = self.records.entry(id).or_insert(Record {
            window_id: None,
            activity: ActivityState::Created,
            service: false,
            cached: false,
            seq: 0,
            live: BTreeSet::new(),
            top: None,
        });
        if window_id.is_some() {
            rec.window_id = window_id;
        }
        rec.activity = ActivityState::Resumed;
        rec.cached = false;
        self.counter += 1;
        rec.seq = self.counter;
        Ok(rec.importance())
    }

    /// Adopt a previously-untracked package from an observed container lifecycle
    /// event (post-restart re-sync, or an app foregrounded outside AmOS). Inserts
    /// a fresh task at `activity` (no bound surface / service) and returns its
    /// derived importance. The caller must only invoke this for packages not yet
    /// tracked, so an existing record (with its window_id / service / recency)
    /// is never silently overwritten.
    pub fn adopt(&mut self, package_name: &str, activity: ActivityState) -> AppState {
        self.counter += 1;
        let rec = Record {
            window_id: None,
            activity,
            service: false,
            cached: false,
            seq: self.counter,
            live: BTreeSet::new(),
            top: None,
        };
        let importance = rec.importance();
        self.records.insert(AppId::new(package_name), rec);
        importance
    }

    /// The focused top Activity regained focus (`onResume`). Requires a tracked
    /// task (use [`Self::launch`] to create one).
    pub fn resume(&mut self, package_name: &str) -> Result<AppState> {
        let rec = self
            .records
            .get_mut(&AppId::new(package_name))
            .ok_or_else(|| LmkError::Unknown(package_name.to_string()))?;
        rec.activity = ActivityState::Resumed;
        rec.cached = false;
        self.counter += 1;
        rec.seq = self.counter;
        Ok(rec.importance())
    }

    /// The top Activity lost focus but is still visible (`onPause`).
    pub fn pause(&mut self, package_name: &str) -> Result<AppState> {
        let rec = self
            .records
            .get_mut(&AppId::new(package_name))
            .ok_or_else(|| LmkError::Unknown(package_name.to_string()))?;
        rec.activity = ActivityState::Paused;
        self.counter += 1;
        rec.seq = self.counter;
        Ok(rec.importance())
    }

    /// The top Activity was hidden (`onStop`) — the task went to the background.
    pub fn stop(&mut self, package_name: &str) -> Result<AppState> {
        let rec = self
            .records
            .get_mut(&AppId::new(package_name))
            .ok_or_else(|| LmkError::Unknown(package_name.to_string()))?;
        rec.activity = ActivityState::Stopped;
        self.counter += 1;
        rec.seq = self.counter;
        Ok(rec.importance())
    }

    /// The task / surface was destroyed (`onDestroy`) — stop tracking it.
    pub fn destroy(&mut self, package_name: &str) -> Result<()> {
        if self.records.remove(&AppId::new(package_name)).is_none() {
            return Err(LmkError::Unknown(package_name.to_string()));
        }
        Ok(())
    }

    // ---- Per-activity (identity) lifecycle — see resume/start/pause/stop/
    // destroy_last below: importance & liveness are decoupled so stacked tasks
    // with stopped siblings behave like a real Android task.

    /// A fresh task for `package_name` at `state` (single implicit activity).
    fn open_task(&mut self, package_name: &str, state: ActivityState) {
        let id = AppId::new(package_name);
        self.counter += 1;
        self.records.insert(
            id,
            Record {
                window_id: None,
                activity: state,
                service: false,
                cached: false,
                seq: self.counter,
                live: BTreeSet::new(),
                top: None,
            },
        );
    }

    /// `activity_id` became the resumed top (`onResume`): it drives importance as
    /// foreground and is registered alive. Self-heals if the task was untracked.
    pub fn resume_activity(&mut self, package_name: &str, activity_id: &str) -> Result<AppState> {
        let id = AppId::new(package_name);
        if !self.records.contains_key(&id) {
            self.open_task(package_name, ActivityState::Resumed);
        }
        let rec = self
            .records
            .get_mut(&id)
            .ok_or_else(|| LmkError::Unknown(package_name.to_string()))?;
        rec.top = Some(activity_id.to_string());
        rec.activity = ActivityState::Resumed;
        rec.cached = false;
        rec.live.insert(activity_id.to_string());
        self.counter += 1;
        rec.seq = self.counter;
        Ok(rec.importance())
    }

    /// `activity_id` entered the task as *alive* (`onStart` / first observation)
    /// without necessarily becoming the top. Liveness is what keeps the task up;
    /// it only becomes top (visible) if nothing more important is on stage.
    pub fn start_activity(&mut self, package_name: &str, activity_id: &str) -> Result<AppState> {
        let id = AppId::new(package_name);
        if !self.records.contains_key(&id) {
            self.open_task(package_name, ActivityState::Started);
        }
        let rec = self
            .records
            .get_mut(&id)
            .ok_or_else(|| LmkError::Unknown(package_name.to_string()))?;
        rec.live.insert(activity_id.to_string());
        if rec.top.is_none() || rec.activity == ActivityState::Stopped {
            rec.top = Some(activity_id.to_string());
            rec.activity = ActivityState::Started;
            self.counter += 1;
            rec.seq = self.counter;
        }
        Ok(rec.importance())
    }

    /// The top activity lost focus but stays visible (`onPause`). Only changes
    /// importance when addressed at the current top; a paused non-top sibling
    /// merely stays alive.
    pub fn pause_activity(&mut self, package_name: &str, activity_id: &str) -> Result<AppState> {
        let id = AppId::new(package_name);
        if !self.records.contains_key(&id) {
            self.open_task(package_name, ActivityState::Paused);
        }
        let rec = self
            .records
            .get_mut(&id)
            .ok_or_else(|| LmkError::Unknown(package_name.to_string()))?;
        rec.live.insert(activity_id.to_string());
        if rec.top.as_deref() == Some(activity_id) {
            rec.activity = ActivityState::Paused;
            self.counter += 1;
            rec.seq = self.counter;
        }
        Ok(rec.importance())
    }

    /// The top activity was hidden (`onStop`). Only demotes the package when
    /// addressed at the current top; a stopped non-top sibling keeps the task
    /// alive but must not change its (still-shown) importance.
    pub fn stop_activity(&mut self, package_name: &str, activity_id: &str) -> Result<AppState> {
        let id = AppId::new(package_name);
        if !self.records.contains_key(&id) {
            self.open_task(package_name, ActivityState::Stopped);
        }
        let rec = self
            .records
            .get_mut(&id)
            .ok_or_else(|| LmkError::Unknown(package_name.to_string()))?;
        rec.live.insert(activity_id.to_string());
        if rec.top.as_deref() == Some(activity_id) {
            rec.activity = ActivityState::Stopped;
            self.counter += 1;
            rec.seq = self.counter;
        }
        Ok(rec.importance())
    }

    /// Fold a `Destroy` of one live activity `activity_id`. Returns:
    /// - `Ok(None)` when this was the task's **last** live activity (or the task
    ///   was untracked / running in legacy whole-task mode) — the task is gone;
    /// - `Ok(Some(state))` when other activities remain alive — the task survives
    ///   at `state`. If the destroyed activity was the top, the task stays alive
    ///   (a stopped sibling remains) and is demoted to a visible placeholder
    ///   rather than torn down (finishing a stacked/sub activity must not kill
    ///   the app, nor may we keep claiming a foreground we can't back up).
    pub fn destroy_last(
        &mut self,
        package_name: &str,
        activity_id: &str,
    ) -> Result<Option<AppState>> {
        let id = AppId::new(package_name);
        let Some(rec) = self.records.get_mut(&id) else {
            return Ok(None); // untracked → already gone
        };
        rec.live.remove(activity_id);
        if rec.live.is_empty() {
            self.records.remove(&id);
            return Ok(None);
        }
        // Other live activities remain (e.g. a stopped sibling). If the destroyed
        // one was the top, point at a survivor and demote to a visible baseline.
        if rec.top.as_deref() == Some(activity_id) {
            rec.top = rec.live.iter().next().cloned();
            rec.activity = ActivityState::Started;
            self.counter += 1;
            rec.seq = self.counter;
        }
        Ok(Some(rec.importance()))
    }

    /// Promote a running process to a user-perceptible foreground service
    /// (e.g. media / a call) so a hidden Activity stays protected.
    pub fn start_service(&mut self, package_name: &str) -> Result<AppState> {
        let rec = self
            .records
            .get_mut(&AppId::new(package_name))
            .ok_or_else(|| LmkError::Unknown(package_name.to_string()))?;
        rec.service = true;
        rec.cached = false;
        self.counter += 1;
        rec.seq = self.counter;
        Ok(rec.importance())
    }

    /// Demote a foreground service back to a plain (background) process.
    pub fn stop_service(&mut self, package_name: &str) -> Result<AppState> {
        let rec = self
            .records
            .get_mut(&AppId::new(package_name))
            .ok_or_else(|| LmkError::Unknown(package_name.to_string()))?;
        rec.service = false;
        self.counter += 1;
        rec.seq = self.counter;
        Ok(rec.importance())
    }

    /// Freeze a `Background` task into the `Cached` tombstone (keeps surface +
    /// saved state). A no-op for anything not in `Background` (never freezes a
    /// protected tier); returns the resulting importance.
    pub fn freeze(&mut self, package_name: &str) -> Result<AppState> {
        let rec = self
            .records
            .get_mut(&AppId::new(package_name))
            .ok_or_else(|| LmkError::Unknown(package_name.to_string()))?;
        if rec.importance() == AppState::Background {
            rec.cached = true;
            self.counter += 1;
            rec.seq = self.counter;
        }
        Ok(rec.importance())
    }

    /// Un-freeze a `Cached` tombstone back to `Background` (partial resume).
    pub fn thaw(&mut self, package_name: &str) -> Result<AppState> {
        let rec = self
            .records
            .get_mut(&AppId::new(package_name))
            .ok_or_else(|| LmkError::Unknown(package_name.to_string()))?;
        if rec.cached {
            rec.cached = false;
            self.counter += 1;
            rec.seq = self.counter;
        }
        Ok(rec.importance())
    }

    /// Read-only snapshot of every tracked task (stable order).
    pub fn snapshot(&self) -> Vec<TaskSnapshot> {
        self.records
            .iter()
            .map(|(id, rec)| TaskSnapshot {
                package_name: id.0.clone(),
                window_id: rec.window_id.clone(),
                activity: rec.activity,
                state: rec.importance(),
            })
            .collect()
    }

    /// Per-tier counts: `(cached, background)` over tracked tasks.
    pub fn tier_counts(&self) -> (usize, usize) {
        let cached = self
            .records
            .values()
            .filter(|r| r.importance() == AppState::Cached)
            .count();
        let background = self
            .records
            .values()
            .filter(|r| r.importance() == AppState::Background)
            .count();
        (cached, background)
    }

    /// Plan what this pressure round *would* do, without mutating state.
    pub fn plan(&self, pressure: MemoryPressure, budget: usize) -> LmkDecision {
        let victims = self.select(pressure, budget);
        let (cached_now, background_now) = self.tier_counts();
        LmkDecision {
            victims,
            cached_now,
            background_now,
        }
    }

    /// Decide under `pressure` and apply the transitions to the registry,
    /// returning the concrete decision (victims + resulting tier counts).
    ///
    /// `Low` freezes LRU `Background` victims (`Cached`), keeping surfaces;
    /// `Critical` reclaims (kills) LRU `Cached` then `Background` victims,
    /// removing their tasks. Protected tiers are never picked.
    pub fn apply(&mut self, pressure: MemoryPressure, budget: usize) -> LmkDecision {
        let victims = self.select(pressure, budget);
        for victim in &victims {
            match victim.action {
                LmkAction::Freeze => {
                    if let Some(rec) = self.records.get_mut(&AppId::new(&victim.package_name)) {
                        rec.cached = true;
                        self.counter += 1;
                        rec.seq = self.counter;
                    }
                }
                LmkAction::Kill => {
                    self.records.remove(&AppId::new(&victim.package_name));
                }
            }
        }
        let (cached_now, background_now) = self.tier_counts();
        LmkDecision {
            victims,
            cached_now,
            background_now,
        }
    }

    /// Ordered victim list for a pressure round (no mutation).
    fn select(&self, pressure: MemoryPressure, budget: usize) -> Vec<LmkVictim> {
        if budget == 0 {
            return Vec::new();
        }
        let mut victims = Vec::new();
        match pressure {
            MemoryPressure::None => {}
            MemoryPressure::Low => {
                // LRU `Background` only (freeze; never already-`Cached`).
                let mut bg: Vec<(&AppId, &Record)> = self
                    .records
                    .iter()
                    .filter(|(_, r)| r.importance() == AppState::Background)
                    .collect();
                bg.sort_by_key(|(_, r)| r.seq);
                for (id, rec) in bg.into_iter().take(budget) {
                    victims.push(LmkVictim {
                        package_name: id.0.clone(),
                        window_id: rec.window_id.clone(),
                        action: LmkAction::Freeze,
                    });
                }
            }
            MemoryPressure::Critical => {
                // Reclaimable (Cached then Background), LRU within a tier.
                let mut cand: Vec<(&AppId, &Record)> = self
                    .records
                    .iter()
                    .filter(|(_, r)| r.importance().is_reclaimable())
                    .collect();
                cand.sort_by(|(a_id, a), (b_id, b)| {
                    // Higher rank (less important) first: Cached(4) before
                    // Background(3); among equals the LRU (smaller seq) first.
                    b.importance()
                        .rank()
                        .cmp(&a.importance().rank())
                        .then_with(|| a.seq.cmp(&b.seq))
                        .then_with(|| a_id.0.cmp(&b_id.0))
                });
                for (id, rec) in cand.into_iter().take(budget) {
                    victims.push(LmkVictim {
                        package_name: id.0.clone(),
                        window_id: rec.window_id.clone(),
                        action: LmkAction::Kill,
                    });
                }
            }
        }
        victims
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy() -> LmkProxy {
        LmkProxy::new()
    }

    #[test]
    fn launch_creates_resumed_foreground_task() {
        let mut p = proxy();
        let s = p
            .launch("com.tencent.mm", Some("waydroid_com.tencent.mm".into()))
            .unwrap();
        assert_eq!(s, AppState::Foreground);
        assert_eq!(p.len(), 1);
        assert_eq!(
            p.importance("com.tencent.mm").unwrap(),
            AppState::Foreground
        );
        assert_eq!(p.snapshot()[0].activity, ActivityState::Resumed);
        assert_eq!(
            p.snapshot()[0].window_id.as_deref(),
            Some("waydroid_com.tencent.mm")
        );
    }

    #[test]
    fn pause_is_visible_stop_is_background() {
        let mut p = proxy();
        p.launch("com.tencent.mm", None).unwrap();
        assert_eq!(p.pause("com.tencent.mm").unwrap(), AppState::Visible);
        assert_eq!(p.stop("com.tencent.mm").unwrap(), AppState::Background);
    }

    #[test]
    fn resume_clears_cached_tombstone() {
        let mut p = proxy();
        p.launch("notes", None).unwrap();
        p.stop("notes").unwrap();
        assert_eq!(p.freeze("notes").unwrap(), AppState::Cached);
        assert_eq!(p.resume("notes").unwrap(), AppState::Foreground);
        assert!(!p.importance("notes").unwrap().is_reclaimable());
    }

    #[test]
    fn foreground_service_protects_hidden_activity() {
        let mut p = proxy();
        p.launch("music", None).unwrap();
        p.stop("music").unwrap();
        assert_eq!(
            p.start_service("music").unwrap(),
            AppState::ForegroundService
        );
        // A hidden-but-service app is never a reclaim candidate.
        assert!(p.plan(MemoryPressure::Critical, 10).victims.is_empty());
        // Demoting the service returns it to the reclaimable background tier.
        assert_eq!(p.stop_service("music").unwrap(), AppState::Background);
        assert_eq!(p.plan(MemoryPressure::Critical, 10).victims.len(), 1);
    }

    #[test]
    fn unknown_task_operations_error() {
        let mut p = proxy();
        assert_eq!(p.pause("nope"), Err(LmkError::Unknown("nope".into())));
        assert_eq!(p.destroy("nope"), Err(LmkError::Unknown("nope".into())));
        assert!(p.importance("nope").is_err());
    }

    #[test]
    fn destroy_removes_task() {
        let mut p = proxy();
        p.launch("notes", Some("w".into())).unwrap();
        p.destroy("notes").unwrap();
        assert!(p.is_empty());
    }

    #[test]
    fn low_pressure_freezes_lru_background_not_cached_or_protected() {
        let mut p = proxy();
        // Protected: foreground + visible.
        p.launch("fg", Some("wfg".into())).unwrap();
        p.launch("vis", Some("wvis".into())).unwrap();
        p.pause("vis").unwrap(); // Visible
                                 // Two background apps; "old" used first => LRU.
        p.launch("old", Some("wold".into())).unwrap();
        p.stop("old").unwrap();
        p.launch("recent", Some("wrec".into())).unwrap();
        p.stop("recent").unwrap();

        let d = p.apply(MemoryPressure::Low, 1);
        assert_eq!(d.victims.len(), 1);
        assert_eq!(d.victims[0].package_name, "old");
        assert_eq!(d.victims[0].action, LmkAction::Freeze);
        // The frozen app is now Cached; visible & foreground untouched.
        assert_eq!(p.importance("old").unwrap(), AppState::Cached);
        assert_eq!(p.importance("fg").unwrap(), AppState::Foreground);
        assert_eq!(p.importance("vis").unwrap(), AppState::Visible);
        // Second Low round freezes the next LRU background.
        let d2 = p.apply(MemoryPressure::Low, 10);
        assert_eq!(d2.victims.len(), 1);
        assert_eq!(d2.victims[0].package_name, "recent");
    }

    #[test]
    fn critical_reclaims_cached_before_background_lru() {
        let mut p = proxy();
        p.launch("bg", Some("wbg".into())).unwrap();
        p.stop("bg").unwrap(); // Background
        p.launch("cache", Some("wca".into())).unwrap();
        p.stop("cache").unwrap();
        p.freeze("cache").unwrap(); // Cached

        // Critical with budget 1 must take the Cached app first.
        let d = p.apply(MemoryPressure::Critical, 1);
        assert_eq!(d.victims.len(), 1);
        assert_eq!(d.victims[0].package_name, "cache");
        assert_eq!(d.victims[0].action, LmkAction::Kill);
        assert!(!p.contains("cache"));

        // Now only the Background app remains reclaimable.
        let d2 = p.apply(MemoryPressure::Critical, 10);
        assert_eq!(d2.victims.len(), 1);
        assert_eq!(d2.victims[0].package_name, "bg");
        assert!(p.is_empty());
    }

    #[test]
    fn plan_does_not_mutate() {
        let mut p = proxy();
        p.launch("a", Some("w".into())).unwrap();
        p.stop("a").unwrap();
        let planned = p.plan(MemoryPressure::Critical, 10);
        assert_eq!(planned.victims.len(), 1);
        assert!(p.contains("a")); // still tracked after planning
        p.apply(MemoryPressure::Critical, 10);
        assert!(!p.contains("a"));
    }

    #[test]
    fn zero_budget_and_no_pressure_do_nothing() {
        let mut p = proxy();
        p.launch("a", None).unwrap();
        p.stop("a").unwrap();
        assert!(p.apply(MemoryPressure::Critical, 0).victims.is_empty());
        assert!(p.apply(MemoryPressure::None, 10).victims.is_empty());
        assert!(p.contains("a"));
    }

    #[test]
    fn keys_are_stable() {
        assert_eq!(ActivityState::Resumed.key(), "resumed");
        assert_eq!(MemoryPressure::Critical.key(), "critical");
        assert_eq!(LmkAction::Kill.key(), "kill");
        assert_eq!(HostAction::Reclaim.key(), "reclaim");
        assert_eq!(HostAction::Freeze.key(), "freeze");
        assert_eq!(HostAction::Thaw.key(), "thaw");
    }

    #[test]
    fn tier_counts_reflect_states() {
        let mut p = proxy();
        p.launch("fg", None).unwrap();
        p.launch("bg1", None).unwrap();
        p.stop("bg1").unwrap();
        p.launch("bg2", None).unwrap();
        p.stop("bg2").unwrap();
        p.freeze("bg2").unwrap();
        let (cached, background) = p.tier_counts();
        assert_eq!((cached, background), (1, 1));
    }

    #[test]
    fn host_state_maps_visible_to_foreground_and_passthrough() {
        // Visible is host-derived (not settable); report it as foreground so the
        // host keeps the on-screen-but-unfocused app protected.
        assert_eq!(host_state(AppState::Visible), AppState::Foreground);
        for s in [
            AppState::Foreground,
            AppState::ForegroundService,
            AppState::Background,
            AppState::Cached,
            AppState::Stopped,
        ] {
            assert_eq!(host_state(s), s, "{s:?}");
        }
    }

    #[test]
    fn adopt_creates_a_task_at_the_given_activity_and_tier() {
        let mut p = LmkProxy::new();
        // Adopt an untracked package from the lifecycle event it implies.
        assert_eq!(
            p.adopt("com.tencent.mm", ActivityState::Resumed),
            AppState::Foreground
        );
        assert_eq!(p.adopt("com.a.b", ActivityState::Paused), AppState::Visible);
        assert_eq!(
            p.adopt("com.c.d", ActivityState::Stopped),
            AppState::Background
        );
        assert_eq!(p.len(), 3);

        let snap = p.snapshot();
        let mm = snap
            .iter()
            .find(|t| t.package_name == "com.tencent.mm")
            .unwrap();
        // Adopted tasks carry no bound surface yet and are not service-promoted.
        assert_eq!(mm.window_id, None);
        assert_eq!(mm.activity, ActivityState::Resumed);
        assert_eq!(mm.state, AppState::Foreground);
    }

    #[test]
    fn adopt_overwrites_unconditionally_and_advances_recency() {
        let mut p = LmkProxy::new();
        // adopt() overwrites the key blindly by design; dispatch() gates it behind
        // contains() so a tracked task is never adopted over. Pin that primitive
        // contract here so a future caller can't misuse it silently.
        let _ = p.launch("com.tencent.mm", Some("legacy:w".into()));
        assert_eq!(p.window_id("com.tencent.mm").as_deref(), Some("legacy:w"));
        let _ = p.adopt("com.tencent.mm", ActivityState::Stopped);
        assert_eq!(
            p.window_id("com.tencent.mm"),
            None,
            "adopt over a tracked task drops its surface (caller must gate it)"
        );
        assert_eq!(
            p.importance("com.tencent.mm").unwrap(),
            AppState::Background
        );

        // adopt() bumps the LRU recency (seq) like a launch, so an adopted
        // background app is a real reclaim candidate under Critical pressure.
        p.adopt("com.third", ActivityState::Stopped);
        let victims = p.plan(MemoryPressure::Critical, 10);
        assert!(
            victims
                .victims
                .iter()
                .any(|v| v.package_name == "com.third"),
            "adopted background task is reclaimable"
        );
    }
}

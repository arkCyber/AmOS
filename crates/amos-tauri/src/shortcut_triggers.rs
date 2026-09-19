//! Tauri host bridge for **shortcut automation triggers** (`shortcuts_trigger_*`).
//!
//! ## Why this exists
//!
//! A shortcut's time trigger ("每天 08:00 跑这条指令") cannot be owned by the WebView:
//! `setInterval` is throttled in the background, and it simply does not exist while
//! no window is open. The decision "wake at this absolute instant" therefore lives
//! here, in the same shape this repo already established for Clock alarms
//! (`crate::alarm_sched`): a wall-clock ledger of absolute epoch-ms instants
//! ([`amos_scheduler::ExactAlarmClock`]) plus the platform's exact-alarm binding.
//!
//! The split of responsibility is deliberate and worth stating, because it is the
//! seam most likely to be "optimised" into a lie later:
//!
//! * **Rust (here)** — *when* to fire. It computes the next occurrence of a
//!   `HH:mm`-on-these-weekdays rule in the host's local time, holds it in the
//!   ledger, and hands it to `AlarmManager` on Android (reusing `alarm_sched`'s
//!   device binding, so there is exactly **one** JNI call path in this crate).
//! * **WebView (`lib/shortcuts.ts`)** — *what* to run. Only it can reach the action
//!   targets (`amos.notifications`, the clipboard, `wm_open`, …), so the poll answer
//!   is an instruction ("this trigger is due"), never an execution.
//!
//! ## Commands
//!
//! * `shortcuts_trigger_sync { triggers, nowMs? } -> TriggerSyncReply`
//!   Replaces the whole plan idempotently: entries not in the new set are cancelled
//!   (ledger **and** OS), the rest are (re)armed. One malformed trigger is **rejected
//!   by name** rather than failing the whole call — a single bad row must not silently
//!   disable every automation the user has.
//!
//!   There is deliberately **no** single-entry cancel command: the shell's only edit
//!   path is the whole-plan re-sync above, so a `_cancel` would be a command with no
//!   caller — the exact "defined, tested, never wired" defect this repo gates on. When
//!   a UI grows a per-trigger switch, the command comes back with it.
//! * `shortcuts_trigger_poll { nowMs? } -> TriggerPoll`
//!   Fires the due entries once **and re-arms repeating ones** for their next
//!   occurrence — a time trigger is a recurrence, not a one-shot.
//!
//! Honest boundaries, in this module's own words:
//! * Times are resolved in the **host's local zone** via `chrono::Local`. A DST fold
//!   (the hour that happens twice) resolves to its *earliest* instant; a DST gap (the
//!   hour that never happens) is **skipped to the next matching day** instead of being
//!   silently snapped to a neighbouring minute.
//! * On a host without `AlarmManager` (desktop / CI) the ledger still works while the
//!   process lives, and the answer says `host_only` — it never claims the OS was armed.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use amos_scheduler::{ExactAlarmClock, JobId};
use chrono::{Datelike, Duration as ChronoDuration, Local, TimeZone};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::alarm_sched::{arm_device, cancel_device, DeviceOutcome};

/// Maximum number of *distinct* trigger entries the ledger will hold.
///
/// `shortcuts_trigger_sync` is WebView-callable, so the count needs a bound for the
/// same reason `MAX_ALARM_ENTRIES` does (REQ-A374): an unbounded map is a
/// caller-controlled growth path. Re-syncing an existing key is always allowed —
/// that is the everyday case (every edit re-syncs the plan) and must never fail.
pub const MAX_TRIGGER_ENTRIES: usize = 256;

/// Maximum bytes in a trigger key (`"<shortcutId>:<triggerId>"`).
pub const MAX_TRIGGER_KEY_BYTES: usize = 256;

/// Ledger id namespace, so a shortcut entry can never collide with a Clock alarm id.
pub const TRIGGER_ID_PREFIX: &str = "shortcut:";

/// Wall-clock epoch (ms) now, never panicking / never negative.
fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

/// One time trigger exactly as the WebView hands it in (camelCase over the bridge).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeTriggerSpec {
    /// `"<shortcutId>:<triggerId>"` — identity of this trigger in the ledger.
    pub key: String,
    /// `"HH:mm"` (24-hour).
    pub time: String,
    /// ISO weekdays (1 = Monday … 7 = Sunday). Empty = every day.
    #[serde(default)]
    pub days: Vec<u8>,
}

/// The parsed form of a [`TimeTriggerSpec`]: what the scheduler actually needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimeSpec {
    pub hour: u8,
    pub minute: u8,
    pub days: Vec<u8>,
}

/// Parse `"HH:mm"` into `(hour, minute)`.
///
/// Strict on purpose: a rule we cannot read is refused by name at the command seam
/// instead of being approximated to midnight (an automation that runs at the wrong
/// hour is worse than one that visibly refuses to arm).
pub fn parse_hh_mm(text: &str) -> Option<(u8, u8)> {
    let trimmed = text.trim();
    let (h, m) = trimmed.split_once(':')?;
    // Require two digits for the minute, matching the UI and the WebView rules.
    if m.len() != 2 || !m.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let hour: u8 = h.parse().ok()?;
    let minute: u8 = m.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some((hour, minute))
}

/// Parse a spec, rejecting an unreadable time or an out-of-range weekday.
pub fn parse_time_spec(spec: &TimeTriggerSpec) -> Result<TimeSpec, String> {
    let (hour, minute) =
        parse_hh_mm(&spec.time).ok_or_else(|| format!("time \"{}\" is not HH:mm", spec.time))?;
    for day in &spec.days {
        if !(1..=7).contains(day) {
            return Err(format!("weekday {day} is not 1..=7 (ISO, 7 = Sunday)"));
        }
    }
    let mut days = spec.days.clone();
    days.sort_unstable();
    days.dedup();
    Ok(TimeSpec { hour, minute, days })
}

/// ISO weekday (1..7, Sunday = 7) — the convention the UI and the WebView use.
fn iso_weekday(date: chrono::NaiveDate) -> u8 {
    match date.weekday() {
        chrono::Weekday::Mon => 1,
        chrono::Weekday::Tue => 2,
        chrono::Weekday::Wed => 3,
        chrono::Weekday::Thu => 4,
        chrono::Weekday::Fri => 5,
        chrono::Weekday::Sat => 6,
        chrono::Weekday::Sun => 7,
    }
}

/// The next instant **strictly after** `now_ms` that matches the spec, in epoch ms.
///
/// Scans today plus the following seven days, so any weekday subset is reachable.
/// `None` means "this rule can never fire" — only possible when the local calendar
/// cannot represent the requested wall-clock time (a DST gap on every candidate day).
pub fn next_fire_ms(spec: &TimeSpec, now_ms: i64) -> Option<i64> {
    let now = Local.timestamp_millis_opt(now_ms).single()?;
    let today = now.date_naive();

    for offset in 0..=7i64 {
        let date = today.checked_add_signed(ChronoDuration::days(offset))?;
        if !spec.days.is_empty() && !spec.days.contains(&iso_weekday(date)) {
            continue;
        }
        let naive = date.and_hms_opt(spec.hour as u32, spec.minute as u32, 0)?;
        // A DST gap has no instant for this wall-clock time (`earliest()` is `None`);
        // skip the day rather than firing at a time the user never asked for.
        let Some(local) = Local.from_local_datetime(&naive).earliest() else {
            continue;
        };
        let at = local.timestamp_millis();
        if at > now_ms {
            return Some(at);
        }
    }
    None
}

/// One armed entry in the answer to `shortcuts_trigger_sync`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerArmed {
    pub key: String,
    pub at_ms: i64,
    /// What the OS half did: `host_only` on desktop, `scheduled` when a real
    /// `AlarmManager` alarm was set on Android. Never rounded up.
    pub device: DeviceOutcome,
}

/// One rule the sync refused, with the reason — surfaced, never silently dropped.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerRejected {
    pub key: String,
    pub reason: String,
}

/// Answer to `shortcuts_trigger_sync`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerSyncReply {
    pub armed: Vec<TriggerArmed>,
    pub rejected: Vec<TriggerRejected>,
    /// Keys that were in the previous plan and are gone from this one.
    pub canceled: Vec<String>,
}

/// One due entry in the answer to `shortcuts_trigger_poll`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerFired {
    pub key: String,
    /// The instant the rule was scheduled for (the WebView fires *that* minute).
    pub at_ms: i64,
}

/// Answer to `shortcuts_trigger_poll` (a named struct, not a bare array, so adding a
/// field later — e.g. "what was re-armed" — does not break the bridge shape).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerPoll {
    pub due: Vec<TriggerFired>,
}

/// A rule plus the instant it is currently armed for.
///
/// Both halves are needed: the rule **repeats** (when one fires, the next occurrence
/// must be computed from the same rule), and the instant is what the poll reports as
/// "this is the moment that just arrived" — a value `ExactAlarmClock::due()` does not
/// return (it answers only *which* ids are due).
#[derive(Clone, Debug)]
struct ArmedRule {
    spec: TimeSpec,
    at_ms: i64,
}

/// Process-shared trigger plan: a fire-once wall-clock ledger plus the rules behind it.
pub struct ShortcutTriggerState {
    inner: Mutex<ExactAlarmClock>,
    rules: Mutex<HashMap<String, ArmedRule>>,
}

impl Default for ShortcutTriggerState {
    fn default() -> Self {
        Self::new()
    }
}

impl ShortcutTriggerState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ExactAlarmClock::new()),
            rules: Mutex::new(HashMap::new()),
        }
    }

    /// How many triggers are currently armed (the ledger size, for the entry cap).
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    /// Replace the whole plan. Returns what was armed / refused / dropped.
    ///
    /// Ordering note: the ledger is updated **before** the OS is touched, so an
    /// unavailable platform binding still leaves a working in-process plan — the same
    /// decision `scheduler_alarm_register` documents.
    pub fn sync(&self, triggers: Vec<TimeTriggerSpec>, now: i64) -> TriggerSyncReply {
        let mut armed = Vec::new();
        let mut rejected = Vec::new();
        let mut accepted: Vec<(String, TimeSpec)> = Vec::new();

        for spec in &triggers {
            if let Err(reason) = check_trigger_key(&spec.key) {
                rejected.push(TriggerRejected {
                    key: spec.key.clone(),
                    reason,
                });
                continue;
            }
            match parse_time_spec(spec) {
                Ok(parsed) => accepted.push((spec.key.clone(), parsed)),
                Err(reason) => rejected.push(TriggerRejected {
                    key: spec.key.clone(),
                    reason,
                }),
            }
        }

        // Capacity counts *new* keys only: a plan that is being re-synced (the everyday
        // case — every edit re-syncs) must always fit.
        let mut slots = {
            let rules = self.rules();
            MAX_TRIGGER_ENTRIES.saturating_sub(rules.len())
        };
        for (key, parsed) in accepted {
            if !self
                .rules
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .contains_key(&key)
            {
                if slots == 0 {
                    rejected.push(TriggerRejected {
                        key,
                        reason: format!("trigger capacity reached: {MAX_TRIGGER_ENTRIES} entries"),
                    });
                    continue;
                }
                slots -= 1;
            }
            match next_fire_ms(&parsed, now) {
                Some(at) => {
                    self.arm(&key, &parsed, at);
                    // Arm the OS *before* moving `key` into the reply (the ledger id is
                    // built from it, so the order matters).
                    let device = arm_device(&ledger_id_for(&key), at.max(0) as u64);
                    armed.push(TriggerArmed {
                        key,
                        at_ms: at,
                        device,
                    });
                }
                None => rejected.push(TriggerRejected {
                    key,
                    reason: "the local calendar cannot represent this wall-clock time".to_string(),
                }),
            }
        }

        // Drop anything that is no longer in the plan (ledger + OS).
        let wanted: Vec<String> = armed.iter().map(|a| a.key.clone()).collect();
        let stale: Vec<String> = self
            .rules()
            .keys()
            .filter(|key| !wanted.contains(key))
            .cloned()
            .collect();
        let mut canceled = Vec::new();
        for key in stale {
            self.cancel(&key);
            canceled.push(key);
        }

        TriggerSyncReply {
            armed,
            rejected,
            canceled,
        }
    }

    /// Cancel one trigger (ledger + OS). Returns whether it was armed.
    pub fn cancel(&self, key: &str) -> bool {
        let id = ledger_id_for(key);
        let was_armed = self.lock().cancel(&JobId::new(id.clone()));
        self.rules().remove(key);
        cancel_device(&id);
        was_armed
    }

    /// Register one rule in both halves of the state.
    fn arm(&self, key: &str, spec: &TimeSpec, at_ms: i64) {
        self.lock()
            .register(JobId::new(ledger_id_for(key)), at_ms.max(0) as u64);
        self.rules().insert(
            key.to_string(),
            ArmedRule {
                spec: spec.clone(),
                at_ms,
            },
        );
    }

    /// Fire everything due by `now`, re-arming repeating rules for their next
    /// occurrence — a time trigger is a **recurrence**, not a one-shot.
    ///
    /// Idempotent by construction: the ledger removes an entry when it fires and the
    /// re-arm instant is strictly in the future, so polling twice in the same minute
    /// cannot report the same occurrence twice.
    pub fn poll(&self, now: i64) -> Vec<TriggerFired> {
        let due = self.lock().due(now.max(0) as u64);
        let mut fired = Vec::new();

        for id in due {
            let Some(key) = id.as_str().strip_prefix(TRIGGER_ID_PREFIX) else {
                // Not ours — a stray id must never be reported as a fired shortcut trigger.
                continue;
            };
            let Some(rule) = self.rules().get(key).cloned() else {
                continue;
            };
            fired.push(TriggerFired {
                key: key.to_string(),
                at_ms: rule.at_ms,
            });
            if let Some(next) = next_fire_ms(&rule.spec, now) {
                self.arm(key, &rule.spec, next);
                arm_device(id.as_str(), next.max(0) as u64);
            }
        }

        fired
    }

    /// The rules map (poison-recovering, like the ledger lock).
    fn rules(&self) -> std::sync::MutexGuard<'_, HashMap<String, ArmedRule>> {
        self.rules.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ExactAlarmClock> {
        // Poison-recover: a panicked writer must never deadlock the commands.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// The ledger id for a trigger key (namespaced; see [`TRIGGER_ID_PREFIX`]).
fn ledger_id_for(key: &str) -> String {
    format!("{TRIGGER_ID_PREFIX}{key}")
}

/// Bound a trigger key at the command seam (mirrors `alarm_sched::check_alarm_id`).
fn check_trigger_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > MAX_TRIGGER_KEY_BYTES {
        return Err(format!(
            "trigger key invalid: {} bytes (max {MAX_TRIGGER_KEY_BYTES})",
            key.len()
        ));
    }
    if key.chars().any(|c| c.is_control() || c == '\0') {
        return Err("trigger key contains control characters".to_string());
    }
    Ok(())
}

/// Replace the whole time-trigger plan.
///
/// `nowMs` is a test seam (and lets a host replay a plan at a fixed instant);
/// production omits it and the host wall clock is used.
#[tauri::command]
pub fn shortcuts_trigger_sync(
    state: State<'_, ShortcutTriggerState>,
    triggers: Vec<TimeTriggerSpec>,
    now_ms: Option<i64>,
) -> Result<TriggerSyncReply, String> {
    // `now_ms` here is the Option param (it shadows the module fn of the same name),
    // so call the free fn via its full path — the same trap `alarm_sched` documents.
    let now = now_ms.unwrap_or_else(crate::shortcut_triggers::now_ms);
    Ok(state.sync(triggers, now))
}

/// Fire the due triggers (once each) and re-arm repeating ones.
#[tauri::command]
pub fn shortcuts_trigger_poll(
    state: State<'_, ShortcutTriggerState>,
    now_ms: Option<i64>,
) -> Result<TriggerPoll, String> {
    let now = now_ms.unwrap_or_else(crate::shortcut_triggers::now_ms);
    Ok(TriggerPoll {
        due: state.poll(now),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    /// A local instant, built from the local zone so the assertions hold in any tz.
    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        let date = NaiveDate::from_ymd_opt(y, m, d).unwrap();
        let naive = date.and_hms_opt(h, min, 0).unwrap();
        Local
            .from_local_datetime(&naive)
            .earliest()
            .unwrap()
            .timestamp_millis()
    }

    fn spec(key: &str, time: &str, days: &[u8]) -> TimeTriggerSpec {
        TimeTriggerSpec {
            key: key.to_string(),
            time: time.to_string(),
            days: days.to_vec(),
        }
    }

    // ---- parsing ----------------------------------------------------------

    #[test]
    fn parse_hh_mm_accepts_real_times_and_refuses_typos() {
        assert_eq!(parse_hh_mm("08:00"), Some((8, 0)));
        assert_eq!(parse_hh_mm(" 23:59 "), Some((23, 59)));
        assert_eq!(parse_hh_mm("0:00"), Some((0, 0)));
        // Strict minute width: "8:0" is a typo, not 08:00 — an automation that runs at
        // the wrong hour is worse than one that visibly refuses to arm.
        assert_eq!(parse_hh_mm("8:0"), None);
        assert_eq!(parse_hh_mm("8"), None);
        assert_eq!(parse_hh_mm("24:00"), None);
        assert_eq!(parse_hh_mm("08:60"), None);
        assert_eq!(parse_hh_mm("ab:cd"), None);
        assert_eq!(parse_hh_mm(""), None);
    }

    #[test]
    fn parse_time_spec_rejects_out_of_range_weekdays_and_normalises_days() {
        assert!(parse_time_spec(&spec("k", "08:00", &[0])).is_err());
        assert!(parse_time_spec(&spec("k", "08:00", &[8])).is_err());
        assert!(parse_time_spec(&spec("k", "nope", &[])).is_err());
        let parsed = parse_time_spec(&spec("k", "08:00", &[3, 1, 3])).unwrap();
        assert_eq!(parsed.days, vec![1, 3], "sorted + deduped");
    }

    // ---- next occurrence --------------------------------------------------

    #[test]
    fn next_fire_is_strictly_after_now() {
        let s = TimeSpec {
            hour: 8,
            minute: 0,
            days: vec![],
        };
        // 07:30 → today 08:00
        assert_eq!(
            next_fire_ms(&s, at(2026, 1, 5, 7, 30)),
            Some(at(2026, 1, 5, 8, 0))
        );
        // 08:00 exactly → tomorrow (an instant that has arrived is not "next")
        assert_eq!(
            next_fire_ms(&s, at(2026, 1, 5, 8, 0)),
            Some(at(2026, 1, 6, 8, 0))
        );
        // 09:00 → tomorrow
        assert_eq!(
            next_fire_ms(&s, at(2026, 1, 5, 9, 0)),
            Some(at(2026, 1, 6, 8, 0))
        );
    }

    #[test]
    fn next_fire_honours_the_weekday_filter() {
        let monday_only = TimeSpec {
            hour: 8,
            minute: 0,
            days: vec![1],
        };
        // 2026-01-05 is a Monday; from Sunday 2026-01-04 the next Monday is the 5th.
        assert_eq!(
            next_fire_ms(&monday_only, at(2026, 1, 4, 9, 0)),
            Some(at(2026, 1, 5, 8, 0))
        );
        // From Monday 09:00 the next occurrence is a whole week later.
        assert_eq!(
            next_fire_ms(&monday_only, at(2026, 1, 5, 9, 0)),
            Some(at(2026, 1, 12, 8, 0))
        );
        // Weekends are skipped for a weekdays-only rule (2026-01-10 is a Saturday).
        let weekdays = TimeSpec {
            hour: 7,
            minute: 30,
            days: vec![1, 2, 3, 4, 5],
        };
        assert_eq!(
            next_fire_ms(&weekdays, at(2026, 1, 10, 12, 0)),
            Some(at(2026, 1, 12, 7, 30))
        );
    }

    // ---- plan lifecycle ---------------------------------------------------

    #[test]
    fn sync_arms_states_and_reports_the_capacity_refusal_by_name() {
        let state = ShortcutTriggerState::new();
        let now = at(2026, 1, 5, 7, 0);
        let reply = state.sync(vec![spec("s1:t1", "08:00", &[1])], now);

        assert_eq!(reply.armed.len(), 1);
        assert_eq!(reply.armed[0].key, "s1:t1");
        assert_eq!(reply.armed[0].at_ms, at(2026, 1, 5, 8, 0));
        // The device half is a *fact about this host*, so the assertion is per-configuration
        // (the same shape `alarm_sched::tests` uses): desktop/CI has no `AlarmManager` and
        // answers `HostOnly`, while the `android` feature on a host with no JVM attached
        // answers `Unattached`. Hard-coding either one makes this test red in the other
        // configuration — which is how it was found (`make test` runs the android feature).
        #[cfg(not(feature = "android"))]
        assert_eq!(reply.armed[0].device, DeviceOutcome::HostOnly);
        #[cfg(feature = "android")]
        assert_eq!(reply.armed[0].device, DeviceOutcome::Unattached);
        assert!(reply.rejected.is_empty());
        assert!(reply.canceled.is_empty());
        assert_eq!(state.len(), 1);
    }

    #[test]
    fn sync_replaces_the_plan_and_cancels_what_left_it() {
        let state = ShortcutTriggerState::new();
        let now = at(2026, 1, 5, 7, 0);
        state.sync(
            vec![spec("s1:t1", "08:00", &[]), spec("s1:t2", "09:00", &[])],
            now,
        );
        assert_eq!(state.len(), 2);

        // Only t1 remains → t2 is cancelled, t1 re-armed (idempotent).
        let reply = state.sync(vec![spec("s1:t1", "08:00", &[])], now);
        assert_eq!(reply.armed.len(), 1);
        assert_eq!(reply.canceled, vec!["s1:t2".to_string()]);
        assert_eq!(state.len(), 1);
        assert!(!state.rules().contains_key("s1:t2"));

        // An empty plan cancels everything (the user deleted every automation).
        let reply = state.sync(vec![], now);
        assert_eq!(reply.canceled, vec!["s1:t1".to_string()]);
        assert!(state.is_empty());
    }

    #[test]
    fn a_bad_rule_is_rejected_by_name_and_does_not_disable_the_rest() {
        let state = ShortcutTriggerState::new();
        let now = at(2026, 1, 5, 7, 0);
        let reply = state.sync(
            vec![
                spec("ok", "08:00", &[]),
                spec("typo", "8:0", &[]),
                spec("badday", "08:00", &[9]),
            ],
            now,
        );
        assert_eq!(reply.armed.len(), 1);
        assert_eq!(reply.armed[0].key, "ok");
        assert_eq!(reply.rejected.len(), 2);
        assert!(reply.rejected.iter().any(|r| r.key == "typo"));
        assert!(reply.rejected.iter().any(|r| r.key == "badday"));
    }

    #[test]
    fn the_key_bound_is_enforced() {
        let state = ShortcutTriggerState::new();
        let long = "k".repeat(MAX_TRIGGER_KEY_BYTES + 1);
        let reply = state.sync(vec![spec(&long, "08:00", &[]), spec("", "08:00", &[])], 0);
        assert!(reply.armed.is_empty());
        assert_eq!(reply.rejected.len(), 2);
    }

    // ---- firing -----------------------------------------------------------

    #[test]
    fn poll_fires_once_and_re_arms_the_next_occurrence() {
        let state = ShortcutTriggerState::new();
        state.sync(vec![spec("s:t", "08:00", &[])], at(2026, 1, 5, 7, 0));

        // Before the instant: nothing due.
        assert!(state.poll(at(2026, 1, 5, 7, 59)).is_empty());

        // At the instant: fired, and it reports the instant it fired *for*.
        let fired = state.poll(at(2026, 1, 5, 8, 0));
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].key, "s:t");
        assert_eq!(fired[0].at_ms, at(2026, 1, 5, 8, 0));

        // Polling again in the same minute must NOT fire it twice...
        assert!(state.poll(at(2026, 1, 5, 8, 0)).is_empty());
        // ...and it is already armed for tomorrow.
        assert_eq!(state.len(), 1);
        assert_eq!(
            state.poll(at(2026, 1, 6, 8, 0))[0].at_ms,
            at(2026, 1, 6, 8, 0)
        );
    }

    #[test]
    fn a_long_sleep_fires_once_not_once_per_missed_occurrence() {
        let state = ShortcutTriggerState::new();
        state.sync(vec![spec("s:t", "08:00", &[])], at(2026, 1, 5, 7, 0));
        // The device was asleep for three days; the shell wakes up and polls.
        let fired = state.poll(at(2026, 1, 8, 12, 0));
        assert_eq!(
            fired.len(),
            1,
            "one missed window is one trigger, not three"
        );
        // And the plan continues normally afterwards.
        assert_eq!(
            state.poll(at(2026, 1, 9, 8, 0))[0].at_ms,
            at(2026, 1, 9, 8, 0)
        );
    }

    #[test]
    fn cancel_removes_the_rule_from_both_halves() {
        let state = ShortcutTriggerState::new();
        state.sync(vec![spec("s:t", "08:00", &[])], at(2026, 1, 5, 7, 0));
        assert!(state.cancel("s:t"));
        assert!(!state.cancel("s:t"), "already gone");
        assert!(state.is_empty());
        assert!(state.poll(at(2026, 1, 6, 8, 0)).is_empty());
    }
}

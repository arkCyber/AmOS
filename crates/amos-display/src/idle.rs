//! Idle-timeout screen controller: the state machine that turns the display off
//! after inactivity (or wakes it), plus the [`IdlePolicy`] timeouts it runs on.

use std::collections::BTreeSet;
use std::time::Duration;

use crate::spec::{ScreenChange, ScreenState};

/// Idle timeouts for auto screen-off, per power source. Keeping them separate is
/// phone-accurate: on a charger the screen may stay alive far longer than on
/// battery, and a host can tune either without the other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IdlePolicy {
    /// Idle time (in caller monotonic ticks) before auto-off while on battery.
    pub on_battery_timeout: Duration,
    /// Idle time (in caller monotonic ticks) before auto-off while charging.
    pub on_charger_timeout: Duration,
}

impl IdlePolicy {
    /// A sane default: ~30 s on battery, ~2 min while charging.
    pub fn default_for_phones() -> Self {
        Self {
            on_battery_timeout: Duration::from_secs(30),
            on_charger_timeout: Duration::from_secs(120),
        }
    }

    /// Which timeout applies for the given power source.
    pub fn timeout_for(&self, charging: bool) -> Duration {
        if charging {
            self.on_charger_timeout
        } else {
            self.on_battery_timeout
        }
    }
}

impl Default for IdlePolicy {
    fn default() -> Self {
        Self::default_for_phones()
    }
}

/// A deterministic auto screen-off state machine. Callers own the clock: every
/// method takes a `now` in **seconds** since the host's idle clock started (the
/// natural cadence of a phone screen timeout), so this is fully offline-testable.
///
/// * [`ScreenController::touch`] — a user interaction happened: mark activity
///   and, if the screen was off, report it came back `On` (a wake).
/// * [`ScreenController::probe`] — periodic: if On and idle for >= the policy's
///   timeout (and nothing *holds* the screen — a persistent reason or the
///   transient argument), turn it `Off`.
/// * [`ScreenController::set_hold`] / [`ScreenController::clear_hold`] — a host
///   declares/revokes a *reason* the screen must stay on (an active call, media
///   playback, turn-by-turn nav). Any active hold suppresses auto-off.
/// * [`ScreenController::sleep`] / [`ScreenController::wake`] — explicit host
///   control (power button / app-requested).
///
/// Holds are **reason-keyed and sticky** (unlike the transient per-probe
/// `hold_screen` argument): a host asserts a reason once (e.g. `"call"`) and it
/// stays until the reason is explicitly revoked — no repeated bookkeeping on
/// every probe, and two overlapping sources (call + media) each need their own
/// clear.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScreenController {
    state: ScreenState,
    policy: IdlePolicy,
    last_activity: u64,
    /// Reasons the display must not auto-off, e.g. `"call"` / `"media"` / `"nav"`.
    holds: BTreeSet<String>,
}

impl ScreenController {
    /// Start `On`, treating `now` as the last-activity instant.
    pub fn new(policy: IdlePolicy, now: u64) -> Self {
        Self {
            state: ScreenState::On,
            policy,
            last_activity: now,
            holds: BTreeSet::new(),
        }
    }

    /// The idle policy this controller runs on.
    pub fn policy(&self) -> &IdlePolicy {
        &self.policy
    }

    /// Current display state.
    pub fn state(&self) -> ScreenState {
        self.state
    }

    /// Last monotonic tick at which the user interacted.
    pub fn last_activity(&self) -> u64 {
        self.last_activity
    }

    /// Declare a reason the screen must stay on (idempotent). Returns `true` the
    /// first time `reason` is asserted (a second `set_hold` of the same reason is
    /// a no-op → `false`). See also [`ScreenController::clear_hold`].
    pub fn set_hold(&mut self, reason: impl Into<String>) -> bool {
        self.holds.insert(reason.into())
    }

    /// Revoke a hold reason. Returns `true` if it was active (and is now gone).
    pub fn clear_hold(&mut self, reason: &str) -> bool {
        self.holds.remove(reason)
    }

    /// Whether any reason is currently holding the screen on.
    pub fn held(&self) -> bool {
        !self.holds.is_empty()
    }

    /// The active hold reasons, ascending.
    pub fn holds(&self) -> impl Iterator<Item = &str> {
        self.holds.iter().map(String::as_str)
    }

    /// Register a user interaction at `now`. Resets the idle clock; if the
    /// screen was off this wakes it (`ScreenChange::On`).
    pub fn touch(&mut self, now: u64) -> ScreenChange {
        self.last_activity = now;
        if self.state == ScreenState::Off {
            self.state = ScreenState::On;
            ScreenChange::On
        } else {
            ScreenChange::None
        }
    }

    /// Explicitly turn the display off (power button, app sleep request).
    pub fn sleep(&mut self) -> ScreenChange {
        if self.state == ScreenState::On {
            self.state = ScreenState::Off;
            ScreenChange::Off
        } else {
            ScreenChange::None
        }
    }

    /// Explicitly wake the display at `now`.
    pub fn wake(&mut self, now: u64) -> ScreenChange {
        self.last_activity = now;
        if self.state == ScreenState::Off {
            self.state = ScreenState::On;
            ScreenChange::On
        } else {
            ScreenChange::None
        }
    }

    /// Periodic idle probe. Reports `ScreenChange::Off` exactly once, the first
    /// tick at which the display has been idle long enough to sleep. Never auto-
    /// turns back on (waking is always explicit / user-driven).
    ///
    /// * `charging` — picks the battery vs charger idle timeout.
    /// * `hold_screen` — a transient, one-shot "keep awake" flag (an active call,
    ///   a foreground-heavy task). Auto-off is suppressed while it is `true` OR
    ///   while any persistent [`ScreenController::set_hold`] reason is active —
    ///   either alone is enough to keep the display on.
    pub fn probe(&mut self, now: u64, charging: bool, hold_screen: bool) -> ScreenChange {
        if self.state == ScreenState::Off {
            return ScreenChange::None;
        }
        if hold_screen || self.held() {
            return ScreenChange::None;
        }
        // Timeouts are wall-time Durations but the caller drives `now` in whole
        // seconds. A sub-second timeout would truncate to 0 and (via `idle >= 0`)
        // turn the screen off on the very first probe — so floor it at 1 s: the
        // finest granularity this controller can honour, never an instant sleep
        // from a misconfigured Duration.
        let timeout_ticks = self.policy.timeout_for(charging).as_secs().max(1);
        let idle = now.saturating_sub(self.last_activity);
        if idle >= timeout_ticks {
            self.state = ScreenState::Off;
            ScreenChange::Off
        } else {
            ScreenChange::None
        }
    }
}

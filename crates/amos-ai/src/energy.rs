//! Daemon energy governor (`energy.rs`) — assembly of [`amos_power`].
//!
//! Mirrors `profiler.rs`: a shared store behind an `Arc` that a periodic task
//! ticks and that `get_status` reads into the `StatusReply.energy` wire message.
//! Inputs are env-configured on a host (`AMOS_ENERGY_*`); on a real device a
//! sampler feeds the live battery/thermal HAL instead (the same seam
//! `amos-profiling`'s `PowerSource` describes — `docs/power-policy.md`).
//!
//! Honest labels: the daemon does not measure real power or drive a
//! `SensorManager` here — it *runs the governor* and reports the recommended
//! mode/flags so a UI/supervisor can act on `cap_inference` / `throttle_background`.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use amos_power::{BatteryState, Decision, EnergyGovernor, Policy, Telemetry, Usage};

/// A point-in-time governor read (mapped onto the `EnergyPolicy` wire message and
/// the periodic log line).
#[derive(Clone, Copy, Debug)]
pub struct EnergySnapshot {
    /// Recommended mode key: `performance` | `balanced` | `power_save`.
    pub sensor_mode: &'static str,
    /// Stable reason key (`amos_power::Reason::key`); `pending` before the first tick.
    pub reason: &'static str,
    /// Governor recommends capping / deferring inference.
    pub cap_inference: bool,
    /// Governor recommends deferring background work.
    pub throttle_background: bool,
    /// Periodic governor ticks so far (`> 0` ⇒ the governor has run).
    pub ticks: u64,
    // Latest tick's inputs (for diagnostics / an operator reading the log line).
    pub level_pct: Option<f64>,
    pub temperature_c: Option<f64>,
    pub power_mw: Option<f64>,
    pub charging: bool,
    pub screen_on: bool,
    pub inference_active: bool,
}

impl EnergySnapshot {
    /// The not-yet-run baseline: Balanced/healthy, zero ticks.
    pub fn pending() -> Self {
        Self {
            sensor_mode: "balanced",
            reason: "pending",
            cap_inference: false,
            throttle_background: false,
            ticks: 0,
            level_pct: None,
            temperature_c: None,
            power_mw: None,
            charging: false,
            screen_on: true,
            inference_active: false,
        }
    }
}

/// Shared, periodically-ticked energy governor for the daemon.
pub struct EnergyStore {
    governor: Mutex<EnergyGovernor>,
    ticks: AtomicU64,
    last: Mutex<Option<EnergySnapshot>>,
}

impl Default for EnergyStore {
    fn default() -> Self {
        Self::new()
    }
}

impl EnergyStore {
    /// A governor with the default [`Policy`].
    pub fn new() -> Self {
        Self::new_with_policy(Policy::default())
    }

    /// A governor with an explicit [`Policy`].
    pub fn new_with_policy(policy: Policy) -> Self {
        Self {
            governor: Mutex::new(EnergyGovernor::new(policy)),
            ticks: AtomicU64::new(0),
            last: Mutex::new(None),
        }
    }

    /// Run one governor tick on an explicit [`Telemetry`] and remember the result.
    /// Deterministic and env-free — the unit-test entry point.
    pub fn tick_with(&self, telemetry: Telemetry) -> EnergySnapshot {
        let mut gov = self.governor.lock().unwrap_or_else(|p| p.into_inner());
        let d: Decision = gov.observe(&telemetry);
        let ticks = self.ticks.fetch_add(1, Ordering::Relaxed) + 1;
        let snap = snapshot_of(&d, ticks, &telemetry);
        *self.last.lock().unwrap_or_else(|p| p.into_inner()) = Some(snap);
        snap
    }

    /// Run one governor tick on an env-sampled [`Telemetry`] (the periodic-loop /
    /// CLI entry point on a host). See [`telemetry_from_env`].
    pub fn tick_once(&self) -> EnergySnapshot {
        self.tick_with(telemetry_from_env())
    }

    /// Current read: the latest tick, or the "pending" baseline before the first.
    pub fn snapshot(&self) -> EnergySnapshot {
        self.last
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .unwrap_or_else(EnergySnapshot::pending)
    }

    /// Periodically tick the governor and log the decision, on the same cadence as
    /// the health / profile heartbeats. Aborted on shutdown (mirrors the others).
    pub fn spawn_periodic(self: &Arc<Self>, interval: Duration) -> tokio::task::JoinHandle<()> {
        let interval = interval.max(Duration::from_millis(1));
        let store = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            // Runs until the daemon shuts down: this task has no exit and is aborted
            // with the runtime (or the process stopping). `tick()` is the wait.
            loop {
                ticker.tick().await;
                let s = store.tick_once();
                tracing::info!(
                    sensor_mode = s.sensor_mode,
                    reason = s.reason,
                    cap_inference = s.cap_inference,
                    throttle_background = s.throttle_background,
                    ticks = s.ticks,
                    level_pct = s.level_pct.map(|x| format!("{x:.1}")).unwrap_or_default(),
                    temperature_c = s
                        .temperature_c
                        .map(|x| format!("{x:.1}"))
                        .unwrap_or_default(),
                    power_mw = s.power_mw.map(|x| format!("{x:.1}")).unwrap_or_default(),
                    charging = s.charging,
                    screen_on = s.screen_on,
                    inference_active = s.inference_active,
                    "amos-ai energy governor"
                );
            }
        })
    }
}

/// Fold a decision + the telemetry it came from into an [`EnergySnapshot`].
fn snapshot_of(d: &Decision, ticks: u64, t: &Telemetry) -> EnergySnapshot {
    EnergySnapshot {
        sensor_mode: d.sensor_mode.key(),
        reason: d.reason.key(),
        cap_inference: d.cap_inference,
        throttle_background: d.throttle_background,
        ticks,
        level_pct: t.battery.level_pct,
        temperature_c: t.battery.temperature_c,
        power_mw: t.power_mw,
        charging: t.battery.charging,
        screen_on: t.usage.screen_on,
        inference_active: t.usage.inference_active,
    }
}

/// Sample a [`Telemetry`] for one governor tick from `AMOS_ENERGY_*` environment
/// variables (host/dev). Unset optional readings stay `None` (unknown) — the
/// policy never assumes a healthy battery. Real on-device samplers replace this.
///
/// `screen_on` is resolved with the display-protection contract first: if
/// `AMOS_SCREEN_STATE_PATH` names a readable file whose content is `off`, the
/// screen is genuinely off (the System UI host wrote it on idle); otherwise it
/// falls back to the legacy `AMOS_ENERGY_SCREEN_ON` flag, then to `true`. This is
/// what lets "auto screen-off" actually reach the governor — see
/// `docs/display-idle.md` and `crates/amos-display`.
///
/// Every `bool` flag here is read *strictly* (see [`parse_flag`]): a value this
/// module cannot read — empty, or a typo — is "no signal", so the flag's own
/// documented default applies rather than a fabricated `false`. (REQ-A533.)
pub fn telemetry_from_env() -> Telemetry {
    let battery = BatteryState {
        level_pct: env_f64("AMOS_ENERGY_LEVEL_PCT"),
        // An unreadable/unset charger state must not unlock Performance (policy
        // step 6), so the default is "on battery" — the conservative side. The
        // strict parse below means a typo lands here too, never on a fabricated
        // `false` of its own (REQ-A533).
        charging: env_flag("AMOS_ENERGY_CHARGING").unwrap_or(false),
        temperature_c: env_f64("AMOS_ENERGY_TEMP_C"),
    };
    let usage = Usage {
        screen_on: resolve_screen_on(),
        // `Usage`'s workload hints are plain `bool`s (`amos_power::types::Usage`
        // cannot express "unknown"), so an absent hint reads as "no such workload
        // was reported" — which never *starts* a throttle on a reading we do not
        // have. A mistyped flag reaches here as the same absent hint, not as an
        // assertion (REQ-A533).
        foreground_heavy: env_flag("AMOS_ENERGY_FOREGROUND_HEAVY").unwrap_or(false),
        inference_active: env_flag("AMOS_ENERGY_INFERENCE_ACTIVE").unwrap_or(false),
    };
    Telemetry::new(battery, usage, env_f64("AMOS_ENERGY_POWER_MW"))
}

/// Resolve the *authoritative* screen on/off for one governor tick.
///
/// 1. If `AMOS_SCREEN_STATE_PATH` points at a readable `on`/`off` file (written
///    by the System UI on idle/wake), that wins — the display is really off.
/// 2. Otherwise the legacy `AMOS_ENERGY_SCREEN_ON` flag decides (host/dev).
/// 3. Otherwise (nothing configured, **or a value we could not read**) we
///    conservatively assume the screen is on — the governor must not start
///    throttling as if asleep with no signal.
fn resolve_screen_on() -> bool {
    let from_file = amos_display::screen_state_path()
        .and_then(|p| amos_display::read_screen_state_from(&p))
        .map(|s| s == amos_display::ScreenState::On);
    resolve_screen_on_from(from_file, env_flag("AMOS_ENERGY_SCREEN_ON"))
}

/// The pure priority rule behind [`resolve_screen_on`] — split out so that
/// "the file wins, the flag is next, and with no readable signal at all the screen
/// is assumed **on**" is unit-testable without touching the process environment.
///
/// `flag` is the strict tri-state from [`env_flag`]: a mistyped value arrives as
/// `None` ("no signal") and falls through to the same conservative `true` as an
/// unset flag. It is deliberately **not** read as `false` — under the old
/// collapse-to-`false` parse, a typo like `AMOS_ENERGY_SCREEN_ON=flase` made the
/// governor treat an in-use device as asleep and defer background work (policy
/// steps 5 and 7). (REQ-A533.)
fn resolve_screen_on_from(from_file: Option<bool>, flag: Option<bool>) -> bool {
    from_file.or(flag).unwrap_or(true)
}

/// Parse an optional float env var; garbage / empty → `None`.
fn env_f64(key: &str) -> Option<f64> {
    std::env::var(key).ok().and_then(|v| v.parse::<f64>().ok())
}

/// The tokens a `bool` flag accepts as **true** / **false**. The documented
/// convention in `docs/ENV_VARIABLES.md` is `1`/`0`/`true`/`false`; `yes`/`on`
/// and `no`/`off` are accepted as the obvious operator spellings of the same two
/// states. Nothing outside these two sets is a value this module understands.
const TRUE_TOKENS: [&str; 4] = ["1", "true", "yes", "on"];
const FALSE_TOKENS: [&str; 4] = ["0", "false", "no", "off"];

/// Parse a bool flag value **strictly** into three states: `Some(true)` for a
/// truthy token, `Some(false)` for a falsy one, and `None` for a value we could
/// not read (unset, empty, or a typo).
///
/// The third state is the whole point. `Usage` / `BatteryState` carry plain
/// `bool`s that cannot express "unknown", so every caller keeps an explicit
/// default — and it may only ever be *overridden* by a value this function
/// actually understood. The previous implementation mapped everything outside the
/// truthy set to a definite `Some(false)`, which silently turned a typo (`ture`,
/// `flase`, `enable`) into an assertion the operator never made. Both directions
/// of that were wrong: `AMOS_ENERGY_SCREEN_ON` mistyped made the governor treat an
/// in-use device as asleep (deferring background work), while
/// `AMOS_ENERGY_INFERENCE_ACTIVE` mistyped made it believe no inference was running
/// (so policy step 5's `PowerDraw` cap never engaged). (REQ-A533.)
///
/// A misread is no longer silent: each distinct unrecognized `(key, value)` pair is
/// logged at WARN once per process — the same "no silently inert configuration"
/// rule `telemetry_spy_capture::plan_from_env_values` already follows.
///
/// (This comment used to exempt the *opt-in gates* — `notifier_sink::amos_notifier_enabled`,
/// `telemetry_spy_capture::env_flag` — as "anything else is false … deliberate and
/// safe". Half of that held: a typo landing on the gate's off side cannot *open*
/// it, so the collapse was safe in the arming direction. It was not safe in the
/// reading direction, and that half was wrong: an operator who writes
/// `AMOS_NOTIFIER=enable` believes paging is armed, and `AMOS_SPY_LAYER3=enable`
/// silently frames the capture at L2 — neither was told otherwise. Both now use
/// the same two token sets as this function and warn on a value outside them;
/// the off default still applies, so a typo still cannot arm anything.
/// REQ-A1903.)
fn parse_flag(key: &str, raw: Option<&str>) -> Option<bool> {
    let raw = raw?;
    let tok = raw.trim().to_ascii_lowercase();
    if TRUE_TOKENS.contains(&tok.as_str()) {
        return Some(true);
    }
    if FALSE_TOKENS.contains(&tok.as_str()) {
        return Some(false);
    }
    warn_once_bad_flag(key, raw);
    None
}

/// Read and strictly parse (see [`parse_flag`]) an optional `bool` env var.
///
/// Read through [`std::env::var_os`] so the two facts `std::env::var` folds
/// together stay apart: an **unset** key is silent, while a value that is present
/// but not valid Unicode is reported once. `std::env::var(..).ok()` mapped both
/// to the same silent `None`, so a mojibake value read as "not set" (REQ-A1920).
///
/// `pub(crate)` so the other flag readers in this crate — the JSON-log opt-in, the
/// telemetry-spy and netguard feed gates — share this one rule rather than keeping
/// their own copy of it.
pub(crate) fn env_flag(key: &str) -> Option<bool> {
    flag_from_os(key, std::env::var_os(key))
}

/// [`env_flag`] with the raw value supplied by the caller, so a reader can be
/// exercised on a value without mutating the process environment (one value per key
/// per process). Absent is the only silent state; a value present but not valid
/// Unicode is reported once. The `key` is a parameter — as in [`parse_flag`] — so a
/// caller's own rule stays testable, and one gate does not need the process env to
/// pin how it reads one.
pub(crate) fn flag_from_os(key: &str, raw: Option<std::ffi::OsString>) -> Option<bool> {
    let raw = raw?;
    let Some(raw) = raw.to_str() else {
        warn_once_bad_flag(key, "<non-Unicode>");
        return None;
    };
    parse_flag(key, Some(raw))
}

/// The `(key, value)` pairs already reported as unrecognized (see
/// [`warn_once_bad_flag`]). One entry per distinct bad value ever seen.
fn bad_flag_seen() -> &'static Mutex<BTreeSet<(String, String)>> {
    static SEEN: OnceLock<Mutex<BTreeSet<(String, String)>>> = OnceLock::new();
    SEEN.get_or_init(Default::default)
}

/// Log an unrecognized flag value at WARN **once per distinct `(key, value)` per
/// process**. [`telemetry_from_env`] runs on every governor tick (a timer), so an
/// un-deduped warning would repeat the same line forever — log flooding is its own
/// defect.
fn warn_once_bad_flag(key: &str, value: &str) {
    let first = bad_flag_seen()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert((key.to_owned(), value.to_owned()));
    if first {
        tracing::warn!(
            key,
            value,
            "amos-ai energy: unrecognized bool flag value — treating the flag as unset so \
             the caller's conservative default applies (expected 1/0/true/false/yes/no/on/off)"
        );
    }
}

/// How many times `key` has been reported as an unrecognized flag, for the unit
/// test that pins the once-per-distinct-value rule. Counting the *record* rather
/// than tracing events is deliberate: `tracing` caches callsite interest globally,
/// so a test that counts events at a callsite other tests also hit reads 0 or 2
/// depending on suite scheduling (measured) — and a flaky honesty test is worse
/// than none. The `warn!` is the single statement inside the `if first` branch.
#[cfg(test)]
pub(crate) fn bad_flag_reports_for(key: &str) -> usize {
    bad_flag_seen()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .filter(|(k, _)| k == key)
        .count()
}

/// Read and parse an optional **numeric** env knob, keeping three facts apart:
/// **unset** (silent, `None`), a **usable** number, and a value the operator set
/// but which is unusable — either present but not valid Unicode, or not a number.
/// Each unusable `(key, value)` is reported at WARN once per process. A *blank*
/// value is treated as unset, silently (a blank is "nothing typed", not a typed
/// mistake).
///
/// `std::env::var(..).ok().and_then(|v| v.parse().ok())` folded all three into one
/// silent `None`, so a set-but-unreadable override was indistinguishable from an
/// unset one — the same defect [`env_flag`] was fixed for in the bool direction.
/// `pub(crate)` so every numeric knob in this crate shares one rule. (REQ-A2000 /
/// F-AI-062)
pub(crate) fn number_from(key: &str, raw: Option<std::ffi::OsString>) -> Option<u64> {
    let raw = raw?;
    let Some(s) = raw.to_str() else {
        warn_once_bad_number(key, "<non-Unicode>");
        return None;
    };
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    match s.parse::<u64>() {
        Ok(n) => Some(n),
        Err(_) => {
            warn_once_bad_number(key, s);
            None
        }
    }
}

/// The `(key, value)` pairs already reported as an unusable number (see
/// [`warn_once_bad_number`]).
fn bad_number_seen() -> &'static Mutex<BTreeSet<(String, String)>> {
    static SEEN: OnceLock<Mutex<BTreeSet<(String, String)>>> = OnceLock::new();
    SEEN.get_or_init(Default::default)
}

fn warn_once_bad_number(key: &str, value: &str) {
    let first = bad_number_seen()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert((key.to_owned(), value.to_owned()));
    if first {
        tracing::warn!(
            key,
            value,
            "amos-ai energy: {key} is set to a value that is not a usable number — treating it \
             as unset so the caller's documented default applies"
        );
    }
}

#[cfg(test)]
pub(crate) fn bad_number_reports_for(key: &str) -> usize {
    bad_number_seen()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .filter(|(k, _)| k == key)
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(level: f64) -> Telemetry {
        Telemetry::new(BatteryState::on_battery(level), Usage::default(), None)
    }

    #[test]
    fn pending_snapshot_before_any_tick() {
        let s = EnergyStore::new();
        let snap = s.snapshot();
        assert_eq!(snap.ticks, 0);
        assert_eq!(snap.reason, "pending");
        assert_eq!(snap.sensor_mode, "balanced");
    }

    #[test]
    fn tick_records_mode_reason_and_counts() {
        let s = EnergyStore::new();
        // 15 % on battery → PowerSave / battery_low.
        let a = s.tick_with(t(15.0));
        assert_eq!(a.ticks, 1);
        assert_eq!(a.sensor_mode, "power_save");
        assert_eq!(a.reason, "battery_low");
        assert!(a.cap_inference && a.throttle_background);
        // Healthy charge later → balanced / healthy; ticks increment.
        let b = s.tick_with(t(70.0));
        assert_eq!(b.ticks, 2);
        assert_eq!(b.sensor_mode, "balanced");
        assert_eq!(b.reason, "healthy");
        assert_eq!(s.snapshot().ticks, 2);
    }

    #[test]
    fn charging_decision_is_performance() {
        let s = EnergyStore::new();
        let snap = s.tick_with(Telemetry::new(
            BatteryState::charging(50.0),
            Usage::default(),
            None,
        ));
        assert_eq!(snap.sensor_mode, "performance");
        assert_eq!(snap.reason, "charging");
    }

    #[test]
    fn telemetry_from_env_parses_numbers_and_flags() {
        // SAFETY: these tests run single-threaded w.r.t. env by convention; we set
        // only AMOS_ENERGY_* keys that no other test reads, so no cross-test race.
        std::env::set_var("AMOS_ENERGY_LEVEL_PCT", "12.5");
        std::env::set_var("AMOS_ENERGY_CHARGING", "1");
        std::env::set_var("AMOS_ENERGY_TEMP_C", "41.0");
        std::env::set_var("AMOS_ENERGY_POWER_MW", "5200");
        let t = telemetry_from_env();
        assert_eq!(t.battery.level_pct, Some(12.5));
        assert!(t.battery.charging);
        assert_eq!(t.battery.temperature_c, Some(41.0));
        assert_eq!(t.power_mw, Some(5200.0));
        std::env::remove_var("AMOS_ENERGY_LEVEL_PCT");
        std::env::remove_var("AMOS_ENERGY_CHARGING");
        std::env::remove_var("AMOS_ENERGY_TEMP_C");
        std::env::remove_var("AMOS_ENERGY_POWER_MW");
    }

    #[test]
    fn screen_state_file_overrides_env_flag() {
        // SAFETY: we touch only AMOS_SCREEN_STATE_PATH / AMOS_ENERGY_SCREEN_ON,
        // which no other test in this binary reads, so no cross-test race (repo
        // convention). The file is written under a unique temp path.
        let path =
            std::env::temp_dir().join(format!("amos-ai-screen-{}.state", std::process::id()));
        // File says "off" → the screen is genuinely off, regardless of the flag.
        std::fs::write(&path, "off").expect("temp write");
        std::env::set_var("AMOS_SCREEN_STATE_PATH", &path);
        std::env::set_var("AMOS_ENERGY_SCREEN_ON", "1");
        assert!(!telemetry_from_env().usage.screen_on);
        // File says "on" → the screen is on, again regardless of the flag.
        std::fs::write(&path, "on").expect("temp write");
        std::env::set_var("AMOS_ENERGY_SCREEN_ON", "0");
        assert!(telemetry_from_env().usage.screen_on);
        // No file contract → falls back to the legacy flag.
        std::env::remove_var("AMOS_SCREEN_STATE_PATH");
        std::env::set_var("AMOS_ENERGY_SCREEN_ON", "1");
        assert!(telemetry_from_env().usage.screen_on);
        std::env::set_var("AMOS_ENERGY_SCREEN_ON", "0");
        assert!(!telemetry_from_env().usage.screen_on);
        // A *mistyped* value is no signal at all, not an assertion that the screen
        // is off: the documented conservative default (assume on) must apply. Under
        // the old collapse-to-`false` parse this deferred background work on a device
        // the user was actively looking at (REQ-A533).
        std::env::set_var("AMOS_ENERGY_SCREEN_ON", "ture");
        assert!(
            telemetry_from_env().usage.screen_on,
            "a typo must not force screen-off"
        );
        // Same for an empty value (`export AMOS_ENERGY_SCREEN_ON=`).
        std::env::set_var("AMOS_ENERGY_SCREEN_ON", "");
        assert!(
            telemetry_from_env().usage.screen_on,
            "an empty flag is no signal"
        );
        // Cleanup.
        std::env::remove_var("AMOS_SCREEN_STATE_PATH");
        std::env::remove_var("AMOS_ENERGY_SCREEN_ON");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn screen_on_priority_and_conservative_default() {
        // The file contract wins over the flag, the flag wins over nothing, and
        // with no readable signal at all the screen is assumed ON — never "asleep",
        // which would start throttling on a reading we do not have. (REQ-A533.)
        assert!(
            !resolve_screen_on_from(Some(false), Some(true)),
            "the screen-state file wins over the legacy flag"
        );
        assert!(resolve_screen_on_from(Some(true), Some(false)));
        assert!(!resolve_screen_on_from(None, Some(false)));
        assert!(resolve_screen_on_from(None, Some(true)));
        assert!(
            resolve_screen_on_from(None, None),
            "no signal ⇒ assume the screen is on"
        );
    }

    #[test]
    fn flag_parse_is_strict_and_three_valued() {
        // Keys here are unique to this test so the process-wide "already warned"
        // set cannot make an assertion order-dependent.
        let key = "AMOS_ENERGY_PROBE_STRICT";
        for t in ["1", "true", "TRUE", " yes ", "On"] {
            assert_eq!(parse_flag(key, Some(t)), Some(true), "{t:?}");
        }
        for f in ["0", "false", "FALSE", " no ", "off"] {
            assert_eq!(parse_flag(key, Some(f)), Some(false), "{f:?}");
        }
        // Unset, empty, and every mistyped value are *not* a definite `false` —
        // they are "no signal", so the caller's own default decides (REQ-A533).
        for bad in [
            None,
            Some(""),
            Some("ture"),
            Some("flase"),
            Some("2"),
            Some("enable"),
        ] {
            assert_eq!(
                parse_flag(key, bad),
                None,
                "{bad:?} must not be read as false"
            );
        }
    }

    #[test]
    fn an_unreadable_flag_is_reported_once_per_distinct_value() {
        // Asserted on the report *record*, not on a count of tracing events: a unit
        // test cannot reliably observe events at a callsite shared with other tests in
        // this binary (`tracing` caches callsite interest globally — measured: the
        // event-counting version of this test read 0 and 2 across runs of the same
        // binary). The `warn!` is the single statement in the `if first` branch.
        let key = "AMOS_ENERGY_PROBE_WARN";
        // Understood values are silent.
        assert_eq!(parse_flag(key, Some("1")), Some(true));
        assert_eq!(parse_flag(key, Some("0")), Some(false));
        assert_eq!(bad_flag_reports_for(key), 0, "understood values are silent");
        // The first sighting of a bad value is reported; a repeat is not — the
        // governor ticks on a timer, so an un-deduped report would flood the log
        // forever. A *different* bad value is news again.
        assert_eq!(parse_flag(key, Some("ture")), None);
        assert_eq!(bad_flag_reports_for(key), 1);
        assert_eq!(parse_flag(key, Some("ture")), None);
        assert_eq!(
            bad_flag_reports_for(key),
            1,
            "an identical repeat is not re-reported"
        );
        assert_eq!(parse_flag(key, Some("flase")), None);
        assert_eq!(
            bad_flag_reports_for(key),
            2,
            "a different bad value is news"
        );
    }
}

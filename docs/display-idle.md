# Display Protection / Auto Screen-Off (idle → sleep → lock)

> 2026-09-05 — new capability. A phone does not need a desktop "screensaver";
> it needs a small honest rule: *after the user stops interacting, turn the
> display off*, which the OS then renders as sleep + lock and the energy
> governor reads as `screen_on = false` (so it defers background work and can
> freeze apps).

## 1. Why (and what this is *not*)

`README` / `FUNCTIONAL_GAP_ANALYSIS.md` already ship a **lock screen (PIN)**, a
**Doze-aware scheduler**, and an **energy governor** whose `Usage.screen_on`
input existed but — until this change — came only from an env default
(`AMOS_ENERGY_SCREEN_ON`, `crates/amos-ai/src/energy.rs`) or an in-test value.
So the real screen state was never connected: nothing said *"the display is
actually off right now."*

This change fills that one gap with a **display-protection layer**:

```
[ Shell (System UI) ]  activity ─▶ idle N s ─▶ sleep()         wake()/unlock()
        │                          (writes screen-state file "off")   │ "on"
        ▼                                                             │
[ amos-display: ScreenController ]   domain kernel (pure, offline-tested)
        │  screen_on = false
        ▼
[ amos-ai energy beat ]  telemetry_from_env() ─▶ ResourceGovernor.observe
        └─ defers background inference / can freeze Background apps while off
```

It deliberately does **not** add a burn-in "screensaver animation": on OLED
phones that is neither power-efficient nor protective, and the industry moved to
off / Always-On-Display instead. (An AOD is a future, separate host concern.)

## 2. Domain core: `crates/amos-display`

Pure `std`, no wall clock (callers pass `now` in arbitrary monotonic ticks) —
the same pattern as `amos-scheduler` / `amos-applife`. Design and docs in the
crate; three pieces:

- `spec.rs` — [`ScreenState`]`{On,Off}` + [`ScreenChange`]`{None,On,Off}`.
  `ScreenState::key()` is the shared vocabulary (`"on"` | `"off"`).
- `idle.rs` — [`IdlePolicy`] (separate **on-battery** vs **on-charger** idle
  timeouts) and [`ScreenController`], a deterministic auto screen-off state
  machine:
  - `touch(now)` — a user interaction: resets the idle clock; wakes if off.
  - `probe(now, charging, hold_screen)` — periodic: turns `Off` exactly once
    when On and idle ≥ the policy timeout; auto-off is suppressed while the
    transient `hold_screen` is true **or** any persistent hold is active.
  - `set_hold(reason)` / `clear_hold(reason)` / `held()` / `holds()` — first-class,
    **reason-keyed, sticky** keep-awake (an active call, media, nav): a host
    asserts `"call"` once and it suppresses auto-off until explicitly cleared;
    overlapping sources (`call` + `media`) each need their own clear.
  - `sleep()` / `wake(now)` — explicit host control.
- `host.rs` — the **screen-state file contract**: `AMOS_SCREEN_STATE_PATH`
  names a file holding `on` | `off`; `parse_screen_state` / `read_screen_state_from`
  tolerate `1/0/true/false/yes/no` and treat garbage as unknown (never guessed).

## 3. The file contract (how the two processes agree)

The System UI host owns the display; the headless daemon owns the energy
decision. They share one small file:

| Who | What |
|-----|------|
| `amos-tauri::display` | `screen_state_set(on)` / `screen_state_get()` commands. On idle the shell calls set(false); on unlock set(true). Atomic temp-file+rename write. Registered in `lib.rs`. |
| `amos-ai::energy` | `telemetry_from_env()` now calls `resolve_screen_on()`: **file wins** (if `AMOS_SCREEN_STATE_PATH` is set + readable) → else legacy `AMOS_ENERGY_SCREEN_ON` → else `true`. |
| `amos-display::host` | owns path resolution + parse/read, shared by both crates (one vocabulary, no drift). |

Setting the path is done by launch environment (dev: run the daemon and the
Tauri shell with the same `AMOS_SCREEN_STATE_PATH`). When unset there is no
cross-process effect and the shell treats a set as "no sync" (command errors →
frontend `null`), never a silent lie.

## 4. Frontend wiring (System UI shell)

Guard by a durable-store knob `amos.displayAutoOffSec` (seconds; **0 / absent
= off**, the desktop default — so existing behaviour/tests are unchanged). It is
**user-configurable** from Settings → General → **Auto screen-off** (`Segmented`:
Off / 15 s / 30 s / 60 s), and the shell reads it when the watcher arms, so a live
change re-arms it without a remount. When enabled and the shell is not locked, the
idle watcher (`svelte/osAutoOff.ts`, 1 s ticker over
`keydown`/`pointerdown`/`touchstart`/`pointermove` last-activity) sleeps after the
timeout.

All **screen-off paths go through one entry**, `lock()` (shellState): the lock
screen appears, and the shell reports `off` to the daemon. It is used by both the
TopBar 🔒 button and the idle watcher (`Shell.svelte` starts
`startOsAutoOff({ onSleep: lock })`), so a manual lock and an auto-sleep report
the *same* `screen_on = false` (no state drift). Unlock/`goHome` reports `on`.

The reporting itself lives in `svelte/osScreenState.ts` (`reportScreenOff` /
`reportScreenOn` / `reassertScreenOnUnlocked`) over `lib/display`'s
`setScreenState` / `getScreenState` commands. `Shell.svelte` drives it from **one
edge detector on the surface kind** (`home|app|…` → `off` on `lock`, `on`
otherwise), which covers every off/on path with a single line of truth, plus a
one-shot **boot re-assert** that calls `setScreenState(true)` when the shell
starts unlocked — clearing a stale `off` left by a previous run so the daemon
never keeps deferring as if the display were still dark (it reads first, so an
already-consistent `on` writes nothing).

**Keep-awake is a generic reason bus** in the Svelte shell (`lib/keepAwakeCore.ts`):
any consumer asserts a reason the display must stay on via `assertHold("reason")` /
`releaseHold("reason")` (module-singleton, sticky, each source owns its own
reason). The Shell's idle watcher (`svelte/osAutoOff.ts`) consumes the aggregate
(`screenHeld()`) and never auto-sleeps while any reason is active — the frontend
mirror of the Rust `ScreenController`'s reason-keyed holds. The wired reasons
(**call**, **video**) and the wake→home policy are detailed in §6 below.

Pure decision helpers (`clampAutoOffSec`, `autoOffDue`, `idleElapsedSec`,
`wakeHomeDue`, `makeWakeHomeGate`, `wakeHomeEnabled`) live in `lib/display.ts` and
are unit-tested offline; the hold-aware auto-off decision
(`osAutoOffDecisionHeld`) and the call-hold fold (`holdSet`) have their own
headless tests.

## 5. Verification

- `cargo test -p amos-display` — controller + host (4 unit + 9 integration =
  13; includes a sub-second-timeout safety regression — a misconfigured `<1s`
  timeout is floored to 1 s and never sleeps on the very first probe — plus
  first-class hold tests: a `"call"` hold keeps the screen on until cleared,
  overlapping holds each need their own clear, and `holds()` enumerates them).
- `cargo test -p amos-ai --lib energy::` — `screen_state_file_overrides_env_flag`
  proves the file beats the env flag in both directions + the env fallback.
- `cargo test -p amos-tauri --lib display::` — pure write/read + a command-level
  test (set/get round-trip through the real file; honest error + conservative
  `on` when no `AMOS_SCREEN_STATE_PATH` is configured).
- frontend `bun test .../display.test.ts` — clamp/idle-due + the wake→home gate
  (`makeWakeHomeGate`: no pre-leave → no fire, real wake → fire, brief absence
  ignored, once-per-leave, live preference); `osAutoOff.test.ts` (hold-aware
  decision), `keepAwakeCore.test.ts` (bus + `videoHoldActive`),
  `osTelephonyHold.test.ts` (call fold); `svelte-tests/shell.svelte.test.ts`
  **(+2)** — boot-while-unlocked re-asserts `screen_state_set on` (after reading
  the stale `off`), and locking/unlocking reports `off`/`on`, so the
  "shell → daemon screen truth" path is regression-guarded end to end;
  `tsc`/`svelte-check` clean; existing
  `Shell` DOM tests stay green (feature off by default).
- `cargo clippy -p amos-display --all-targets -D warnings` — clean.

## 6. Honest boundaries & on-device follow-on

- **Physical blanking / wake** (really turning the panel off, proximity/pocket
  wake, power-key sleep): the System UI exposes a **device seam** — `DisplayPower`
  in `amos-tauri::display` (with `FileDisplayPower`, which updates the shared
  file, and a managed `DisplayPowerBridge` the `screen_state_set/get` commands
  route through). A real Android build injects a `PowerManager`-backed `DisplayPower`
  so the panel also sleeps/wakes. Honest note: `PowerManager.goToSleep` needs
  `DEVICE_POWER`/system or OEM integration (a normal app cannot), so that binding
  is a caller-side (OEM/System-UI-APK) step — the seam itself is complete and
  unit-tested on the host.
- **Keep-awake sources**: both layers use **reason-keyed holds** — the Rust
  domain exposes `set_hold("reason")` / `clear_hold("reason")`, and the frontend
  mirrors it with the React-free **reason bus** (`lib/keepAwakeCore.ts`:
  `assertHold`/`releaseHold`/`screenHeld`/`onHoldChange`). The auto-off loop
  (`svelte/osAutoOff.ts`) now **honours the bus**: while any reason is held the
  display never auto-sleeps and the idle window restarts, so attention ends a
  full timeout after release (not instantly). Wired reasons:
  - **call** — `svelte/osTelephonyHold.ts` folds `telephony-event`s through the
    pure, call-id-aware `holdSet` reducer (`lib/useTelephonyHold.ts`):
    Ringing/Active/Dialing assert `"call"`, ending the *last* call releases it;
    overlapping calls each need their own End.
  - **video** — `svelte/PlayerApp.svelte` asserts `"video"` while a *video* track
    is playing (`videoHoldActive`), released on pause/track-change/unmount.
    Music playback is deliberately **not** a hold (a playing track must let the
    screen sleep).
  - **nav** — still unwired: Maps has no navigation session yet, so `"nav"` sits
    ready on the bus for a one-line `assertHold("nav")` when one exists.
  `Shell.svelte` starts/stops the call watcher alongside the other OS watchers.
- **Wake → home**: the "唤醒后回主屏 / Return to home on wake" preference
  (`amos.wakeHome`, default **on**, toggled in Settings → 显示与亮度) is now wired
  in the pure-Svelte shell by `svelte/osWakeHome.ts`: on `visibilitychange`/
  `blur`/`focus` it records the away time and, if the resume is a *real* wake
  (away ≥ `WAKE_HOME_MIN_MS` = 1 s), calls `goHome()`. The decision is the pure
  `makeWakeHomeGate` (`lib/display`), unit-tested; the preference is read live so
  toggling it applies without a restart. A brief notification-shade peek or
  permission dialog never yanks the user home. (Device timing — e.g. a WebView
  that does not emit `visibilitychange` on panel power — remains a device
  acceptance item.)
- **AOD** (Always-On Display clock when "off") is intentionally out of scope
  here and can sit on the same `ScreenState::Off` branch later.

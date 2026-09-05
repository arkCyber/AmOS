# Delivery notes — display protection / auto screen-off (2026-09-05)

Follows the repo DELIVERY_NOTES convention (commit message + changeset + known
limits). Design doc: `docs/display-idle.md`.

## Commit message

```
Add display protection / auto screen-off (idle → sleep → lock → power-aware)

A phone needs no desktop "screensaver": it needs "turn the display off after N
seconds of no interaction", rendered as sleep + lock, and reported to the energy
governor so a dark screen actually defers/freezes. Previously `screen_on` was an
env default with no connection to the real display.

New pure-std domain crate `amos-display` (ScreenState + IdlePolicy +
ScreenController with reason-keyed holds + the AMOS_SCREEN_STATE_PATH file
contract). Daemon energy beat now resolves `screen_on` file-first. System UI
writes the file on lock/unlock/boot via `screen_state_set/get`. Frontend: a
guarded idle watcher gated by a reactive Settings "Auto screen-off" knob, a
single screen-off entry, and a generic keep-awake reason bus with the call hold
wired. Docs in docs/display-idle.md.
```

## Changeset

### New crate `crates/amos-display` (pure `std`)
- `spec.rs` — `ScreenState{On,Off}` / `ScreenChange{None,On,Off}`; `key()` is the
  shared `on|off` vocabulary.
- `idle.rs` — `IdlePolicy` (on-battery vs on-charger timeouts); `ScreenController`
  (`touch`/`probe`/`sleep`/`wake`); sub-second timeouts floored to 1 s so a
  misconfigured Duration never sleeps on the first probe; reason-keyed sticky
  holds `set_hold`/`clear_hold`/`held`/`holds` (overlapping sources each need
  their own clear); transient per-probe `hold_screen` kept for backward compat.
- `host.rs` — `AMOS_SCREEN_STATE_PATH` file contract: `parse_screen_state` /
  `read_screen_state_from` / `screen_state_path` / `SCREEN_STATE_ENV`; tolerant of
  `on|off|1|0|true|false|yes|no`; garbage → unknown (never guessed).

### Workspace
- `Cargo.toml`: member + workspace dep `amos-display`.
- `crates/amos-ai/Cargo.toml`, `crates/amos-tauri/Cargo.toml`: depend on
  `amos-display`.

### Daemon `amos-ai::energy`
- `telemetry_from_env()` now resolves `screen_on` via `resolve_screen_on()`:
  shared file (if `AMOS_SCREEN_STATE_PATH` set + readable) → legacy
  `AMOS_ENERGY_SCREEN_ON` env → default `true`. Both the `EnergyStore` periodic
  beat and the server ResourceGovernor beat consume it, so a real screen-off now
  drives freeze/thaw/defer.

### System UI Rust `amos-tauri`
- `src/display.rs` — **device seam**: `DisplayPower` trait (`set`/`is_on`),
  desktop `FileDisplayPower` (atomic file write to `AMOS_SCREEN_STATE_PATH`),
  managed `DisplayPowerBridge` (injected via `with()`; seeded `file_default()` in
  `lib.rs`). Commands `screen_state_set` / `screen_state_get` route through the
  bridge (honest error when no path; `get` conservative-on when unknown). A real
  Android build injects a `PowerManager`-backed `DisplayPower` for physical
  blanking (OEM/`DEVICE_POWER` step). Registered in `src/lib.rs`.

### Frontend (`frontend-ts`)
- `lib/display.ts` — `clampAutoOffSec`, `idleElapsedSec`, `autoOffDue`,
  `dueForAutoSleep` (a call/hold suppresses auto-sleep), `setScreenState` /
  `getScreenState` bridge wrappers, `AUTOOFF_STORE_KEY`.
- `App.tsx` Shell — guarded idle watcher (1 s ticker over last interaction),
  single `lockScreen()` entry (TopBar 🔒 + auto-sleep both report off), unlock /
  boot re-assert on; reactive `useStoreValue` read of the timeout so a live change
  re-arms without remount.
- `apps.tsx` Settings → General → **Auto screen-off** (Off/15/30/60 s).
- `lib/keepAwake.ts` — generic keep-awake reason bus (`assertHold`/`releaseHold`/
  `useScreenHold`/`clearAllHolds`) + `useCallKeepAwake` (call-id aware via
  `lib/useTelephonyHold::holdSet`).
- i18n en/zh `settings.autoOff*`.

### Docs
- `docs/display-idle.md`; README crate + doc-list entries; CHANGELOG entry.

## Tests
- `cargo test -p amos-display`: 4 unit + 9 integration = 13 (controller / holds /
  sub-second floor / host file contract).
- `cargo test -p amos-ai --lib`: 150; `--tests` (real UDS e2e + integration): all
  pass. `amos-ai` clippy `-D warnings` clean.
- `cargo test -p amos-tauri --lib`: 101 (incl. `display::` write/read + command
  round-trip + no-path error). clippy clean.
- Frontend: `tsc --noEmit` clean; full ISO `bun run test` 607 pass / 0 fail
  (display + keepAwake + settings-autooff + telephony-hold pure/DOM; SSR shell
  mounts stay green).

## Known limits / honest boundaries
- **Physical blanking / wake** (real panel off, proximity/pocket wake, power-key
  sleep) is an Android PowerManager / `ROLE`-UI host duty — the seam here is the
  `screen_state_set` host command; a device build binds it to the real display
  manager instead of (or in addition to) the file contract.
- Cross-process file contract requires the daemon and System UI to share
  `AMOS_SCREEN_STATE_PATH` in the launch environment; when unset the shell treats
  a set as "no sync" (never a silent lie).
- Keep-awake: reason-keyed holds on both Rust (`set_hold`) and frontend
  (`keepAwake`). Only **call** is wired. Music playback is deliberately NOT a hold
  (a playing track must let the screen sleep). Maps has no navigation session yet,
  so `"nav"`/`"video"` are asserted-ready on the bus but unwired until a real
  session exists.
- Auto screen-off is **off by default** (knob 0 / absent) so existing behaviour
  and tests are unchanged; enable via Settings → Auto screen-off.

## Addendum (2026-09-05) — media/nav verification + keep-awake bus-ization

One-line summary: **no honest media/nav keep-awake source exists in the
prototype, so we did not fabricate one — instead we unified keep-awake into a
generic reason bus and re-verified.**

- **Media/nav audit outcome.** Music playback is deliberately **not** a screen
  hold (on real devices a playing track must still let the screen sleep); the
  prototype has no foreground-video player with a play state. MapsApp is a
  pan/zoom map with **no navigation session** (no turn-by-turn state to key off).
  Wiring `assertHold("media")`/`assertHold("nav")` to any of these would have been
  fabricated semantics.
- **What was done instead (bus-ization).** Added `lib/keepAwake.ts` — a
  module-singleton reason bus (`assertHold`/`releaseHold`/`heldReasons`/
  `useScreenHold`/`clearAllHolds`) that mirrors the Rust
  `amos_display::ScreenController` reason-keyed holds. The Shell idle watcher now
  reads the **aggregate** `useScreenHold()`. The previously-bespoke call hold was
  migrated onto it via `useCallKeepAwake()` (call-id aware, overlap-safe); the
  superseded `useTelephonyHold` hook was removed (its pure reducers
  `holdSet`/`isHoldState` remain and feed the bus).
- **Result.** Any future keep-awake source becomes a one-liner: a real nav/video
  session calls `assertHold("nav")` / `assertHold("video")` on start and
  `releaseHold(...)` on stop — the Shell and governor gating already consume it.
- **Remaining follow-ons (after this seam).**
  1. **Physical blanking / wake**: the host **device seam** now exists —
     `DisplayPower` + `FileDisplayPower` + managed `DisplayPowerBridge` in
     `amos-tauri::display`, unit-tested (6 display tests). The remaining piece is
     injecting a `PowerManager`-backed `DisplayPower` in the System-UI APK build
     (`goToSleep`/wake needs `DEVICE_POWER`/OEM — an on-device/OEM step).
  2. AOD (Always-On Display) — can sit on the `ScreenState::Off` branch.
  3. Assert `"nav"`/`"video"` once a genuine navigation/video session exists.
- **Tests after bus-ization:** `lib/keepAwake` DOM (aggregate + call integration +
  overlap) green; frontend full ISO still **607 pass / 0 fail**; `tsc` clean.

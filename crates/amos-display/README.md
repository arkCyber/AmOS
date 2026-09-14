# amos-display — display protection (auto screen-off / idle)

Decides when an interactive display should turn off: battery vs charging timeouts, a hold
while a call is in progress, and a hold while the user is actively touching — expressed as a
pure `ScreenState` + `IdlePolicy` controller. Part of **[Amos](../../README.md)**. Design
record: [`docs/display-idle.md`](../../docs/display-idle.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `ScreenController` folds inputs (idle time, charging, call active, explicit sleep) into one
  `ScreenChange`: `None | On | Off` — so "nothing happened" is distinguishable from "we just
  turned it off", and a caller never re-fires the same transition.
- `IdlePolicy` holds the *numbers* (battery timeout, charging timeout, hold rules) as data,
  so a policy change is a value change, not a code edit.
- **`src/host.rs` is the file contract**: the daemon's energy beat reads the screen state
  from a path (`AMOS_SCREEN_STATE_PATH`), and `parse_screen_state` /
  `read_screen_state_from` are the only parsers — a missing or malformed file is reported,
  never guessed into `on`.
- The controller is **pure** (`now`/durations in, transition out), so every rule is pinned by
  a unit test with no sleeping.

It is **not** a brightness or refresh-rate controller, and it does not lock the screen: it
says when the display goes off; the host shows sleep/lock and the daemon treats it as
`screen_on = false` for energy policy.

## Layout

| file | what |
|---|---|
| `src/spec.rs` | `ScreenState` (+ `key()`: `on`/`off`), `ScreenChange` |
| `src/idle.rs` | `IdlePolicy`, `ScreenController` |
| `src/host.rs` | `screen_state_path`, `SCREEN_STATE_ENV`, `parse_screen_state`, `read_screen_state_from` |

## Build & test

```bash
cargo test -p amos-display
cargo clippy -p amos-display --all-targets -- -D warnings
cargo fmt -p amos-display -- --check
```

## Examples

```bash
# Walk the idle rules: battery vs charging timeouts, hold-while-call, explicit sleep.
cargo run -p amos-display --example idle_timeline
```

| example | shows |
|---|---|
| `idle_timeline` | a minute of input steps through `ScreenController`: idle on battery, the longer charging timeout, a call holding the screen, an explicit sleep, and the exact `ScreenChange` each step produces |

## Honest boundaries

- **No timers live here**: the controller is called with elapsed time; waking itself is the
  host's job (`crates/amos-tauri`) or the daemon's energy beat.
- **`on` is never inferred from a missing file**: absence is an error path, because a
  fabricated "screen is on" would change power policy behind the user's back.
- **Brightness, refresh rate and lock-screen policy are out of scope** (the
  `docs/display-idle.md` non-goals).

## Related

- [`docs/display-idle.md`](../../docs/display-idle.md) — inputs, rules and the file contract.
- [`crates/amos-power`](../amos-power/README.md) — consumes `screen_on` in the energy policy.
- [`crates/amos-telephony`](../amos-telephony/README.md) — the call state the hold rule reads.

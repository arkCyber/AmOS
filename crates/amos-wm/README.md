# amos-wm — window-manager state machine (multi-window)

Transport-agnostic window manager state: windows, focus, form factor, layout snapshots and
split screen — as a **pure state machine**, so every rule (what a phone may do vs a tablet vs
a desktop) is testable with no OS window in sight. Part of **[Amos](../../README.md)**.
Design record: [`docs/multi-window.md`](../../docs/multi-window.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `WindowManager` (in `lib.rs`): exactly one immortal `Launcher` at the bottom, at most one
  focused window, a focus stack ("recents") that restores the previous window when the
  focused one hides or closes, and transitions that return `WmEvent`s for the host to apply.
- `form.rs` (`FormFactor`, `LayoutPolicy`, `resolve_hint`, `HintSource`, `ShellFit`): the
  **class** decides what a window may do (multi-window, free resize, divider gap, min pane,
  content columns, initial size) and what the shell should request — including the desktop
  "fit the usable area" rule that replaced a fixed board sized for no screen. `Robot` is the
  headless class: `has_ui()` is false and window numbers are inert there.
- `layout.rs` (`Bounds`, `split_panes`): integer geometry with the constraints a real screen
  imposes (a pane never becomes zero/negative).
- `split.rs` (`SplitScreen`): a two-pane session at a divider percent, with `resize_to`/
  `resize_by`/`swap`/`set_screen`, built only when the panes + gap actually fit.
- **Pure and synchronous**: the model produces events; `crates/amos-tauri` applies them to
  real `WebviewWindow`s and composes the `LayoutSnapshot` the UI reads.

It is **not** a compositor and does not own pixels: it decides, the host executes and reports
what the OS actually did.

## Layout

| file | what |
|---|---|
| `src/lib.rs` | `WindowManager`, `WindowId`, `WindowKind`, `WindowState`, `WmEvent`, focus/recents |
| `src/form.rs` | `FormFactor`, `LayoutPolicy` (+ `of`, `columns_for`), `resolve_hint`, `ShellFit` |
| `src/layout.rs` | `Bounds`, `split_panes` — the integer geometry |
| `src/split.rs` | `SplitScreen` — the two-pane session |

## Build & test

```bash
cargo test -p amos-wm
cargo clippy -p amos-wm --all-targets -- -D warnings
cargo fmt -p amos-wm -- --check
```

## Examples

```bash
# The model on its own: phone vs tablet vs desktop policies, a split, and its constraints.
cargo run -p amos-wm --example form_and_split
```

| example | shows |
|---|---|
| `form_and_split` | the same window set under three form factors (what each class may do, the shell fit each requests), then a split entering, swapping panes and closing one — including the refusal that a split cannot outlive its pane |

## Honest boundaries

- **No real windows**: this crate never creates one; geometry that depends on the OS
  (usable area, DPI, activation) is the host's, and the host reports what was applied.
- **Unmeasured screen ⇒ conservative answer**: a `0×0` screen gets the most conservative
  layout rather than an invented density.
- **Container surfaces are not manageable**: a composited Android surface has no
  `WebviewWindow`, so it is not offered as a split candidate — and the UI says why.
- **Model acceptance ≠ feasibility**: the model accepts two windows for a split; whether the
  host can place them is reported by the host (and logged when it cannot).

## Related

- [`docs/multi-window.md`](../../docs/multi-window.md) — the state machine, the policies and
  the UI contract.
- [`crates/amos-tauri`](../amos-tauri/README.md) — the host that applies these events.

/**
 * desktopKeys.ts — the **desktop shell's** system keys, as a table (REQ-A341).
 *
 * Same arc as `lib/systemKeys.ts` (the touch shell's admission): a key that acts on the focused
 * window used to exist only as a `switch` inside `DesktopShell.svelte` —
 *
 *     if (key === "w") { … }  if (key === "m") { … }  if (key === "h") { … }  if (key === ",") { … }
 *
 * — which meant the *only* way to learn "which system keys exist" was to read that function. Two
 * other artefacts already had to guess: the shortcuts page in Settings lists them as **literals**
 * (`"⌘W"` / `"⌘M"` / `"⌘H"` / `"⌘,"`) and any tooltip that wanted to teach them would too. That is
 * the same multi-source shape this audit has been removing from the *overlay* keys (REQ-A335: the
 * registry) and from the *touch* keys (REQ-A336/REQ-A338: one catalog generated from both) — and
 * the fix is the same: the table is the truth, the dispatch reads it, and the display can too.
 *
 * Scope, deliberately: only the four keys that act on the focused window. The Spaces keys
 * (`Ctrl+1-9`, `Ctrl+←→`, `Ctrl+↑`) stay where they are — their handling is *stateful* (each has a
 * different failure path and a different log line, and `Ctrl+↑` is registered locally by
 * `SpacesPanel`) rather than a one-line command dispatch, so a table would not simplify them. That
 * boundary is stated here so the next reader does not "finish the job" by flattening code that
 * genuinely differs.
 *
 * Matching reuses `shortcutMatches` — the registry's own rulebook — so exact-modifier matching
 * (Shift/Alt must match) and the Ctrl-as-⌘ compatibility for non-Apple keyboards behave exactly as
 * they do for every other shell key. One consequence is a deliberate tightening: `⌘⇧W` used to
 * close the focused window (the old `switch` ignored Shift); now it matches nothing, like every
 * other binding in this shell.
 */
import { formatShortcut, type ShellShortcut } from "./shellModule";

/** What a desktop system key asks the focused window to do. */
export type DesktopKeyIntent =
  | { kind: "close-window" } // ⌘W
  | { kind: "minimize-window" } // ⌘M
  | { kind: "hide-app" } // ⌘H
  | { kind: "open-settings" } // ⌘,
  | { kind: "new-window" } // ⌘N — one more window of the focused app (REQ-A473)
  | { kind: "cycle-window" }; // ⌘` — the focused app's windows, in order (REQ-A473)

/** The table. One row per key, ordered the way macOS documents them. */
export const DESKTOP_SYSTEM_KEYS: ReadonlyArray<{
  intent: DesktopKeyIntent;
  shortcut: ShellShortcut;
}> = [
  { intent: { kind: "new-window" }, shortcut: { key: "n", meta: true }, id: "newWindow" },
  { intent: { kind: "close-window" }, shortcut: { key: "w", meta: true }, id: "closeWindow" },
  { intent: { kind: "minimize-window" }, shortcut: { key: "m", meta: true }, id: "minimizeWindow" },
  { intent: { kind: "hide-app" }, shortcut: { key: "h", meta: true }, id: "hideApp" },
  { intent: { kind: "cycle-window" }, shortcut: { key: "`", meta: true }, id: "cycleWindows" },
  { intent: { kind: "open-settings" }, shortcut: { key: ",", meta: true }, id: "preferences" },
] as ReadonlyArray<{ intent: DesktopKeyIntent; shortcut: ShellShortcut; id: string }>;

/**
 * The **config id** a table row's binding lives under (`SYSTEM_DEFAULTS` in
 * `lib/keyboardConfigHook.svelte.ts`), i.e. the key the user's overrides and disables are stored
 * against.
 *
 * The table used to hold only the intent and the default key, so a *menu* could not ask "what is
 * this user's binding?" — it could only print the default (REQ-A484, F-SH-038). The ids are listed
 * here (not imported from the hook, which is a runes module) and a test
 * (`src/__tests__/desktopKeys.test.ts`) pins the two lists together, the same way the shortcut
 * page's literals were pinned to this table.
 */
export function intentIdFor(kind: DesktopKeyIntent["kind"]): string | null {
  const row = (
    DESKTOP_SYSTEM_KEYS as ReadonlyArray<{ intent: DesktopKeyIntent; shortcut: ShellShortcut; id: string }>
  ).find((r) => r.intent.kind === kind);
  return row?.id ?? null;
}

/**
 * One shortcut in **muda's** accelerator grammar, for the native menu bar (REQ-A485).
 *
 * The host's menu items are built with literals (`CmdOrCtrl+N` in `menu.rs`); when the user rebinds
 * or disables a chord, the native bar has to hear about it or it keeps advertising the key it was
 * built with — the same defect the in-window menus had, on the surface a user reads first. This is
 * the *one* translation from the shell's `ShellShortcut` shape to that grammar, so the frontend side
 * of the sync has a single implementation to test.
 *
 * Rules, each with a reason:
 *   * **`meta` ⇒ `CmdOrCtrl`**, not `Cmd`: that is the spelling the host already uses in
 *     `DEFAULT_ACCELERATORS` (matching the platform: ⌘ on macOS, Ctrl elsewhere), and the shell's own
 *     matcher treats Ctrl as ⌘ on non-Apple keyboards the same way.
 *   * **`ctrl` alone ⇒ `Ctrl`** (only when `meta` is absent): sending both would ask muda for a
 *     chord no keyboard has.
 *   * **A printable key is upper-cased** when it is a single letter — the same presentation rule the
 *     keycaps follow — and passed through otherwise (`,`, `.`, digits, punctuation).
 *   * **Named keys** (ArrowLeft, Escape …) are **not translated**: they have no native menu row in
 *     this shell (the Spaces chords are shell-owned), and inventing a spelling would put a chord on
 *     the bar that muda may parse differently. `null` is returned, and the caller simply does not
 *     send that intent.
 */
export function toAccelerator(shortcut: ShellShortcut): string | null {
  const key = shortcut.key;
  const named = /^(Arrow(Left|Right|Up|Down)|Escape|Enter|Tab|Backspace|Delete|Home|End|Page(Up|Down)|F[0-9]{1,2})$/;
  if (named.test(key)) return null;
  if (key.length !== 1) return null;
  const parts: string[] = [];
  if (shortcut.meta) parts.push("CmdOrCtrl");
  else if (shortcut.ctrl) parts.push("Ctrl");
  if (shortcut.alt) parts.push("Alt");
  if (shortcut.shift) parts.push("Shift");
  parts.push(/^[a-z]$/.test(key) ? key.toUpperCase() : key);
  return parts.join("+");
}

/**
 * The payload for the host's `menu_set_shortcuts` (REQ-A485): the **synced intents only**, in the
 * user's merge state — a shortcut string, or `null` for a disabled binding (the host then clears the
 * row's accelerator, so the bar stops advertising a key the shell does not match).
 *
 * The intent list mirrors `menu.rs`'s `ACCELERATOR_ITEMS`, and the binding is established by
 * `src/__tests__/desktopKeys.test.ts`, which **reads** `menu.rs` (REQ-A661): it holds both the intent
 * ids and each row's default chord to the Rust source, so a rename or re-chord on either side fails
 * rather than silently not syncing. (It used to point at `menu.rs::tests::the_build_time_defaults_
 * equal_the_shells_defaults` — but that test re-typed the shell's defaults as a Rust literal and
 * compared Rust to Rust, so nothing actually bound the two languages.)
 */
export function nativeAcceleratorPayload(
  bindings: ReadonlyMap<string, ShellShortcut>,
): Record<string, string | null> {
  const payload: Record<string, string | null> = {};
  for (const intent of ["newWindow", "closeWindow", "minimizeWindow", "hideApp", "preferences"]) {
    const shortcut = bindings.get(intent);
    payload[intent] = shortcut ? toAccelerator(shortcut) : null;
  }
  return payload;
}

/**
 * The keycap to show for an intent.
 *
 * This is the **display** half of the table, and the only production consumer of
 * `DESKTOP_SYSTEM_KEYS`: the menu bar renders `⌘W` next to "关闭窗口" by asking this function, so the
 * hint cannot drift from the key the shell matches. Before it existed, the menu read an i18n key that
 * no locale defined and printed the key *name* on screen.
 *
 * The **dispatch** half is deliberately not here (REQ-A348): binding a key to a command is now the
 * user-configurable layer's job (`lib/keyboardConfig` → `DesktopShell.customSystemBindings`, matched
 * with the shared `shortcutMatches`), and a second dispatch table would be exactly the "two places
 * that know the keys" defect this audit keeps removing. This module owns what the *table says*, not
 * who acts on it.
 */
export function desktopShortcutLabel(
  kind: DesktopKeyIntent["kind"],
  bindings?: ReadonlyMap<string, ShellShortcut>,
): string {
  const id = intentIdFor(kind);
  // With the merged bindings in scope, the menu shows **the key this user's shell honors**
  // (defaults + overrides + disables). A disabled binding is *absent* from the map, and then the
  // honest hint is none at all: this repository's own rule is that a menu may not advertise a
  // binding the shell does not have (REQ-A342), and printing the default here is exactly that
  // defect (measured before the fix: rebinding ⌘N left every menu still saying ⌘N).
  if (bindings) {
    const live = id ? bindings.get(id) : undefined;
    if (!live) return "";
    return labelOf(live);
  }
  const row = DESKTOP_SYSTEM_KEYS.find((r) => r.intent.kind === kind) as
    | { shortcut: ShellShortcut }
    | undefined;
  return row ? labelOf(row.shortcut) : "";
}

/**
 * One shortcut, as macOS writes it.
 *
 * Case, on purpose: the table stores letter keys lower-case because matching folds case, while
 * macOS *writes* them upper-case (`⌘W`).
 */
function labelOf(shortcut: ShellShortcut): string {
  const shown = /^[a-z]$/.test(shortcut.key) ? shortcut.key.toUpperCase() : shortcut.key;
  return formatShortcut({ ...shortcut, key: shown });
}


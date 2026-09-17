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
  | { kind: "open-settings" }; // ⌘,

/** The table. One row per key, ordered the way macOS documents them. */
export const DESKTOP_SYSTEM_KEYS: ReadonlyArray<{
  intent: DesktopKeyIntent;
  shortcut: ShellShortcut;
}> = [
  { intent: { kind: "close-window" }, shortcut: { key: "w", meta: true } },
  { intent: { kind: "minimize-window" }, shortcut: { key: "m", meta: true } },
  { intent: { kind: "hide-app" }, shortcut: { key: "h", meta: true } },
  { intent: { kind: "open-settings" }, shortcut: { key: ",", meta: true } },
];

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
export function desktopShortcutLabel(kind: DesktopKeyIntent["kind"]): string {
  const row = DESKTOP_SYSTEM_KEYS.find((r) => r.intent.kind === kind);
  if (!row) return "";
  // Case, on purpose: the table stores letter keys lower-case because matching folds case, while
  // macOS *writes* them upper-case (`⌘W`).
  const shown = /^[a-z]$/.test(row.shortcut.key) ? row.shortcut.key.toUpperCase() : row.shortcut.key;
  return formatShortcut({ ...row.shortcut, key: shown });
}


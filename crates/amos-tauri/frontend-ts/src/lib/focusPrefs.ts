/**
 * Persistent Focus "scenario" preferences for the Settings「专注模式」page.
 *
 * REQ-A206: the 勿扰 (Do-Not-Disturb) row on that page is **not** an intent bit —
 * it is the real quick-settings DND key (`amos.settings.dnd`, `lib/settings
 * dndActive`), the same single source of truth the shell, control center, arrival
 * banner and the 通知 page honour. It used to persist a decorative `dnd` field
 * here that **no silencing path ever read** — a switch that did not do what its
 * label said, next to a real one of the same name on the 通知 page.
 *
 * What remains here is the per-scenario *intent* (工作 / 睡眠): saved preferences,
 * honestly labelled as such — a scenario scheduling engine isn't wired yet, and no
 * fabricated silencing is claimed for them. The legacy persisted `dnd` field is
 * dropped on read (never converted): it never had any effect, so dropping it
 * keeps behaviour byte-identical, while auto-applying it would *newly* silence a
 * device on upgrade.
 */
export const FOCUS_KEY = "amos.focus";

export type FocusId = "work" | "sleep";
export const FOCUS_SCENARIOS: readonly FocusId[] = ["work", "sleep"];

export type FocusPrefs = Record<FocusId, boolean>;

export function defaultFocus(): FocusPrefs {
  return { work: false, sleep: false };
}

/** Corruption guard: keeps only the known scenario booleans (default off). */
export function normalizeFocus(raw: unknown): FocusPrefs {
  const out = defaultFocus();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const id of FOCUS_SCENARIOS) out[id] = o[id] === true;
  return out;
}

/** Pure: flip one scenario preference (immutable). */
export function toggleFocus(s: FocusPrefs, id: FocusId): FocusPrefs {
  return { ...s, [id]: !s[id] };
}

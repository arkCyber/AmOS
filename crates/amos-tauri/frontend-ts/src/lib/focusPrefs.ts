/**
 * Persistent Focus "scenario" preferences for the Settings「专注模式」page.
 *
 * The actual silencing is driven by the shell's Do-Not-Disturb quick bit (control
 * center). Here we let the user express per-scenario *intent* (Do Not Disturb /
 * Work / Sleep) as persisted preferences — honest, since they're saved — with a
 * note that a scenario scheduling engine isn't wired yet. No fabricated behaviour.
 */
export const FOCUS_KEY = "amos.focus";

export type FocusId = "dnd" | "work" | "sleep";
export const FOCUS_SCENARIOS: readonly FocusId[] = ["dnd", "work", "sleep"];

export type FocusPrefs = Record<FocusId, boolean>;

export function defaultFocus(): FocusPrefs {
  return { dnd: false, work: false, sleep: false };
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

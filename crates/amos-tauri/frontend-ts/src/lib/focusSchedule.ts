/**
 * focusSchedule.ts — automatic Do-Not-Disturb windows (REQ-A684).
 *
 * `lib/focusPrefs.ts` deliberately stopped short of "a scenario scheduling engine":
 * 工作 / 睡眠 were saved *intent* and nothing silenced on a schedule. This module is
 * that engine's **decision half** — pure, clock-in / decision-out.
 *
 * Scope, stated honestly: a window only ever flips the **one real DND bit**
 * (`amos.settings.dnd`, `lib/settings::dndActive`) — the same single source of truth
 * the shell, control centre, arrival banner and 通知 page already honour. It never
 * invents a second silencing path, and it never claims a per-app mute it cannot do.
 *
 * There is exactly **one window per scenario** (the UI edits 工作 / 睡眠 in place) —
 * a list with ids would be generality nothing uses.
 *
 * The subtle half is **ownership**. A schedule that blindly wrote `dnd = desired`
 * would clobber a DND the user set by hand, and would also leave a scheduled DND
 * stuck on after its window. So the engine tracks whether *it* turned the bit on:
 *  - inside a window → DND on, the schedule owns it;
 *  - outside a window → release a DND the schedule turned on; **never** touch one
 *    the user set themselves.
 * The owner flag is persisted (`amos.focus.auto`) so a reload mid-window does not
 * forget who is responsible and strand DND on forever.
 */
import { FOCUS_SCENARIOS, type FocusId } from "./focusPrefs";

/** Durable shape: the schedule (one window per scenario). */
export const FOCUS_SCHEDULE_KEY = "amos.focus.schedule";
/** Durable shape: whether the schedule currently owns the DND bit. */
export const FOCUS_AUTO_KEY = "amos.focus.auto";

export const MINUTES_PER_DAY = 1440;
const DAYS_PER_WEEK = 7;

/** One scenario's window. */
export interface FocusWindow {
  /** Days the window **starts** on — 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Start minute-of-day, 0..1439. */
  start: number;
  /** End minute-of-day, 0..1439. `end <= start` means the window spans midnight. */
  end: number;
  enabled: boolean;
}

export type FocusSchedule = Record<FocusId, FocusWindow>;

/** Sensible starting shapes; every scenario is **off** until the user turns it on. */
export function defaultSchedule(): FocusSchedule {
  return {
    work: { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 18 * 60, enabled: false },
    sleep: { days: [0, 1, 2, 3, 4, 5, 6], start: 23 * 60, end: 7 * 60, enabled: false },
  };
}

function isIntIn(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

/** Corruption guard: keeps a usable window per scenario, defaulting the rest. */
export function normalizeSchedule(raw: unknown): FocusSchedule {
  const out = defaultSchedule();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const id of FOCUS_SCENARIOS) {
    const w = o[id];
    if (!w || typeof w !== "object" || Array.isArray(w)) continue;
    const r = w as Record<string, unknown>;
    if (!isIntIn(r.start, 0, MINUTES_PER_DAY - 1)) continue;
    if (!isIntIn(r.end, 0, MINUTES_PER_DAY - 1)) continue;
    if (!Array.isArray(r.days)) continue;
    const days = [
      ...new Set(r.days.filter((d): d is number => isIntIn(d, 0, DAYS_PER_WEEK - 1))),
    ].sort((a, b) => a - b);
    out[id] = { days, start: r.start, end: r.end, enabled: r.enabled === true };
  }
  return out;
}

function prevDay(day: number): number {
  return (day + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK;
}

/**
 * Whether `w` is running at (day, minute). `start === end` is a **zero-length**
 * window and is never active — an empty window silences nothing, so it must not be
 * read as "all day". A window with no days is likewise never active.
 */
export function windowContains(w: FocusWindow, day: number, minute: number): boolean {
  if (!w.enabled) return false;
  if (w.start === w.end) return false;
  if (w.start < w.end) return w.days.includes(day) && minute >= w.start && minute < w.end;
  // Spans midnight: the same-day tail, or the after-midnight head of yesterday's.
  return (
    (w.days.includes(day) && minute >= w.start) || (w.days.includes(prevDay(day)) && minute < w.end)
  );
}

/** Minutes since a running window began — used only to rank overlapping windows. */
function elapsedIn(w: FocusWindow, minute: number): number {
  if (w.start < w.end) return minute - w.start;
  return minute >= w.start ? minute - w.start : minute + (MINUTES_PER_DAY - w.start);
}

/**
 * The scenario running at (day, minute), or `null`. If both overlap, the one that
 * started most recently wins; a tie breaks by declaration order so the answer is
 * deterministic (a UI that showed a different "active" scenario each tick is a bug).
 */
export function activeScenario(
  schedule: FocusSchedule,
  day: number,
  minute: number,
): FocusId | null {
  let best: FocusId | null = null;
  let bestElapsed = Infinity;
  for (const id of FOCUS_SCENARIOS) {
    const w = schedule[id];
    if (!windowContains(w, day, minute)) continue;
    const elapsed = elapsedIn(w, minute);
    // Most recently started = smallest elapsed. Ties keep declaration order.
    if (elapsed < bestElapsed) {
      best = id;
      bestElapsed = elapsed;
    }
  }
  return best;
}

/** Whether the schedule owns the DND bit it turned on. */
export interface FocusAuto {
  auto: boolean;
}

export function normalizeFocusAuto(raw: unknown): FocusAuto {
  const o =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  return { auto: o?.auto === true };
}

/** The DND transition the watcher should write. */
export interface DndStep {
  dnd: boolean;
  auto: FocusAuto;
}

/**
 * The ownership state machine (see the module header). `desired` is whether a window
 * is active now; `currentDnd` is the real bit; `auto` is who turned it on.
 *
 * During a window the schedule is authoritative (DND is forced on and claimed). After
 * it, only a DND the schedule turned on is released — a manual DND is left alone.
 * The honest boundary this implies: a manual DND that happens to sit inside a window
 * is claimed, and released when the window ends.
 */
export function advanceDnd(desired: boolean, currentDnd: boolean, auto: FocusAuto): DndStep {
  if (desired) return { dnd: true, auto: { auto: true } };
  if (auto.auto) return { dnd: false, auto: { auto: false } };
  return { dnd: currentDnd, auto: { auto: false } };
}

/** Local minute-of-day of `d` (0..1439). Pure — the caller owns the clock. */
export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** Local day-of-week of `d`, 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(d: Date): number {
  return d.getDay();
}

/** `minutes` → "HH:MM" (24h), clamped into a day. */
export function formatMinutes(minutes: number): string {
  const m = Math.min(MINUTES_PER_DAY - 1, Math.max(0, Math.trunc(minutes)));
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** "HH:MM" → minute-of-day, or `null` when the text is not a time. */
export function parseMinutes(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

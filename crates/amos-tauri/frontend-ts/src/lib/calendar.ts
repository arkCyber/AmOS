/* Calendar domain kernel (iOS-style 日历) — pure + headless-friendly.
 *
 * Everything here is a pure function over plain arrays/values so it can be
 * unit-tested without a DOM and reused by any host. The UI persists through the
 * shared `amos.*` store under `amos.calendar` (events) / `amos.calendars`
 * (coloured calendar groups), exactly like the other AmOS domain kernels.
 *
 * Recurrence is deliberately a *bounded* subset of iCalendar RRULE (see
 * docs/calendar.md): none / daily / weekly / monthly / yearly, interval 1, no
 * COUNT/UNTIL/EXDATE. Expansion is guarded (MAX_OCCURRENCES_PER_EVENT) so a
 * pathological or corrupt row can never make a range query loop forever —
 * defensive by construction, not certified.
 */

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;
export const DEFAULT_CALENDAR_ID = "personal";
export const CALENDAR_KEY = "amos.calendar";
export const CALENDARS_KEY = "amos.calendars";
/** Upper bound on persisted events (newest kept), matching the other kernels. */
export const EVENT_CAP = 1000;
/** Upper bound on occurrences expanded from ONE event inside one range query. */
export const MAX_OCCURRENCES_PER_EVENT = 2000;
/** Bounded, iOS-like palette for colour-coded calendars. */
export const CALENDAR_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "indigo",
  "purple",
  "pink",
  "gray",
] as const;
export type CalendarColor = (typeof CALENDAR_COLORS)[number];

export type Repeat = "none" | "daily" | "weekly" | "monthly" | "yearly";
export const REPEATS: readonly Repeat[] = ["none", "daily", "weekly", "monthly", "yearly"];

/** Alert offsets the editor offers (minutes before start; null = no alert). */
export const ALERT_OPTIONS: readonly (number | null)[] = [null, 0, 5, 15, 30, 60, 120, 1440];
/** iOS default: alert at the time of the event. */
export const DEFAULT_ALERT_MINUTES: number | null = 0;
/** Longest alert offset we accept (1 day) — bounds the OS-alert scan window. */
export const MAX_ALERT_MINUTES = 1440;

export interface CalendarGroup {
  id: string;
  /** Built-in default calendar has a localized name; user ones are plain text. */
  custom: boolean;
  name: string;
  color: CalendarColor;
  /** false = hidden (the unchecked calendar in iOS); shown when true. */
  enabled: boolean;
  createdAt: number;
}

export interface CalendarEvent {
  id: string;
  /** Owning calendar group id (DEFAULT_CALENDAR_ID = the built-in calendar). */
  calendarId: string;
  title: string;
  location?: string;
  notes?: string;
  /** Inclusive start instant (epoch ms, local semantics). */
  startAt: number;
  /** Exclusive end instant (epoch ms). Always > startAt after normalization. */
  endAt: number;
  /** Whole-day event: startAt is local midnight, endAt = startAt + DAY_MS. */
  allDay: boolean;
  repeat: Repeat;
  /** Minutes before start to alert; null = no alert. */
  alertMinutes: number | null;
  createdAt: number;
}

/** One concrete happening of an event inside a queried range. */
export interface Occurrence {
  event: CalendarEvent;
  startAt: number;
  endAt: number;
}


/* ---------------------------------------------------------------- date math
 * All calendar math is LOCAL-time and Date-based (not raw ms arithmetic) so a
 * "09:00 daily" event stays at 09:00 across DST transitions. */

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** Add `n` whole local days (keeps the wall-clock time across DST). */
export function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

export function startOfMonth(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

/** Add `n` months, clamping the day to the target month's length (Jan 31 → Feb 28). */
export function addMonths(ms: number, n: number): number {
  const d = new Date(ms);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  return d.getTime();
}

/** True when `ms` is exactly a local midnight (minute-precision inputs). */
function isMidnight(ms: number): boolean {
  const d = new Date(ms);
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

/** Whole local days from `fromMs` to `toMs` (negative when `toMs` is earlier).
 *  Date-based, so a DST day (23h/25h) still counts as one day. */
export function countDays(fromMs: number, toMs: number): number {
  return Math.round((startOfDay(toMs) - startOfDay(fromMs)) / DAY_MS);
}

/**
 * Move `base` by the same local wall-clock offset that takes `from` → `to`.
 *
 * Used when editing ONE occurrence of a repeating event: the editor shows the
 * occurrence the user tapped, but the stored series is re-anchored by the same
 * offset, so "move this occurrence" means "move the series". The day part is
 * applied with `addDays` (whole local days, DST-safe) and only the time-of-day
 * part in minutes — never raw ms — so an edit across a DST boundary shifts by the
 * intended wall-clock amount, not 23/25h. `from === to` is an exact no-op, so
 * editing an unrelated field (title, notes…) never drifts the series.
 */
export function shiftByWallClock(base: number, from: number, to: number): number {
  if (from === to) return base;
  const dayDelta = countDays(from, to);
  const f = new Date(from);
  const t = new Date(to);
  const minuteDelta = t.getHours() * 60 + t.getMinutes() - (f.getHours() * 60 + f.getMinutes());
  const d = new Date(addDays(base, dayDelta));
  d.setMinutes(d.getMinutes() + minuteDelta);
  d.setSeconds(0, 0);
  return d.getTime();
}

/**
 * Exclusive end of an all-day event (local midnight after its last day).
 *
 * A `endRaw` that is already midnight-aligned is taken at face value — that is
 * the persisted convention and keeps normalization **idempotent** — otherwise it
 * is snapped up to the next midnight (an inclusive "ends on" day). Anything not
 * after `startAt` collapses to a single day. Day arithmetic is date-based so a
 * span never drifts across a DST transition.
 */
export function allDayEnd(startAt: number, endRaw: number): number {
  if (!(endRaw > startAt)) return addDays(startAt, 1);
  return isMidnight(endRaw) ? endRaw : addDays(startOfDay(endRaw), 1);
}

/**
 * The 6×7 grid of local-midnight day stamps shown for `anchorMs`'s month.
 * `weekStartsOn` follows `Date#getDay()` (0 = Sunday, iOS default; 1 = Monday).
 */
export function monthGrid(anchorMs: number, weekStartsOn = 0): number[] {
  const first = startOfMonth(anchorMs);
  const lead = (new Date(first).getDay() - weekStartsOn + 7) % 7;
  const start = addDays(first, -lead);
  const out: number[] = [];
  for (let i = 0; i < 42; i += 1) out.push(addDays(start, i));
  return out;
}

/** Weekday indices in display order for a week starting on `weekStartsOn`. */
export function weekdayOrder(weekStartsOn = 0): number[] {
  return Array.from({ length: 7 }, (_, i) => (weekStartsOn + i) % 7);
}

/**
 * Local midnight of the first day of the week containing `ms`.
 *
 * `weekStartsOn` follows `Date#getDay()` (0 = Sunday, iOS default; 1 = Monday)
 * and is the SAME region rule the month grid uses, so the week view and the
 * month grid can never disagree about where a week begins. Built on `addDays`
 * (date arithmetic, not raw ms) so it stays correct across DST transitions.
 */
export function startOfWeek(ms: number, weekStartsOn = 0): number {
  const day = startOfDay(ms);
  const back = (new Date(day).getDay() - weekStartsOn + 7) % 7;
  return addDays(day, -back);
}

/**
 * The seven local-midnight days of the week containing `anchorMs`, in display
 * order (index 0 = the region's first weekday). Always exactly 7 entries, so the
 * week view renders a fixed grid with no "row popping"; each step is one
 * `addDays`, so a 23h/25h DST day still counts as exactly one day.
 */
export function weekDays(anchorMs: number, weekStartsOn = 0): number[] {
  const start = startOfWeek(anchorMs, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/* ------------------------------------------------------------- corruption
 * Tolerate malformed/bogus persisted data: keep usable rows, drop the rest. */

function trimTo(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}
function toColor(v: unknown): CalendarColor {
  return (CALENDAR_COLORS as readonly string[]).includes(v as string)
    ? (v as CalendarColor)
    : "blue";
}
function toRepeat(v: unknown): Repeat {
  return (REPEATS as readonly string[]).includes(v as string) ? (v as Repeat) : "none";
}
function toAlertMinutes(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0 || v > MAX_ALERT_MINUTES) return null;
  return Math.round(v);
}
function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function normalizeCalendars(v: unknown): CalendarGroup[] {
  if (!Array.isArray(v)) return [];
  const out: CalendarGroup[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id ? o.id : "";
    if (!id || seen.has(id)) continue;
    const custom = o.custom === true;
    const name = typeof o.name === "string" ? o.name.trim().slice(0, 60) : "";
    // The built-in calendar may be unnamed (the UI localizes it); custom ones
    // need a real name or they are unresolvable rows we refuse to keep.
    if (custom && !name) continue;
    seen.add(id);
    out.push({
      id,
      custom,
      name,
      color: toColor(o.color),
      enabled: o.enabled !== false,
      createdAt: finiteOr(o.createdAt, 0),
    });
  }
  return out;
}

export function normalizeEvents(v: unknown): CalendarEvent[] {
  if (!Array.isArray(v)) return [];
  const out: CalendarEvent[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const title = trimTo(o.title, 200);
    if (!title) continue;
    const createdAt = finiteOr(o.createdAt, 0);
    const baseId = typeof o.id === "string" && o.id ? o.id : `${createdAt.toString(36)}-${out.length}`;
    let id = baseId;
    let k = 1;
    while (seen.has(id)) id = `${baseId}-${k++}`;
    seen.add(id);

    const allDay = o.allDay === true;
    const startRaw = finiteOr(o.startAt, createdAt);
    const startAt = allDay ? startOfDay(startRaw) : startRaw;
    const endRaw = finiteOr(o.endAt, startAt + MINUTE_MS);
    // An event must occupy a non-empty interval; an all-day one owns ≥ 1 whole
    // local day (and may own several — a multi-day holiday stays multi-day).
    const endAt = allDay
      ? allDayEnd(startAt, endRaw)
      : Math.max(endRaw, startAt + MINUTE_MS);

    const e: CalendarEvent = {
      id,
      calendarId:
        typeof o.calendarId === "string" && o.calendarId ? o.calendarId : DEFAULT_CALENDAR_ID,
      title,
      startAt,
      endAt,
      allDay,
      repeat: toRepeat(o.repeat),
      alertMinutes: toAlertMinutes(o.alertMinutes),
      createdAt,
    };
    const location = trimTo(o.location, 200);
    if (location) e.location = location;
    const notes = trimTo(o.notes, 2000);
    if (notes) e.notes = notes;
    out.push(e);
  }
  return out.length > EVENT_CAP ? out.slice(out.length - EVENT_CAP) : out;
}

/* ------------------------------------------------------------- recurrence
 * Bounded expansion of an event into concrete occurrences inside a range. */

function durationOf(e: CalendarEvent): number {
  return Math.max(0, e.endAt - e.startAt);
}

/** The `k`-th repeat offset of `base` (k = 0 is the event's own start). */
export function shiftOccurrence(base: number, repeat: Repeat, k: number): number {
  switch (repeat) {
    case "daily":
      return addDays(base, k);
    case "weekly":
      return addDays(base, 7 * k);
    case "monthly":
      return addMonths(base, k);
    case "yearly":
      return addMonths(base, 12 * k);
    default:
      return base;
  }
}

/**
 * Upper bound on the gap between two consecutive occurrences of a repeat.
 *
 * Used **only** to fast-forward to the query window. It must be ≥ the real gap:
 * the estimate `floor((threshold - startAt) / step)` may then never land *after*
 * the first occurrence that can overlap the window, so no occurrence is skipped.
 * (A too-small step overshoots and silently drops occurrences of an event longer
 * than one period — see the `long` recurrence test.) `addDays`/`addMonths` are
 * wall-clock ops, so a DST transition can add an hour; the +1 h covers it.
 */
const MAX_STEP_MS: Record<Repeat, number> = {
  none: 0,
  daily: DAY_MS + 3_600_000, // 25 h (DST fall-back)
  weekly: 7 * DAY_MS + 3_600_000,
  monthly: 31 * DAY_MS + 3_600_000, // 31 days (longest month) + DST
  yearly: 366 * DAY_MS + 3_600_000, // 366 days (leap) + DST
};

/** Half-open range overlap: [startAt, endAt) vs [from, to). */
export function overlapsRange(startAt: number, endAt: number, from: number, to: number): boolean {
  return startAt < to && endAt > from;
}

/** All occurrences of ONE event overlapping [from, to), bounded + deterministic. */
export function expandOccurrences(e: CalendarEvent, from: number, to: number): Occurrence[] {
  if (!(to > from)) return [];
  if (e.repeat === "none") {
    return overlapsRange(e.startAt, e.endAt, from, to)
      ? [{ event: e, startAt: e.startAt, endAt: e.endAt }]
      : [];
  }
  const dur = durationOf(e);
  const step = MAX_STEP_MS[e.repeat];
  let k = 0;
  // An occurrence overlaps [from, to) iff `startAt > from - dur`, so fast-forward
  // to the neighbourhood of that threshold instead of iterating every occurrence
  // since the event was created. `MAX_STEP_MS` bounds the real gap from above, so
  // the estimate is at most one period *before* the first overlapping occurrence —
  // it can never skip one (a longer event needs the earlier occurrences too).
  const threshold = from - dur;
  if (step > 0 && e.startAt <= threshold) {
    const est = Math.floor((threshold - e.startAt) / step);
    if (est > 0) k = est;
  }
  const out: Occurrence[] = [];
  for (let guard = 0; guard < MAX_OCCURRENCES_PER_EVENT; guard += 1, k += 1) {
    const startAt = shiftOccurrence(e.startAt, e.repeat, k);
    if (startAt >= to) break; // monotonic: no later occurrence can fit
    const endAt = startAt + dur;
    if (endAt > from) out.push({ event: e, startAt, endAt });
  }
  return out;
}

/** iOS-like ordering: all-day events first, then by start time, then title. */
export function sortOccurrences(list: readonly Occurrence[]): Occurrence[] {
  return [...list].sort((a, b) => {
    if (a.event.allDay !== b.event.allDay) return a.event.allDay ? -1 : 1;
    if (a.startAt !== b.startAt) return a.startAt - b.startAt;
    return a.event.title.localeCompare(b.event.title);
  });
}

/** Every occurrence of `events` overlapping [from, to), time-ordered. */
export function occurrencesInRange(
  events: readonly CalendarEvent[],
  from: number,
  to: number,
): Occurrence[] {
  const out: Occurrence[] = [];
  for (const e of events) out.push(...expandOccurrences(e, from, to));
  return sortOccurrences(out);
}

/** Occurrences on one local calendar day (date-based window, DST-safe). */
export function occurrencesOnDay(events: readonly CalendarEvent[], dayMs: number): Occurrence[] {
  const from = startOfDay(dayMs);
  return occurrencesInRange(events, from, addDays(from, 1));
}

/** Bucket occurrences by their local start day (key = local midnight stamp). */
export function groupByDay(list: readonly Occurrence[]): Map<number, Occurrence[]> {
  const map = new Map<number, Occurrence[]>();
  for (const occ of list) {
    const key = startOfDay(occ.startAt);
    const bucket = map.get(key);
    if (bucket) bucket.push(occ);
    else map.set(key, [occ]);
  }
  return map;
}

/**
 * Bucket occurrences by **every local day they overlap** (multi-day events mark
 * each day they cover — the data behind the month grid's dots). Bounded: a walk
 * never leaves `[from, to)`, so a pathological span cannot loop.
 */
export function occurrencesByDay(
  list: readonly Occurrence[],
  from: number,
  to: number,
): Map<number, Occurrence[]> {
  const map = new Map<number, Occurrence[]>();
  if (!(to > from)) return map;
  const lastKey = startOfDay(to - 1);
  for (const occ of list) {
    let day = startOfDay(Math.max(occ.startAt, from));
    const lastCovered = startOfDay(Math.max(occ.endAt - 1, day));
    // Bounded: the walk starts inside the window and stops at `lastKey`.
    while (day <= lastCovered && day <= lastKey) {
      const bucket = map.get(day);
      if (bucket) bucket.push(occ);
      else map.set(day, [occ]);
      const next = addDays(day, 1);
      if (next <= day) break; // defensive: never loop on a broken clock
      day = next;
    }
  }
  return map;
}

/** True when this occurrence began on an earlier local day (multi-day event). */
export function isContinuation(occ: Occurrence, dayMs: number): boolean {
  return startOfDay(occ.startAt) < startOfDay(dayMs);
}

/** True when the occurrence's own span covers more than one local day. */
export function spansDays(occ: Occurrence): boolean {
  return startOfDay(occ.endAt - 1) > startOfDay(occ.startAt);
}

/* --------------------------------------------------------------- selectors */

/** Events whose calendar group is not hidden (orphan ids count as visible). */
export function visibleEvents(
  events: readonly CalendarEvent[],
  groups: readonly CalendarGroup[],
): CalendarEvent[] {
  const hidden = new Set(groups.filter((g) => !g.enabled).map((g) => g.id));
  if (hidden.size === 0) return [...events];
  return events.filter((e) => !hidden.has(e.calendarId));
}

/** Case-insensitive substring search over title + location + notes. */
export function searchEvents(list: readonly CalendarEvent[], query: string): CalendarEvent[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter(
    (e) =>
      e.title.toLowerCase().includes(q) ||
      (e.location ?? "").toLowerCase().includes(q) ||
      (e.notes ?? "").toLowerCase().includes(q),
  );
}

export function calendarById(
  groups: readonly CalendarGroup[],
  id: string,
): CalendarGroup | undefined {
  return groups.find((g) => g.id === id);
}


/* -------------------------------------------------------------------- CRUD */

export type EventDraft = Omit<CalendarEvent, "id" | "createdAt">;

/** Process-local monotonic counter keeps ids unique within a millisecond. */
let seq = 0;
export function makeId(now: number): string {
  seq += 1;
  return `${now.toString(36)}-${seq}`;
}

/** Clean one editor payload into the authoritative persisted shape. */
export function sanitizeDraft(draft: EventDraft): EventDraft | null {
  const title = (draft.title ?? "").trim();
  if (!title) return null;
  const allDay = draft.allDay === true;
  const startRaw = finiteOr(draft.startAt, 0);
  const startAt = allDay ? startOfDay(startRaw) : startRaw;
  const endAt = allDay
    ? allDayEnd(startAt, finiteOr(draft.endAt, 0))
    : Math.max(finiteOr(draft.endAt, startAt + MINUTE_MS), startAt + MINUTE_MS);
  const out: EventDraft = {
    calendarId: draft.calendarId || DEFAULT_CALENDAR_ID,
    title: title.slice(0, 200),
    startAt,
    endAt,
    allDay,
    repeat: toRepeat(draft.repeat),
    alertMinutes: toAlertMinutes(draft.alertMinutes),
  };
  const location = trimTo(draft.location, 200);
  if (location) out.location = location;
  const notes = trimTo(draft.notes, 2000);
  if (notes) out.notes = notes;
  return out;
}

/** Append a new event; refuses a blank title (returns a copy of the input). */
export function addEvent(
  list: readonly CalendarEvent[],
  draft: EventDraft,
  now: number,
): CalendarEvent[] {
  const clean = sanitizeDraft(draft);
  if (!clean) return [...list];
  const next = [...list, { ...clean, id: makeId(now), createdAt: now }];
  return next.length > EVENT_CAP ? next.slice(next.length - EVENT_CAP) : next;
}

/** Patch an event (re-sanitized); a missing id or blank title is a no-op. */
export function updateEvent(
  list: readonly CalendarEvent[],
  id: string,
  patch: Partial<EventDraft>,
): CalendarEvent[] {
  const curr = list.find((e) => e.id === id);
  if (!curr) return [...list];
  const merged = { ...curr, ...patch, title: patch.title ?? curr.title };
  const clean = sanitizeDraft(merged);
  if (!clean) return [...list];
  return list.map((e) => (e.id === id ? { ...clean, id, createdAt: curr.createdAt } : e));
}

export function removeEvent(list: readonly CalendarEvent[], id: string): CalendarEvent[] {
  return list.filter((e) => e.id !== id);
}

export function addCalendar(
  groups: readonly CalendarGroup[],
  draft: { name: string; color: CalendarColor },
  now: number,
): CalendarGroup[] {
  const name = draft.name.trim().slice(0, 60);
  if (!name) return [...groups];
  return [
    ...groups,
    { id: makeId(now), custom: true, name, color: draft.color, enabled: true, createdAt: now },
  ];
}

/** Remove a user calendar; the built-in default can never be removed. */
export function removeCalendar(groups: readonly CalendarGroup[], id: string): CalendarGroup[] {
  if (id === DEFAULT_CALENDAR_ID) return [...groups];
  return groups.filter((g) => g.id !== id);
}

/** Toggle one calendar's visibility (immutable). */
export function toggleCalendar(groups: readonly CalendarGroup[], id: string): CalendarGroup[] {
  return groups.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g));
}

/** Events whose calendar no longer exists fall back to the built-in default. */
export function reassignOrphans(
  events: readonly CalendarEvent[],
  groups: readonly CalendarGroup[],
): CalendarEvent[] {
  const known = new Set(groups.map((g) => g.id));
  if (events.every((e) => known.has(e.calendarId))) return [...events];
  return events.map((e) =>
    known.has(e.calendarId) ? e : { ...e, calendarId: DEFAULT_CALENDAR_ID },
  );
}


/* ------------------------------------------------------- formatting helpers
 * Locale-neutral on purpose: the component supplies the localized words and
 * formats month/weekday titles with `Intl`, so these stay deterministic to test. */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `YYYY-MM-DD` in local time — the value an `<input type="date">` needs. */
export function toDateInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `HH:MM` in local time — the value an `<input type="time">` needs. */
export function toTimeInput(ms: number): string {
  return fmtTime(ms);
}

/** Parse `YYYY-MM-DD` + `HH:MM` (both local) into epoch ms; null if unusable. */
export function fromDateAndTime(dateStr: string, timeStr: string): number | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!dm) return null;
  const y = Number(dm[1]);
  const mo = Number(dm[2]);
  const d = Number(dm[3]);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  const hh = tm ? Number(tm[1]) : 0;
  const mm = tm ? Number(tm[2]) : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  const out = new Date(y, mo - 1, d, hh, mm, 0, 0);
  if (out.getMonth() !== mo - 1 || out.getDate() !== d) return null; // e.g. Feb 31
  return out.getTime();
}

/** Local wall-clock time on the given day (DST-correct: sets hours, not ms). */
export function atLocalTime(dayMs: number, hour: number, minute = 0): number {
  const d = new Date(startOfDay(dayMs));
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/** Convenience for the editor: a sensible default draft on a given day. */
export function newEventDraft(dayMs: number, calendarId = DEFAULT_CALENDAR_ID): EventDraft {
  return {
    calendarId,
    title: "",
    startAt: atLocalTime(dayMs, 9), // 09:00, iOS-ish
    endAt: atLocalTime(dayMs, 10),
    allDay: false,
    repeat: "none",
    alertMinutes: DEFAULT_ALERT_MINUTES,
  };
}

/* ------------------------------------------------------------------- seeds */

export function seedCalendars(now: number): CalendarGroup[] {
  return [
    { id: DEFAULT_CALENDAR_ID, custom: false, name: "", color: "blue", enabled: true, createdAt: now },
    { id: "work", custom: true, name: "工作", color: "indigo", enabled: true, createdAt: now + 1 },
    { id: "life", custom: true, name: "生活", color: "green", enabled: true, createdAt: now + 2 },
  ];
}

export function seedEvents(now: number): CalendarEvent[] {
  const day = startOfDay(now);
  const d3 = addDays(day, 3);
  const d7 = addDays(day, 7);
  const base: Array<Omit<CalendarEvent, "id">> = [
    {
      calendarId: "work", title: "团队同步", startAt: atLocalTime(day, 9),
      endAt: atLocalTime(day, 10), allDay: false, repeat: "daily",
      alertMinutes: 15, createdAt: now, location: "会议室 A",
    },
    {
      calendarId: "work", title: "设计评审", startAt: atLocalTime(day, 14),
      endAt: atLocalTime(day, 15), allDay: false, repeat: "none",
      alertMinutes: 30, createdAt: now + 1,
    },
    {
      calendarId: "life", title: "健身", startAt: atLocalTime(day, 19),
      endAt: atLocalTime(day, 20), allDay: false, repeat: "weekly",
      alertMinutes: null, createdAt: now + 2,
    },
    {
      calendarId: DEFAULT_CALENDAR_ID, title: "奶奶生日", startAt: d3,
      endAt: addDays(d3, 1), allDay: true, repeat: "yearly",
      alertMinutes: 1440, createdAt: now + 3,
    },
    {
      calendarId: "work", title: "季度规划", startAt: atLocalTime(d7, 10),
      endAt: atLocalTime(d7, 12), allDay: false, repeat: "none",
      alertMinutes: 60, notes: "准备两个方案", createdAt: now + 4,
    },
    {
      // A multi-day all-day span (iOS: a vacation/holiday covering whole days).
      calendarId: "life", title: "年假", startAt: addDays(day, 10),
      endAt: addDays(day, 13), allDay: true, repeat: "none",
      alertMinutes: null, createdAt: now + 5,
    },
  ];
  return base.map((e) => ({ ...e, id: makeId(now) }));
}


/** Pure helpers for UI time/status so they can be unit-tested. */
export function fmtClock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Format a `Date` instant's local wall-clock time (HH:MM) in an IANA zone. */
// Constructing an Intl.DateTimeFormat is comparatively expensive and the Clock
// world list reformats every second, so cache one formatter per zone (they are
// locale/options-fixed → safe to reuse for the process lifetime).
const zoneFmtCache = new Map<string, Intl.DateTimeFormat>();
function fmtForZone(timeZone: string): Intl.DateTimeFormat | null {
  let f = zoneFmtCache.get(timeZone);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    });
  } catch {
    return null; // unknown/invalid IANA zone
  }
  zoneFmtCache.set(timeZone, f);
  return f;
}

export function zoneClock(d: Date, timeZone: string): string {
  const f = fmtForZone(timeZone);
  if (!f) {
    // Fall back to the caller's local time rather than throwing in the UI.
    return fmtClock(d);
  }
  return f.format(d);
}

/* ---- World-clock "how far / which day" info (pure, host-agnostic) ----
 * iOS shows under each world city a small relative line (e.g. "快 16 小时" and
 * "今天/明天"). These helpers compute, for a fixed instant, the wall-clock
 * offset and calendar-day difference BETWEEN two explicit IANA zones — never the
 * caller's own timezone — so they are deterministic to unit-test.
 * ---------------------------------------------------------------------- */

/** Full-detail formatter cache: `timeZone` → parts formatter. */
const zonePartsCache = new Map<string, Intl.DateTimeFormat>();
function partsForZone(timeZone: string): Intl.DateTimeFormat | null {
  let f = zonePartsCache.get(timeZone);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return null; // unknown/invalid IANA zone
  }
  zonePartsCache.set(timeZone, f);
  return f;
}

/** Read a Date's wall-clock fields as seen in `timeZone`, else null. */
function zoneParts(
  d: Date,
  timeZone: string,
): { y: number; mo: number; day: number; h: number; min: number; s: number } | null {
  const f = partsForZone(timeZone);
  if (!f) return null;
  const parts = f.formatToParts(d);
  const get = (t: string) => {
    const p = parts.find((x) => x.type === t);
    return p ? Number(p.value) : NaN;
  };
  const y = get("year");
  const mo = get("month");
  const day = get("day");
  let h = get("hour");
  const min = get("minute");
  const s = get("second");
  if (![y, mo, day, min].every(Number.isFinite)) return null;
  if (!Number.isFinite(h)) return null;
  // Some engines render midnight as "24" — roll it to the next day 00:00.
  const extraDay = h === 24 ? 1 : 0;
  if (extraDay) h = 0;
  return { y, mo, day: day + extraDay, h, min, s: Number.isFinite(s) ? s : 0 };
}

/** Whole calendar-day number (from epoch) as seen in `timeZone`. */
function zoneDayNumber(d: Date, timeZone: string): number | null {
  const p = zoneParts(d, timeZone);
  if (!p) return null;
  return Math.floor(Date.UTC(p.y, p.mo - 1, p.day) / 86_400_000);
}

/** UTC offset (minutes) of `timeZone` at instant `d`; null if the zone is invalid. */
export function zoneUtcOffsetMinutes(d: Date, timeZone: string): number | null {
  const p = zoneParts(d, timeZone);
  if (!p) return null;
  const wall = Date.UTC(p.y, p.mo - 1, p.day, p.h, p.min, p.s);
  return Math.round((wall - d.getTime()) / 60_000);
}

/**
 * Relative difference of a city zone from a base zone at a fixed instant.
 * `aheadMinutes` = minutes the city is AHEAD of the base (positive → later wall
 * clock); `dayDelta` = how many calendar days the city's date is ahead of the
 * base's (0 = same day, +1 = already tomorrow there, -1 = still yesterday).
 * Returns null if either zone is unusable.
 */
export interface ZoneDiff {
  aheadMinutes: number;
  dayDelta: number;
}
export function zoneDiff(baseTz: string, tz: string, d: Date): ZoneDiff | null {
  const base = zoneUtcOffsetMinutes(d, baseTz);
  const city = zoneUtcOffsetMinutes(d, tz);
  const baseDay = zoneDayNumber(d, baseTz);
  const cityDay = zoneDayNumber(d, tz);
  if (base == null || city == null || baseDay == null || cityDay == null) return null;
  return { aheadMinutes: city - base, dayDelta: cityDay - baseDay };
}

/**
 * Compact magnitude text for an offset, dropping a trailing ".0" (e.g. 960→"16",
 * -330→"-5.5", 0→"0"). Purely for display/testing.
 */
export function fmtOffsetMinutes(minutes: number): string {
  const m = Number.isFinite(minutes) ? minutes : 0;
  const h = m / 60;
  return Number.isInteger(h) ? String(h) : h.toFixed(1).replace(/\.0$/, "");
}

/** The device's own IANA zone (fallback "" when unavailable). */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/** Cosmetic battery % (mirrors the legacy status bar countdown). */
export function batteryPercent(d: Date): number {
  return 100 - d.getSeconds();
}

/* ---- Stopwatch (pure reducer so it's headlessly testable) ---- */
export interface StopwatchState {
  running: boolean;
  /** Wall-clock base used to derive the running elapsed. */
  baseMs: number;
  /** Elapsed captured when paused (or the latest tick while running). */
  elapsedMs: number;
}
export type StopwatchAction =
  | { type: "start"; now: number }
  | { type: "pause"; now: number }
  | { type: "tick"; now: number }
  | { type: "reset" };

export const stopwatchInit = (): StopwatchState => ({ running: false, baseMs: 0, elapsedMs: 0 });

export function stopwatchReducer(s: StopwatchState, a: StopwatchAction): StopwatchState {
  switch (a.type) {
    case "start":
      if (s.running) return s;
      return { running: true, baseMs: a.now - s.elapsedMs, elapsedMs: s.elapsedMs };
    case "pause":
      if (!s.running) return s;
      return {
        running: false,
        baseMs: 0,
        // clamp ≥0 so a system clock step backwards never yields negative time
        elapsedMs: Math.max(0, a.now - s.baseMs),
      };
    case "tick":
      return s.running ? { ...s, elapsedMs: Math.max(0, a.now - s.baseMs) } : s;
    case "reset":
      return stopwatchInit();
  }
}

/** Format elapsed ms as `mm:ss.cc`. */
export function fmtStopwatch(elapsedMs: number): string {
  const cs = Math.max(0, Math.floor(elapsedMs / 10));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(m).padStart(2, "0")}:${p(s)}.${p(c)}`;
}

/** Per-lap deltas from cumulative lap snapshots (first lap = its own elapsed). */
export function lapDeltas(snaps: readonly number[]): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const v of snaps) {
    out.push(v - prev);
    prev = v;
  }
  return out;
}

/** Index of the fastest (smallest) non-empty lap delta, else -1. */
export function fastestLap(snaps: readonly number[]): number {
  const deltas = lapDeltas(snaps);
  if (deltas.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < deltas.length; i++) if (deltas[i]! < deltas[best]!) best = i;
  return best;
}

/** Index of the slowest (largest) non-empty lap delta, else -1 (iOS marks it red). */
export function slowestLap(snaps: readonly number[]): number {
  const deltas = lapDeltas(snaps);
  if (deltas.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < deltas.length; i++) if (deltas[i]! > deltas[best]!) best = i;
  return best;
}

/* ---- Countdown timer (pure reducer; mirrors the stopwatch pattern) ---- */
export interface TimerState {
  running: boolean;
  /** Duration the user picked (kept so a finished timer can restart). */
  totalMs: number;
  /** Remaining captured when paused; authoritative otherwise. */
  remainingMs: number;
  /** Wall-clock deadline while running (now + remaining). */
  endAtMs: number;
}
export type TimerAction =
  | { type: "start"; now: number }
  | { type: "pause"; now: number }
  | { type: "tick"; now: number }
  | { type: "set"; totalMs: number }
  | { type: "reset" };

export const timerInit = (): TimerState => ({
  running: false,
  totalMs: 0,
  remainingMs: 0,
  endAtMs: 0,
});

export function timerReducer(s: TimerState, a: TimerAction): TimerState {
  switch (a.type) {
    case "start": {
      if (s.running) return s;
      // finished (remaining 0) → restart from the original duration
      const base = s.remainingMs > 0 ? s.remainingMs : s.totalMs;
      return { ...s, running: true, remainingMs: base, endAtMs: a.now + base };
    }
    case "pause": {
      if (!s.running) return s;
      return { ...s, running: false, remainingMs: Math.max(0, s.endAtMs - a.now), endAtMs: 0 };
    }
    case "tick": {
      if (!s.running) return s;
      const rem = Math.max(0, s.endAtMs - a.now);
      return rem <= 0 ? { ...s, running: false, remainingMs: 0, endAtMs: 0 } : { ...s, remainingMs: rem };
    }
    case "set": {
      const total = Math.max(0, a.totalMs);
      return { running: false, totalMs: total, remainingMs: total, endAtMs: 0 };
    }
    case "reset":
      return { ...s, running: false, remainingMs: s.totalMs, endAtMs: 0 };
  }
}

/** Format a remaining-duration as `mm:ss` (guarded non-negative). */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

/* ---- Alarms (pure reducer; headless-testable) ---- */
export const ALARM_TONES = ["🔔", "⏰", "📯", "🎶"] as const;

/** Standard snooze interval (minutes). */
export const SNOOZE_MS = 5 * 60 * 1000;
/** Default snooze length (minutes) when an alarm has no explicit snoozeMin. */
export const DEFAULT_SNOOZE_MIN = 5;

/** Clamp a snooze length to a sane 1–120 minute integer (or undefined). */
export function normalizeSnoozeMin(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  return n >= 1 && n <= 120 ? n : undefined;
}

/** A rising boolean edge: true only on the transition false → true. Pure & testable
 *  (used for one-shot "timer just finished" / transient cues). */
export function risingEdge(prev: boolean, next: boolean): boolean {
  return next && !prev;
}

/* ---- Editable world clock (catalog + persisted user list) ---- */
export interface WorldCity {
  zone: string;
  /** i18n message key for preset cities (clock.city.*). Extra catalog cities use
   *  an empty string here and carry a bilingual `name` instead. */
  labelKey: string;
  /** Bilingual display name for cities added from a larger catalog. */
  name?: { zh: string; en: string };
}
export const WORLD_CITY_PRESETS: WorldCity[] = [
  { zone: "Asia/Shanghai", labelKey: "clock.city.beijing" },
  { zone: "Asia/Tokyo", labelKey: "clock.city.tokyo" },
  { zone: "Europe/London", labelKey: "clock.city.london" },
  { zone: "America/New_York", labelKey: "clock.city.newyork" },
  { zone: "Australia/Sydney", labelKey: "clock.city.sydney" },
  { zone: "Europe/Paris", labelKey: "clock.city.paris" },
  { zone: "Europe/Berlin", labelKey: "clock.city.berlin" },
  { zone: "America/Los_Angeles", labelKey: "clock.city.losangeles" },
  { zone: "Asia/Singapore", labelKey: "clock.city.singapore" },
  { zone: "Asia/Dubai", labelKey: "clock.city.dubai" },
  { zone: "Asia/Kolkata", labelKey: "clock.city.mumbai" },
  { zone: "America/Chicago", labelKey: "clock.city.chicago" },
  { zone: "Asia/Bangkok", labelKey: "clock.city.bangkok" },
  { zone: "Asia/Seoul", labelKey: "clock.city.seoul" },
  { zone: "Europe/Rome", labelKey: "clock.city.rome" },
  { zone: "America/Toronto", labelKey: "clock.city.toronto" },
  { zone: "America/Mexico_City", labelKey: "clock.city.mexico" },
  { zone: "Pacific/Auckland", labelKey: "clock.city.auckland" },
];
export const WORLD_CITY_MAX = 30;
export const defaultWorldCities = (): WorldCity[] => WORLD_CITY_PRESETS.slice(0, 4);

/** Read a persisted bilingual display name (both fields non-empty), if present. */
function worldCityName(raw: unknown): { zh: string; en: string } | undefined {
  const n = raw && typeof raw === "object" ? (raw as { name?: unknown }).name : undefined;
  if (!n || typeof n !== "object") return undefined;
  const o = n as { zh?: unknown; en?: unknown };
  if (typeof o.zh === "string" && o.zh && typeof o.en === "string" && o.en) {
    return { zh: o.zh, en: o.en };
  }
  return undefined;
}

/** Sanitize a persisted world-clock list (garbage dropped, de-duped, capped).
 *  Keeps preset zones (labelKey) AND non-preset zones carrying a valid bilingual
 *  `name` (added from a larger catalog). Empty/invalid falls back to the default. */
export function normalizeWorldCities(v: unknown, fallback: WorldCity[] = defaultWorldCities()): WorldCity[] {
  if (!Array.isArray(v)) return fallback;
  const known = new Map(WORLD_CITY_PRESETS.map((c) => [c.zone, c]));
  const out: WorldCity[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const zone = raw && typeof raw === "object" ? (raw as { zone?: unknown }).zone : undefined;
    if (typeof zone !== "string" || !zone || seen.has(zone)) continue;
    const preset = known.get(zone);
    let entry: WorldCity | undefined;
    if (preset) {
      entry = preset;
    } else {
      const name = worldCityName(raw);
      if (!name) continue; // unknown zone without a name → garbage
      entry = { zone, labelKey: "", name };
    }
    seen.add(zone);
    out.push(entry);
    if (out.length >= WORLD_CITY_MAX) break;
  }
  return out.length ? out : fallback;
}
export function removeWorldCity(list: WorldCity[], zone: string): WorldCity[] {
  return list.filter((c) => c.zone !== zone);
}
export function addWorldCity(list: WorldCity[], city: WorldCity): WorldCity[] {
  if (list.some((c) => c.zone === city.zone)) return list;
  const next = list.length >= WORLD_CITY_MAX ? list.slice(list.length - (WORLD_CITY_MAX - 1)) : list;
  return [...next, city];
}

/** Reorder a world-city list (iOS world clock lets you drag cities). Clamped,
 *  out-of-range indices are no-ops; returns a new list or the same when unchanged. */
export function moveWorldCity(list: WorldCity[], from: number, to: number): WorldCity[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return list;
  const n = list.length;
  if (n < 2) return list;
  const a = Math.max(0, Math.min(n - 1, from));
  const b = Math.max(0, Math.min(n - 1, to));
  if (a === b) return list;
  const next = [...list];
  const [item] = next.splice(a, 1);
  next.splice(b, 0, item as WorldCity);
  return next;
}

/** Convenience repeat presets (0=Sun..6=Sat, matching `dayAllowed`). */
export const WEEKDAYS: number[] = [1, 2, 3, 4, 5];
export const WEEKENDS: number[] = [0, 6];

export interface Alarm {
  id: string;
  hour: number; // 0-23
  min: number; // 0-59
  label: string;
  enabled: boolean;
  /** True while the alarm is ringing (until dismissed or toggled off). */
  ringing: boolean;
  /** Optional repeat: weekday indices 0(Sun)..6(Sat). Absent = every day. */
  repeat?: number[];
  /** Ringtone emoji; falls back to the default when absent (legacy data). */
  tone?: string;
  /** Snooze length in minutes; absent → DEFAULT_SNOOZE_MIN (5). */
  snoozeMin?: number;
}

export interface AlarmState {
  list: Alarm[];
  /** "hh:mm" key of the last minute evaluated — used to avoid duplicate latches. */
  lastKey: string;
}

let alarmSeq = 0;

export type AlarmAction =
  | { type: "add"; hour: number; min: number; label: string; repeat?: number[]; tone?: string; snoozeMin?: number }
  | {
      type: "update";
      id: string;
      hour: number;
      min: number;
      label: string;
      /** undefined clears the repeat list (every day); a non-empty array replaces it. */
      repeat?: number[];
      /** Optional tone token; a valid one replaces the alarm's ringtone. */
      tone?: string;
      /** Optional snooze length (minutes); a valid one replaces the alarm's. */
      snoozeMin?: number;
    }
  | { type: "remove"; id: string }
  | { type: "toggle"; id: string }
  | { type: "tone"; id: string }
  | { type: "dismiss"; id: string }
  | { type: "snooze"; id: string; now: Date }
  | { type: "tick"; now: Date };

export const alarmInit = (seed: readonly Alarm[] = []): AlarmState => ({
  list: [...seed].map((a) => ({ ...a })),
  lastKey: "",
});

function normalizeAlarm(hour: number, min: number) {
  const h = Math.min(23, Math.max(0, Math.floor(hour)));
  const m = Math.min(59, Math.max(0, Math.floor(min)));
  return { h, m };
}

/** Sanitize a repeat-day list to integer weekday indices 0..6 (dedup + sorted).
 * Returns `undefined` when none are valid — matching normalizeAlarms, so an
 * in-session add can never hold day numbers that dayAllowed() would silently
 * never match (a real bug when the UI/legacy data supplied e.g. 2.5 / -1 / 8). */
function cleanRepeat(r: readonly number[] | undefined): number[] | undefined {
  if (!r || r.length === 0) return undefined;
  const days = [...new Set(r.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return days.length ? days : undefined;
}

export function alarmsReducer(s: AlarmState, a: AlarmAction): AlarmState {
  switch (a.type) {
    case "add": {
      const { h, m } = normalizeAlarm(a.hour, a.min);
      const repeat = cleanRepeat(a.repeat);
      alarmSeq += 1;
      const alarm: Alarm = {
        id: `${Date.now().toString(36)}-${alarmSeq}`,
        hour: h,
        min: m,
        label: a.label.trim() || "",
        enabled: true,
        ringing: false,
        tone: ALARM_TONES.includes(a.tone as (typeof ALARM_TONES)[number]) ? a.tone! : ALARM_TONES[0],
        snoozeMin: normalizeSnoozeMin(a.snoozeMin),
        ...(repeat ? { repeat } : {}),
      };
      return { ...s, list: [...s.list, alarm] };
    }
    case "update": {
      // Edit an existing alarm in place (iOS parity: tapping an alarm opens an
      // editor). Keeps id/enabled, sanitizes hh:mm + repeat like add, and stops
      // any ring it is in the middle of — the new time is authoritative.
      const { h, m } = normalizeAlarm(a.hour, a.min);
      const repeat = cleanRepeat(a.repeat);
      const tone =
        typeof a.tone === "string" && ALARM_TONES.includes(a.tone as (typeof ALARM_TONES)[number])
          ? a.tone
          : undefined;
      const sm = normalizeSnoozeMin(a.snoozeMin);
      return {
        ...s,
        list: s.list.map((al) => {
          if (al.id !== a.id) return al;
          const next: Alarm = {
            ...al,
            hour: h,
            min: m,
            label: typeof a.label === "string" ? a.label.trim() : "",
            ringing: false,
          };
          // cleanRepeat returns undefined for "every day" → drop the repeat field
          // (an edited alarm that unchecks every weekday fires daily again).
          if (repeat && repeat.length > 0) next.repeat = repeat;
          else delete next.repeat;
          // A valid tone replaces the ringtone; absent keeps the existing one.
          if (tone !== undefined) next.tone = tone;
          // A valid snooze length replaces it; absent keeps the existing one.
          if (sm !== undefined) next.snoozeMin = sm;
          return next;
        }),
      };
    }
    case "remove":
      return { ...s, list: s.list.filter((al) => al.id !== a.id) };
    case "toggle":
      return {
        ...s,
        list: s.list.map((al) =>
          al.id === a.id ? { ...al, enabled: !al.enabled, ringing: false } : al,
        ),
      };
    case "dismiss":
      return {
        ...s,
        list: s.list.map((al) => (al.id === a.id ? { ...al, ringing: false } : al)),
      };
    case "tone": {
      // Cycle the ringtone for one alarm (wraps at the end of the list).
      const tones = [...ALARM_TONES];
      return {
        ...s,
        list: s.list.map((al) => {
          if (al.id !== a.id) return al;
          const cur = al.tone && tones.includes(al.tone as (typeof ALARM_TONES)[number]) ? al.tone : tones[0]!;
          const idx = tones.indexOf(cur as (typeof ALARM_TONES)[number]);
          return { ...al, tone: tones[(idx + 1) % tones.length]! };
        }),
      };
    }
    case "snooze": {
      // Stop ringing and re-arm later (crosses the hour boundary safely by
      // computing from an actual Date). Uses the alarm's snoozeMin (default 5).
      return {
        ...s,
        list: s.list.map((al) =>
          al.id === a.id && al.ringing
            ? {
                ...al,
                ringing: false,
                hour: new Date(a.now.getTime() + (al.snoozeMin ?? DEFAULT_SNOOZE_MIN) * 60_000).getHours(),
                min: new Date(a.now.getTime() + (al.snoozeMin ?? DEFAULT_SNOOZE_MIN) * 60_000).getMinutes(),
              }
            : al,
        ),
      };
    }
    case "tick": {
      const key = alarmKey(a.now);
      const freshMinute = key !== s.lastKey;
      let next = s.list;
      // Ring every enabled alarm only when its minute *has just arrived*. The
      // freshMinute latch means dismissing within the same minute does not make
      // the very next tick re-ring it (fixes dismiss being ineffective).
      if (freshMinute) {
        for (let i = 0; i < next.length; i++) {
          const al = next[i]!;
          if (
            al.enabled &&
            !al.ringing &&
            dayAllowed(al, a.now) &&
            al.hour === a.now.getHours() &&
            al.min === a.now.getMinutes()
          ) {
            const copy = [...next];
            copy[i] = { ...al, ringing: true };
            next = copy;
          }
        }
      }
      return { list: next, lastKey: key };
    }
  }
}

/** Local wall-clock "hh:mm" key for a Date. */
export function alarmKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Whether an alarm fires on a given date: no repeat list = every day; with a
 * list, only when `date.getDay()` (0=Sun..6=Sat) is included. */
export function dayAllowed(alarm: Pick<Alarm, "repeat">, d: Date): boolean {
  if (!alarm.repeat || alarm.repeat.length === 0) return true;
  return alarm.repeat.includes(d.getDay());
}

/**
 * The next epoch-ms at which an alarm will ring: the first allowed day (repeat /
 * every-day) at its HH:MM strictly after `nowMs`. Returns null if none is found
 * (defensive upper bound of one year). Used to register the alarm with the native
 * exact-wake host (`amos-scheduler` / AlarmManager bridge).
 */
export function nextAlarmAtMs(alarm: Pick<Alarm, "hour" | "min" | "repeat">, nowMs: number): number | null {
  const base = new Date(nowMs);
  let cand = new Date(base.getFullYear(), base.getMonth(), base.getDate(), alarm.hour, alarm.min, 0, 0);
  if (cand.getTime() <= nowMs) cand = new Date(cand.getTime() + 86_400_000);
  for (let i = 0; i < 367; i++) {
    if (dayAllowed(alarm, cand)) return cand.getTime();
    cand = new Date(cand.getTime() + 86_400_000);
  }
  return null;
}

/** How many alarms are currently ringing (for banners / tests). */
export function ringingAlarms(state: AlarmState): Alarm[] {
  return state.list.filter((al) => al.ringing);
}

/** Stable sort of alarms by time (earliest first), as iOS shows them. Returns a
 *  new array; ties keep their existing relative order. */
export function alarmsByTime(list: readonly Alarm[]): Alarm[] {
  return [...list].sort((a, b) => a.hour - b.hour || a.min - b.min);
}

/** Corruption / back-compat guard for the persisted alarm list. Drops entries
 * without a usable id + numeric hh:mm, clamps the time, dedups ids, and keeps
 * only valid `repeat` days / `tone`. */
export function normalizeAlarms(list: unknown): Alarm[] {
  if (!Array.isArray(list)) return [];
  const out: Alarm[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id === "") continue;
    if (seen.has(o.id)) continue;
    if (typeof o.hour !== "number" || !Number.isFinite(o.hour)) continue;
    if (typeof o.min !== "number" || !Number.isFinite(o.min)) continue;
    const { h, m } = normalizeAlarm(o.hour, o.min);
    const al: Alarm = {
      id: o.id,
      hour: h,
      min: m,
      label: typeof o.label === "string" ? o.label : "",
      enabled: o.enabled === true,
      ringing: false,
      tone: ALARM_TONES.includes(o.tone as (typeof ALARM_TONES)[number])
        ? (o.tone as string)
        : ALARM_TONES[0],
      snoozeMin: normalizeSnoozeMin(o.snoozeMin),
    };
    if (Array.isArray(o.repeat)) {
      const days = [...new Set(o.repeat.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
      if (days.length > 0) al.repeat = days as number[];
    }
    seen.add(al.id);
    out.push(al);
  }
  return out;
}

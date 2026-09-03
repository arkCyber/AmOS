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

/* ---- Editable world clock (catalog + persisted user list) ---- */
export interface WorldCity {
  zone: string;
  /** i18n message key for the city label (clock.city.*). */
  labelKey: string;
}
export const WORLD_CITY_PRESETS: WorldCity[] = [
  { zone: "Asia/Shanghai", labelKey: "clock.city.beijing" },
  { zone: "Asia/Tokyo", labelKey: "clock.city.tokyo" },
  { zone: "Europe/London", labelKey: "clock.city.london" },
  { zone: "America/New_York", labelKey: "clock.city.newyork" },
  { zone: "Australia/Sydney", labelKey: "clock.city.sydney" },
];
export const WORLD_CITY_MAX = 6;
export const defaultWorldCities = (): WorldCity[] => WORLD_CITY_PRESETS.slice(0, 4);

/** Sanitize a persisted world-clock list (unknown zones / garbage dropped,
 * de-duped, capped). Empty/invalid falls back to the default four. */
export function normalizeWorldCities(v: unknown, fallback: WorldCity[] = defaultWorldCities()): WorldCity[] {
  if (!Array.isArray(v)) return fallback;
  const known = new Map(WORLD_CITY_PRESETS.map((c) => [c.zone, c]));
  const out: WorldCity[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const zone = raw && typeof raw === "object" ? (raw as { zone?: unknown }).zone : undefined;
    if (typeof zone !== "string" || !known.has(zone) || seen.has(zone)) continue;
    seen.add(zone);
    out.push(known.get(zone)!);
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
}

export interface AlarmState {
  list: Alarm[];
  /** "hh:mm" key of the last minute evaluated — used to avoid duplicate latches. */
  lastKey: string;
}

let alarmSeq = 0;

export type AlarmAction =
  | { type: "add"; hour: number; min: number; label: string; repeat?: number[]; tone?: string }
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

export function alarmsReducer(s: AlarmState, a: AlarmAction): AlarmState {
  switch (a.type) {
    case "add": {
      const { h, m } = normalizeAlarm(a.hour, a.min);
      alarmSeq += 1;
      const alarm: Alarm = {
        id: `${Date.now().toString(36)}-${alarmSeq}`,
        hour: h,
        min: m,
        label: a.label.trim() || "",
        enabled: true,
        ringing: false,
        tone: ALARM_TONES.includes(a.tone as (typeof ALARM_TONES)[number]) ? a.tone! : ALARM_TONES[0],
        ...(a.repeat && a.repeat.length > 0 ? { repeat: [...new Set(a.repeat)].sort() } : {}),
      };
      return { ...s, list: [...s.list, alarm] };
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
      // Stop ringing and re-arm SNOOZE_MS later (crosses the hour boundary safely
      // by computing from an actual Date).
      const next = new Date(a.now.getTime() + SNOOZE_MS);
      return {
        ...s,
        list: s.list.map((al) =>
          al.id === a.id && al.ringing
            ? { ...al, ringing: false, hour: next.getHours(), min: next.getMinutes() }
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
export function dayAllowed(alarm: Alarm, d: Date): boolean {
  if (!alarm.repeat || alarm.repeat.length === 0) return true;
  return alarm.repeat.includes(d.getDay());
}

/** How many alarms are currently ringing (for banners / tests). */
export function ringingAlarms(state: AlarmState): Alarm[] {
  return state.list.filter((al) => al.ringing);
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

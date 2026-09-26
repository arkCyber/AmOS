/**
 * Health & Fitness — the domain core behind `HealthApp.svelte` (REQ-A1454).
 *
 * Two things live here:
 *
 *  1. **The reading seam** (`readHealthFeed`) over the System UI `SensorHost`. The
 *     wellness pair — a cumulative step count and a heart rate — is produced on device by
 *     `SensorGlue` and pushed into the shared stream bus; `SensorHost`'s snapshot carries
 *     it as `vitals`. Nothing here invents a sample: with no bridge or no sensor the
 *     answer is `null`, which the screen prints as `—`.
 *
 *  2. **The pure history reducer** (`applyVitalsTick` and friends). The device's step
 *     counter is **cumulative since boot** (Android `TYPE_STEP_COUNTER`), so a day's step
 *     count is the sum of the positive deltas between ticks. Two things make that
 *     non-trivial and both are handled here, not in the component:
 *       * the counter **resets to a low value on reboot** — a negative delta is a
 *         re-baseline, never a negative day (see [`stepDelta`]);
 *       * a **local midnight** ends the day — the cumulative counter knows nothing about
 *         midnight, so the first tick of a new day re-baselines and the steps taken
 *         between midnight and that tick are unknowable (started from the sample, never
 *         guessed).
 *
 * Honesty rules, applied throughout: a reading is `number | null` end to end (`null` is
 * "no reading", **not** `0`); a heart rate outside a physiological range is refused rather
 * than stored; calories are only ever shown when the user has given a weight.
 */
import { readStoreValue, writeStoreValueChecked } from "./amosStore";
import { invoke } from "./backend";
import { amosWarn } from "./debugLog";
import { localId } from "./localId";
import { normalizeVitals, type SensorVitalsDatum } from "./sensorEvents";
import { addLocalDays } from "./time";

/** Daily history + workouts — **content the user created**, so it is backed up. */
export const HEALTH_HISTORY_KEY = "amos.health.history";

/**
 * The raw cumulative counter we last folded into the history — pure **device state**.
 *
 * It is deliberately its own key, not a field of the history: the history is synced to the
 * cloud, and a stale restore would put yesterday's (or another device's) raw count beside
 * today's history, making the very next delta wrong. `scripts/store-allowlist.json` records
 * it as `device-state` for that reason.
 */
export const HEALTH_COUNTER_KEY = "amos.health.counter";

/**
 * The one user-supplied profile field: body weight, used **only** to turn a step count into
 * an approximate calorie figure. It is configuration (not history) and stays its own key so
 * the calorie line can honestly say "—" until the user provides one.
 */
export const HEALTH_PROFILE_KEY = "amos.health.profile";

export const WORKOUT_KINDS = ["walk", "run", "cycle"] as const;
export type WorkoutKind = (typeof WORKOUT_KINDS)[number];

/** One local day's totals. */
export interface HealthDay {
  /** Local day key, `YYYY-MM-DD`. */
  day: string;
  /**
   * Steps **attributed** to this day — the sum of the positive deltas folded into it.
   *
   * It is a measurement only when {@link HealthDay.steps_recorded} is `true`. A row can
   * exist for a day whose steps were never observed: the counter is cumulative since boot,
   * so the first sample of a new local day re-baselines without folding anything (see
   * [`applyVitalsTick`]), and a heart-rate-only sample mints the day's row for the bpm
   * pair with `steps` left at the seed `0`. Reading that `0` as "you walked zero steps" is
   * the fabrication {@link steps_recorded} exists to prevent — the strip and the header both
   * go through it.
   */
  steps: number;
  /**
   * Whether a **step** observation was folded into this day — i.e. whether {@link steps}
   * is a measurement rather than the seed `0`.
   *
   * Set when a positive delta is attributed; **not** set by a heart-rate update or by a
   * re-baseline, neither of which observes a step. A day with `false` is drawn as "no
   * reading" (`—`) by every consumer, exactly like a day with no row at all: the two differ
   * only in *why* nothing was observed, which is not a difference the screen can act on.
   */
  steps_recorded: boolean;
  /** Lowest / highest heart rate seen that day, or `null` when none was recorded. */
  hr_min: number | null;
  hr_max: number | null;
}

/** One workout. `endedAt === 0` means it is still running (see [`normalizeHealthState`]). */
export interface Workout {
  id: string;
  kind: WorkoutKind;
  startedAt: number;
  endedAt: number;
  steps: number;
}

export interface HealthState {
  days: HealthDay[];
  workouts: Workout[];
}

/** The user-supplied profile; `weightKg` is `null` until they provide one. */
export interface HealthProfile {
  weightKg: number | null;
}

/** The step-counter baseline we last applied. */
export interface HealthCounter {
  day: string;
  raw: number;
}

/** The reducer's whole state: the history plus the counter, kept together so a tick
 *  cannot update one and forget the other. */
export interface HealthTick {
  state: HealthState;
  counter: HealthCounter;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * The **local** calendar day of `tsMs`, as `YYYY-MM-DD`.
 *
 * Local, not UTC: "today's steps" is what the person's clock says today, and a UTC day key
 * would roll the count over in the middle of their evening.
 */
export function dayKey(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** One row of the last-N-days strip: the local day, its weekday, and the steps recorded. */
export interface RecentDay {
  /** Local day key, `YYYY-MM-DD` — the identity the strip keys its rows by. */
  day: string;
  /** `Date#getDay()` of that local day (0 = Sunday), for the weekday label. */
  dow: number;
  /**
   * Steps recorded for that day; `0` when the day has no row.
   *
   * The `0` is a **structural** placeholder, not a measurement — which is what
   * {@link RecentDay.recorded} distinguishes. The strip must still draw seven rows (the
   * `{#each}` is keyed by `day`, and a variable row count would collapse the week), but a
   * day we never saw a sample for is "no reading", not "you walked zero steps".
   */
  steps: number;
  /**
   * Whether a **step** observation was folded into this day (the row's own
   * [`HealthDay.steps_recorded`]), so `steps` is a measurement.
   *
   * `false` covers two cases that read alike: no row at all, and a row minted by a
   * heart-rate-only sample (whose `steps` is the seed `0`, not a count). In both, `steps`
   * is `0` only because a row cannot be absent from a fixed-length strip — drawing the
   * number (or a bar at its height, or a `title` of `"<day>: 0"`) would assert a
   * measurement the app never took. This is the same `null`-vs-`0` rule the readings follow
   * (REQ-A1454; the heart-rate case is REQ-A1838 ∕ F-SH-909).
   */
  recorded: boolean;
}

/**
 * The last `count` **local calendar** days, oldest first.
 *
 * The step is a calendar day (`addLocalDays`), never a fixed 24 h. A day is not always 24
 * hours: on a fall-back day `nowMs - 86_400_000` is still *today* in local time, so the strip
 * came back with a **duplicate `day`** — and because the component keys its `{#each}` by that
 * key, the bar chart broke and the weekly total counted that day twice. `lib/time.ts` carries
 * that rule (REQ-A343) and names its callers; the strip was the one caller that hand-rolled
 * the subtraction.
 */
export function recentDays(state: HealthState, nowMs: number, count = 7): RecentDay[] {
  const out: RecentDay[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(addLocalDays(nowMs, -i));
    const day = dayKey(d.getTime());
    const row = state.days.find((x) => x.day === day);
    // `recorded` is carried rather than inferred from `steps === 0`, and it is the row's own
    // *step* record — not merely "a row exists": a heart-rate-only sample mints a row whose
    // `steps` is the seed `0`, so row presence alone would print that day as a measured zero
    // (REQ-A1454; the heart-rate case is REQ-A1838 ∕ F-SH-909).
    out.push({
      day,
      dow: d.getDay(),
      steps: row?.steps ?? 0,
      recorded: row?.steps_recorded === true,
    });
  }
  return out;
}

/**
 * The steps **measured** for `day`, or `null` when none were observed.
 *
 * `null` is the honest answer for a day the history has no row for **and** for a day whose
 * only row was minted by a heart-rate sample (see [`HealthDay.steps_recorded`]) — the counter
 * was cumulative-since-boot and re-baselined, so the day's step total was never observed.
 * The header must print `—` for it, never the row's seed `0`; reading the row's `steps` alone
 * is what made the tile say 「今日步数 0」 beside a strip that drew the same day as 「无读数」
 * (REQ-A1838 ∕ F-SH-909).
 */
export function daySteps(state: HealthState, day: string): number | null {
  const row = state.days.find((d) => d.day === day);
  return row?.steps_recorded === true ? row.steps : null;
}

/**
 * The steps taken between two cumulative readings.
 *
 * A **negative** difference is a device reboot (the counter restarts near zero), not a
 * negative day: it re-baselines to `0` new steps. A non-finite reading is not a sample, so
 * it also yields `0` — the caller re-baselines without recording a delta.
 */
export function stepDelta(prevRaw: number, nextRaw: number): number {
  if (!Number.isFinite(prevRaw) || !Number.isFinite(nextRaw)) return 0;
  const d = nextRaw - prevRaw;
  return d > 0 ? d : 0;
}

/**
 * Narrow a raw heart-rate reading: finite and inside a plausible range (25–250 bpm).
 *
 * Out-of-range values are the sensor's own "no reading" pathologies (a contact artifact, a
 * zero from a disconnected strap), and storing one would draw a spike the person never had.
 */
export function normalizeHeartRate(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 25 && v <= 250 ? v : null;
}

function optSteps(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function optHr(v: unknown): number | null {
  return normalizeHeartRate(v);
}

function isWorkoutKind(v: unknown): v is WorkoutKind {
  return typeof v === "string" && (WORKOUT_KINDS as readonly string[]).includes(v);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Coerce a raw stored history into the shape the screen renders.
 *
 * Two repairs matter:
 *   * a `days` entry that is not a well-formed day is dropped rather than rendered with
 *     `undefined` numbers;
 *   * a workout whose `endedAt` is `0` (still running when the app died) is **closed at its
 *     start** — the elapsed time is unknown, so it gets zero duration rather than a timer
 *     that resumes a session from a previous launch and never ends. A persisted "still
 *     running" flag with no retractor is exactly the shape that leaves a screen stuck.
 */
export function normalizeHealthState(raw: unknown): HealthState {
  const o = (raw ?? {}) as { days?: unknown; workouts?: unknown };
  const days: HealthDay[] = [];
  if (Array.isArray(o.days)) {
    for (const row of o.days) {
      const r = row as Partial<HealthDay>;
      if (typeof r?.day !== "string" || !DAY_RE.test(r.day)) continue;
      const hrMin = optHr(r.hr_min);
      const hrMax = optHr(r.hr_max);
      const both = hrMin !== null && hrMax !== null;
      const steps = optSteps(r.steps);
      days.push({
        day: r.day,
        steps,
        // Migrated, not stored: older rows carry no flag, and the reducer only ever *adds* a
        // positive delta — so a stored count above zero is necessarily a measurement and a
        // stored `0` cannot be one (it could only have come from a heart-rate-only seed).
        // A stored flag wins when present so the field is authoritative once written.
        steps_recorded:
          typeof r.steps_recorded === "boolean" ? r.steps_recorded : steps > 0,
        // A stored pair that is the wrong way round (min > max) is repaired, not rendered
        // as an inverted range.
        hr_min: both ? Math.min(hrMin, hrMax) : (hrMin ?? hrMax),
        hr_max: both ? Math.max(hrMin, hrMax) : (hrMax ?? hrMin),
      });
    }
  }
  days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const workouts: Workout[] = [];
  if (Array.isArray(o.workouts)) {
    for (const row of o.workouts) {
      const r = row as Partial<Workout>;
      if (typeof r?.id !== "string" || r.id === "") continue;
      const startedAt = typeof r.startedAt === "number" && Number.isFinite(r.startedAt) ? r.startedAt : 0;
      const endedRaw = typeof r.endedAt === "number" && Number.isFinite(r.endedAt) ? r.endedAt : 0;
      // A row with no usable start is not a workout we can show; drop it rather than draw a
      // zero-length entry at the epoch.
      if (startedAt <= 0) continue;
      workouts.push({
        id: r.id,
        kind: isWorkoutKind(r.kind) ? r.kind : "walk",
        startedAt,
        // `endedAt === 0` is the "still running" marker; a persisted one is closed at its
        // start (zero duration) — the end is unknown, and a session that resumes a timer
        // from a previous launch never ends.
        endedAt: endedRaw > 0 ? endedRaw : startedAt,
        steps: optSteps(r.steps),
      });
    }
  }
  return { days, workouts };
}

export function readHealthState(): HealthState {
  return normalizeHealthState(readStoreValue<unknown>(HEALTH_HISTORY_KEY, null));
}

/** The stored profile, narrowed. A non-positive / non-finite weight is treated as absent. */
export function normalizeHealthProfile(raw: unknown): HealthProfile {
  const o = (raw ?? {}) as { weightKg?: unknown };
  const w = o.weightKg;
  return { weightKg: typeof w === "number" && Number.isFinite(w) && w > 0 ? w : null };
}

export function readHealthProfile(): HealthProfile {
  return normalizeHealthProfile(readStoreValue<unknown>(HEALTH_PROFILE_KEY, null));
}

/** Persist the profile; returns whether the write landed (the screen reads the verdict). */
export function saveHealthProfile(weightKg: number | null): boolean {
  return writeStoreValueChecked(HEALTH_PROFILE_KEY, { weightKg });
}

/** The stored counter, or `null` when absent/unusable (the caller re-baselines). */
export function readHealthCounter(): HealthCounter | null {
  const raw = readStoreValue<unknown>(HEALTH_COUNTER_KEY, null);
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Partial<HealthCounter>;
  if (typeof o.day !== "string" || !DAY_RE.test(o.day)) return null;
  if (typeof o.raw !== "number" || !Number.isFinite(o.raw) || o.raw < 0) return null;
  return { day: o.day, raw: o.raw };
}

/** Replace or insert one day's row, keeping `days` ordered by day key. */
function upsertDay(state: HealthState, day: string, f: (d: HealthDay) => HealthDay): HealthState {
  const i = state.days.findIndex((d) => d.day === day);
  const days = [...state.days];
  // The seed is a **structural** zero: `steps_recorded` stays `false` so a caller that only
  // touches the bpm pair (the heart-rate branch below) mints a day that prints `—` for
  // steps, not a measured `0` (REQ-A1838 ∕ F-SH-909).
  const seed: HealthDay = { day, steps: 0, steps_recorded: false, hr_min: null, hr_max: null };
  days[i >= 0 ? i : days.length] = i >= 0 ? f(days[i]!) : f(seed);
  days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return { ...state, days };
}

/** The workout still running, if any (`endedAt === 0` is the running marker). */
export function activeWorkout(state: HealthState): Workout | null {
  return state.workouts.find((w) => w.endedAt === 0) ?? null;
}

/**
 * Fold one vitals reading into the history.
 *
 * Steps only advance on a finite cumulative reading; a day rollover re-baselines instead of
 * attributing the whole since-boot count to the new day. While a workout is running, the
 * same delta is also credited to it. Heart rate updates today's min/max.
 */
export function applyVitalsTick(prev: HealthTick, vitals: SensorVitalsDatum, nowMs: number): HealthTick {
  const day = dayKey(nowMs);
  let state = prev.state;
  let counter = prev.counter;

  const raw = vitals.steps_total;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    if (counter.day !== day) {
      // New local day (or first ever tick): the cumulative counter still holds everything
      // since boot, so the steps already taken today cannot be recovered from it. Start the
      // new day from this sample — the count begins when we start watching, never at a guess.
      counter = { day, raw };
    } else {
      const delta = stepDelta(counter.raw, raw);
      if (delta > 0) {
        // A folded delta is a step *observation*, so the day is marked as measured — this is
        // the only place `steps_recorded` becomes true (REQ-A1838 ∕ F-SH-909).
        state = upsertDay(state, day, (d) => ({
          ...d,
          steps: d.steps + delta,
          steps_recorded: true,
        }));
        const running = activeWorkout(state);
        if (running) {
          state = {
            ...state,
            workouts: state.workouts.map((w) => (w.id === running.id ? { ...w, steps: w.steps + delta } : w)),
          };
        }
      }
      counter = { day, raw };
    }
  }

  const hr = normalizeHeartRate(vitals.heart_rate_bpm);
  if (hr !== null) {
    state = upsertDay(state, day, (d) => ({
      ...d,
      hr_min: d.hr_min === null ? hr : Math.min(d.hr_min, hr),
      hr_max: d.hr_max === null ? hr : Math.max(d.hr_max, hr),
    }));
  }

  return { state, counter };
}

/**
 * Persist a tick. Returns whether **both** stores landed.
 *
 * The order is the guard: the counter is written first, then the history. If the history
 * write is refused, the caller keeps its previous in-memory tick, so the delta is recomputed
 * and retried on the next sample — the failure direction is an *under*-count (we only ever
 * report what we stored), never a double-count. Metrics are not a reason to overwrite either
 * store blindly.
 */
export function persistHealthTick(tick: HealthTick): boolean {
  // A baseline we do not have is **not** a baseline of 0: without a finite raw count there
  // is nothing to re-baseline from, and storing `0` would make the next real reading look
  // like a full since-boot delta. So an unseeded counter is skipped, not zeroed.
  const counterOk = Number.isFinite(tick.counter.raw)
    ? writeStoreValueChecked(HEALTH_COUNTER_KEY, tick.counter)
    : true;
  if (!counterOk) {
    amosWarn("health", "step-counter baseline was not stored; keeping the previous tick");
    return false;
  }
  const historyOk = writeStoreValueChecked(HEALTH_HISTORY_KEY, tick.state);
  if (!historyOk) {
    amosWarn("health", "health history was not stored; keeping the previous tick");
    return false;
  }
  return true;
}

/** Persist only the history (used by workout start/end, which do not move the baseline). */
export function persistHealthState(state: HealthState): boolean {
  return writeStoreValueChecked(HEALTH_HISTORY_KEY, state);
}

/** Aggregate totals over the workout log. Pure; used for the summary strip. */
export function workoutTotals(workouts: readonly Workout[]): {
  count: number;
  ms: number;
  steps: number;
} {
  let ms = 0;
  let steps = 0;
  for (const w of workouts) {
    ms += Math.max(0, w.endedAt - w.startedAt);
    steps += w.steps;
  }
  return { count: workouts.length, ms, steps };
}

/** Start a workout, returning the new state and the new id. */
export function startWorkout(state: HealthState, kind: WorkoutKind, nowMs: number): { state: HealthState; id: string } {
  const id = localId("workout");
  const w: Workout = { id, kind, startedAt: nowMs, endedAt: 0, steps: 0 };
  return { state: { ...state, workouts: [...state.workouts, w] }, id };
}

/** End the running workout (or the one with `id`), closing it at `nowMs`. Pure. */
export function endWorkout(state: HealthState, id: string | null, nowMs: number): HealthState {
  const target = id ?? activeWorkout(state)?.id ?? null;
  if (target === null) return state;
  return {
    ...state,
    workouts: state.workouts.map((w) => (w.id === target ? { ...w, endedAt: nowMs } : w)),
  };
}

/**
 * Approximate calories for a step count, or `null` when no weight is known.
 *
 * `null` is the point: without the person's weight any number would be a fabricated
 * measurement, so the screen shows `—` (and offers to record a weight) rather than a
 * plausible-looking figure. The formula is the common walking approximation
 * (≈0.04 kcal per step per kg).
 */
export function stepCalories(steps: number, weightKg: number | null): number | null {
  if (weightKg === null || !Number.isFinite(weightKg) || weightKg <= 0) return null;
  if (!Number.isFinite(steps) || steps <= 0) return 0;
  return Math.round(steps * 0.04 * weightKg);
}

/**
 * Whether a host answered the sensor snapshot at all, plus whatever wellness pair it carries.
 *
 * `bridged` and `vitals` are two **independent** facts, and folding them into one `null`
 * value is the defect this exists to prevent: "no host answered" (the desktop shell over a
 * synced history) and "a host answered and has not reported a sample yet" (a phone whose
 * wellness producer is registered and waiting for the first step) both read as `null`, so the
 * screen told a user who had *already* connected a phone and granted the permission to do
 * exactly that (REQ-A1886).
 *
 * `vitals` is `null` whenever the host has recorded no sample — a device with no step counter
 * or heart-rate sensor, or one whose counter is registered but has not emitted yet. Keeping
 * `bridged` separate is what lets the screen name the right cause.
 */
export interface HealthFeed {
  bridged: boolean;
  vitals: SensorVitalsDatum | null;
}

export async function readHealthFeed(): Promise<HealthFeed> {
  const snap = await invoke<{ vitals?: unknown }>("sensor_host_snapshot");
  if (snap === null) return { bridged: false, vitals: null };
  return { bridged: true, vitals: normalizeVitals(snap.vitals) };
}

/**
 * Which sentence the "no reading" banner may say — one per distinct, reachable cause.
 *
 * * `"none"` — a real reading is on screen; no banner.
 * * `"unbridged"` — no host answered, so the app is not talking to a device at all. This is
 *   the only case the "connect a phone and allow the permission" copy is true for.
 * * `"stopped"` — a host answered and its producer **announced a detach** (`cleared`), so the
 *   sensors were released. Walking would change nothing until the app re-attaches, which is
 *   why this is not folded into `"awaiting"`.
 * * `"awaiting"` — a host answered, no sample has arrived, and no detach was announced: the
 *   producer is attached and simply has not reported yet (or the device exposes no motion
 *   sensor at all — the banner's hint says so, because from here the two are one fact).
 *
 * A sample carrying neither scalar is still "no reading": the host drops such a sample
 * (`VitalsLatest::record` keeps the previous value when there is nothing to retract), so this
 * arm is a belt to that braces, not a distinct state. A sample carrying only a scalar the
 * screen will not draw — see [`vitalsHasReading`] — is the same state, for the same reason
 * (REQ-A1902).
 */
export type HealthNotice = "none" | "unbridged" | "stopped" | "awaiting";

/**
 * Whether a sample carries a reading the screen will actually draw (REQ-A1902).
 *
 * The banner must agree with the cells it stands above. It used to test the raw wire fields —
 * `steps_total !== null || heart_rate_bpm !== null` — while the pulse cell draws
 * `normalizeHeartRate(...)` (25–250) and the reducer folds only a non-negative step count. The
 * two seams do not even agree above the frontend: `android_glue::reading` refuses only a
 * **non-positive** heart rate (`v > 0.0`), so a contact artifact reporting `12 bpm` (or a worn
 * strap at `300`) arrives as a number, the cell refuses to draw it, and the banner was withheld
 * on the strength of the very value the cell discarded — a screen of three `—` with nothing
 * saying why. Judging by the drawn value is the one rule both faces can share.
 */
function vitalsHasReading(v: SensorVitalsDatum): boolean {
  const steps = v.steps_total;
  // The reducer's own guard (`applyVitalsTick`): a finite, non-negative cumulative count.
  const hasSteps = typeof steps === "number" && Number.isFinite(steps) && steps >= 0;
  return hasSteps || normalizeHeartRate(v.heart_rate_bpm) !== null;
}

export function healthNotice(
  latest: SensorVitalsDatum | null,
  bridged: boolean,
  stopped: boolean,
): HealthNotice {
  if (latest !== null && vitalsHasReading(latest)) return "none";
  if (!bridged) return "unbridged";
  return stopped ? "stopped" : "awaiting";
}

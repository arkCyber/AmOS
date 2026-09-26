<script lang="ts">
  // HealthApp.svelte — Health & Fitness (REQ-A1454).
  //
  // The screen is a **view of real device readings**, never a demo: the step count and
  // heart rate come from the System UI `SensorHost` bus (produced on device by
  // `SensorGlue`), and every number the device did not report prints as `—`. The
  // domain decisions — reboot re-baseline, midnight rollover, out-of-range heart rates,
  // calories only with a known weight — live in `lib/health.ts` and are unit-tested
  // there; this component owns only the wiring and the drawing.

  import { onMount } from "svelte";
  import { t } from "./locale.svelte";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import {
    activeWorkout,
    applyVitalsTick,
    dayKey,
    daySteps,
    endWorkout,
    normalizeHeartRate,
    persistHealthState,
    persistHealthTick,
    readHealthCounter,
    readHealthProfile,
    readHealthState,
    healthNotice,
    readHealthFeed,
    recentDays,
    saveHealthProfile,
    startWorkout,
    stepCalories,
    workoutTotals,
    WORKOUT_KINDS,
    type HealthProfile,
    type HealthState,
    type HealthTick,
    type Workout,
    type WorkoutKind,
  } from "../lib/health";
  import { subscribeSensorData, type SensorVitalsDatum } from "../lib/sensorEvents";

  let history = $state<HealthState>(readHealthState());
  let profile = $state<HealthProfile>(readHealthProfile());
  let counter = $state(readHealthCounter());
  /** The most recent vitals sample, or `null` when nothing has been reported. */
  let latest = $state<SensorVitalsDatum | null>(null);
  /**
   * Whether a host answered `sensor_host_snapshot` at all — i.e. whether this shell is talking
   * to a device. Kept apart from `latest` because "no host" and "host, no sample yet" are
   * different causes and the banner must not tell a connected phone to connect (REQ-A1886).
   */
  let bridged = $state(false);
  /** Whether the host announced its producer detached (`cleared`) since the last sample. */
  let stopped = $state(false);
  let nowMs = $state(Date.now());
  let writeError = $state<string | null>(null);

  /**
   * Drop the live sample because its producer detached.
   *
   * A `cleared` event is how the bus reports that `clear_samples` ran — the glue's
   * `SensorGlue.detach()` (System UI teardown), which drops the IMU/frame/**vitals** stores so a
   * re-attach never serves a stale pre-detach reading as current (docs/sensors.md). The last
   * sample this screen holds is therefore no longer being produced; keeping it would draw the
   * pre-detach heart rate as the *current* one and hide the "no sensor" line — the same
   * stale-as-current outcome `lib/sensorLive.applySensorLive` already handles for its own
   * last-sample fields on this arm (REQ-A1800). This screen read only the `vitals` arm, so a
   * detach left the pre-detach bpm drawn as the current one (REQ-A1804).
   *
   * Only `latest` is dropped. Today's step figure and the day rows are **history** (what was
   * observed), not the live feed, and the cumulative baseline is what makes the next sample's
   * delta correct — discarding it would fold a whole since-boot count into the next tick.
   */
  function clearLive(): void {
    latest = null;
    stopped = true;
  }

  /**
   * Fold one sample into the history and persist it. The history only advances when the
   * write landed — the screen must never show steps the store refused (REQ-A1454).
   */
  function applyVitals(v: SensorVitalsDatum): void {
    latest = v;
    // A fresh sample means the producer is attached again; the detach notice no longer holds.
    stopped = false;
    const prev: HealthTick = {
      state: history,
      counter: counter ?? { day: dayKey(Date.now()), raw: Number.NaN },
    };
    const next = applyVitalsTick(prev, v, Date.now());
    if (persistHealthTick(next)) {
      history = next.state;
      // Adopt the baseline only together with the history it belongs to: the counter is
      // written first, so a refused history write leaves the baseline on disk ahead of the
      // days. Keeping the *previous* tick in memory is what makes the next sample recompute
      // the lost delta and retry it (REQ-A1454) — adopting `next.counter` here would drop
      // those steps for good.
      counter = next.counter;
      writeError = null;
    } else {
      writeError = t("health.writeFailed");
    }
  }

  onMount(() => {
    let disposed = false;
    let stopFeed: (() => void) | null = null;
    void (async () => {
      const seed = await readHealthFeed();
      if (disposed) return;
      bridged = seed.bridged;
      if (seed.vitals) applyVitals(seed.vitals);
      const un = await subscribeSensorData((ev) => {
        if (ev.kind === "vitals" && ev.vitals) applyVitals(ev.vitals);
        else if (ev.kind === "cleared") clearLive();
      });
      if (disposed) {
        un?.();
        return;
      }
      stopFeed = un;
    })();
    // Drives the workout stopwatch; the reading itself arrives on the sensor feed.
    const timer = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    return () => {
      disposed = true;
      stopFeed?.();
      clearInterval(timer);
    };
  });

  const GROUP =
    "rounded-[14px] bg-white/70 p-4 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const MUTED = "text-[13px] text-neutral-500 dark:text-neutral-400";
  const LABEL = "text-[13px] font-medium text-neutral-600 dark:text-neutral-300";

  const todayKey = $derived(dayKey(nowMs));
  // The day's **measured** steps, or `null` for "no reading" — never the row's seed `0`. A
  // missing row is no reading, and so is a row minted by a *heart-rate-only* sample: the
  // counter is cumulative since boot, so the first sample of a day re-baselines without
  // folding a day row (`applyVitalsTick`), and if that sample also carried a bpm the row was
  // created for the pulse pair with `steps` left at `0`. Reading that `0` as a measurement
  // printed 「今日步数 0」 (and 「卡路里 0」) beside a strip that drew the same day as
  // 「无读数」 — one day, two answers, and the loud one was a count nobody took
  // (REQ-A1454; the heart-rate case is REQ-A1838 ∕ F-SH-909). `daySteps` owns that rule.
  //
  // The figure comes from `history` and from nothing else. It used to be gated on
  // `latest && latest.steps_total !== null` — whether the **live cumulative counter** was
  // readable — which is a different fact from "the app has a recorded total for today". A host
  // that answers `sensor_host_snapshot` without a `steps_total` (no counter on the platform, a
  // missing activity permission), or no host at all (the desktop shell over a history that
  // arrived by sync/restore), left that gate shut: the tile printed 「—」 while the seven-day
  // strip on the **same screen** drew today's bar straight from `history`, its `title` carrying
  // the very number — one day, two answers. That is the mirror of the pair REQ-A1454 fixed (a
  // row-less day shown as 0); the question the gate was standing in for is the one the line
  // below already asks, so it is gone. `noReading` still reports the absent live feed
  // separately, which is what it is about (REQ-A1555).
  const todaySteps = $derived(daySteps(history, todayKey));
  const heartRate = $derived(normalizeHeartRate(latest?.heart_rate_bpm));
  const calories = $derived(todaySteps === null ? null : stepCalories(todaySteps, profile.weightKg));
  /**
   * Which sentence the absent-reading banner may say, if any.
   *
   * This used to be one boolean — `latest === null || (both scalars null)` — and the banner
   * rendered the single "this device is not reporting health readings / connect a phone and
   * allow the permission" pair for every case it covered. That pair is true for a desktop shell
   * with no host, and **false** for the phone that is connected, has granted the permission and
   * is simply waiting for its first step (verified on device: the step counter registers and no
   * sample arrives until a step does). `healthNotice` keeps the causes apart (REQ-A1886).
   */
  const notice = $derived(healthNotice(latest, bridged, stopped));

  const running = $derived(activeWorkout(history));
  const elapsedMs = $derived(running ? Math.max(0, nowMs - running.startedAt) : 0);
  const totals = $derived(workoutTotals(history.workouts));

  // The last seven **local calendar** days, oldest first (the stepping and the day keys live
  // in `lib/health.ts::recentDays`: a fixed 24 h step duplicates the fall-back day and the
  // keyed `{#each}` below breaks on it).
  const week = $derived(recentDays(history, nowMs));
  const weekMax = $derived(Math.max(1, ...week.map((w) => w.steps)));
  /** The days the history actually has a row for — the only ones a total may count. */
  const weekRecorded = $derived(week.filter((w) => w.recorded).length);
  /** The sum of the days the history sampled — an unobserved day's structural `0` adds nothing. */
  const weekSteps = $derived(week.reduce((a, w) => a + w.steps, 0));
  /**
   * The figure the header may present as **the week's total**, or `null` unless every day of
   * the strip has a row.
   *
   * `RecentDay.steps` is a **structural** `0` for a day the history never sampled (see its
   * doc), so summing all seven folds those placeholders into a number the header then calls
   * the week's total — 「共 600 步」 for a week of which four days were never observed. The
   * strip already withholds those days (a baseline mark, no `title`), and `weekRecorded`
   * exists for exactly this question; the old guard only enforced it at the `=== 0` extreme.
   * A partial week is reported as what it is (`health.weekPartial`), never as the whole
   * (REQ-A1635).
   */
  const weekTotal = $derived(weekRecorded === week.length ? weekSteps : null);

  function weekdayLabel(dow: number): string {
    return t(`health.wd.${dow}`);
  }

  function formatDuration(ms: number): string {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = `${m}`.padStart(2, "0");
    const ss = `${s}`.padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  /**
   * One log row's time cell.
   *
   * A still-running workout carries `endedAt === 0` (the running marker), so the naive
   * `endedAt - startedAt` is a large **negative** count that `formatDuration` renders as
   * nonsense (`-6:-15`) — beside the running card that already says 「进行中」. A *closed* row is
   * clamped at zero for the same reason [`workoutTotals`] does it: a stored `endedAt` before
   * its start must not draw a negative elapsed. This is the row's copy of the rule the summary
   * line two rows up already applies (`ms += Math.max(0, w.endedAt - w.startedAt)`).
   */
  function rowDuration(w: Workout): string {
    if (w.endedAt === 0) return t("health.running");
    return formatDuration(Math.max(0, w.endedAt - w.startedAt));
  }

  function start(kind: WorkoutKind): void {
    const r = startWorkout(history, kind, Date.now());
    if (persistHealthState(r.state)) {
      history = r.state;
      writeError = null;
    } else {
      writeError = t("health.writeFailed");
    }
  }

  function stop(): void {
    const id = running?.id ?? null;
    const next = endWorkout(history, id, Date.now());
    if (persistHealthState(next)) {
      history = next;
      writeError = null;
    } else {
      writeError = t("health.writeFailed");
    }
  }

  function setWeight(raw: string): void {
    const n = Number.parseFloat(raw);
    const weightKg = Number.isFinite(n) && n > 0 ? n : null;
    if (saveHealthProfile(weightKg)) {
      profile = { weightKg };
      writeError = null;
    } else {
      writeError = t("health.writeFailed");
    }
  }

  const kindKey = (k: WorkoutKind): string => `health.kind.${k}`;
</script>

<div class="flex h-full flex-col gap-3 overflow-y-auto p-4">
  <StoreErrorBar message={writeError ?? ""} />

  <header class="flex items-end justify-between">
    <h1 class="text-[22px] font-semibold text-neutral-900 dark:text-neutral-50">{t("app.health")}</h1>
    <span class={MUTED}>{todayKey}</span>
  </header>

  {#if notice !== "none"}
    <p class="rounded-[11px] bg-amber-50 px-4 py-3 text-[13px] text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/20" role="status">
      {notice === "unbridged" ? t("health.noSensor") : notice === "stopped" ? t("health.sensorStopped") : t("health.noReadingYet")}
      {notice === "unbridged" ? t("health.noSensorHint") : notice === "stopped" ? t("health.sensorStoppedHint") : t("health.noReadingYetHint")}
    </p>
  {/if}

  <!-- Today's readings. `—` whenever the device reported nothing. -->
  <section class="grid grid-cols-3 gap-3">
    <div class={GROUP}>
      <div class={LABEL}>{t("health.stepsToday")}</div>
      <div class="mt-1 text-[26px] font-semibold tabular-nums text-neutral-900 dark:text-neutral-50">
        {todaySteps === null ? "—" : todaySteps}
      </div>
    </div>
    <div class={GROUP}>
      <div class={LABEL}>{t("health.heartRate")}</div>
      <div class="mt-1 text-[26px] font-semibold tabular-nums text-neutral-900 dark:text-neutral-50">
        {heartRate === null ? "—" : heartRate}
      </div>
      <div class={MUTED}>{t("health.bpm")}</div>
    </div>
    <div class={GROUP}>
      <div class={LABEL}>{t("health.calories")}</div>
      <div class="mt-1 text-[26px] font-semibold tabular-nums text-neutral-900 dark:text-neutral-50">
        {calories === null ? "—" : calories}
      </div>
      <!-- Only when today's step figure exists is the missing weight the reason for the `—`
           (REQ-A1462): with no daily figure (no reading, or a reading with no row folded yet —
           REQ-A1454) the same sentence would tell the user to record a weight they may already
           have recorded, and a figure would still not appear. -->
      {#if calories === null && todaySteps !== null}
        <div class={MUTED}>{t("health.caloriesNoWeight")}</div>
      {/if}
    </div>
  </section>

  <!-- Last seven days. -->
  <section class={GROUP}>
    <div class="flex items-baseline justify-between">
      <div class={LABEL}>{t("health.week")}</div>
      <!-- A week is only summarised as a total when every day of the strip has a row: the
           structural `0` of an unobserved day (`RecentDay.recorded`) would otherwise be summed
           in and the result presented as the week's total (REQ-A1635). With no day recorded
           there is nothing to report at all; with some, the figure is named for what it covers. -->
      <div class={MUTED}>
        {#if weekRecorded === 0}
          {t("health.noReading")}
        {:else if weekTotal === null}
          {t("health.weekPartial", { n: weekSteps, d: weekRecorded })}
        {:else}
          {t("health.weekTotal", { n: weekTotal })}
        {/if}
      </div>
    </div>
    <div class="mt-3 flex h-28 items-end justify-between gap-2" role="img" aria-label={t("health.week")}>
      {#each week as w (w.day)}
        <div class="flex flex-1 flex-col items-center gap-1">
          <div class="flex h-20 w-full items-end">
            {#if w.recorded}
              <div
                class="w-full rounded-t-[4px] bg-rose-400/80 dark:bg-rose-400/70"
                style="height: {Math.round((w.steps / weekMax) * 100)}%"
                title={`${w.day}: ${w.steps}`}
              ></div>
            {:else}
              <!-- No row for this day: draw a baseline mark, not a zero-height bar, and never
                   a `title` asserting a step count (REQ-A1454). -->
              <div
                class="h-[2px] w-full rounded-full bg-black/10 dark:bg-white/15"
                title={`${w.day} · ${t("health.noReading")}`}
              ></div>
            {/if}
          </div>
          <span class="text-[11px] text-neutral-500 dark:text-neutral-400">{weekdayLabel(w.dow)}</span>
        </div>
      {/each}
    </div>
  </section>

  <!-- Workouts. -->
  <section class={GROUP}>
    <div class="flex items-center justify-between">
      <div class={LABEL}>{t("health.workouts")}</div>
      <div class={MUTED}>
        {t("health.totals", { n: totals.count, time: formatDuration(totals.ms), steps: totals.steps })}
      </div>
    </div>

    {#if running}
      <div class="mt-3 flex items-center justify-between rounded-[11px] bg-rose-50 px-3 py-2 dark:bg-rose-500/10">
        <div>
          <div class="text-[14px] font-medium text-rose-700 dark:text-rose-300">
            {t(kindKey(running.kind))} · {t("health.running")}
          </div>
          <div class="text-[13px] tabular-nums text-rose-600/80 dark:text-rose-300/80">
            {formatDuration(elapsedMs)} · {t("health.stepsUnit", { n: running.steps })}
          </div>
        </div>
        <button
          type="button"
          class="rounded-full bg-rose-600 px-4 py-1.5 text-[13px] font-medium text-white hover:bg-rose-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
          onclick={stop}
        >
          {t("health.stop")}
        </button>
      </div>
    {:else}
      <div class="mt-3 flex gap-2">
        {#each WORKOUT_KINDS as k (k)}
          <button
            type="button"
            class="flex-1 rounded-[11px] bg-neutral-100 px-3 py-2 text-[13px] font-medium text-neutral-700 hover:bg-neutral-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/20"
            onclick={() => start(k)}
          >
            {t(kindKey(k))}
          </button>
        {/each}
      </div>
    {/if}

    {#if history.workouts.length === 0}
      <p class="mt-3 {MUTED}">{t("health.noWorkouts")}</p>
    {:else}
      <ul class="mt-3 flex flex-col divide-y divide-black/5 dark:divide-white/10">
        {#each [...history.workouts].reverse() as w (w.id)}
          <li class="flex items-center justify-between py-2 text-[13px]">
            <span class="text-neutral-800 dark:text-neutral-100">{t(kindKey(w.kind))}</span>
            <span class="tabular-nums text-neutral-500 dark:text-neutral-400">
              {rowDuration(w)} · {t("health.stepsUnit", { n: w.steps })}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Body weight: the one input the calorie estimate needs. -->
  <section class={GROUP}>
    <label class="flex items-center justify-between gap-3" for="health-weight">
      <span class={LABEL}>{t("health.weight")}</span>
      <span class="flex items-center gap-2">
        <input
          id="health-weight"
          type="number"
          min="1"
          step="0.1"
          inputmode="decimal"
          value={profile.weightKg ?? ""}
          placeholder="—"
          class="w-24 rounded-[9px] border border-black/10 bg-white px-2 py-1 text-right text-[14px] tabular-nums text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-rose-500 dark:border-white/15 dark:bg-white/10 dark:text-neutral-50"
          onchange={(e) => setWeight((e.currentTarget as HTMLInputElement).value)}
        />
        <span class={MUTED}>{t("health.kg")}</span>
      </span>
    </label>
  </section>

  <p class={MUTED}>{t("health.historyHint", { n: history.days.length })}</p>
</div>

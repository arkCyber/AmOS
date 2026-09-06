<script lang="ts">
  // ClockApp.svelte — Svelte 5 (runes) port of the React `Clock` in src/apps.tsx
  // (world clock / stopwatch / countdown timer / alarms). All logic reuses the
  // pure lib/time.ts reducers + helpers. Timers tick from ONE interval callback
  // (alarm/timer on the 1s clock tick, stopwatch on its own 50ms tick) so no
  // $effect writes to itself. Store keys: amos.worldclock, amos.alarms.
  import {
    WORLD_CITY_PRESETS,
    addWorldCity,
    alarmInit,
    alarmsReducer,
    defaultWorldCities,
    fastestLap,
    fmtCountdown,
    fmtStopwatch,
    lapDeltas,
    normalizeAlarms,
    normalizeWorldCities,
    removeWorldCity,
    ringingAlarms,
    stopwatchInit,
    stopwatchReducer,
    timerInit,
    timerReducer,
    zoneClock,
  } from "../lib/time";
  import type { Alarm, WorldCity } from "../lib/time";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { locale, t } from "./locale.svelte";

  const p2 = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const fmtDate = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const fmtHm = (h: number, m: number) => `${p2(h)}:${p2(m)}`;
  const DOW = $derived(
    locale() === "zh" ? ["日", "一", "二", "三", "四", "五", "六"] : ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
  );

  // --- shared tick (1 Hz) drives the clock, countdown, and alarm latch ---
  let now = $state(new Date());
  // --- tab ---
  let tab = $state<"world" | "stopwatch" | "timer" | "alarm">("world");
  // --- world clock (persisted) ---
  const initWc = normalizeWorldCities(
    readStoreValue<unknown>("amos.worldclock", undefined),
    defaultWorldCities(),
  );
  let wc = $state<WorldCity[]>(initWc);
  let wcEdit = $state(false);
  // --- stopwatch ---
  let sw = $state(stopwatchInit());
  let laps = $state<number[]>([]);
  // --- countdown timer ---
  let tm = $state(timerInit());
  const timerDone = $derived(tm.totalMs > 0 && tm.remainingMs === 0 && !tm.running);
  // --- alarms (pure reducer, persisted) ---
  const initAl = alarmInit(normalizeAlarms(readStoreValue<unknown>("amos.alarms", [])));
  let al = $state(initAl);
  let alH = $state("8");
  let alM = $state("0");
  let alLabel = $state("");
  let alRepeat = $state<number[]>([]);
  const ringAlarms = $derived(ringingAlarms(al));

  $effect(() => {
    writeStoreValue("amos.worldclock", wc);
  });
  $effect(() => {
    writeStoreValue("amos.alarms", al.list);
  });

  // ONE 1 Hz interval: advance the clock + latch alarms + tick the running timer.
  $effect(() => {
    const id = setInterval(() => {
      const d = new Date();
      now = d;
      al = alarmsReducer(al, { type: "tick", now: d });
      if (tm.running) tm = timerReducer(tm, { type: "tick", now: d.getTime() });
    }, 1000);
    return () => clearInterval(id);
  });

  // Stopwatch ticks at 50ms only while running (started/stopped by $effect on running).
  $effect(() => {
    if (!sw.running) return;
    const id = setInterval(() => {
      sw = stopwatchReducer(sw, { type: "tick", now: Date.now() });
    }, 50);
    return () => clearInterval(id);
  });

  const swToggle = () => {
    sw = stopwatchReducer(sw, { type: sw.running ? "pause" : "start", now: Date.now() });
  };
  const doLap = () => {
    if (laps.length < 50) laps = [...laps, sw.elapsedMs];
  };
  const resetSw = () => {
    laps = [];
    sw = stopwatchReducer(sw, { type: "reset" });
  };
  const deltas = $derived(lapDeltas(laps));
  const fastest = $derived(fastestLap(laps));

  const setTimer = (min: number) => {
    tm = timerReducer(tm, { type: "set", totalMs: min * 60000 });
  };
  const tmToggle = () => {
    tm = timerReducer(tm, { type: tm.running ? "pause" : "start", now: Date.now() });
  };
  const tmReset = () => {
    tm = timerReducer(tm, { type: "reset" });
  };

  const toggleDay = (day: number) =>
    (alRepeat = alRepeat.includes(day)
      ? alRepeat.filter((d) => d !== day)
      : [...alRepeat, day].sort());
  const addAlarm = () => {
    const h = Number.parseInt(alH, 10);
    const m = Number.parseInt(alM, 10);
    al = alarmsReducer(al, {
      type: "add",
      hour: Number.isNaN(h) ? 0 : h,
      min: Number.isNaN(m) ? 0 : m,
      label: alLabel,
      repeat: alRepeat,
    });
    alH = "8";
    alM = "0";
    alLabel = "";
    alRepeat = [];
  };
  const alarmDispatch = (a: Parameters<typeof alarmsReducer>[1]) => {
    al = alarmsReducer(al, a);
  };
  const toggleEnabled = (a: Alarm) => alarmDispatch({ type: "toggle", id: a.id });
  const toggleRepeatDay = (day: number) => toggleDay(day);
  const addMissingCity = () => {
    const missing = WORLD_CITY_PRESETS.find((c) => !wc.some((x) => x.zone === c.zone));
    if (missing) wc = addWorldCity(wc, missing);
  };
  const removeCityAt = (zone: string) => {
    wc = removeWorldCity(wc, zone);
  };

  // Local helpers (React ui.tsx string fns, inlined to avoid dragging React in).
  const seg = (active: boolean) =>
    `px-3 py-1.5 text-xs rounded-full transition ${active ? "bg-accent text-white" : "text-neutral-500 dark:text-neutral-300"}`;
  const round = (bg: string) => `h-12 w-12 rounded-full text-lg text-white ${bg}`;
  const smallBtn = "rounded-full px-3 py-1 text-xs transition active:scale-95 bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100";
  const dangerBtn = "rounded-full px-3 py-1 text-xs transition active:scale-95 bg-danger text-white";
  const neutralBtn = smallBtn;
</script>

<div class="p-6">
  <!-- Tabs (mini Segmented) -->
  <div class="flex justify-center gap-1 pt-1 pb-3" role="tablist" aria-label="clock-tabs">
    <button role="tab" aria-selected={tab === "world"} onclick={() => (tab = "world")} class={seg(tab === "world")}>{t("clock.world")}</button>
    <button role="tab" aria-selected={tab === "stopwatch"} onclick={() => (tab = "stopwatch")} class={seg(tab === "stopwatch")}>{t("clock.stopwatch")}</button>
    <button role="tab" aria-selected={tab === "timer"} onclick={() => (tab = "timer")} class={seg(tab === "timer")}>{t("clock.timer")}</button>
    <button role="tab" aria-selected={tab === "alarm"} onclick={() => (tab = "alarm")} class={seg(tab === "alarm")}>{t("clock.alarm")}</button>
  </div>

  {#if tab === "world"}
    <div>
      <div class="text-center">
        <div class="text-5xl font-thin tabular-nums">{fmt(now)}</div>
        <div class="mt-1 text-sm opacity-60">{fmtDate(now)}</div>
        <div class="mt-1 text-xs uppercase tracking-wide opacity-50">{t("clock.now")}</div>
      </div>
      <div class="mt-6 flex items-center justify-between">
        <span class="text-xs uppercase tracking-wide opacity-50">{t("clock.world")}</span>
        <div class="flex items-center gap-2">
          {#if WORLD_CITY_PRESETS.find((c) => !wc.some((x) => x.zone === c.zone))}
            <button onclick={addMissingCity} class="rounded-full bg-neutral-200 px-2 py-0.5 text-xs dark:bg-neutral-700">+ {t("clock.addCity")}</button>
          {/if}
          <button onclick={() => (wcEdit = !wcEdit)} class="rounded-full bg-neutral-200 px-2 py-0.5 text-xs dark:bg-neutral-700">
            {wcEdit ? t("common.done") : t("clock.edit")}
          </button>
        </div>
      </div>
      <div class="mt-2 space-y-2">
        {#each wc as c (c.zone)}
          <div class="flex items-center justify-between rounded-xl bg-neutral-200/50 px-3 py-2 text-sm dark:bg-neutral-800/50">
            <span class="opacity-70">{t(c.labelKey)}</span>
            <div class="flex items-center gap-2">
              {#if wcEdit}
                <button onclick={() => removeCityAt(c.zone)} aria-label="remove-city" class="rounded-full bg-neutral-300 px-2 text-xs text-danger dark:bg-neutral-700">✕</button>
              {/if}
              <span class="tabular-nums">{zoneClock(now, c.zone)}</span>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}


  {#if tab === "timer"}
    <div class="mt-6 rounded-xl bg-neutral-200/50 p-4 text-center dark:bg-neutral-800/50">
      <div class="text-xs uppercase tracking-wide opacity-50">{t("clock.timer")}</div>
      <div class="mt-1 text-4xl font-thin tabular-nums {timerDone ? 'text-danger' : ''}">{fmtCountdown(tm.remainingMs)}</div>
      {#if timerDone}
        <div class="mt-1 text-xs text-danger">{t("clock.timerDone")}</div>
      {/if}
      <div class="mt-2 flex items-center justify-center gap-2">
        {#each [1, 3, 5] as m (m)}
          <button onclick={() => setTimer(m)} disabled={tm.running} class={neutralBtn}>{m} {t("clock.min")}</button>
        {/each}
      </div>
      <div class="mt-3 flex items-center justify-center gap-4">
        <button onclick={tmToggle} disabled={tm.totalMs === 0 && !tm.running} aria-label={t("clock.timer")} class={round(tm.running ? "bg-danger" : "bg-green-500")}>
          {tm.running ? "⏸" : "▶"}
        </button>
        <button onclick={tmReset} disabled={tm.totalMs === 0} aria-label="reset" class="h-12 w-12 rounded-full bg-neutral-300 text-lg disabled:opacity-30 dark:bg-neutral-700">↺</button>
      </div>
    </div>
  {/if}


  {#if tab === "alarm"}
    <div>
      {#if ringAlarms.length > 0}
        <div class="mt-4 space-y-2">
          {#each ringAlarms as ra (ra.id)}
            <div class="flex items-center justify-between gap-2 rounded-xl bg-danger/15 px-3 py-2 text-sm">
              <span>{(ra.tone ?? "🔔")} {fmtHm(ra.hour, ra.min)}{ra.label ? ` · ${ra.label}` : ""}</span>
              <div class="flex shrink-0 gap-1.5">
                <button onclick={() => alarmDispatch({ type: "snooze", id: ra.id, now })} class={neutralBtn}>{t("clock.snooze")}</button>
                <button onclick={() => alarmDispatch({ type: "dismiss", id: ra.id })} class={dangerBtn}>{t("clock.dismissAlarm")}</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <div class="mt-6 rounded-xl bg-neutral-200/50 p-4 dark:bg-neutral-800/50">
        <div class="flex items-center justify-between">
          <span class="text-xs uppercase tracking-wide opacity-50">{t("clock.alarm")}</span>
          <span class="text-xs opacity-50">{t("clock.alarmCount", { n: al.list.length })}</span>
        </div>
        {#if al.list.length === 0}
          <p class="py-2 text-center text-xs opacity-50">{t("clock.alarmEmpty")}</p>
        {:else}
          <div class="mt-2 space-y-1.5">
            {#each al.list as a (a.id)}
              <div class="flex items-center justify-between gap-2 text-sm">
                <div class="min-w-0">
                  <span class="tabular-nums font-semibold {a.enabled ? '' : 'opacity-40'}">{fmtHm(a.hour, a.min)}</span>
                  {#if a.label}
                    <span class="ml-2 text-xs {a.enabled ? 'opacity-60' : 'opacity-40'}">{a.label}</span>
                  {/if}
                  {#if a.repeat && a.repeat.length > 0}
                    <span class="block text-xs {a.enabled ? 'opacity-50' : 'opacity-40'}">
                      {t("clock.repeat")}: {a.repeat.map((d) => DOW[d] ?? "").join(" · ")}
                    </span>
                  {/if}
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <button onclick={() => alarmDispatch({ type: "tone", id: a.id })} aria-label={t("clock.tone")} title={t("clock.tone")} class="rounded-full px-1 text-base leading-none">{a.tone ?? "🔔"}</button>
                  <button onclick={() => toggleEnabled(a)} aria-pressed={a.enabled} title={t("clock.alarmToggle")}
                    class={"relative h-6 w-10 rounded-full transition " + (a.enabled ? "bg-accent" : "bg-neutral-400")}>
                    <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all {a.enabled ? 'left-[1.125rem]' : 'left-0.5'}"></span>
                  </button>
                  <button onclick={() => alarmDispatch({ type: "remove", id: a.id })} aria-label={t("clock.alarmRemove")} class="text-danger">✕</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        <div class="mt-3 flex items-center gap-1">
          <span class="mr-1 text-xs opacity-50">{t("clock.repeat")}</span>
          {#each DOW as d, day}
            <button onclick={() => toggleRepeatDay(day)} aria-pressed={alRepeat.includes(day)}
              class={"h-6 w-6 rounded-full text-xs " + (alRepeat.includes(day) ? "bg-accent text-white" : "bg-neutral-300 dark:bg-neutral-700")}>{d}</button>
          {/each}
        </div>
        <div class="mt-3 flex items-end gap-1.5">
          <input bind:value={alH} inputmode="numeric" aria-label={t("clock.hour")} class="w-12 rounded-lg bg-white/70 px-2 py-1 text-center text-sm outline-none dark:bg-neutral-900/70" />
          <span class="pb-1 text-sm">:</span>
          <input bind:value={alM} inputmode="numeric" aria-label={t("clock.minute")} class="w-12 rounded-lg bg-white/70 px-2 py-1 text-center text-sm outline-none dark:bg-neutral-900/70" />
          <input bind:value={alLabel} placeholder={t("clock.alarmLabel")} aria-label={t("clock.alarmLabel")} class="min-w-0 flex-1 rounded-lg bg-white/70 px-2 py-1 text-sm outline-none dark:bg-neutral-900/70" />
          <button onclick={addAlarm} class="shrink-0 rounded-full bg-accent px-3 py-1.5 text-sm text-white active:scale-95">{t("clock.addAlarm")}</button>
        </div>
      </div>
    </div>
  {/if}


  {#if tab === "stopwatch"}
    <div class="mt-6 rounded-xl bg-neutral-200/50 p-4 text-center dark:bg-neutral-800/50">
      <div class="text-xs uppercase tracking-wide opacity-50">{t("clock.stopwatch")}</div>
      <div class="mt-1 text-4xl font-thin tabular-nums">{fmtStopwatch(sw.elapsedMs)}</div>
      <div class="mt-3 flex items-center justify-center gap-4">
        <button onclick={swToggle} aria-label={t("clock.stopwatch")} class={round(sw.running ? "bg-danger" : "bg-green-500")}>{sw.running ? "⏸" : "▶"}</button>
        <button onclick={doLap} disabled={!sw.running} aria-label="lap" class="h-10 rounded-full bg-neutral-300 px-3 text-sm disabled:opacity-30 dark:bg-neutral-700">{t("clock.lap")}</button>
        <button onclick={resetSw} disabled={sw.elapsedMs === 0 && !sw.running} aria-label="reset" class="h-12 w-12 rounded-full bg-neutral-300 text-lg disabled:opacity-30 dark:bg-neutral-700">↺</button>
      </div>
      {#if laps.length > 0}
        <div class="mt-3 space-y-1 border-t pt-2 text-sm tabular-nums">
          {#each laps as l, i (i)}
            <div class={"flex justify-between " + (i === fastest ? "font-semibold text-accent" : "opacity-70")}>
              <span>{t("clock.lapCount", { n: String(i + 1) })}{i === fastest ? " ★" : ""}</span>
              <span class="tabular-nums">{fmtStopwatch(l)} <span class="opacity-50">(+{fmtStopwatch(deltas[i] ?? 0)})</span></span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>


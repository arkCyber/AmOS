<script lang="ts">
  // ClockApp.svelte — Svelte 5 (runes) implementation of the clock app
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
    slowestLap,
    moveWorldCity,
    alarmsByTime,
    risingEdge,
    normalizeAlarms,
    normalizeWorldCities,
    removeWorldCity,
    ringingAlarms,
    stopwatchInit,
    stopwatchReducer,
    timerReducer,
    zoneClock,
    fmtOffsetMinutes,
    systemTimeZone,
    zoneDiff,
    ALARM_TONES,
    DEFAULT_SNOOZE_MIN,
    WEEKDAYS,
    WEEKENDS,
  } from "../lib/time";
  import type { Alarm, WorldCity } from "../lib/time";
  import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { iconSvg } from "../lib/sysIcons";
  import { locale, t } from "./locale.svelte";
  import { onDestroy, onMount } from "svelte";
  import { startAlarmRing, stopAlarmRing, previewAlarmTone, setRingtoneFilesEnabled, activeRingtone } from "../lib/ringtonePlayer";
  import { restoreTimerState, persistFromTimer } from "../lib/timerStore";
  import { CITY_CATALOG, resolveCity, searchCities } from "../lib/cityIndex";
  import { playNotifyTone } from "../lib/notifyTone";

  const p2 = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const fmtDate = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const fmtHm = (h: number, m: number) => `${p2(h)}:${p2(m)}`;
  const DOW = $derived(
    locale() === "zh" ? ["日", "一", "二", "三", "四", "五", "六"] : ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
  );

  /** The device's own timezone — base for every city's "ahead/behind + day". */
  const localZone = systemTimeZone();
  /** iOS-style relative line for a city: e.g. "明天 · 快 16 小时" / "同时". */
  const zoneSub = (c: WorldCity): string => {
    const d = zoneDiff(localZone, c.zone, now);
    if (!d) return "";
    const parts: string[] = [];
    if (d.dayDelta !== 0) {
      parts.push(d.dayDelta > 0 ? t("clock.dayTomorrow") : t("clock.dayYesterday"));
    }
    const mag = fmtOffsetMinutes(d.aheadMinutes);
    if (d.aheadMinutes === 0) parts.push(t("clock.zoneSame"));
    else parts.push(d.aheadMinutes > 0 ? t("clock.zoneAhead", { n: mag }) : t("clock.zoneBehind", { n: mag }));
    return parts.join(" · ");
  };

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
  /** Zone selected in the world-clock picker (defaults to the first addable city). */
  let wcPick = $state("");
  /** A cityIndex catalog entry as a bilingual `WorldCity` (no i18n key needed). */
  const wcCityOf = (zone: string): WorldCity | null => {
    const ce = resolveCity(zone);
    return ce ? { zone: ce.zone, labelKey: "", name: { zh: ce.zh, en: ce.en } } : null;
  };
  /** Choices offered by the picker: remaining presets + larger cityIndex catalog (dedup). */
  function wcAvail(): WorldCity[] {
    const added = new Set(wc.map((x) => x.zone));
    const seen = new Set<string>();
    const out: WorldCity[] = [];
    for (const p of WORLD_CITY_PRESETS) {
      if (added.has(p.zone) || seen.has(p.zone)) continue;
      seen.add(p.zone);
      out.push(p);
    }
    for (const ce of CITY_CATALOG) {
      if (added.has(ce.zone) || seen.has(ce.zone)) continue;
      seen.add(ce.zone);
      out.push({ zone: ce.zone, labelKey: "", name: { zh: ce.zh, en: ce.en } });
    }
    return out;
  }
  /** Display label for a world city (bilingual name when present, else i18n key). */
  const wcLabel = (c: WorldCity): string =>
    c.name ? (locale() === "zh" ? c.name.zh : c.name.en) : t(c.labelKey);
  /** Free-text search narrowing the add-city list. */ 
  let wcSearch = $state("");
  function wcAvailFiltered(): WorldCity[] {
    const q = wcSearch.trim();
    if (!q) return wcAvail();
    const added = new Set(wc.map((x) => x.zone));
    const seen = new Set<string>();
    const out: WorldCity[] = [];
    // Presets carry i18n label keys (they may have no catalog entry), so they are
    // matched here; the CATALOG is searched by the DOMAIN — `lib/cityIndex.searchCities`
    // is locale-aware on the display name *and* the IANA zone, excludes the zones we
    // offer above, and bounds the result.
    const ql = q.toLowerCase();
    for (const p of WORLD_CITY_PRESETS) {
      if (added.has(p.zone) || seen.has(p.zone)) continue;
      if (!wcLabel(p).toLowerCase().includes(ql) && !p.zone.toLowerCase().includes(ql)) continue;
      seen.add(p.zone);
      out.push(p);
    }
    for (const ce of searchCities(q, locale(), new Set([...added, ...seen]))) {
      out.push({ zone: ce.zone, labelKey: "", name: { zh: ce.zh, en: ce.en } });
    }
    return out;
  }
  // Keep the selection valid as the list changes (added / removed / capped).
  $effect(() => {
    if (!wcAvail().some((c) => c.zone === wcPick)) {
      wcPick = wcAvail()[0]?.zone ?? "";
    }
  });
  // When a search narrows the options away from the current pick, jump to the
  // first match so + always adds what the user is looking at.
  $effect(() => {
    const filtered = wcAvailFiltered();
    if (filtered.length > 0 && !filtered.some((c) => c.zone === wcPick)) {
      wcPick = filtered[0]!.zone;
    }
  });
  // --- stopwatch ---
  let sw = $state(stopwatchInit());
  let laps = $state<number[]>([]);
  // --- countdown timer (persisted so an OS notifier can finish it when the Clock
  // app is closed) ---
  let tm = $state(restoreTimerState(Date.now()));
  // Persist every in-memory timer change (start/pause/set/reset/done) so the
  // shell-level notifier (lib/timerNotify.ts) can take over when this screen closes.
  $effect(() => {
    persistFromTimer(tm);
  });
  const timerDone = $derived(tm.totalMs > 0 && tm.remainingMs === 0 && !tm.running);
  // --- alarms (pure reducer, persisted) ---
  // Seed alarms from the store, PRESERVING any persisted `ringing:true` (e.g. one
  // the OS notifier or a previous session left ringing) — `normalizeAlarms`
  // deliberately strips ringing for corruption-guarding, so re-apply it here.
  const rawAl = readStoreValue<unknown>("amos.alarms", []);
  const ringingIds = new Set<string>();
  if (Array.isArray(rawAl)) {
    for (const o of rawAl) {
      if (o && typeof o === "object" && (o as { ringing?: unknown }).ringing === true) {
        const id = (o as { id?: unknown }).id;
        if (typeof id === "string" && id) ringingIds.add(id);
      }
    }
  }
  const initAl = alarmInit(
    normalizeAlarms(rawAl).map((a) => (ringingIds.has(a.id) ? { ...a, ringing: true } : a)),
  );
  let al = $state(initAl);
  // A rejected `amos.alarms` write (full/unavailable storage): say so.
  let storeErr = $state("");
  let alH = $state("8");
  let alM = $state("0");
  let alLabel = $state("");
  let alRepeat = $state<number[]>([]);
  /** Ringtone token chosen in the editor (defaults to the first tone). */
  let alTone = $state("🔔");
  /** Snooze length (minutes) chosen in the editor (defaults to 5). */
  let alSnoozeMin = $state(5);
  const SNOOZE_CHOICES = [5, 9, 15] as const;
  /** When set, the alarm form edits this existing alarm instead of adding a new one. */
  let editingId = $state<string | null>(null);
  const ringAlarms = $derived(ringingAlarms(al));
  /** Alarm rows shown earliest-first, as iOS does (store order untouched). */
  const sortedAlarms = $derived(alarmsByTime(al.list));
  // Audible ring: start looping the first ringing alarm's tone once a ring
  // begins; stop when nothing rings. Tracked so the 1 Hz tick doesn't restart it.
  let ringStarted = false;
  /** The ringtone layer reported it could not start any audio (no AudioContext /
   *  autoplay blocked) — the banner says so instead of implying a sound. */
  let ringSilent = $state(false);
  $effect(() => {
    const ringingNow = ringAlarms.length > 0;
    if (ringingNow && !ringStarted) {
      ringStarted = true;
      const first = ringAlarms[0];
      if (first) {
        startAlarmRing(first.tone);
        // `activeRingtone()` is the truth about whether audio actually started
        // (`null` = no AudioContext / autoplay blocked). The banner must never
        // claim a sound that isn't playing.
        ringSilent = activeRingtone() === null;
      }
    } else if (!ringingNow && ringStarted) {
      ringStarted = false;
      stopAlarmRing();
      ringSilent = false;
    }
  });
  // Timer "time's up": on the rising edge (idle → done) play a chime once. Uses a
  // plain closure flag (not state) so it doesn't re-fire on every re-render.
  let timerDonePrev = false;
  $effect(() => {
    const done = timerDone;
    if (risingEdge(timerDonePrev, done)) {
      timerDonePrev = true;
      playNotifyTone();
    } else if (!done) {
      timerDonePrev = false;
    }
  });
  // Leaving the screen (or unmount) while it's still ringing → stop the loop.
  onDestroy(() => stopAlarmRing());
  // In a real browser/WebView the bundled ringtone files are served — prefer them
  // over synthesis. (Headless/happy-dom has no usable Audio, so this stays off.)
  onMount(() => {
    if (typeof Audio === "function") setRingtoneFilesEnabled(true);
  });

  $effect(() => {
    writeStoreValue("amos.worldclock", wc);
  });
  $effect(() => {
    // The alarm list is **content the user set**, so a rejected write is reported
    // (the reducer state still shows the alarms; that they will not survive a reload
    // is exactly what the user must be told).
    storeErr = writeStoreValueChecked("amos.alarms", al.list) ? "" : t("common.storeWriteFailed");
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
  const slowest = $derived(slowestLap(laps));

  // --- countdown timer: armed duration lives in tArmMin/tArmSec so the quick
  // chips and the custom "mm:ss" inputs share one source of truth and the armed
  // value is visible in the inputs even before the timer starts (iOS parity:
  // timers accept arbitrary lengths, not just the quick presets). ---
  let tArmMin = $state(0);
  let tArmSec = $state(0);
  /** Clamp + (re)arm the countdown to `min` minutes + `sec` seconds (≤ 24 h). */
  const armTimer = (min: number, sec: number) => {
    const mm = Math.min(1439, Math.max(0, Math.floor(Number.isFinite(min) ? min : 0)));
    const ss = Math.min(59, Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0)));
    tArmMin = mm;
    tArmSec = ss;
    tm = timerReducer(tm, { type: "set", totalMs: mm * 60000 + ss * 1000 });
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
  const setRepeat = (days: number[]) => {
    alRepeat = [...days].sort((a, b) => a - b);
  };

  // Time step keys — wrap within valid ranges (hour 0-23, minute 0-59).
  const toNum = (s: string, fb: number) => {
    const x = Number.parseInt(s, 10);
    return Number.isFinite(x) && x >= 0 ? x : fb;
  };
  const stepAlHour = (delta: number) => {
    const h = ((toNum(alH, 0) + delta) % 24 + 24) % 24;
    alH = p2(h);
  };
  const stepAlMin = (delta: number) => {
    const m = ((toNum(alM, 0) + delta) % 60 + 60) % 60;
    alM = p2(m);
  };

  const resetAlarmForm = () => {
    alH = "8";
    alM = "0";
    alLabel = "";
    alRepeat = [];
    alTone = "🔔";
    alSnoozeMin = DEFAULT_SNOOZE_MIN;
    editingId = null;
  };
  /** Load an alarm into the editor form (iOS parity: tapping an alarm edits it). */
  const beginEditAlarm = (a: Alarm) => {
    editingId = a.id;
    alH = p2(a.hour);
    alM = p2(a.min);
    alLabel = a.label;
    alRepeat = a.repeat ? [...a.repeat] : [];
    alTone = a.tone ?? "🔔";
    alSnoozeMin = a.snoozeMin ?? DEFAULT_SNOOZE_MIN;
  };
  const submitAlarm = () => {
    const h = Number.parseInt(alH, 10);
    const m = Number.parseInt(alM, 10);
    const hour = Number.isNaN(h) ? 0 : h;
    const min = Number.isNaN(m) ? 0 : m;
    if (editingId) {
      al = alarmsReducer(al, {
        type: "update",
        id: editingId,
        hour,
        min,
        label: alLabel,
        repeat: alRepeat,
        tone: alTone,
        snoozeMin: alSnoozeMin,
      });
    } else {
      al = alarmsReducer(al, {
        type: "add",
        hour,
        min,
        label: alLabel,
        repeat: alRepeat,
        tone: alTone,
        snoozeMin: alSnoozeMin,
      });
    }
    resetAlarmForm();
  };
  const alarmDispatch = (a: Parameters<typeof alarmsReducer>[1]) => {
    al = alarmsReducer(al, a);
  };
  const toggleEnabled = (a: Alarm) => alarmDispatch({ type: "toggle", id: a.id });
  const toggleRepeatDay = (day: number) => toggleDay(day);
  const addPickedCity = () => {
    const preset = WORLD_CITY_PRESETS.find((c) => c.zone === wcPick);
    const city = preset ?? wcCityOf(wcPick);
    if (city) wc = addWorldCity(wc, city);
  };
  const removeCityAt = (zone: string) => {
    wc = removeWorldCity(wc, zone);
  };
  const moveCity = (zone: string, dir: -1 | 1) => {
    const idx = wc.findIndex((c) => c.zone === zone);
    if (idx < 0) return;
    wc = moveWorldCity(wc, idx, idx + dir);
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
  <StoreErrorBar message={storeErr} />
  <!-- Tabs (mini Segmented) -->
  <div class="flex justify-center gap-1 pt-1 pb-3" role="tablist" aria-label="clock-tabs">
    <button role="tab" aria-selected={tab === "world"} onclick={() => (tab = "world")} class={seg(tab === "world")}>{t("clock.world")}</button>
    <button role="tab" aria-selected={tab === "stopwatch"} onclick={() => (tab = "stopwatch")} class={seg(tab === "stopwatch")}>{t("clock.stopwatch")}</button>
    <button role="tab" aria-selected={tab === "timer"} onclick={() => (tab = "timer")} class={seg(tab === "timer")}>{t("clock.timer")}</button>
    <button role="tab" aria-selected={tab === "alarm"} onclick={() => (tab = "alarm")} class={seg(tab === "alarm")}>{t("clock.alarm")}</button>
  </div>

  {#if ringAlarms.length > 0}
    <div class="alarm-ring" data-testid="alarm-ring" role="alert" aria-live="assertive">
      {#each ringAlarms as ra (ra.id)}
        <div class="alarm-ring-card">
          <div class="alarm-ring-icon" aria-hidden="true">{(ra.tone ?? "🔔")}</div>
          <div class="alarm-ring-time tabular-nums">{fmtHm(ra.hour, ra.min)}</div>
          {#if ra.label}
            <div class="alarm-ring-label">{ra.label}</div>
          {/if}
          {#if ringSilent}
            <div data-testid="alarm-ring-silent" class="alarm-ring-label opacity-80">
              {t("clock.ringSilent")}
            </div>
          {/if}
          <div class="flex items-center justify-center gap-3">
            <button onclick={() => alarmDispatch({ type: "snooze", id: ra.id, now })} class={neutralBtn + " alarm-ring-btn"}>{t("clock.snooze")}</button>
            <button onclick={() => alarmDispatch({ type: "dismiss", id: ra.id })} class={dangerBtn + " alarm-ring-btn"}>{t("clock.dismissAlarm")}</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if tab === "world"}
    <div>
      <div class="text-center">
        <div class="text-5xl font-medium tabular-nums">{fmt(now)}</div>
        <div class="mt-1 text-sm opacity-60">{fmtDate(now)}</div>
        <div class="mt-1 text-xs uppercase tracking-wide opacity-50">{t("clock.now")}</div>
      </div>
      <div class="mt-6 flex items-center justify-between">
        <span class="text-xs uppercase tracking-wide opacity-50">{t("clock.world")}</span>
        <button onclick={() => (wcEdit = !wcEdit)} class="rounded-full bg-neutral-200 px-2 py-0.5 text-xs dark:bg-neutral-700">
          {wcEdit ? t("common.done") : t("clock.edit")}
        </button>
      </div>
      {#if wcAvail().length > 0}
        <div class="mt-2 flex items-center gap-1.5">
          <input bind:value={wcSearch} aria-label={t("clock.searchCity")} placeholder={t("clock.searchCity")} class="min-w-0 flex-1 rounded-lg bg-neutral-200/70 px-2 py-1 text-xs outline-none placeholder:opacity-50 dark:bg-neutral-700/70" />
          <select
            value={wcPick}
            aria-label={t("clock.addCity")}
            onchange={(e) => (wcPick = (e.currentTarget as HTMLSelectElement).value)}
            class="max-w-[7rem] rounded-lg bg-neutral-200 px-1 py-0.5 text-xs outline-none dark:bg-neutral-700"
          >
            {#each wcAvailFiltered() as c (c.zone)}
              <option value={c.zone}>{wcLabel(c)}</option>
            {/each}
          </select>
          <button onclick={addPickedCity} disabled={wcAvailFiltered().length === 0 || !wcPick} aria-label={t("clock.addCity")} data-role="add-city" class="rounded-full bg-neutral-200 px-2 py-0.5 text-xs disabled:opacity-30 dark:bg-neutral-700">+</button>
        </div>
      {/if}
      <div class="mt-2 space-y-2">
        {#each wc as c (c.zone)}
          <div data-city={c.zone} class="rounded-xl bg-neutral-200/50 px-3 py-2 text-sm dark:bg-neutral-800/50">
            <div class="flex items-center justify-between gap-2">
              <span class="opacity-70">{wcLabel(c)}</span>
              <div class="flex items-center gap-2">
                {#if wcEdit}
                  <div class="flex flex-col gap-0.5">
                    <button onclick={() => moveCity(c.zone, -1)} disabled={wc[0]?.zone === c.zone} aria-label={t("clock.moveUp")} data-role="move-up" class="grid h-4 w-5 place-items-center rounded bg-neutral-300 text-[10px] leading-none disabled:opacity-25 dark:bg-neutral-700">▲</button>
                    <button onclick={() => moveCity(c.zone, 1)} disabled={wc[wc.length - 1]?.zone === c.zone} aria-label={t("clock.moveDown")} data-role="move-down" class="grid h-4 w-5 place-items-center rounded bg-neutral-300 text-[10px] leading-none disabled:opacity-25 dark:bg-neutral-700">▼</button>
                  </div>
                  <button onclick={() => removeCityAt(c.zone)} aria-label="remove-city" data-icon="x" class="inline-flex items-center gap-1 rounded-full bg-neutral-300 px-2 text-xs text-danger dark:bg-neutral-700">{@html iconSvg("x", "h-3 w-3")}</button>
                {/if}
                <span class="tabular-nums">{zoneClock(now, c.zone)}</span>
              </div>
            </div>
            <div data-zone-sub class="mt-0.5 text-xs opacity-50 tabular-nums">{zoneSub(c)}</div>
          </div>
        {/each}
      </div>
    </div>
  {/if}


  {#if tab === "timer"}
    <div class="mt-6 rounded-xl bg-neutral-200/50 p-4 text-center dark:bg-neutral-800/50">
      <div class="text-xs uppercase tracking-wide opacity-50">{t("clock.timer")}</div>
      <div class="mt-1 text-4xl font-medium tabular-nums {timerDone ? 'text-danger' : ''}">{fmtCountdown(tm.remainingMs)}</div>
      {#if timerDone}
        <div data-testid="timer-done" role="status" aria-live="assertive" class="timer-done mt-1 text-base font-semibold text-danger">{t("clock.timerDone")}</div>
      {/if}
      <div class="mt-2 flex items-center justify-center gap-2">
        {#each [1, 3, 5] as m (m)}
          <button onclick={() => armTimer(m, 0)} disabled={tm.running} class={neutralBtn}>{m} {t("clock.min")}</button>
        {/each}
      </div>
      <div class="mt-2 flex items-center justify-center gap-1.5 text-sm">
        <span class="opacity-60">{t("clock.custom")}</span>
        <input
          type="number" min={0} max={1439} step={1} value={tArmMin}
          aria-label={t("clock.minute")}
          disabled={tm.running}
          oninput={(e) => armTimer(Number((e.currentTarget as HTMLInputElement).value), tArmSec)}
          class="w-16 rounded-lg bg-white/70 px-2 py-1 text-center tabular-nums outline-none dark:bg-neutral-900/70"
        />
        <span class="opacity-60">:</span>
        <input
          type="number" min={0} max={59} step={1} value={tArmSec}
          aria-label={t("clock.second")}
          disabled={tm.running}
          oninput={(e) => armTimer(tArmMin, Number((e.currentTarget as HTMLInputElement).value))}
          class="w-14 rounded-lg bg-white/70 px-2 py-1 text-center tabular-nums outline-none dark:bg-neutral-900/70"
        />
      </div>
      <div class="mt-3 flex items-center justify-center gap-4">
        <button onclick={tmToggle} disabled={tm.totalMs === 0 && !tm.running} aria-label={t("clock.timer")} data-icon={tm.running ? "pause" : "play"} class={round(tm.running ? "bg-danger" : "bg-green-500")}>
          {@html iconSvg(tm.running ? "pause" : "play", "h-7 w-7")}
        </button>
        <button onclick={tmReset} disabled={tm.totalMs === 0} aria-label="reset" data-icon="reset" class="grid h-12 w-12 place-items-center rounded-full bg-neutral-300 text-neutral-700 disabled:opacity-30 dark:bg-neutral-700 dark:text-neutral-100">{@html iconSvg("rotateCcw", "h-5 w-5")}</button>
      </div>
    </div>
  {/if}


  {#if tab === "alarm"}
    <div>
      <div class="mt-6 rounded-xl bg-neutral-200/50 p-4 dark:bg-neutral-800/50">
        <div class="flex items-center justify-between">
          <span class="text-xs uppercase tracking-wide opacity-50">{t("clock.alarm")}</span>
          <span class="text-xs opacity-50">{t("clock.alarmCount", { n: al.list.length })}</span>
        </div>
        {#if editingId}
          <div class="mt-2 flex items-center justify-between rounded-lg bg-accent/10 px-2 py-1 text-xs">
            <span class="opacity-80">{t("clock.editAlarm")}</span>
            <button onclick={resetAlarmForm} class="rounded-full px-2 py-0.5 text-accent underline-offset-2 hover:underline">{t("clock.cancelEdit")}</button>
          </div>
        {/if}
        {#if al.list.length === 0}
          <p class="py-2 text-center text-xs opacity-50">{t("clock.alarmEmpty")}</p>
        {:else}
          <div class="mt-2 space-y-1.5">
            {#each sortedAlarms as a (a.id)}
              <div class={"flex items-center justify-between gap-2 rounded-lg px-1 py-0.5 text-sm " + (a.id === editingId ? "bg-accent/10 ring-1 ring-accent" : "")}>
                <button onclick={() => beginEditAlarm(a)} title={t("clock.editAlarm")} class="min-w-0 flex-1 text-left">
                  <span class={"tabular-nums font-semibold " + (a.enabled ? '' : 'opacity-40')}>{fmtHm(a.hour, a.min)}</span>
                  {#if a.label}
                    <span class="ml-2 text-xs {a.enabled ? 'opacity-60' : 'opacity-40'}">{a.label}</span>
                  {/if}
                  {#if a.repeat && a.repeat.length > 0}
                    <span class="block text-xs {a.enabled ? 'opacity-50' : 'opacity-40'}">
                      {t("clock.repeat")}: {a.repeat.map((d) => DOW[d] ?? "").join(" · ")}
                    </span>
                  {/if}
                </button>
                <div class="flex shrink-0 items-center gap-2">
                  <button onclick={() => alarmDispatch({ type: "tone", id: a.id })} aria-label={t("clock.tone")} title={t("clock.tone")} class="rounded-full px-1 text-base leading-none">{a.tone ?? "🔔"}</button>
                  <button onclick={() => toggleEnabled(a)} aria-pressed={a.enabled} title={t("clock.alarmToggle")}
                    class={"relative h-6 w-10 rounded-full transition " + (a.enabled ? "bg-accent" : "bg-neutral-400")}>
                    <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all {a.enabled ? 'left-[1.125rem]' : 'left-0.5'}"></span>
                  </button>
                  <button onclick={() => alarmDispatch({ type: "remove", id: a.id })} aria-label={t("clock.alarmRemove")} data-icon="x" class="grid h-5 w-5 place-items-center text-danger">{@html iconSvg("x", "h-3 w-3")}</button>
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
        <div class="mt-1.5 flex items-center gap-1.5">
          <button onclick={() => setRepeat(WEEKDAYS)} data-role="repeat-weekdays" aria-pressed={alRepeat.length === 5 && WEEKDAYS.every((d) => alRepeat.includes(d))} class="rounded-full bg-neutral-300 px-2 py-0.5 text-xs dark:bg-neutral-700">{t("clock.repeatWeekdays")}</button>
          <button onclick={() => setRepeat(WEEKENDS)} data-role="repeat-weekends" aria-pressed={alRepeat.length === 2 && WEEKENDS.every((d) => alRepeat.includes(d))} class="rounded-full bg-neutral-300 px-2 py-0.5 text-xs dark:bg-neutral-700">{t("clock.repeatWeekends")}</button>
          <button onclick={() => setRepeat([])} data-role="repeat-daily" aria-pressed={alRepeat.length === 0} class="rounded-full bg-neutral-300 px-2 py-0.5 text-xs dark:bg-neutral-700">{t("clock.repeatDaily")}</button>
        </div>
        <div class="mt-3 flex items-center gap-1.5">
          <span class="mr-1 text-xs opacity-50">{t("clock.ringtone")}</span>
          {#each [...ALARM_TONES] as tone (tone)}
            <button
              onclick={() => {
                alTone = tone;
                previewAlarmTone(tone);
              }}
              aria-label={t("clock.ringtoneSelect", { n: tone })}
              aria-pressed={alTone === tone}
              title={t("clock.preview")}
              class={"grid h-7 w-7 place-items-center rounded-full text-base leading-none transition " + (alTone === tone ? "bg-accent text-white ring-2 ring-accent/40" : "bg-neutral-300 dark:bg-neutral-700")}
            >{tone}</button>
          {/each}
          <button onclick={() => previewAlarmTone(alTone)} aria-label={t("clock.preview")} title={t("clock.preview")} class="ml-1 rounded-full bg-neutral-300 px-2 py-1 text-xs dark:bg-neutral-700">{t("clock.preview")}</button>
        </div>
        <div class="mt-3 flex items-center gap-1.5">
          <span class="mr-1 text-xs opacity-50">{t("clock.snoozeLength")}</span>
          {#each SNOOZE_CHOICES as m (m)}
            <button onclick={() => (alSnoozeMin = m)} aria-pressed={alSnoozeMin === m} class={"rounded-full px-2 py-0.5 text-xs " + (alSnoozeMin === m ? "bg-accent text-white" : "bg-neutral-300 dark:bg-neutral-700")}>{m}</button>
          {/each}
        </div>
        <div class="mt-3 flex items-end gap-1.5">
          <div class="flex items-end gap-0.5">
            <div class="flex flex-col">
              <button onclick={() => stepAlHour(1)} data-step="hour-up" title={t("clock.hour")} class="h-4 w-8 rounded-t bg-neutral-300 text-[10px] leading-none dark:bg-neutral-700">▲</button>
              <input bind:value={alH} inputmode="numeric" aria-label={t("clock.hour")} class="w-8 rounded-none bg-white/70 px-1 py-1 text-center text-sm tabular-nums outline-none dark:bg-neutral-900/70" />
              <button onclick={() => stepAlHour(-1)} data-step="hour-down" title={t("clock.hour")} class="h-4 w-8 rounded-b bg-neutral-300 text-[10px] leading-none dark:bg-neutral-700">▼</button>
            </div>
            <span class="pb-3 text-sm">:</span>
            <div class="flex flex-col">
              <button onclick={() => stepAlMin(1)} data-step="min-up" title={t("clock.minute")} class="h-4 w-8 rounded-t bg-neutral-300 text-[10px] leading-none dark:bg-neutral-700">▲</button>
              <input bind:value={alM} inputmode="numeric" aria-label={t("clock.minute")} class="w-8 rounded-none bg-white/70 px-1 py-1 text-center text-sm tabular-nums outline-none dark:bg-neutral-900/70" />
              <button onclick={() => stepAlMin(-1)} data-step="min-down" title={t("clock.minute")} class="h-4 w-8 rounded-b bg-neutral-300 text-[10px] leading-none dark:bg-neutral-700">▼</button>
            </div>
          </div>
          <input bind:value={alLabel} placeholder={t("clock.alarmLabel")} aria-label={t("clock.alarmLabel")} class="min-w-0 flex-1 rounded-lg bg-white/70 px-2 py-1 text-sm outline-none dark:bg-neutral-900/70" />
          {#if editingId}
            <button onclick={resetAlarmForm} aria-label={t("clock.cancelEdit")} class="shrink-0 rounded-full bg-neutral-300 px-3 py-1.5 text-sm text-neutral-900 active:scale-95 dark:bg-neutral-700 dark:text-neutral-100">{t("clock.cancelEdit")}</button>
            <button onclick={submitAlarm} data-role="save-edit" class="shrink-0 rounded-full bg-accent px-3 py-1.5 text-sm text-white active:scale-95">{t("clock.saveAlarm")}</button>
          {:else}
            <button onclick={submitAlarm} class="shrink-0 rounded-full bg-accent px-3 py-1.5 text-sm text-white active:scale-95">{t("clock.addAlarm")}</button>
          {/if}
        </div>
      </div>
    </div>
  {/if}


  {#if tab === "stopwatch"}
    <div class="mt-6 rounded-xl bg-neutral-200/50 p-4 text-center dark:bg-neutral-800/50">
      <div class="text-xs uppercase tracking-wide opacity-50">{t("clock.stopwatch")}</div>
      <div class="mt-1 text-4xl font-medium tabular-nums">{fmtStopwatch(sw.elapsedMs)}</div>
      <div class="mt-3 flex items-center justify-center gap-4">
        <button onclick={swToggle} aria-label={t("clock.stopwatch")} data-icon={sw.running ? "pause" : "play"} class={round(sw.running ? "bg-danger" : "bg-green-500")}>{@html iconSvg(sw.running ? "pause" : "play", "h-7 w-7")}</button>
        <button onclick={doLap} disabled={!sw.running} aria-label="lap" class="h-10 rounded-full bg-neutral-300 px-3 text-sm disabled:opacity-30 dark:bg-neutral-700">{t("clock.lap")}</button>
        <button onclick={resetSw} disabled={sw.elapsedMs === 0 && !sw.running} aria-label="reset" data-icon="reset" class="grid h-12 w-12 place-items-center rounded-full bg-neutral-300 text-neutral-700 disabled:opacity-30 dark:bg-neutral-700 dark:text-neutral-100">{@html iconSvg("rotateCcw", "h-5 w-5")}</button>
      </div>
      {#if laps.length > 0}
        <div class="mt-3 space-y-1 border-t pt-2 text-sm tabular-nums">
          {#each laps as l, i (i)}
            <div class={"flex justify-between " + (i === fastest ? "font-semibold text-accent" : i === slowest ? "font-semibold text-danger" : "opacity-70")}>
              <span>{t("clock.lapCount", { n: String(i + 1) })}{i === fastest ? " ★" : i === slowest && fastest !== slowest ? " ●" : ""}</span>
              <span class="tabular-nums">{fmtStopwatch(l)} <span class="opacity-50">(+{fmtStopwatch(deltas[i] ?? 0)})</span></span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>


<style>
  /* Ringing-alarm screen animation (visible on any tab while the Clock app is open). */
  .alarm-ring {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1rem;
    border-radius: 1rem;
    animation: ringFlash 1s ease-in-out infinite;
  }
  .alarm-ring-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    padding: 1.1rem 1rem 1rem;
    border-radius: 0.9rem;
    background: linear-gradient(160deg, #ffecec, #ffd7d7);
    color: #b91c1c;
    text-align: center;
    border: 1px solid rgba(255, 59, 48, 0.4);
    animation: ringGlow 1.2s ease-in-out infinite, ringShake 0.9s ease-in-out infinite;
  }
  :global(.dark) .alarm-ring-card {
    background: linear-gradient(160deg, #3b1212, #2a0c0c);
    color: #ffb3ab;
    border-color: rgba(255, 89, 76, 0.5);
  }
  .alarm-ring-icon {
    font-size: 2.9rem;
    line-height: 1;
    animation: ringPulse 0.7s ease-in-out infinite;
  }
  .alarm-ring-time {
    font-size: 1.65rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .alarm-ring-label {
    opacity: 0.8;
    font-size: 0.95rem;
  }
  .alarm-ring-btn {
    min-width: 4.5rem;
  }
  @keyframes ringPulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.22); }
  }
  @keyframes ringShake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-3px); }
    75% { transform: translateX(3px); }
  }
  @keyframes ringFlash {
    0%, 100% { background-color: rgba(255, 59, 48, 0.04); }
    50% { background-color: rgba(255, 59, 48, 0.18); }
  }
  @keyframes ringGlow {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 59, 48, 0); }
    50% { box-shadow: 0 0 24px 5px rgba(255, 59, 48, 0.5); }
  }

  /* "Time's up" cue pulses to draw the eye when the countdown finishes. */
  .timer-done {
    display: inline-block;
    animation: timerDonePulse 0.9s ease-in-out infinite;
  }
  @keyframes timerDonePulse {
    0%, 100% { opacity: 0.55; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.14); }
  }
</style>


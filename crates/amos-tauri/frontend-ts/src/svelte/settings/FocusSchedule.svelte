<script lang="ts">
  // FocusSchedule.svelte — the 自动勿扰时段 editor (REQ-A684).
  //
  // This is the UI half of the schedule engine in `lib/focusSchedule.ts`. It only
  // edits *intent* (the windows); the shell watcher (`osFocusWatcher`) is what flips
  // the one real DND bit. Nothing here silences anything itself.
  import { readStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
  import {
    FOCUS_SCHEDULE_KEY,
    activeScenario,
    dayOfWeek,
    formatMinutes,
    minutesOfDay,
    normalizeSchedule,
    parseMinutes,
    type FocusSchedule,
    type FocusWindow,
  } from "../../lib/focusSchedule";
  import { FOCUS_SCENARIOS, focusLabelKey, type FocusId } from "../../lib/focusPrefs";
  import { locale, t } from "../locale.svelte";
  import { GROUP, HINT, LABEL, ROW, SUB } from "./kit";
  import Switch from "./Switch.svelte";
  import StoreErrorBar from "../StoreErrorBar.svelte";

  let sched = $state<FocusSchedule>(
    normalizeSchedule(readStoreValue<unknown>(FOCUS_SCHEDULE_KEY, {})),
  );

  // A live "which window is running now" readout. The clock is read here (the UI owns
  // its own now); the decision itself is pure and takes the time as input.
  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 30_000);
    return () => clearInterval(id);
  });
  const active = $derived(activeScenario(sched, dayOfWeek(now), minutesOfDay(now)));

  const scenarioLabel = (id: FocusId) => t(focusLabelKey(id));

  /**
   * 这个编辑器的每一枚开关 ∕ 每个时段读写都落到这一枚键上，而它的**权威读者是
   * `osFocusWatcher`**（就是它按时间窗去翻那一位真正的勿扰）。所以拒写时本地 `sched` 必须
   * 原样不动 —— 否则编辑器画着「已启用、23:00–07:00」，而到了点没有任何东西会静音：用户以为
   * 排好了，实际上没有（F-SH-632）。修法与同族的 `Launchpad.commitLayout` 逐字同一条。
   */
  let storeErr = $state("");
  function save(next: FocusSchedule) {
    if (!writeStoreValueChecked(FOCUS_SCHEDULE_KEY, next)) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    sched = next;
  }
  const patch = (id: FocusId, p: Partial<FocusWindow>) =>
    save({ ...sched, [id]: { ...sched[id], ...p } });
  const toggleEnabled = (id: FocusId) => patch(id, { enabled: !sched[id].enabled });
  function toggleDay(id: FocusId, day: number) {
    const cur = sched[id].days;
    const days = cur.includes(day)
      ? cur.filter((d) => d !== day)
      : [...cur, day].sort((a, b) => a - b);
    patch(id, { days });
  }
  function setTime(id: FocusId, which: "start" | "end", text: string) {
    const m = parseMinutes(text);
    if (m !== null) patch(id, which === "start" ? { start: m } : { end: m });
  }

  // Mon-first, the familiar week order (0 = Sunday stays the kernel's indexing).
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const localeTag = $derived(locale() === "zh" ? "zh-CN" : "en-US");
  const dayName = (d: number) =>
    new Intl.DateTimeFormat(localeTag, { weekday: "narrow" }).format(new Date(2024, 0, 7 + d));
</script>

<section class={GROUP}>
  <div class="px-4 pt-3">
    <p class={LABEL}>{t("settings.focusSchedule")}</p>
  </div>
  <div class="px-4"><StoreErrorBar message={storeErr} /></div>
  {#each FOCUS_SCENARIOS as id, i (id)}
    <div class={SUB}></div>
    <div class={ROW}>
      <span class={LABEL}>{scenarioLabel(id)}</span>
      <Switch
        aria={t("settings.focusAutoAria", { name: scenarioLabel(id) })}
        on={sched[id].enabled}
        ontoggle={() => toggleEnabled(id)}
      />
    </div>
    {#if sched[id].enabled}
      <div class="flex items-center justify-between gap-3 px-4 pb-2">
        <span class="flex gap-1">
          {#each DAY_ORDER as d (d)}
            <button
              type="button"
              aria-pressed={sched[id].days.includes(d)}
              aria-label={t("settings.focusDayAria", { name: scenarioLabel(id), day: dayName(d) })}
              onclick={() => toggleDay(id, d)}
              class={"grid h-8 w-8 place-items-center rounded-full text-ios-footnote transition " +
                (sched[id].days.includes(d)
                  ? "bg-accent text-white"
                  : "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300")}
            >{dayName(d)}</button>
          {/each}
        </span>
      </div>
      <div class="flex items-center gap-2 px-4 pb-3">
        <input
          type="time"
          aria-label={t("settings.focusStartAria", { name: scenarioLabel(id) })}
          value={formatMinutes(sched[id].start)}
          oninput={(e) => setTime(id, "start", (e.currentTarget as HTMLInputElement).value)}
          class="rounded-ios-input bg-black/5 px-3 py-2 text-ios-body outline-none dark:bg-white/10"
        />
        <span class="text-neutral-400">–</span>
        <input
          type="time"
          aria-label={t("settings.focusEndAria", { name: scenarioLabel(id) })}
          value={formatMinutes(sched[id].end)}
          oninput={(e) => setTime(id, "end", (e.currentTarget as HTMLInputElement).value)}
          class="rounded-ios-input bg-black/5 px-3 py-2 text-ios-body outline-none dark:bg-white/10"
        />
      </div>
    {/if}
    {#if i < FOCUS_SCENARIOS.length - 1}<div class={SUB}></div>{/if}
  {/each}
  <div class="px-4 pb-3">
    <!-- `role="status"` (= polite + aria-atomic) because this line is the only place the
         running window is stated, and it changes on its own: the 30 s tick crosses a window
         boundary while the user is elsewhere on the page. Polite, never assertive — this is
         information, not an interruption (contrast `NotificationBanner`, which is role=alert
         because an arriving toast *is* one). It also speaks once when a switch/start/end edit
         changes which window is active, which is the confirmation of what that edit did. -->
    <p class={HINT} data-testid="focus-schedule-hint" role="status">
      {active
        ? t("settings.focusActive", { name: scenarioLabel(active), end: formatMinutes(sched[active].end) })
        : t("settings.focusScheduleHint")}
    </p>
  </div>
</section>

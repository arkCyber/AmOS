<script lang="ts">
  // CalendarApp.svelte — Svelte 5 (runes) iOS-style Calendar (日历).
  //
  // All domain logic is the pure `lib/calendar.ts` kernel; OS-level "upcoming
  // event" alerts live in `lib/calendarCore.ts` and are scheduled by the shell's
  // `svelte/osCalendarWatcher`. Data persists through the shared amos.* store
  // under amos.calendar / amos.calendars, so the watcher and any other surface
  // read exactly the same rows.
  import {
    ALERT_OPTIONS,
    CALENDAR_COLORS,
    CALENDAR_KEY,
    CALENDARS_KEY,
    DEFAULT_CALENDAR_ID,
    REPEATS,
    addCalendar,
    addDays,
    addEvent,
    addMonths,
    allDayEnd,
    calendarById,
    countDays,
    fromDateAndTime,
    groupByDay,
    isContinuation,
    isSameDay,
    monthGrid,
    newEventDraft,
    normalizeCalendars,
    normalizeEvents,
    occurrencesByDay,
    occurrencesInRange,
    occurrencesOnDay,
    reassignOrphans,
    removeCalendar,
    removeEvent,
    searchEvents,
    seedCalendars,
    seedEvents,
    shiftByWallClock,
    spansDays,
    startOfDay,
    startOfMonth,
    toDateInput,
    toTimeInput,
    toggleCalendar,
    updateEvent,
    visibleEvents,
    weekDays,
    weekdayOrder,
    type CalendarColor,
    type CalendarEvent,
    type CalendarGroup,
    type EventDraft,
    type Occurrence,
    type Repeat,
  } from "../lib/calendar";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { iconSvg } from "../lib/sysIcons";
  import { locale, t } from "./locale.svelte";

  /* Colour tokens (literal Tailwind classes — never dynamic class names). */
  const BG: Record<CalendarColor, string> = {
    red: "bg-red-500",
    orange: "bg-orange-500",
    yellow: "bg-yellow-500",
    green: "bg-green-500",
    teal: "bg-teal-500",
    blue: "bg-blue-500",
    indigo: "bg-indigo-500",
    purple: "bg-purple-500",
    pink: "bg-pink-500",
    gray: "bg-neutral-400",
  };
  const TEXT: Record<CalendarColor, string> = {
    red: "text-red-500",
    orange: "text-orange-500",
    yellow: "text-yellow-500",
    green: "text-green-500",
    teal: "text-teal-500",
    blue: "text-blue-500",
    indigo: "text-indigo-500",
    purple: "text-purple-500",
    pink: "text-pink-500",
    gray: "text-neutral-400",
  };

  /* ---- seed / init from the shared store (mirrors the other apps) ---- */
  const now0 = Date.now();
  let initGroups = normalizeCalendars(readStoreValue<unknown>(CALENDARS_KEY, []));
  if (!initGroups.some((g) => g.id === DEFAULT_CALENDAR_ID)) {
    initGroups = initGroups.length ? [seedCalendars(now0)[0]!, ...initGroups] : seedCalendars(now0);
    writeStoreValue(CALENDARS_KEY, initGroups);
  }
  let initEvents = normalizeEvents(readStoreValue<unknown>(CALENDAR_KEY, []));
  if (!initEvents.length) {
    initEvents = seedEvents(now0);
    writeStoreValue(CALENDAR_KEY, initEvents);
  }
  let groups = $state<CalendarGroup[]>(initGroups);
  let events = $state<CalendarEvent[]>(initEvents);

  const persistGroups = (l: CalendarGroup[]) => {
    const c = normalizeCalendars(l);
    writeStoreValue(CALENDARS_KEY, c);
    groups = c;
  };
  /**
   * Persist events. Invariant enforced here (single choke point): **every stored
   * event points at a calendar that still exists** — anything orphaned by a
   * deletion falls back to the built-in calendar. Without this, deleting a
   * calendar while its event is open in the editor could commit an event whose
   * `calendarId` resolves to nothing.
   */
  const persistEvents = (l: CalendarEvent[]) => {
    const c = normalizeEvents(reassignOrphans(l, groups));
    writeStoreValue(CALENDAR_KEY, c);
    events = c;
  };

  /* ---- slow clock (today highlight / agenda window refresh) ---- */
  let tick = $state(Date.now());
  $effect(() => {
    const id = window.setInterval(() => (tick = Date.now()), 60_000);
    return () => window.clearInterval(id);
  });

  /* ---- view state ---- */
  type View = "month" | "week" | "agenda";
  let view = $state<View>("month");
  let cursor = $state(startOfMonth(Date.now()));
  let selected = $state(startOfDay(Date.now()));
  let searchOpen = $state(false);
  let query = $state("");
  let manageOpen = $state(false);
  let editorOpen = $state(false);
  let editId = $state<string | null>(null);
  /**
   * The concrete occurrence the editor was opened from (null for a new event).
   * The editor SHOWS this occurrence's date/time — so tapping a repeat's
   * occurrence for 9/11 opens on 9/11, not on the series anchor — and `commit`
   * re-anchors the series by the same wall-clock offset the user applied.
   */
  let editOcc = $state<{ startAt: number; endAt: number } | null>(null);

  interface Draft {
    title: string;
    location: string;
    notes: string;
    calendarId: string;
    repeat: Repeat;
    alertMinutes: number | null;
    allDay: boolean;
    dateStr: string;
    startTime: string;
    endDateStr: string;
    endTime: string;
  }
  const todayStr = toDateInput(Date.now());
  let draft = $state<Draft>({
    title: "",
    location: "",
    notes: "",
    calendarId: DEFAULT_CALENDAR_ID,
    repeat: "none",
    alertMinutes: 0,
    allDay: false,
    dateStr: todayStr,
    startTime: "09:00",
    endDateStr: todayStr,
    endTime: "10:00",
  });
  let newCalName = $state("");
  let newCalColor = $state<CalendarColor>("red");

  /* ---- derived view data ---- */
  const localeTag = $derived(locale() === "zh" ? "zh-CN" : "en-US");
  // iOS follows the region's first weekday: zh-CN starts on Monday, en-US Sunday.
  const weekStartsOn = $derived(locale() === "zh" ? 1 : 0);
  const monthTitle = $derived(
    new Intl.DateTimeFormat(localeTag, { year: "numeric", month: "long" }).format(
      new Date(cursor),
    ),
  );
  const weekdayNames = $derived(
    weekdayOrder(weekStartsOn).map((d) =>
      new Intl.DateTimeFormat(localeTag, { weekday: "narrow" }).format(new Date(2024, 0, 7 + d)),
    ),
  );
  const visible = $derived(visibleEvents(events, groups));
  const searched = $derived(searchEvents(visible, query));
  const searching = $derived(query.trim().length > 0);
  const grid = $derived(monthGrid(cursor, weekStartsOn));
  const gridFrom = $derived(grid[0] ?? startOfMonth(cursor));
  const gridTo = $derived(addDays(grid[41] ?? startOfMonth(cursor), 1));
  // Multi-day events mark EVERY day they cover (not just their start day).
  const byDay = $derived(
    occurrencesByDay(occurrencesInRange(searched, gridFrom, gridTo), gridFrom, gridTo),
  );
  const selectedOccs = $derived(occurrencesOnDay(searched, selected));
  const agendaFrom = $derived(startOfDay(tick));
  const agendaOccs = $derived(
    occurrencesInRange(searched, agendaFrom, addDays(agendaFrom, 60)),
  );
  const agendaDays = $derived([...groupByDay(agendaOccs)].sort((a, b) => a[0] - b[0]));

  /* ---- week view ---- */
  // Anchored on `selected` so "go to today" and day taps move the week too, and
  // built from the same region rule the month grid uses (`weekStartsOn`).
  const week = $derived(weekDays(selected, weekStartsOn));
  const weekOccs = $derived(new Map(week.map((d) => [d, occurrencesOnDay(searched, d)])));

  /* ---- actions ---- */
  const groupOf = (id: string): CalendarGroup | undefined => calendarById(groups, id);
  const colorOf = (id: string): CalendarColor => groupOf(id)?.color ?? "gray";
  const calName = (id: string): string => {
    const g = groupOf(id);
    if (!g || g.id === DEFAULT_CALENDAR_ID) return t("calendar.calendar");
    return g.name;
  };

  /** ‹ › moves one month (month grid) or one week (week view). */
  const shiftPeriod = (n: number) => {
    if (view === "week") selected = addDays(selected, 7 * n);
    else cursor = addMonths(cursor, n);
  };
  /** Localized ‹ › label for the active view (never a stale "month" hint). */
  const navLabel = (dir: -1 | 1): string =>
    view === "week"
      ? t(dir < 0 ? "calendar.prevWeek" : "calendar.nextWeek")
      : t(dir < 0 ? "calendar.prevMonth" : "calendar.nextMonth");
  const goToday = () => {
    const n = Date.now();
    cursor = startOfMonth(n);
    selected = startOfDay(n);
  };
  const selectDay = (day: number) => {
    selected = startOfDay(day);
    editorOpen = false;
  };

  const openNew = (day: number) => {
    editId = null;
    editOcc = null;
    const base = newEventDraft(day, groups[0]?.id ?? DEFAULT_CALENDAR_ID);
    draft = {
      title: base.title,
      location: base.location ?? "",
      notes: base.notes ?? "",
      calendarId: base.calendarId,
      repeat: base.repeat,
      alertMinutes: base.alertMinutes,
      allDay: base.allDay,
      dateStr: toDateInput(base.startAt),
      startTime: toTimeInput(base.startAt),
      endDateStr: toDateInput(base.endAt),
      endTime: toTimeInput(base.endAt),
    };
    editorOpen = true;
  };
  const openEdit = (occ: Occurrence) => {
    const e = events.find((x) => x.id === occ.event.id);
    if (!e) return;
    editId = e.id;
    // Show the OCCURRENCE date/time (what the user actually tapped) — for a
    // repeat this is often a later day than the series anchor. `commit` maps the
    // edit back onto the series by the same wall-clock offset.
    editOcc = { startAt: occ.startAt, endAt: occ.endAt };
    draft = {
      title: e.title,
      location: e.location ?? "",
      notes: e.notes ?? "",
      calendarId: e.calendarId,
      repeat: e.repeat,
      alertMinutes: e.alertMinutes,
      allDay: e.allDay,
      dateStr: toDateInput(occ.startAt),
      startTime: toTimeInput(occ.startAt),
      // All-day drafts show the INCLUSIVE last day (iOS "ends 6/3"), so the
      // multi-day round-trip is exact (see fromDraft).
      endDateStr: toDateInput(e.allDay ? addDays(occ.endAt, -1) : occ.endAt),
      endTime: toTimeInput(occ.endAt),
    };
    editorOpen = true;
    manageOpen = false;
  };

  const fromDraft = (d: Draft): EventDraft | null => {
    const startAt = fromDateAndTime(d.dateStr, d.allDay ? "00:00" : d.startTime);
    if (startAt == null) return null;
    let endAt: number;
    if (d.allDay) {
      // Inclusive end day → exclusive midnight; a bad/earlier day collapses to
      // a single day rather than producing an inverted span.
      const endDay = fromDateAndTime(d.endDateStr, "00:00");
      endAt = allDayEnd(startAt, endDay != null ? addDays(endDay, 1) : 0);
    } else {
      const e = fromDateAndTime(d.endDateStr, d.endTime);
      endAt = e != null && e > startAt ? e : startAt + 3_600_000;
    }
    return {
      calendarId: d.calendarId,
      title: d.title,
      location: d.location.trim() || undefined,
      notes: d.notes.trim() || undefined,
      startAt,
      endAt,
      allDay: d.allDay,
      repeat: d.repeat,
      alertMinutes: d.alertMinutes,
    };
  };

  const closeEditor = () => {
    editorOpen = false;
    editId = null;
    editOcc = null;
  };
  /**
   * Changing the start DATE moves the end date by the same whole-day offset (iOS
   * keeps the duration), so "tomorrow, 09:00–10:00" stays a one-hour event on the
   * new day instead of collapsing to a fallback hour or landing on a stale day.
   * Uses `oninput` (one-way `value`) rather than `bind:value` so the previous
   * date is still readable when the handler runs.
   */
  const onStartDateInput = (e: Event) => {
    const next = (e.currentTarget as HTMLInputElement).value;
    const prev = draft.dateStr;
    if (next === prev) return;
    if (!next) {
      draft.dateStr = ""; // unusable → commit refuses (same as a cleared field)
      return;
    }
    const prevStart = fromDateAndTime(prev, "00:00");
    const prevEnd = fromDateAndTime(draft.endDateStr, "00:00");
    const nextStart = fromDateAndTime(next, "00:00");
    draft.dateStr = next;
    if (prevStart == null || prevEnd == null || nextStart == null) return;
    const offset = Math.max(0, countDays(prevStart, prevEnd));
    draft.endDateStr = toDateInput(addDays(nextStart, offset));
  };
  const commit = () => {
    if (!draft.title.trim()) return;
    const payload = fromDraft(draft);
    if (!payload) return;
    if (editId) {
      // The draft is expressed relative to the occurrence the user tapped, so
      // translate it back onto the stored row by the SAME wall-clock offset.
      // For a non-repeating event — or when nothing changed — this is an exact
      // no-op, so existing behaviour is unchanged.
      const curr = events.find((x) => x.id === editId);
      if (curr && editOcc) {
        payload.startAt = shiftByWallClock(curr.startAt, editOcc.startAt, payload.startAt);
        payload.endAt = shiftByWallClock(curr.endAt, editOcc.endAt, payload.endAt);
      }
      persistEvents(updateEvent(events, editId, payload));
    } else {
      persistEvents(addEvent(events, payload, Date.now()));
    }
    closeEditor();
  };
  const del = () => {
    if (editId) persistEvents(removeEvent(events, editId));
    closeEditor();
  };

  const createCalendar = () => {
    if (!newCalName.trim()) return;
    persistGroups(addCalendar(groups, { name: newCalName, color: newCalColor }, Date.now()));
    newCalName = "";
  };
  const deleteCalendar = (id: string) => {
    if (id === DEFAULT_CALENDAR_ID) return;
    const next = removeCalendar(groups, id);
    persistGroups(next);
    // Events left behind fall back to the built-in calendar (never orphaned) —
    // the same pure helper the kernel tests pin, so the two can't drift. The
    // persistence boundary re-applies it, so an event being edited right now
    // can't slip through either.
    persistEvents(reassignOrphans(events, next));
    // ...and point the open editor at a calendar that still exists.
    if (draft.calendarId === id) draft.calendarId = DEFAULT_CALENDAR_ID;
  };


  /* ---- localized labels ---- */
  const dayLabel = (ms: number): string =>
    new Intl.DateTimeFormat(localeTag, { month: "short", day: "numeric", weekday: "short" }).format(
      new Date(ms),
    );
  /** Short local date without the year ("6月9日" / "Jun 9"). */
  const shortDate = (ms: number): string =>
    new Intl.DateTimeFormat(localeTag, { month: "short", day: "numeric" }).format(new Date(ms));
  /** Accessible label for one month-grid cell: date + how many events it holds. */
  const dayAria = (ms: number, count: number): string =>
    t("calendar.dayAria", { date: dayLabel(ms), n: count });

  /* ---- header title (month name vs. week span) ---- */
  const weekTitle = $derived(`${shortDate(week[0]!)} – ${shortDate(week[6]!)}`);
  const headerTitle = $derived(view === "week" ? weekTitle : monthTitle);
  const repeatLabel = (r: Repeat): string =>
    r === "daily"
      ? t("calendar.repeatDaily")
      : r === "weekly"
        ? t("calendar.repeatWeekly")
        : r === "monthly"
          ? t("calendar.repeatMonthly")
          : r === "yearly"
            ? t("calendar.repeatYearly")
            : t("calendar.repeatNone");
  const alertLabel = (m: number | null): string => {
    if (m == null) return t("calendar.alertNone");
    if (m === 0) return t("calendar.alertAtTime");
    if (m % 1440 === 0) return t("calendar.alertDays", { n: m / 1440 });
    if (m % 60 === 0) return t("calendar.alertHours", { n: m / 60 });
    return t("calendar.alertMinutes", { n: m });
  };
  const alertValue = (m: number | null): string => (m == null ? "none" : String(m));
  const parseAlert = (v: string): number | null => (v === "none" ? null : Number(v));

  const inThisMonth = (day: number): boolean =>
    new Date(day).getMonth() === new Date(cursor).getMonth();
  /**
   * The row's time column. Rules (never show a time that doesn't belong to the
   * displayed day):
   *  - all-day            → "全天"
   *  - starts today       → "14:05", or "22:00 → 06:00" when it crosses midnight
   *  - continues from an   earlier day → "→ 06:00" (ends today) or "延续"
   */
  const timeLabel = (occ: Occurrence, dayMs: number): string => {
    if (occ.event.allDay) return t("calendar.allDay");
    if (isContinuation(occ, dayMs)) {
      const dayStart = startOfDay(dayMs);
      return occ.endAt <= addDays(dayStart, 1)
        ? `→ ${toTimeInput(occ.endAt)}`
        : t("calendar.continues");
    }
    return spansDays(occ)
      ? `${toTimeInput(occ.startAt)} → ${toTimeInput(occ.endAt)}`
      : toTimeInput(occ.startAt);
  };
  /** "6月1日 – 6月3日" for a multi-day span (inclusive last day), else null. */
  const spanLabel = (occ: Occurrence): string | null =>
    spansDays(occ)
      ? `${shortDate(occ.startAt)} – ${shortDate(addDays(occ.endAt, -1))}`
      : null;

  /* Shared class tokens (kept in one place so rows/cards stay consistent). */
  const GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const SUB = "h-px bg-black/5 dark:bg-white/10";
  const FIELD =
    "w-full rounded-lg bg-black/5 px-2.5 py-1.5 text-sm outline-none dark:bg-white/10";
  const btn = (kind: "neutral" | "accent" | "danger"): string => {
    const tone =
      kind === "accent"
        ? "bg-accent text-white"
        : kind === "danger"
          ? "bg-danger text-white"
          : "bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100";
    return `px-3 py-1 text-sm rounded-full ${tone} transition active:scale-95 disabled:opacity-40`;
  };
</script>


<div class="flex h-full flex-col">
  <!-- month / title navigation -->
  <div class="flex shrink-0 items-center gap-1 px-2 pt-2">
    <button
      aria-label={navLabel(-1)}
      title={navLabel(-1)}
      data-testid="cal-prev"
      onclick={() => shiftPeriod(-1)}
      class="grid h-8 w-8 place-items-center rounded-full text-lg leading-none opacity-70 active:bg-black/5 dark:active:bg-white/10"
    >‹</button>
    <span class="min-w-0 flex-1 truncate text-center text-[15px] font-semibold" data-testid="cal-title">
      {headerTitle}
    </span>
    <button
      aria-label={navLabel(1)}
      title={navLabel(1)}
      data-testid="cal-next"
      onclick={() => shiftPeriod(1)}
      class="grid h-8 w-8 place-items-center rounded-full text-lg leading-none opacity-70 active:bg-black/5 dark:active:bg-white/10"
    >›</button>
  </div>

  <!-- view switch + toolbar -->
  <div class="flex shrink-0 items-center gap-1.5 px-3 pb-2">
    <div class="flex rounded-full bg-neutral-200/70 p-0.5 dark:bg-neutral-700/70" role="tablist">
      <button
        role="tab"
        aria-selected={view === "month"}
        data-view="month"
        onclick={() => (view = "month")}
        class={view === "month"
          ? "rounded-full bg-white px-3 py-0.5 text-xs font-medium shadow-sm dark:bg-neutral-900"
          : "rounded-full px-3 py-0.5 text-xs opacity-70"}
      >{t("calendar.month")}</button>
      <button
        role="tab"
        aria-selected={view === "week"}
        data-view="week"
        onclick={() => (view = "week")}
        class={view === "week"
          ? "rounded-full bg-white px-3 py-0.5 text-xs font-medium shadow-sm dark:bg-neutral-900"
          : "rounded-full px-3 py-0.5 text-xs opacity-70"}
      >{t("calendar.week")}</button>
      <button
        role="tab"
        aria-selected={view === "agenda"}
        data-view="agenda"
        onclick={() => (view = "agenda")}
        class={view === "agenda"
          ? "rounded-full bg-white px-3 py-0.5 text-xs font-medium shadow-sm dark:bg-neutral-900"
          : "rounded-full px-3 py-0.5 text-xs opacity-70"}
      >{t("calendar.agenda")}</button>
    </div>
    <button
      onclick={goToday}
      data-testid="cal-today"
      class="rounded-full bg-accent/15 px-3 py-1 text-xs text-accent"
    >{t("calendar.today")}</button>
    <button
      onclick={() => {
        if (searchOpen) query = "";
        searchOpen = !searchOpen;
      }}
      aria-pressed={searchOpen}
      aria-label={t("calendar.search")}
      title={t("calendar.search")}
      data-icon={searchOpen ? "x" : "search"}
      class="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-full bg-neutral-200/70 text-sm dark:bg-neutral-700/70"
    >
      {@html iconSvg(searchOpen ? "x" : "search", "h-[15px] w-[15px]")}
    </button>
    <button
      onclick={() => (manageOpen = !manageOpen)}
      aria-pressed={manageOpen}
      data-testid="cal-manage"
      aria-label={t("calendar.calendars")}
      title={t("calendar.calendars")}
      class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-neutral-200/70 text-xs dark:bg-neutral-700/70"
    >☰</button>
  </div>

  <!-- search field -->
  {#if searchOpen}
    <div class="flex shrink-0 items-center gap-2 px-3 pb-1.5">
      <div class="flex min-w-0 flex-1 items-center gap-1.5 rounded-xl bg-black/5 px-2.5 py-1 ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10">
        <span class="shrink-0 opacity-50" data-icon="search">{@html iconSvg("search", "h-3.5 w-3.5")}</span>
        <input
          bind:value={query}
          placeholder={t("calendar.search")}
          aria-label={t("calendar.search")}
          data-testid="cal-search"
          class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-black/30 dark:placeholder:text-white/30"
        />
        {#if searching}
          <span class="shrink-0 text-[10px] text-accent" data-testid="cal-matches">
            {t("calendar.eventCount", { n: searched.length })}
          </span>
        {/if}
      </div>
    </div>
  {/if}

  <!-- month grid -->
  {#if view === "month"}
    <div class="shrink-0 px-2" data-testid="cal-grid">
      <div class="grid grid-cols-7">
        {#each weekdayNames as w}
          <div class="py-1 text-center text-[10px] font-medium opacity-50">{w}</div>
        {/each}
      </div>
      <div class="grid grid-cols-7">
        {#each grid as day (day)}
          {@const occ = byDay.get(day) ?? []}
          {@const isToday = isSameDay(day, tick)}
          {@const isSel = isSameDay(day, selected)}
          <button
            data-day={toDateInput(day)}
            data-today={isToday ? "true" : "false"}
            data-selected={isSel ? "true" : "false"}
            aria-label={dayAria(day, occ.length)}
            aria-pressed={isSel}
            onclick={() => selectDay(day)}
            class={"relative flex h-11 flex-col items-center justify-start rounded-xl pt-1 transition " +
              (isSel ? "bg-accent text-white" : "active:bg-black/5 dark:active:bg-white/10")}
          >
            <span class={"text-[13px] leading-none " +
              (isSel
                ? "font-semibold text-white"
                : isToday
                  ? "font-semibold text-danger"
                  : inThisMonth(day)
                    ? ""
                    : "opacity-35")}>
              {new Date(day).getDate()}
            </span>
            <span class="mt-1 flex max-w-full items-center gap-[3px] overflow-hidden" data-dots={occ.length}>
              {#each occ.slice(0, 3) as o}
                <i class={"h-1 w-1 shrink-0 rounded-full " + (isSel ? "bg-white/90" : BG[colorOf(o.event.calendarId)])}></i>
              {/each}
            </span>
          </button>
        {/each}
      </div>
    </div>
  {/if}


  <!-- calendars manager -->
  {#if manageOpen}
    <div class="shrink-0 px-3 pb-2" data-testid="cal-manage-panel">
      <div class={GROUP}>
        <div class="px-4 py-2 text-xs font-medium opacity-60">{t("calendar.calendars")}</div>
        <div class={SUB}></div>
        {#each groups as g (g.id)}
          <div class="flex items-center gap-2 px-4 py-2">
            <button
              role="switch"
              aria-checked={g.enabled}
              aria-label={calName(g.id)}
              data-cal-toggle={g.id}
              onclick={() => persistGroups(toggleCalendar(groups, g.id))}
              class={"grid h-5 w-5 shrink-0 place-items-center rounded-md border text-[11px] " +
                (g.enabled
                  ? BG[g.color] + " border-transparent text-white"
                  : "border-neutral-400 text-transparent dark:border-neutral-500")}
            >✓</button>
            <span class={"min-w-0 flex-1 truncate text-sm " + (g.enabled ? "" : "opacity-40")}>
              {calName(g.id)}
            </span>
            {#if !g.enabled}
              <span class="shrink-0 text-[10px] opacity-40">{t("calendar.hidden")}</span>
            {/if}
            {#if g.id !== DEFAULT_CALENDAR_ID}
              <button
                onclick={() => deleteCalendar(g.id)}
                aria-label={t("calendar.deleteCalendar")}
                data-cal-delete={g.id}
                class="shrink-0 text-xs text-danger"
              >{t("calendar.delete")}</button>
            {/if}
          </div>
        {/each}
        <div class={SUB}></div>
        <div class="px-4 py-2">
          <div class="flex items-center gap-2">
            <input
              bind:value={newCalName}
              placeholder={t("calendar.calendarName")}
              aria-label={t("calendar.calendarName")}
              data-testid="cal-cname"
              class={FIELD + " min-w-0 flex-1"}
            />
            <button
              onclick={createCalendar}
              disabled={!newCalName.trim()}
              data-testid="cal-create"
              class={btn("accent")}
            >{t("calendar.create")}</button>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            {#each CALENDAR_COLORS as c (c)}
              <button
                aria-label={c}
                aria-pressed={newCalColor === c}
                data-color={c}
                onclick={() => (newCalColor = c)}
                class={"h-5 w-5 rounded-full " + BG[c] +
                  (newCalColor === c
                    ? " ring-2 ring-neutral-500 ring-offset-1 dark:ring-offset-neutral-900"
                    : "")}
              ></button>
            {/each}
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- content: selected-day schedule (month view) or agenda list -->
  <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-2" data-testid="cal-content">
    {#if view === "month"}
      <div class="mb-1 flex items-center justify-between px-1">
        <span class="text-xs font-medium opacity-60" data-testid="cal-day-label">{dayLabel(selected)}</span>
        <span class="text-[10px] opacity-40">
          {t("calendar.eventCount", { n: selectedOccs.length })}
        </span>
      </div>
      {#if selectedOccs.length === 0}
        <p class="px-4 py-8 text-center text-sm opacity-50" data-testid="cal-day-empty">
          {searching ? t("calendar.noMatch") : t("calendar.empty")}
        </p>
      {:else}
        <div class={GROUP}>
          {#each selectedOccs as occ, i (`${occ.event.id}@${occ.startAt}`)}
            {#if i > 0}<div class={SUB}></div>{/if}
            {@render eventRow(occ, selected)}
          {/each}
        </div>
      {/if}
    {:else if view === "week"}
      <div class="space-y-1.5 pt-1" data-testid="cal-week">
        {#each week as day (day)}
          {@const list = weekOccs.get(day) ?? []}
          {@const isToday = isSameDay(day, tick)}
          <div data-week-day={day} data-today={isToday ? "true" : "false"}>
            <button
              onclick={() => selectDay(day)}
              aria-label={dayAria(day, list.length)}
              class="flex w-full items-center justify-between px-1 pb-1 pt-1.5 text-xs font-medium"
            >
              <span class={"truncate " + (isToday ? "text-danger" : "opacity-60")}>
                {dayLabel(day)}
              </span>
              <span class="shrink-0 text-[10px] opacity-40">
                {t("calendar.eventCount", { n: list.length })}
              </span>
            </button>
            {#if list.length === 0}
              <p class="px-3 py-1.5 text-xs opacity-30" data-week-empty="true">—</p>
            {:else}
              <div class={GROUP}>
                {#each list as occ, i (`${occ.event.id}@${occ.startAt}`)}
                  {#if i > 0}<div class={SUB}></div>{/if}
                  {@render eventRow(occ, day)}
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {:else if agendaDays.length === 0}
      <p class="px-4 py-8 text-center text-sm opacity-50" data-testid="cal-agenda-empty">
        {searching ? t("calendar.noMatch") : t("calendar.noUpcoming")}
      </p>
    {:else}
      {#each agendaDays as [day, list] (day)}
        <div class="px-1 pb-1 pt-2 text-xs font-medium opacity-60" data-agenda-day={day}>
          {dayLabel(day)}
        </div>
        <div class={GROUP}>
          {#each list as occ, i (`${occ.event.id}@${occ.startAt}`)}
            {#if i > 0}<div class={SUB}></div>{/if}
            {@render eventRow(occ, day)}
          {/each}
        </div>
      {/each}
    {/if}
  </div>


  <!-- compose / edit panel -->
  <div class="shrink-0 border-t border-neutral-200/70 px-3 py-2 dark:border-neutral-800">
    {#if !editorOpen}
      <button
        onclick={() => openNew(selected)}
        data-testid="cal-new"
        class="w-full rounded-xl px-3 py-2 text-left text-[15px] text-accent"
      >＋ {t("calendar.newEvent")}</button>
    {:else}
      <div class="max-h-[52vh] overflow-y-auto" data-testid="cal-editor">
        <div class={GROUP}>
          <div class="px-4 py-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium opacity-60">
                {editId ? t("calendar.editEvent") : t("calendar.newEvent")}
              </span>
              <span class={"text-xs " + TEXT[colorOf(draft.calendarId)]}>
                ● {calName(draft.calendarId)}
              </span>
            </div>
            <input
              bind:value={draft.title}
              onkeydown={(e) => {
                if (e.key === "Enter") commit();
              }}
              placeholder={t("calendar.titlePlaceholder")}
              aria-label={t("calendar.title")}
              data-testid="cal-title-input"
              class="mt-1 w-full text-[15px] outline-none"
            />
          </div>
          <div class={SUB}></div>
          <div class="space-y-2 px-4 py-2">
            <div class="flex items-center justify-between">
              <span class="text-xs opacity-60">{t("calendar.allDay")}</span>
              <button
                role="switch"
                aria-checked={draft.allDay}
                aria-label={t("calendar.allDay")}
                data-testid="cal-allday"
                onclick={() => {
                  draft.allDay = !draft.allDay;
                  // Switching a timed event to all-day: never leave an end day
                  // before the start day.
                  if (draft.allDay && draft.endDateStr < draft.dateStr) {
                    draft.endDateStr = draft.dateStr;
                  }
                }}
                class={"h-5 w-9 shrink-0 rounded-full transition " +
                  (draft.allDay ? "bg-accent" : "bg-neutral-300 dark:bg-neutral-600")}
              >
                <span class={"block h-4 w-4 rounded-full bg-white transition " +
                  (draft.allDay ? "translate-x-[18px]" : "translate-x-0.5")}></span>
              </button>
            </div>
            <div class="flex items-center gap-2">
              <span class="w-10 shrink-0 text-xs opacity-60">{t("calendar.starts")}</span>
              <input
                type="date"
                value={draft.dateStr}
                oninput={onStartDateInput}
                aria-label={t("calendar.starts")}
                data-testid="cal-start-date"
                class="min-w-0 flex-1 rounded-lg bg-black/5 px-2 py-1 text-xs outline-none dark:bg-white/10"
              />
              {#if !draft.allDay}
                <input
                  type="time"
                  bind:value={draft.startTime}
                  aria-label={t("calendar.starts")}
                  data-testid="cal-start-time"
                  class="shrink-0 rounded-lg bg-black/5 px-2 py-1 text-xs outline-none dark:bg-white/10"
                />
              {/if}
            </div>
            <div class="flex items-center gap-2">
              <span class="w-10 shrink-0 text-xs opacity-60">{t("calendar.ends")}</span>
              <input
                type="date"
                bind:value={draft.endDateStr}
                aria-label={t("calendar.ends")}
                data-testid="cal-end-date"
                class="min-w-0 flex-1 rounded-lg bg-black/5 px-2 py-1 text-xs outline-none dark:bg-white/10"
              />
              {#if !draft.allDay}
                <input
                  type="time"
                  bind:value={draft.endTime}
                  aria-label={t("calendar.ends")}
                  data-testid="cal-end-time"
                  class="shrink-0 rounded-lg bg-black/5 px-2 py-1 text-xs outline-none dark:bg-white/10"
                />
              {/if}
            </div>

            <div class="flex items-center gap-2">
              <span class="w-10 shrink-0 text-xs opacity-60">{t("calendar.calendar")}</span>
              <select
                value={draft.calendarId}
                aria-label={t("calendar.calendar")}
                data-testid="cal-calendar-select"
                onchange={(e) => (draft.calendarId = e.currentTarget.value)}
                class="min-w-0 flex-1 rounded-lg bg-black/5 px-2 py-1 text-xs outline-none dark:bg-white/10"
              >
                {#each groups as g (g.id)}
                  <option value={g.id}>{calName(g.id)}</option>
                {/each}
              </select>
            </div>
            <div class="flex items-center gap-2">
              <span class="w-10 shrink-0 text-xs opacity-60">{t("calendar.repeat")}</span>
              <select
                value={draft.repeat}
                aria-label={t("calendar.repeat")}
                data-testid="cal-repeat-select"
                onchange={(e) => (draft.repeat = e.currentTarget.value as Repeat)}
                class="min-w-0 flex-1 rounded-lg bg-black/5 px-2 py-1 text-xs outline-none dark:bg-white/10"
              >
                {#each REPEATS as r (r)}
                  <option value={r}>{repeatLabel(r)}</option>
                {/each}
              </select>
            </div>
            <div class="flex items-center gap-2">
              <span class="w-10 shrink-0 text-xs opacity-60">{t("calendar.alert")}</span>
              <select
                value={alertValue(draft.alertMinutes)}
                aria-label={t("calendar.alert")}
                data-testid="cal-alert-select"
                onchange={(e) => (draft.alertMinutes = parseAlert(e.currentTarget.value))}
                class="min-w-0 flex-1 rounded-lg bg-black/5 px-2 py-1 text-xs outline-none dark:bg-white/10"
              >
                {#each ALERT_OPTIONS as m (alertValue(m))}
                  <option value={alertValue(m)}>{alertLabel(m)}</option>
                {/each}
              </select>
            </div>
            <input
              bind:value={draft.location}
              placeholder={t("calendar.locationPlaceholder")}
              aria-label={t("calendar.location")}
              data-testid="cal-location-input"
              class={FIELD}
            />
            <input
              bind:value={draft.notes}
              placeholder={t("calendar.notesPlaceholder")}
              aria-label={t("calendar.notes")}
              data-testid="cal-notes-input"
              class={FIELD}
            />
          </div>
          {#if editId}
            <div class={SUB}></div>
            <div class="px-4 py-2">
              <button onclick={del} data-testid="cal-delete" class={btn("danger")}>
                {t("calendar.delete")}
              </button>
            </div>
          {/if}
          <div class={SUB}></div>
          <div class="flex items-center justify-end gap-2 px-4 py-2">
            <button onclick={closeEditor} data-testid="cal-cancel" class={btn("neutral")}>
              {t("calendar.cancel")}
            </button>
            <button
              onclick={commit}
              disabled={!draft.title.trim()}
              data-testid="cal-save"
              class={btn("accent")}
            >{t("calendar.save")}</button>
          </div>
        </div>
        {#if editId && draft.repeat !== "none"}
          <p class="px-1 pt-1 text-[10px] opacity-40" data-testid="cal-series-hint">
            {t("calendar.seriesHint")}
          </p>
        {/if}
        <p class="px-1 pt-1 text-[10px] opacity-40">{t("calendar.repeatHint")}</p>
      </div>
    {/if}
  </div>
</div>

{#snippet eventRow(occ: Occurrence, day: number)}
  {@const cont = isContinuation(occ, day)}
  {@const span = spanLabel(occ)}
  <button
    onclick={() => openEdit(occ)}
    data-event={occ.event.id}
    data-occ={occ.startAt}
    data-continuation={cont ? "true" : "false"}
    data-span-days={spansDays(occ) ? "true" : "false"}
    aria-label={`${timeLabel(occ, day)} ${occ.event.title}`}
    class="flex w-full items-stretch gap-2.5 px-3 py-2 text-left"
  >
    <span class={"w-1 shrink-0 rounded-full " + BG[colorOf(occ.event.calendarId)]}></span>
    <span class={"w-12 shrink-0 pt-0.5 text-[11px] tabular-nums " +
      (occ.event.allDay || cont ? "opacity-55" : "opacity-60")}>
      {timeLabel(occ, day)}
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-[15px] leading-snug">{occ.event.title}</span>
      {#if occ.event.location || occ.event.repeat !== "none" || span}
        <span class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs opacity-55">
          {#if span}<span class="tabular-nums">{span}</span>{/if}
          {#if occ.event.location}<span class="truncate">{occ.event.location}</span>{/if}
          {#if occ.event.repeat !== "none"}
            <span class={TEXT[colorOf(occ.event.calendarId)]}>{repeatLabel(occ.event.repeat)}</span>
          {/if}
        </span>
      {/if}
    </span>
  </button>
{/snippet}


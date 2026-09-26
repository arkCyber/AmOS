<script lang="ts">
  // WidgetCalendar.svelte — the home screen's "next event" widget.
  //
  // It shows the soonest thing on the user's calendar (`lib/calendar::nextEvent`), reading
  // the SAME stores the Calendar app writes (`amos.calendar` events + `amos.calendars`
  // groups), so the tile and the app cannot disagree. Repeating events are expanded, so a
  // daily stand-up shows its next occurrence rather than the series' original start.
  //
  // It applies the app's visibility rule (`visibleEvents`): an event on a calendar the user
  // unchecked is filtered out of every app view *and* out of the OS alerts
  // (`collectDueEventAlerts`), so a muted calendar must be muted here too — otherwise the
  // tile advertises an event the app itself refuses to draw. (REQ-A1839 ∕ F-SH-910)
  //
  // Honest when there is nothing to show: an empty (or unreadable) calendar renders the
  // "nothing coming up" line — never a placeholder event.
  //
  // Separate component for the same reason as `WidgetBattery`: the store subscriptions and
  // the 1-minute tick exist only while the widget is actually placed.
  import { createStoreValue } from "../store";
  import {
    CALENDAR_KEY,
    CALENDARS_KEY,
    nextEvent,
    normalizeCalendars,
    normalizeEvents,
    visibleEvents,
    type Occurrence,
  } from "../../lib/calendar";
  import { t, locale } from "../locale.svelte";

  let { onopen }: { onopen: () => void } = $props();

  const calStore = createStoreValue<unknown>(CALENDAR_KEY, []);
  let raw = $state<unknown>([]);
  $effect(() => {
    const un = calStore.subscribe((v) => (raw = v));
    return un;
  });

  const groupsStore = createStoreValue<unknown>(CALENDARS_KEY, []);
  let rawGroups = $state<unknown>([]);
  $effect(() => {
    const un = groupsStore.subscribe((v) => (rawGroups = v));
    return un;
  });

  /** Re-evaluated every minute so an event that has just started (or passed) is reflected
   *  without waiting for the store to change. */
  const TICK_MS = 60_000;
  let now = $state(Date.now());
  $effect(() => {
    const id = window.setInterval(() => (now = Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  });

  const next = $derived<Occurrence | null>(
    nextEvent(
      visibleEvents(normalizeEvents(raw), normalizeCalendars(rawGroups)),
      now,
    ),
  );

  const when = $derived.by(() => {
    const occ = next;
    if (!occ) return "";
    return new Intl.DateTimeFormat(locale() === "zh" ? "zh-CN" : "en-US", {
      weekday: "short",
      ...(occ.event.allDay
        ? { month: "short", day: "numeric" }
        : { hour: "2-digit", minute: "2-digit" }),
    }).format(new Date(occ.startAt));
  });
</script>

<!-- The name carries the reading, like the clock tile in `HomeWidgets` (whose label is
     `${t("a11y.currentTime")} · HH:MM`): this tile's own content is either `aria-hidden`
     (the time) or would be overridden by a constant `aria-label` (the title), so a bare
     `t("widget.calendar")` leaves a screen reader with no idea what is coming up. -->
<button
  class="flex w-full items-center gap-3 rounded-3xl bg-white/40 px-5 py-4 text-left shadow-sm ring-1 ring-black/5 backdrop-blur-md transition active:scale-95 dark:bg-white/10 dark:ring-white/10"
  aria-label={next
    ? `${t("widget.calendar")} · ${next.event.title} ${when}`
    : `${t("widget.calendar")} · ${t("widget.calendarNone")}`}
  data-testid="home-widget-calendar"
  onclick={onopen}
>
  <span aria-hidden="true" class="text-2xl">📅</span>
  {#if next}
    <span class="flex min-w-0 flex-col">
      <span
        class="truncate text-sm font-medium text-neutral-900 dark:text-white"
        data-testid="home-widget-calendar-title">{next.event.title}</span
      >
      <span class="text-xs text-neutral-600/90 dark:text-neutral-300/90" aria-hidden="true"
        >{when}</span
      >
    </span>
  {:else}
    <span class="text-sm text-neutral-600/90 dark:text-neutral-300/90"
      >{t("widget.calendarNone")}</span
    >
  {/if}
</button>

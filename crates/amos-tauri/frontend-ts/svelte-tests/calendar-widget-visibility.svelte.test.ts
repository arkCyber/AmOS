/**
 * calendar-widget-visibility.svelte.test.ts — the home "next event" tile must agree with
 * the Calendar app about which events exist.
 *
 * `WidgetCalendar.svelte` states the invariant in its own header: it reads "the SAME store
 * the Calendar app writes (`amos.calendar`), so the tile and the app cannot disagree". But
 * the app draws `visibleEvents(events, groups)` — an event on a calendar the user unchecked
 * (muted) is filtered out of every view and out of the OS alerts (`collectDueEventAlerts`
 * does the same). The tile only subscribed to `amos.calendar`, never `amos.calendars`, so a
 * muted calendar's event still claimed the home screen's single line. These tests pin the
 * agreement: the tile honours the same visibility rule the app's views do.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import WidgetCalendar from "../src/svelte/widgets/WidgetCalendar.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { CALENDAR_KEY, CALENDARS_KEY, type CalendarEvent, type CalendarGroup } from "../src/lib/calendar";
import { zh } from "../src/i18n/locales/zh";

const label = (key: string): string => zh[key as keyof typeof zh] ?? key;

const HOUR = 60 * 60 * 1000;

function group(id: string, enabled: boolean): CalendarGroup {
  return { id, custom: id !== "personal", name: id, color: "blue", enabled, createdAt: 0 };
}

function event(id: string, calendarId: string, startAt: number): CalendarEvent {
  return {
    id,
    calendarId,
    title: id,
    startAt,
    endAt: startAt + HOUR,
    allDay: false,
    repeat: "none",
    alertMinutes: null,
    createdAt: 0,
  };
}

const titleOf = (container: HTMLElement): string | null | undefined =>
  container.querySelector('[data-testid="home-widget-calendar-title"]')?.textContent;

beforeEach(() => {
  window.localStorage.clear();
});

describe("WidgetCalendar.svelte — a muted calendar is muted on the home tile too", () => {
  test("the next event is the soonest VISIBLE one, not a muted calendar's sooner event", async () => {
    const now = Date.now();
    // "muted-event" starts first but lives on the unchecked calendar; the app hides it.
    writeStoreValue(CALENDAR_KEY, [
      event("muted-event", "muted", now + 1 * HOUR),
      event("visible-event", "personal", now + 5 * HOUR),
    ]);
    writeStoreValue(CALENDARS_KEY, [group("personal", true), group("muted", false)]);

    const { container } = render(WidgetCalendar, { props: { onopen: () => {} } });
    await tick();

    expect(titleOf(container)).toBe("visible-event");
  });

  test("a muted calendar's only event leaves the tile honestly empty", async () => {
    const now = Date.now();
    writeStoreValue(CALENDAR_KEY, [event("muted-only", "muted", now + 1 * HOUR)]);
    writeStoreValue(CALENDARS_KEY, [group("muted", false)]);

    const { container } = render(WidgetCalendar, { props: { onopen: () => {} } });
    await tick();

    expect(container.querySelector('[data-testid="home-widget-calendar-title"]')).toBeNull();
    expect(container.textContent).toContain(label("widget.calendarNone"));
  });

  test("positive control — with no calendar groups stored, the soonest event still shows", async () => {
    const now = Date.now();
    writeStoreValue(CALENDAR_KEY, [
      event("first", "personal", now + 1 * HOUR),
      event("second", "personal", now + 5 * HOUR),
    ]);

    const { container } = render(WidgetCalendar, { props: { onopen: () => {} } });
    await tick();

    expect(titleOf(container)).toBe("first");
  });
});

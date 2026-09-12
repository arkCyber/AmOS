/**
 * DOM tests for the Svelte 5 calendar screen (CalendarApp.svelte).
 *
 * The domain logic is unit-tested against pure lib/calendar.ts and the OS-alert
 * reconciler against lib/calendarCore.ts. Here we verify the Svelte wiring on
 * the shared amos.calendar / amos.calendars store: month grid, selected-day
 * schedule, add / edit / delete through the form, calendar visibility toggles,
 * search filtering, view switch, and month navigation.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import CalendarApp from "../src/svelte/CalendarApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { calendarWatcherTick } from "../src/svelte/osCalendarWatcher";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { NOTIF_KEY } from "../src/lib/settings";
import {
  CALENDAR_KEY,
  CALENDARS_KEY,
  DEFAULT_CALENDAR_ID,
  startOfWeek,
  toDateInput,
  type CalendarEvent,
  type CalendarGroup,
} from "../src/lib/calendar";

afterEach(() => {
  cleanup();
  setLocale("zh");
});

type Host = { container: HTMLElement };

const txt = (h: Host) => h.container.textContent ?? "";
const el = <T extends Element>(h: Host, sel: string) => h.container.querySelector(sel) as T | null;

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return
 * a restore function. (`window.localStorage` is a per-access proxy, so the prototype
 * cannot be patched — the window property itself is replaced.)
 */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}
const rows = (h: Host) =>
  [...h.container.querySelectorAll("[data-event]")].map((r) => r.getAttribute("data-event"));

const DAY = 86_400_000;

/** Deterministic fixture anchored on the viewer's local "today". */
function seed() {
  const now = Date.now();
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const d0 = day.getTime();
  const groups: CalendarGroup[] = [
    { id: DEFAULT_CALENDAR_ID, custom: false, name: "", color: "blue", enabled: true, createdAt: now },
    { id: "work", custom: true, name: "工作", color: "indigo", enabled: true, createdAt: now + 1 },
  ];
  const events: CalendarEvent[] = [
    { id: "e1", calendarId: DEFAULT_CALENDAR_ID, title: "早餐会", startAt: d0 + 9 * 3_600_000, endAt: d0 + 10 * 3_600_000, allDay: false, repeat: "none", alertMinutes: 15, createdAt: now, location: "厨房" },
    { id: "e2", calendarId: "work", title: "周会", startAt: d0 + 14 * 3_600_000, endAt: d0 + 15 * 3_600_000, allDay: false, repeat: "weekly", alertMinutes: null, createdAt: now + 1 },
    { id: "e3", calendarId: DEFAULT_CALENDAR_ID, title: "国庆", startAt: d0, endAt: d0 + DAY, allDay: true, repeat: "none", alertMinutes: null, createdAt: now + 2 },
    { id: "e4", calendarId: DEFAULT_CALENDAR_ID, title: "明天的事", startAt: d0 + DAY + 10 * 3_600_000, endAt: d0 + DAY + 11 * 3_600_000, allDay: false, repeat: "none", alertMinutes: null, createdAt: now + 3 },
  ];
  writeStoreValue(CALENDARS_KEY, groups);
  writeStoreValue(CALENDAR_KEY, events);
  return { now, d0, groups, events };
}

const storedEvents = () => readStoreValue<CalendarEvent[]>(CALENDAR_KEY, []);
const storedGroups = () => readStoreValue<CalendarGroup[]>(CALENDARS_KEY, []);

describe("CalendarApp.svelte — month grid", () => {
  test("an intentionally emptied store is not re-seeded with demo events", () => {
    window.localStorage.setItem("amos.calendar", "[]");
    window.localStorage.setItem("amos.calendars", "[]");
    const host = render(CalendarApp);
    // The built-in default calendar is repaired, but the demo events must not return.
    expect(txt(host)).not.toContain("团队同步");
    expect(readStoreValue<unknown>("amos.calendar", null)).toEqual([]);
  });

  test("renders a 6×7 grid and marks exactly one 'today' cell", () => {
    const { d0 } = seed();
    const host = render(CalendarApp);
    expect(el(host, '[data-testid="cal-grid"]')).toBeTruthy();
    const cells = host.container.querySelectorAll("[data-day]");
    expect(cells.length).toBe(42);
    const today = host.container.querySelectorAll('[data-today="true"]');
    expect(today.length).toBe(1);
    const expectDay = new Date(d0);
    const expectStr = `${expectDay.getFullYear()}-${String(expectDay.getMonth() + 1).padStart(2, "0")}-${String(expectDay.getDate()).padStart(2, "0")}`;
    expect(today[0]!.getAttribute("data-day")).toBe(expectStr);
    expect(today[0]!.getAttribute("data-selected")).toBe("true");
  });

  test("the selected day's schedule lists all-day first, then by start time", () => {
    seed();
    const host = render(CalendarApp);
    expect(rows(host)).toEqual(["e3", "e1", "e2"]);
    const first = el<HTMLElement>(host, '[data-event="e3"]');
    expect(first!.textContent).toContain("全天");
    expect(txt(host)).toContain("早餐会");
    expect(txt(host)).toContain("厨房");
  });

  test("selecting another day shows that day's schedule", async () => {
    const { d0 } = seed();
    const host = render(CalendarApp);
    const tomorrow = new Date(d0 + DAY);
    const cell = host.container.querySelector(
      `[data-day="${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}"]`,
    ) as HTMLButtonElement;
    await fireEvent.click(cell);
    expect(rows(host)).toEqual(["e4"]);
    expect(txt(host)).toContain("明天的事");
  });

  test("empty day shows the localized empty state", async () => {
    const { d0 } = seed();
    const host = render(CalendarApp);
    const far = new Date(d0 + 3 * DAY);
    const cell = host.container.querySelector(
      `[data-day="${far.getFullYear()}-${String(far.getMonth() + 1).padStart(2, "0")}-${String(far.getDate()).padStart(2, "0")}"]`,
    ) as HTMLButtonElement;
    await fireEvent.click(cell);
    expect(el(host, '[data-testid="cal-day-empty"]')!.textContent).toContain("这一天没有日程");
    expect(rows(host)).toEqual([]);
  });

  test("month navigation changes the title and Today returns to this month", async () => {
    seed();
    const host = render(CalendarApp);
    const title = () => el(host, '[data-testid="cal-title"]')!.textContent!.trim();
    const start = title();
    await fireEvent.click(el(host, '[data-testid="cal-next"]')!);
    const next = title();
    expect(next).not.toBe(start);
    await fireEvent.click(el(host, '[data-testid="cal-prev"]')!);
    expect(title()).toBe(start);
    await fireEvent.click(el(host, '[data-testid="cal-next"]')!);
    await fireEvent.click(el(host, '[data-testid="cal-today"]')!);
    expect(title()).toBe(start);
  });
});

/** `YYYY-MM-DD` in local time (the value an <input type="date"> carries). */
function dstr(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("CalendarApp.svelte — create / edit / delete", () => {
  test("adds an event for the selected day and persists it", async () => {
    const { d0 } = seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-testid="cal-new"]')!);
    expect(el(host, '[data-testid="cal-editor"]')).toBeTruthy();

    const title = el<HTMLInputElement>(host, '[data-testid="cal-title-input"]')!;
    await fireEvent.input(title, { target: { value: "牙医" } });
    await fireEvent.input(el(host, '[data-testid="cal-start-time"]')!, {
      target: { value: "11:30" },
    });
    await fireEvent.click(el(host, '[data-testid="cal-save"]')!);

    // editor closed, row visible, and the store really holds the new event
    expect(el(host, '[data-testid="cal-editor"]')).toBeNull();
    const saved = storedEvents().find((e) => e.title === "牙医");
    expect(saved).toBeTruthy();
    expect(saved!.startAt).toBe(d0 + 11 * 3_600_000 + 30 * 60_000);
    expect(rows(host)).toContain(saved!.id);
  });

  test("a rejected write is reported and the event is not applied", async () => {
    seed();
    const restore = failWritesFor(CALENDAR_KEY);
    try {
      const host = render(CalendarApp);
      await fireEvent.click(el(host, '[data-testid="cal-new"]')!);
      await fireEvent.input(el<HTMLInputElement>(host, '[data-testid="cal-title-input"]')!, {
        target: { value: "牙医" },
      });
      await fireEvent.click(el(host, '[data-testid="cal-save"]')!);
      // Not stored ⇒ not claimed: banner, the editor stays open with the draft, and no
      // phantom row (it would vanish on reload).
      expect(txt(host)).toContain("本机存储写入失败");
      expect(el(host, '[data-testid="cal-editor"]')).toBeTruthy();
      expect(storedEvents().some((e) => e.title === "牙医")).toBe(false);
    } finally {
      restore();
    }
  });

  test("a blank title cannot be saved (no phantom event)", async () => {
    seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-testid="cal-new"]')!);
    const save = el<HTMLButtonElement>(host, '[data-testid="cal-save"]')!;
    expect(save.disabled).toBe(true);
    await fireEvent.click(save);
    expect(storedEvents().length).toBe(4); // unchanged
  });

  test("opens an existing event, edits the title, and saves in place", async () => {
    const { d0 } = seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-event="e1"]')!);
    const title = el<HTMLInputElement>(host, '[data-testid="cal-title-input"]')!;
    expect(title.value).toBe("早餐会");
    expect(el<HTMLSelectElement>(host, '[data-testid="cal-alert-select"]')!.value).toBe("15");

    await fireEvent.input(title, { target: { value: "站会" } });
    await fireEvent.click(el(host, '[data-testid="cal-save"]')!);

    const e1 = storedEvents().find((e) => e.id === "e1")!;
    expect(e1.title).toBe("站会");
    expect(e1.startAt).toBe(d0 + 9 * 3_600_000); // unchanged
    expect(txt(host)).toContain("站会");
    expect(txt(host)).not.toContain("早餐会");
  });

  test("deletes an event through the editor", async () => {
    seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-event="e2"]')!);
    // the editor reflects the stored row (calendar + weekly repeat + no alert)
    expect(el<HTMLSelectElement>(host, '[data-testid="cal-calendar-select"]')!.value).toBe("work");
    expect(el<HTMLSelectElement>(host, '[data-testid="cal-repeat-select"]')!.value).toBe("weekly");
    expect(el<HTMLSelectElement>(host, '[data-testid="cal-alert-select"]')!.value).toBe("none");
    expect(txt(host)).toContain("每周");

    await fireEvent.click(el(host, '[data-testid="cal-delete"]')!);
    expect(storedEvents().map((e) => e.id)).not.toContain("e2");
    expect(rows(host)).toEqual(["e3", "e1"]);
  });

  test("the all-day switch swaps the time inputs for a plain end date", async () => {
    seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-testid="cal-new"]')!);
    expect(el(host, '[data-testid="cal-start-time"]')).toBeTruthy();
    expect(el(host, '[data-testid="cal-end-time"]')).toBeTruthy();
    expect(el(host, '[data-testid="cal-end-date"]')).toBeTruthy();

    await fireEvent.click(el(host, '[data-testid="cal-allday"]')!);
    // times are gone, but the end DATE stays so a span can be entered
    expect(el(host, '[data-testid="cal-start-time"]')).toBeNull();
    expect(el(host, '[data-testid="cal-end-time"]')).toBeNull();
    expect(el(host, '[data-testid="cal-end-date"]')).toBeTruthy();

    await fireEvent.input(el(host, '[data-testid="cal-title-input"]')!, {
      target: { value: "假期" },
    });
    await fireEvent.click(el(host, '[data-testid="cal-save"]')!);
    const saved = storedEvents().find((e) => e.title === "假期")!;
    // all-day spans at least one whole local day, starting at midnight
    const start = new Date(saved.startAt);
    expect(start.getHours()).toBe(0);
    expect(saved.endAt).toBeGreaterThanOrEqual(saved.startAt + DAY);
  });

  test("rejects an impossible date instead of saving nonsense", async () => {
    seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-testid="cal-new"]')!);
    await fireEvent.input(el(host, '[data-testid="cal-title-input"]')!, {
      target: { value: "坏日期" },
    });
    await fireEvent.input(el(host, '[data-testid="cal-start-date"]')!, {
      target: { value: "2026-02-31" },
    });
    await fireEvent.click(el(host, '[data-testid="cal-save"]')!);
    expect(storedEvents().some((e) => e.title === "坏日期")).toBe(false);
  });

  test("cancel closes the editor and discards the draft", async () => {
    seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-testid="cal-new"]')!);
    await fireEvent.input(el(host, '[data-testid="cal-title-input"]')!, {
      target: { value: "丢弃我" },
    });
    await fireEvent.click(el(host, '[data-testid="cal-cancel"]')!);
    expect(el(host, '[data-testid="cal-editor"]')).toBeNull();
    expect(storedEvents().some((e) => e.title === "丢弃我")).toBe(false);
  });
});


describe("CalendarApp.svelte — search + views", () => {
  test("search narrows the schedule to matching events (and reports the count)", async () => {
    seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, 'button[data-icon="search"]')!);
    const input = el<HTMLInputElement>(host, '[data-testid="cal-search"]')!;
    await fireEvent.input(input, { target: { value: "周会" } });
    expect(rows(host)).toEqual(["e2"]);
    expect(el(host, '[data-testid="cal-matches"]')!.textContent).toContain("1");

    await fireEvent.input(input, { target: { value: "没有这个" } });
    expect(rows(host)).toEqual([]);
    expect(el(host, '[data-testid="cal-day-empty"]')!.textContent).toContain("没有匹配的日程");

    // Toggling search off clears the filter.
    await fireEvent.click(el(host, 'button[data-icon="x"]')!);
    expect(el(host, '[data-testid="cal-search"]')).toBeNull();
  });

  test("the agenda view lists upcoming events grouped by day", async () => {
    const { d0 } = seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-view="agenda"]')!);
    const days = [...host.container.querySelectorAll("[data-agenda-day]")];
    // today + tomorrow, then the weekly repeat keeps expanding the window
    expect(days.length).toBeGreaterThanOrEqual(3);
    expect(days[0]!.getAttribute("data-agenda-day")).toBe(String(d0));
    expect(days[1]!.getAttribute("data-agenda-day")).toBe(String(d0 + DAY));
    expect(txt(host)).toContain("明天的事");
    expect(txt(host)).toContain("周会");
    // switching back restores the month grid
    await fireEvent.click(el(host, '[data-view="month"]')!);
    expect(el(host, '[data-testid="cal-grid"]')).toBeTruthy();
  });
});

describe("CalendarApp.svelte — week view", () => {
  /** Add one deterministic event inside THIS week (region-first Monday, zh). */
  function seedInsideThisWeek(): number {
    const { d0 } = seed();
    const monday = startOfWeek(d0, 1);
    const anchor: CalendarEvent = {
      id: "eW",
      calendarId: DEFAULT_CALENDAR_ID,
      title: "本周一",
      startAt: monday + 8 * 3_600_000,
      endAt: monday + 9 * 3_600_000,
      allDay: false,
      repeat: "none",
      alertMinutes: null,
      createdAt: Date.now(),
    };
    writeStoreValue(CALENDAR_KEY, [...storedEvents(), anchor]);
    return d0;
  }

  const weekDaysShown = (h: Host) =>
    [...h.container.querySelectorAll("[data-week-day]")].map((n) =>
      Number(n.getAttribute("data-week-day")),
    );

  test("the week tab renders 7 day sections anchored on the region's first weekday", async () => {
    const d0 = seedInsideThisWeek();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-view="week"]')!);

    expect(el(host, '[data-testid="cal-week"]')).toBeTruthy();
    const days = weekDaysShown(host);
    expect(days.length).toBe(7);
    expect(new Date(days[0]!).getDay()).toBe(1); // zh → Monday-first
    for (let i = 1; i < days.length; i += 1) {
      const step = days[i]! - days[i - 1]!;
      expect(step).toBeGreaterThanOrEqual(23 * 3_600_000);
      expect(step).toBeLessThanOrEqual(25 * 3_600_000);
    }
    // Exactly one cell is "today", and it is the day the app selected.
    const today = [...host.container.querySelectorAll('[data-week-day][data-today="true"]')];
    expect(today.length).toBe(1);
    expect(Number(today[0]!.getAttribute("data-week-day"))).toBe(d0);
    // The Monday event is inside this week; the day's schedule renders it.
    expect(txt(host)).toContain("本周一");
    expect(rows(host)).toContain("eW");
  });

  test("‹ › move the week by seven days and Today comes back", async () => {
    seedInsideThisWeek();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-view="week"]')!);
    const first = () => weekDaysShown(host)[0]!;

    const before = first();
    await fireEvent.click(el(host, '[data-testid="cal-next"]')!);
    const after = first();
    expect(after).toBeGreaterThan(before);
    // DST-tolerant: a week is 7 days ±1h.
    expect(after - before).toBeGreaterThanOrEqual(7 * DAY - 3_600_000);
    expect(after - before).toBeLessThanOrEqual(7 * DAY + 3_600_000);
    expect(host.container.querySelector('[data-week-day][data-today="true"]')).toBeNull();

    // Back one week is exact (wall-clock inverse of the forward step).
    await fireEvent.click(el(host, '[data-testid="cal-prev"]')!);
    expect(first()).toBe(before);

    // ...and Today returns to the week that contains today.
    await fireEvent.click(el(host, '[data-testid="cal-next"]')!);
    await fireEvent.click(el(host, '[data-testid="cal-today"]')!);
    expect(host.container.querySelector('[data-week-day][data-today="true"]')).toBeTruthy();
  });

  test("en starts the week view on Sunday too (same region rule as the grid)", async () => {
    setLocale("en");
    seedInsideThisWeek();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-view="week"]')!);
    expect(new Date(weekDaysShown(host)[0]!).getDay()).toBe(0);
  });
});

describe("CalendarApp.svelte — repeat-occurrence editing", () => {
  /**
   * A DAILY repeat anchored YESTERDAY 09:00, so today's row is a *later*
   * occurrence than the series anchor — the case that used to show yesterday's
   * date in the editor.
   */
  function seedRepeat(): { d0: number; anchor: number } {
    const { d0 } = seed();
    const anchor = d0 - DAY + 9 * 3_600_000;
    const r: CalendarEvent = {
      id: "r1",
      calendarId: DEFAULT_CALENDAR_ID,
      title: "晨会",
      startAt: anchor,
      endAt: anchor + 3_600_000,
      allDay: false,
      repeat: "daily",
      alertMinutes: null,
      createdAt: Date.now(),
    };
    writeStoreValue(CALENDAR_KEY, [r]);
    return { d0, anchor };
  }

  test("the editor opens on the tapped occurrence's date, not the series anchor", async () => {
    const { d0 } = seedRepeat();
    const host = render(CalendarApp);
    // Today is selected; its schedule holds today's occurrence of r1.
    await fireEvent.click(el(host, '[data-event="r1"]')!);
    expect(el(host, '[data-testid="cal-editor"]')).toBeTruthy();
    const startDate = el<HTMLInputElement>(host, '[data-testid="cal-start-date"]')!;
    expect(startDate.value).toBe(toDateInput(d0)); // TODAY, not yesterday's anchor
    expect(el<HTMLInputElement>(host, '[data-testid="cal-end-date"]')!.value).toBe(toDateInput(d0));
    // ...and it is honest that this edits the whole series.
    expect(el(host, '[data-testid="cal-series-hint"]')).toBeTruthy();
  });

  test("saving an unchanged repeat occurrence leaves the series anchor untouched", async () => {
    const { anchor } = seedRepeat();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-event="r1"]')!);
    await fireEvent.click(el(host, '[data-testid="cal-save"]')!);
    const e = storedEvents().find((x) => x.id === "r1")!;
    expect(e.startAt).toBe(anchor); // exact identity — no drift
    expect(e.endAt).toBe(anchor + 3_600_000);
    expect(e.repeat).toBe("daily");
  });

  test("moving a repeat occurrence re-anchors the series by the same wall-clock offset", async () => {
    const { anchor } = seedRepeat();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-event="r1"]')!);
    await fireEvent.input(el(host, '[data-testid="cal-start-time"]')!, {
      target: { value: "10:30" },
    });
    await fireEvent.input(el(host, '[data-testid="cal-end-time"]')!, { target: { value: "11:30" } });
    await fireEvent.click(el(host, '[data-testid="cal-save"]')!);
    const e = storedEvents().find((x) => x.id === "r1")!;
    const wantStart = new Date(anchor);
    wantStart.setHours(10, 30, 0, 0);
    const wantEnd = new Date(anchor);
    wantEnd.setHours(11, 30, 0, 0);
    expect(e.startAt).toBe(wantStart.getTime());
    expect(e.endAt).toBe(wantEnd.getTime());
  });

  test("a non-repeating event still edits its own date (no offset surprise)", async () => {
    const { d0 } = seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-event="e1"]')!);
    await fireEvent.input(el(host, '[data-testid="cal-start-date"]')!, {
      target: { value: toDateInput(d0 + DAY) },
    });
    await fireEvent.click(el(host, '[data-testid="cal-save"]')!);
    const e = storedEvents().find((x) => x.id === "e1")!;
    expect(toDateInput(e.startAt)).toBe(toDateInput(d0 + DAY));
    expect(e.startAt - e.endAt).toBe(-3_600_000); // one-hour duration preserved
  });
});

describe("CalendarApp.svelte — calendars manager", () => {
  test("creates a calendar with a chosen colour", async () => {
    seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-testid="cal-manage"]')!);
    expect(el(host, '[data-testid="cal-manage-panel"]')).toBeTruthy();

    await fireEvent.input(el(host, '[data-testid="cal-cname"]')!, { target: { value: "旅行" } });
    await fireEvent.click(el(host, '[data-color="pink"]')!);
    await fireEvent.click(el(host, '[data-testid="cal-create"]')!);

    const groups = storedGroups();
    expect(groups.length).toBe(3);
    expect(groups[2]!.name).toBe("旅行");
    expect(groups[2]!.color).toBe("pink");
    expect(groups[2]!.enabled).toBe(true);
  });

  test("unchecking a calendar hides its events everywhere, re-checking restores them", async () => {
    seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-testid="cal-manage"]')!);
    await fireEvent.click(el(host, '[data-cal-toggle="work"]')!);
    expect(storedGroups().find((g) => g.id === "work")!.enabled).toBe(false);
    expect(rows(host)).toEqual(["e3", "e1"]); // e2 (work) gone
    expect(txt(host)).not.toContain("周会");

    await fireEvent.click(el(host, '[data-cal-toggle="work"]')!);
    expect(rows(host)).toEqual(["e3", "e1", "e2"]);
  });

  test("deleting a calendar reassigns its events to the default one", async () => {
    seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-testid="cal-manage"]')!);
    await fireEvent.click(el(host, '[data-cal-delete="work"]')!);
    expect(storedGroups().some((g) => g.id === "work")).toBe(false);
    const e2 = storedEvents().find((e) => e.id === "e2")!;
    expect(e2.calendarId).toBe(DEFAULT_CALENDAR_ID);
    expect(rows(host)).toContain("e2"); // still visible, now on the default calendar
  });
});

describe("osCalendarWatcher", () => {
  test("tick is suppressed while the Calendar app is focused", () => {
    const { d0 } = seed(); // e1 alerts 15 minutes before 09:00
    const alertAt = d0 + 8 * 3_600_000 + 45 * 60_000;
    expect(calendarWatcherTick("calendar", alertAt)).toBe(false);
    expect(readStoreValue(NOTIF_KEY, [])).toEqual([]);
  });

  test("tick publishes a real OS notification when another app is focused", () => {
    const { d0 } = seed();
    const alertAt = d0 + 8 * 3_600_000 + 45 * 60_000;
    expect(calendarWatcherTick("clock", alertAt)).toBe(true);
    const notifs = readStoreValue<{ id: string; title?: string }[]>(NOTIF_KEY, []);
    expect(notifs.length).toBe(1);
    expect(notifs[0]!.id.startsWith("cal:")).toBe(true);
    expect(notifs[0]!.title).toContain("早餐会");
    // Idempotent: a second tick at the same instant adds nothing.
    calendarWatcherTick("clock", alertAt + 1000);
    expect(readStoreValue<unknown[]>(NOTIF_KEY, []).length).toBe(1);
  });
});


/** Fixture with a 3-day all-day span (today…today+2) plus a cross-midnight shift. */
function seedMultiDay() {
  const now = Date.now();
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const d0 = day.getTime();
  const groups: CalendarGroup[] = [
    { id: DEFAULT_CALENDAR_ID, custom: false, name: "", color: "blue", enabled: true, createdAt: now },
  ];
  const events: CalendarEvent[] = [
    {
      id: "holiday", calendarId: DEFAULT_CALENDAR_ID, title: "年假",
      startAt: d0, endAt: d0 + 3 * DAY, allDay: true, repeat: "none",
      alertMinutes: null, createdAt: now,
    },
    {
      id: "night", calendarId: DEFAULT_CALENDAR_ID, title: "夜班",
      startAt: d0 + 22 * 3_600_000, endAt: d0 + DAY + 6 * 3_600_000, allDay: false,
      repeat: "none", alertMinutes: null, createdAt: now + 1,
    },
  ];
  writeStoreValue(CALENDARS_KEY, groups);
  writeStoreValue(CALENDAR_KEY, events);
  return { d0 };
}

describe("CalendarApp.svelte — multi-day events", () => {
  test("a multi-day event dots every day it covers (and none outside)", () => {
    const { d0 } = seedMultiDay();
    const host = render(CalendarApp);
    const dots = (ms: number) =>
      host.container
        .querySelector(`[data-day="${dstr(ms)}"] [data-dots]`)!
        .getAttribute("data-dots");
    expect(dots(d0)).toBe("2"); // 年假 + 夜班
    expect(dots(d0 + DAY)).toBe("2"); // both continue into tomorrow
    expect(dots(d0 + 2 * DAY)).toBe("1"); // 年假 only — 夜班 ended tomorrow 06:00
    expect(dots(d0 + 4 * DAY)).toBe("0"); // span is over
  });

  test("a continuing event shows 全天 / → end-time, never a stale start time", async () => {
    const { d0 } = seedMultiDay();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, `[data-day="${dstr(d0 + DAY)}"]`)!);

    const holiday = el<HTMLElement>(host, '[data-event="holiday"]')!;
    expect(holiday.getAttribute("data-span-days")).toBe("true");
    expect(holiday.getAttribute("data-continuation")).toBe("true");
    expect(holiday.textContent).toContain("全天");
    // Span label is LOCALIZED (zh: "9月1日 – 9月3日"), never an ISO range.
    expect(holiday.textContent).toMatch(/\d+月\d+日 – \d+月\d+日/);
    expect(holiday.textContent).not.toMatch(/\d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}/);

    // The cross-midnight timed event reports the time it FINISHES here (06:00),
    // not the 22:00 it started yesterday.
    const night = el<HTMLElement>(host, '[data-event="night"]')!;
    expect(night.getAttribute("data-continuation")).toBe("true");
    expect(night.textContent).toContain("→ 06:00");
    expect(night.textContent).not.toContain("22:00");
  });

  test("the editor can create a multi-day all-day span", async () => {
    const { d0 } = seedMultiDay();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-testid="cal-new"]')!);
    await fireEvent.input(el(host, '[data-testid="cal-title-input"]')!, {
      target: { value: "出差" },
    });
    await fireEvent.click(el(host, '[data-testid="cal-allday"]')!);
    await fireEvent.input(el(host, '[data-testid="cal-end-date"]')!, {
      target: { value: dstr(d0 + 2 * DAY) }, // inclusive last day
    });
    await fireEvent.click(el(host, '[data-testid="cal-save"]')!);

    const saved = storedEvents().find((e) => e.title === "出差")!;
    expect(saved.allDay).toBe(true);
    expect(saved.startAt).toBe(d0); // all-day snaps to local midnight
    expect(saved.endAt).toBe(d0 + 3 * DAY); // exclusive end = last day + 1
    // and the span is visible on each of the three days
    for (const d of [0, 1, 2]) {
      await fireEvent.click(el(host, `[data-day="${dstr(d0 + d * DAY)}"]`)!);
      expect(rows(host)).toContain(saved.id);
    }
  });
});

describe("CalendarApp.svelte — region first weekday", () => {
  test("zh (default) starts the week on Monday", () => {
    seed();
    const host = render(CalendarApp);
    const first = host.container.querySelector("[data-day]")!;
    const [y, m, d] = first.getAttribute("data-day")!.split("-").map(Number);
    expect(new Date(y!, m! - 1, d!).getDay()).toBe(1);
  });

  test("en starts the week on Sunday", () => {
    setLocale("en");
    seed();
    const host = render(CalendarApp);
    const first = host.container.querySelector("[data-day]")!;
    const [y, m, d] = first.getAttribute("data-day")!.split("-").map(Number);
    expect(new Date(y!, m! - 1, d!).getDay()).toBe(0);
    // 42 cells regardless of the week start
    expect(host.container.querySelectorAll("[data-day]").length).toBe(42);
  });
});


describe("CalendarApp.svelte — editing integrity", () => {
  test("changing the start date moves the end date (duration preserved)", async () => {
    const { d0 } = seed();
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-event="e1"]')!); // today 09:00–10:00
    const start = el<HTMLInputElement>(host, '[data-testid="cal-start-date"]')!;
    const end = el<HTMLInputElement>(host, '[data-testid="cal-end-date"]')!;
    expect(start.value).toBe(dstr(d0));
    expect(end.value).toBe(dstr(d0));

    await fireEvent.input(start, { target: { value: dstr(d0 + 2 * DAY) } });
    // end follows by the same whole-day offset (still a same-day 1h event)
    expect(end.value).toBe(dstr(d0 + 2 * DAY));
    expect(el<HTMLInputElement>(host, '[data-testid="cal-start-time"]')!.value).toBe("09:00");

    await fireEvent.click(el(host, '[data-testid="cal-save"]')!);
    const saved = storedEvents().find((e) => e.id === "e1")!;
    expect(saved.startAt).toBe(d0 + 2 * DAY + 9 * 3_600_000);
    expect(saved.endAt).toBe(d0 + 2 * DAY + 10 * 3_600_000); // one hour, not collapsed
  });

  test("changing the start date of a multi-day all-day event keeps its length", async () => {
    const { d0 } = seedMultiDay(); // 年假: today … today+2 (3 days)
    const host = render(CalendarApp);
    await fireEvent.click(el(host, '[data-event="holiday"]')!);
    const start = el<HTMLInputElement>(host, '[data-testid="cal-start-date"]')!;
    const end = el<HTMLInputElement>(host, '[data-testid="cal-end-date"]')!;
    expect(end.value).toBe(dstr(d0 + 2 * DAY)); // inclusive last day

    await fireEvent.input(start, { target: { value: dstr(d0 + 5 * DAY) } });
    expect(end.value).toBe(dstr(d0 + 7 * DAY)); // moved 5 days, still 3 days long
    await fireEvent.click(el(host, '[data-testid="cal-save"]')!);
    const saved = storedEvents().find((e) => e.id === "holiday")!;
    expect(saved.startAt).toBe(d0 + 5 * DAY);
    expect(saved.endAt).toBe(d0 + 8 * DAY); // exclusive end (3 days)
  });

  test("a cross-midnight event shows its start → end on the first day", async () => {
    const { d0 } = seedMultiDay(); // 夜班: today 22:00 → tomorrow 06:00
    const host = render(CalendarApp);
    const night = el<HTMLElement>(host, '[data-event="night"]')!;
    expect(night.getAttribute("data-continuation")).toBe("false"); // shown on its start day
    expect(night.textContent).toContain("22:00 → 06:00");
    expect(night.textContent).toContain("→ 06:00");
  });

  test("day cells expose the event count to assistive tech", () => {
    const { d0 } = seedMultiDay();
    const host = render(CalendarApp);
    const cell = host.container.querySelector(`[data-day="${dstr(d0)}"]`)!;
    expect(cell.getAttribute("aria-label")).toContain("2 个日程");
    const empty = host.container.querySelector(`[data-day="${dstr(d0 + 9 * DAY)}"]`)!;
    expect(empty.getAttribute("aria-label")).toContain("0 个日程");
  });

  test("deleting a calendar cannot leave an orphan event behind", async () => {
    seed();
    const host = render(CalendarApp);
    // open an event that belongs to the "work" calendar, keep the editor open…
    await fireEvent.click(el(host, '[data-event="e2"]')!);
    expect(el<HTMLSelectElement>(host, '[data-testid="cal-calendar-select"]')!.value).toBe("work");
    // …then delete "work" from the manager while it is still open
    await fireEvent.click(el(host, '[data-testid="cal-manage"]')!);
    await fireEvent.click(el(host, '[data-cal-delete="work"]')!);
    // the editor now points at a calendar that exists
    expect(el<HTMLSelectElement>(host, '[data-testid="cal-calendar-select"]')!.value).toBe(
      DEFAULT_CALENDAR_ID,
    );
    await fireEvent.input(el(host, '[data-testid="cal-title-input"]')!, {
      target: { value: "改名后保存" },
    });
    await fireEvent.click(el(host, '[data-testid="cal-save"]')!);

    const ids = new Set(storedGroups().map((g) => g.id));
    for (const e of storedEvents()) expect(ids.has(e.calendarId)).toBe(true); // invariant
    expect(storedEvents().find((e) => e.id === "e2")!.calendarId).toBe(DEFAULT_CALENDAR_ID);
  });
});


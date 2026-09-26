/**
 * home-widgets.svelte.test.ts — the home widget stack as the DOM sees it (vitest).
 *
 * The pure model is pinned by `src/__tests__/homeWidgets.test.ts`; this suite covers the
 * things only a render can show: that the stack honours the *store* (missing key ⇒ the
 * historical clock+weather header; an empty list ⇒ no stack while the grid survives),
 * that the default row is byte-identical to the header this screen used to hard-code, that
 * a tile's tap reaches the shell on the SAME "open" channel as an icon, and that the
 * Edit-Home chips add/remove/reorder by writing the one shared key.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import HomeDock from "../src/svelte/HomeDock.svelte";
import EditHome from "../src/svelte/EditHome.svelte";
import HomeWidgets from "../src/svelte/HomeWidgets.svelte";
import { propsChannel, resetPropsChannels, type PropsChannel } from "../src/svelte/propsBus";
import { HOME_WIDGETS_KEY, WIDGET_CATALOG, widgetAppId } from "../src/lib/homeWidgets";
import { writeStoreValue } from "../src/lib/amosStore";
import { CALENDAR_KEY } from "../src/lib/calendar";
import { zh } from "../src/i18n/locales/zh";

interface HomeProps {
  layout: { page: string[]; dock: string[]; hidden: string[] };
  ext: never[];
  pulseId: string | null;
}

const home = (): PropsChannel<HomeProps> => propsChannel<HomeProps>("home");
const layout = (page: string[], dock: string[] = [], hidden: string[] = []) => ({
  page,
  dock,
  hidden,
});
const label = (key: string): string => zh[key as keyof typeof zh] ?? key;

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
});

afterEach(() => {
  resetPropsChannels();
  // A bridged case (the battery tile) must not leak into an unbridged one, which relies on
  // the reading being the honest "—" rather than whatever the last test's host answered.
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

/** Install a Tauri bridge whose `system_health` reports the given battery level — the same
 *  seam `chrome-widgets.svelte.test.ts` uses to prove the bar follows the daemon's reading. */
function installBatteryBridge(levelPct: number) {
  const invoke = async (cmd: string) =>
    cmd === "system_health" ? { battery_level_pct: levelPct, battery_charging: false } : null;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}

/** Let the async battery poll settle (the widget mounts and polls once). */
const settleBattery = () => new Promise((r) => setTimeout(r, 40));

describe("HomeDock.svelte — the widget stack is store-driven", () => {
  test("no store key ⇒ the default clock+weather header, still the [1fr_auto] one-row shape", async () => {
    home().set({ layout: layout(["notes"], ["phone"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();

    const stack = container.querySelector('[data-testid="home-widgets"]');
    expect(stack).not.toBeNull();
    // The default pair renders as ONE row of two, first stretched — the header the screen
    // hard-coded before this change (a regression here would silently reflow home).
    const row = container.querySelector('[data-testid="home-widgets"] [data-row="2"]');
    expect(row).not.toBeNull();
    expect((row!.className ?? "").replace(/\s/g, "")).toContain("grid-cols-[1fr_auto]");
    // Both tiles are present. Their names carry the reading, not just the app key — the
    // dedicated suite below pins what each one says.
    expect(
      container.querySelector(`button[aria-label^="${label("app.weather")} ·"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(`button[aria-label^="${label("a11y.currentTime")} ·"]`),
    ).not.toBeNull();
  });

  test("an explicit list renders exactly those tiles (battery + calendar, no clock tile)", async () => {
    writeStoreValue(HOME_WIDGETS_KEY, ["battery", "calendar"]);
    home().set({ layout: layout(["notes"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();

    expect(container.querySelector('[data-testid="home-widget-battery"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="home-widget-calendar"]')).not.toBeNull();
    expect(container.querySelector(`button[aria-label="${label("app.weather")}"]`)).toBeNull();
  });

  test("an empty list draws no stack — but the app grid is untouched", async () => {
    writeStoreValue(HOME_WIDGETS_KEY, []);
    home().set({ layout: layout(["notes"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();

    expect(container.querySelector('[data-testid="home-widgets"]')).toBeNull();
    expect(container.querySelector('[data-testid="home-grid"]')).not.toBeNull();
    expect(container.querySelector(`button[aria-label="${label("app.notes")}"]`)).not.toBeNull();
  });

  test("a clock tile's tap opens the clock on the SAME 'open' channel an icon uses", async () => {
    writeStoreValue(HOME_WIDGETS_KEY, ["clock"]);
    home().set({ layout: layout(["notes"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();

    const opens: unknown[] = [];
    const un = home().on((e, d) => {
      if (e === "open") opens.push(d);
    });
    await fireEvent.click(container.querySelector('button[aria-label*="·"]') as HTMLButtonElement);
    un();
    expect(opens).toEqual(["clock"]);
  });

  test("a calendar tile shows the next event's title from the shared calendar store", async () => {
    writeStoreValue(HOME_WIDGETS_KEY, ["calendar"]);
    writeStoreValue(CALENDAR_KEY, [
      { id: "e1", title: "Stand-up", startAt: Date.now() + 60 * 60 * 1000, allDay: false },
    ]);
    home().set({ layout: layout(["notes"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();

    const title = container.querySelector('[data-testid="home-widget-calendar-title"]');
    expect(title?.textContent).toBe("Stand-up");
  });

  test("a battery tile's tap goes to Settings (its own app)", async () => {
    writeStoreValue(HOME_WIDGETS_KEY, ["battery"]);
    home().set({ layout: layout(["notes"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();

    const opens: unknown[] = [];
    const un = home().on((e, d) => {
      if (e === "open") opens.push(d);
    });
    await fireEvent.click(
      container.querySelector('[data-testid="home-widget-battery"]') as HTMLButtonElement,
    );
    un();
    expect(opens).toEqual(["settings"]);
  });
});

describe("HomeWidgets.svelte — every tile's tap opens the app the catalog names (REQ-A1562)", () => {
  /**
   * The catalog's `appId` is checked against `APP_META` by `homeWidgets.test.ts`, but until
   * this test nothing tied that check to what a tap actually does: the four destinations
   * were string literals in the component, so a tile could open a dead app while the check
   * stayed green. Weather and calendar had **no** tap test at all. Walking the whole catalog
   * means a fifth widget cannot ship with an unverified destination either.
   */
  test("each catalog kind taps through to its own appId (weather and calendar included)", async () => {
    for (const spec of WIDGET_CATALOG) {
      const opens: string[] = [];
      const { container } = render(HomeWidgets, {
        props: { kinds: [spec.kind], onopen: (id: string) => opens.push(id) },
      });
      await tick();

      const tile = container.querySelector("button");
      expect(tile, `${spec.kind}: the widget must render a tile`).not.toBeNull();
      await fireEvent.click(tile as HTMLButtonElement);
      await tick();

      expect(opens, `${spec.kind} must open the catalog's appId, not a literal`).toEqual([
        widgetAppId(spec.kind),
      ]);
      expect(opens[0]).toBe(spec.appId);
    }
  });
});

describe("HomeWidgets.svelte — layout of an arbitrary list", () => {
  test("a large widget owns its row; the smalls pair ahead of it", async () => {
    const { container } = render(HomeWidgets, {
      props: { kinds: ["clock", "weather", "calendar"], onopen: () => {} },
    });
    await tick();
    const rows = [...container.querySelectorAll('[data-testid="home-widgets"] [data-row]')];
    expect(rows.map((r) => r.getAttribute("data-row"))).toEqual(["2", "1"]);
  });

  test("an empty list renders nothing at all", async () => {
    const { container } = render(HomeWidgets, { props: { kinds: [], onopen: () => {} } });
    await tick();
    expect(container.querySelector('[data-testid="home-widgets"]')).toBeNull();
  });
});

/**
 * REQ-A1014 / F-SH-335 — a tile's reading must reach its **accessible name**.
 *
 * Three of the four widgets used to spell their name as the bare app key ("天气" / "电池" /
 * "下一个日程") while the reading lived only in the content — content that is either
 * `aria-hidden` (the weather tile's temp, the calendar tile's time) or simply overridden by
 * the constant `aria-label` (the calendar's title, the battery's percentage). A screen
 * reader therefore heard a name with no reading, on a tile whose whole job is the reading.
 *
 * The clock tile in the SAME file (`${t("a11y.currentTime")} · HH:MM`) is the in-repo
 * precedent, and `WidgetBattery` even computes the value-bearing `a11y.battery` sentence —
 * as a `title`, which only names an element when no `aria-label` is present. These tests
 * bind each name to the reading it shows, not to a constant.
 */
describe("HomeWidgets — each tile names its reading, not just its app (REQ-A1014)", () => {
  test("the weather tile repeats the temperature its content hides", async () => {
    const { container } = render(HomeWidgets, { props: { kinds: ["weather"], onopen: () => {} } });
    await tick();
    const b = container.querySelector("button")!;
    // The default forecast's day 0 is 26° and the visual span is `aria-hidden`, so the name
    // is the only place the reading can come from.
    expect(b.getAttribute("aria-label")).toBe(`${label("app.weather")} · 26°`);
  });

  test("the battery tile says the level — the same sentence its tooltip carries", async () => {
    installBatteryBridge(80);
    const { container } = render(HomeWidgets, { props: { kinds: ["battery"], onopen: () => {} } });
    await settleBattery();
    const b = container.querySelector('[data-testid="home-widget-battery"]')!;
    const expected = label("a11y.battery").replace("{pct}", "80%");
    expect(b.getAttribute("aria-label")).toBe(expected);
    // Both channels agree — the old defect was `title` holding the reading while the label
    // held a constant; a name that disagrees with its own tooltip is the same bug again.
    expect(b.getAttribute("title")).toBe(expected);
  });

  test("with no sample the battery tile falls back to its widget key, never a fabricated level", async () => {
    // The reverse direction: unbridged, there is no reading to name, so the honest name is
    // the widget's own key (and no tooltip). This is what stops the test above from passing
    // merely because the name is always the `a11y.battery` string.
    const { container } = render(HomeWidgets, { props: { kinds: ["battery"], onopen: () => {} } });
    await settleBattery();
    const b = container.querySelector('[data-testid="home-widget-battery"]')!;
    expect(b.getAttribute("aria-label")).toBe(label("widget.battery"));
    expect(b.getAttribute("title")).toBeNull();
  });

  test("the calendar tile names the next event, title and time together", async () => {
    writeStoreValue(CALENDAR_KEY, [
      { id: "e1", title: "Stand-up", startAt: Date.now() + 60 * 60 * 1000, allDay: false },
    ]);
    const { container } = render(HomeWidgets, { props: { kinds: ["calendar"], onopen: () => {} } });
    await tick();
    const name = container.querySelector("button")!.getAttribute("aria-label")!;
    expect(name.startsWith(`${label("widget.calendar")} · `)).toBe(true);
    expect(name).toContain("Stand-up");
    expect(name).not.toBe(label("widget.calendar")); // the bare constant is the defect
  });

  test("with nothing coming up the calendar tile says so in its name", async () => {
    writeStoreValue(CALENDAR_KEY, []);
    const { container } = render(HomeWidgets, { props: { kinds: ["calendar"], onopen: () => {} } });
    await tick();
    // An empty tile is exactly where a constant name reads as "there is an event" — the
    // name must carry the same "nothing coming up" sentence the tile draws.
    expect(container.querySelector("button")!.getAttribute("aria-label")).toBe(
      `${label("widget.calendar")} · ${label("widget.calendarNone")}`,
    );
  });
});

describe("EditHome.svelte — the widget editor writes the one shared key", () => {
  interface EditProps {
    layout: { page: string[]; dock: string[]; hidden: string[] };
  }
  const edit = (): PropsChannel<EditProps> => propsChannel<EditProps>("editHome");

  const seed = async () => {
    edit().set({ layout: { page: ["notes"], dock: ["phone"], hidden: [] } });
    const r = render(EditHome);
    await tick();
    return r;
  };

  test("the editor shows the default stack's chips and the unplaced catalog entries", async () => {
    const { container } = await seed();
    const placed = [...container.querySelectorAll("[data-widget]")].map((el) =>
      el.getAttribute("data-widget"),
    );
    expect(placed).toEqual(["clock", "weather"]);
    // battery + calendar are offered as ＋ buttons, not chips.
    expect(
      container.querySelector(`button[aria-label="${label("widget.add").replace("{name}", label("widget.battery"))}"]`),
    ).not.toBeNull();
  });

  test("adding a widget writes the store with the kind appended", async () => {
    const { container } = await seed();
    const addBattery = container.querySelector(
      `button[aria-label="${label("widget.add").replace("{name}", label("widget.battery"))}"]`,
    ) as HTMLButtonElement;
    await fireEvent.click(addBattery);
    await tick();
    // The chip now shows, and the shared key holds the new list.
    const placed = [...container.querySelectorAll("[data-widget]")].map((el) =>
      el.getAttribute("data-widget"),
    );
    expect(placed).toEqual(["clock", "weather", "battery"]);
    expect(JSON.parse(window.localStorage.getItem(HOME_WIDGETS_KEY) ?? "null")).toEqual([
      "clock",
      "weather",
      "battery",
    ]);
  });

  test("removing a widget drops it from the store", async () => {
    const { container } = await seed();
    const removeWeather = container.querySelector(
      `button[aria-label="${label("widget.remove").replace("{name}", label("app.weather"))}"]`,
    ) as HTMLButtonElement;
    await fireEvent.click(removeWeather);
    await tick();
    expect(JSON.parse(window.localStorage.getItem(HOME_WIDGETS_KEY) ?? "null")).toEqual(["clock"]);
  });

  test("the first chip's ‹ and the last chip's › are disabled (no dead controls)", async () => {
    const { container } = await seed();
    const chips = [...container.querySelectorAll("[data-widget]")];
    const first = chips[0] as HTMLElement;
    const last = chips[1] as HTMLElement;
    const moves = (chip: HTMLElement) => [...chip.querySelectorAll("button")].slice(0, 2);
    expect((moves(first)[0] as HTMLButtonElement).disabled).toBe(true);
    expect((moves(last)[1] as HTMLButtonElement).disabled).toBe(true);
  });

  test("widget chips name their arrows with the WIDGET keys, not the app-tile ones", async () => {
    // A widget chip named "天气" and the app tile named "天气" render in the SAME view. Sharing
    // `edit.moveEarlier` would give two different controls one accessible name — ambiguous to a
    // screen reader, and (found by the edit-home suite) a query for one finds the other.
    const { container } = await seed();
    const name = label("widget.moveEarlier").replace("{name}", label("app.clock"));
    expect(container.querySelector(`button[aria-label="${name}"]`)).not.toBeNull();
    const appKey = label("edit.moveEarlier").replace("{name}", label("app.clock"));
    expect(container.querySelector(`button[aria-label="${appKey}"]`)).toBeNull();
  });
});

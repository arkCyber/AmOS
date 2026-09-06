/**
 * HomeDock.svelte — interaction tests (vitest).
 *
 * Drives the Svelte home screen through its shared propsBus channel ("home"):
 * it reads { layout, ext, pulseId } from there, so tests seed the channel before
 * each render. One-shot actions (open / move / search) are asserted by listening
 * on the same channel's UP direction.
 *
 * Pure logic is exercised via the same lib/ paths the React version uses, so
 * these tests double as the behavioural lock for the port.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import HomeDock from "../src/svelte/HomeDock.svelte";
import { propsChannel, resetPropsChannels, type PropsChannel } from "../src/svelte/propsBus";
import { writeStoreValue } from "../src/lib/amosStore";
import { zh } from "../src/i18n/locales/zh";
import { NOTIF_KEY, SETTINGS_KEY } from "../src/lib/settings";
import type { StoreTile } from "../src/lib/storeApps";

interface HomeProps {
  layout: { page: string[]; dock: string[]; hidden: string[] };
  ext: StoreTile[];
  pulseId: string | null;
}

const channel = (): PropsChannel<HomeProps> => propsChannel<HomeProps>("home");
const layout = (page: string[], dock: string[], hidden: string[] = []) => ({ page, dock, hidden });

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
});

afterEach(() => {
  resetPropsChannels();
});

const label = (key: string): string => zh[key as keyof typeof zh] ?? key;
const byLabel = (container: HTMLElement, text: string) =>
  container.querySelector(`button[aria-label="${text}"]`);

describe("HomeDock.svelte — dock single row + paged grid", () => {
  test("renders every dock app on one row and page apps on the grid (no dots for a single page)", async () => {
    channel().set({
      layout: layout(["weather", "notes", "files"], ["phone", "messages", "mail"]),
      ext: [],
      pulseId: null,
    });
    const { container } = render(HomeDock);

    expect(byLabel(container, label("app.phone"))).toBeTruthy();
    expect(byLabel(container, label("app.messages"))).toBeTruthy();
    expect(byLabel(container, label("app.mail"))).toBeTruthy();
    expect(byLabel(container, label("app.notes"))).toBeTruthy();
    expect(byLabel(container, label("app.files"))).toBeTruthy();
    expect(container.querySelector('[data-testid="home-dot"]')).toBeNull();
    await tick();
  });

  test("paging: >12 page apps → dots appear; clicking a dot flips the page", async () => {
    const twelve = [
      "clock", "settings", "calculator", "weather", "notes", "reminders",
      "vmemos", "photos", "files", "android", "messages", "phone",
    ];
    channel().set({ layout: layout([...twelve, "music"], []), ext: [], pulseId: null });
    const { container } = render(HomeDock);

    expect(byLabel(container, label("app.phone"))).toBeTruthy();
    expect(byLabel(container, label("app.music"))).toBeNull();

    const dots = [...container.querySelectorAll('button[data-testid="home-dot"]')];
    expect(dots.length).toBe(2);
    await fireEvent.click(dots[1] as HTMLButtonElement);
    expect(byLabel(container, label("app.music"))).toBeTruthy();
    await tick();
  });
});

describe("HomeDock.svelte — actions back to the shell (UP direction)", () => {
  test("tapping an icon emits 'open' with the app id", async () => {
    channel().set({ layout: layout([], ["phone"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);

    const opened: unknown[] = [];
    const off = channel().on((event, detail) => {
      if (event === "open") opened.push(detail);
    });
    await fireEvent.click(byLabel(container, label("app.phone")) as HTMLButtonElement);
    expect(opened).toEqual(["phone"]);
    off();
    await tick();
  });

  test("dragging a dock icon over another emits 'move' { drag, over }", async () => {
    channel().set({ layout: layout([], ["phone", "messages"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);

    const moved: unknown[] = [];
    const off = channel().on((event, detail) => {
      if (event === "move") moved.push(detail);
    });
    const src = byLabel(container, label("app.phone")) as HTMLButtonElement;
    const dst = byLabel(container, label("app.messages")) as HTMLButtonElement;
    await fireEvent.dragStart(src);
    await fireEvent.drop(dst);
    expect(moved).toEqual([{ drag: "phone", over: "messages" }]);
    off();
    await tick();
  });

  test("the search pill emits 'search'", async () => {
    channel().set({ layout: layout([], ["phone"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    const searched: unknown[] = [];
    const off = channel().on((event, detail) => {
      if (event === "search") searched.push(detail);
    });
    await fireEvent.click(container.querySelector('button[aria-label="search"]') as HTMLButtonElement);
    expect(searched).toEqual([undefined]);
    off();
    await tick();
  });
});

describe("HomeDock.svelte — unread badge + Do-Not-Disturb", () => {
  const badgeCount = (container: HTMLElement) =>
    container.querySelectorAll('[class*="bg-danger"]').length;

  test("shows an unread badge for an app and hides it under DND", async () => {
    channel().set({ layout: layout(["notes"], ["phone"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();
    expect(badgeCount(container)).toBe(0);

    writeStoreValue(NOTIF_KEY, [{ id: "n1", app: label("app.notes"), title: "t", time: 1 }]);
    await tick();
    expect(badgeCount(container)).toBeGreaterThanOrEqual(1);

    writeStoreValue(SETTINGS_KEY, { dnd: true });
    await tick();
    expect(badgeCount(container)).toBe(0);
  });
});


describe("HomeDock.svelte — in-place external-prop updates (no remount)", () => {
  test("layout pushed after mount updates the grid AND preserves the current page", async () => {
    const twelve = [
      "clock", "settings", "calculator", "weather", "notes", "reminders",
      "vmemos", "photos", "files", "android", "messages", "phone",
    ];
    channel().set({ layout: layout([...twelve, "music"], []), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();

    // Go to page 2 (shows "music").
    const dots = [...container.querySelectorAll('button[data-testid="home-dot"]')];
    expect(dots.length).toBe(2);
    await fireEvent.click(dots[1] as HTMLButtonElement);
    expect(byLabel(container, label("app.music"))).toBeTruthy();

    // The shell pushes a NEW layout (adds an app) while we are on page 2. Because
    // props arrive over the reactive channel (not a remount), the component keeps
    // its internal page index — we must STILL be on page 2, and the new app shows.
    channel().set({ layout: layout([...twelve, "music", "magnifier"], []), ext: [], pulseId: null });
    await tick();

    expect(byLabel(container, label("app.magnifier"))).toBeTruthy();
    expect(byLabel(container, label("app.music"))).toBeTruthy();
    // Still on page 2 (magnifier is the 14th → page 2), not bounced to page 0.
    expect(byLabel(container, label("app.clock"))).toBeNull();
  });
});


describe("HomeDock.svelte — pulse highlight + store-installed (ext) tiles", () => {
  test("soft-launch pulseId highlights exactly the matching tile", async () => {
    channel().set({ layout: layout([], ["phone", "messages"]), ext: [], pulseId: "phone" });
    const { container } = render(HomeDock);
    await tick();

    const phoneBtn = byLabel(container, label("app.phone"));
    const msgBtn = byLabel(container, label("app.messages"));
    expect(phoneBtn?.innerHTML).toContain("animate-pulse");
    expect(msgBtn?.innerHTML).not.toContain("animate-pulse");
  });

  test("store-installed ext tiles render with their (non-localized) name and never badge", async () => {
    const ext: StoreTile[] = [
      { id: "store:org.amos.pomodoro", mid: "org.amos.pomodoro", name: "Pomodoro", icon: "P" },
    ];
    channel().set({ layout: layout([], ["phone", "store:org.amos.pomodoro"]), ext, pulseId: null });
    const { container } = render(HomeDock);
    await tick();

    // Ext tile shows its manifest name (not a localised title key).
    const extBtn = byLabel(container, "Pomodoro");
    expect(extBtn).toBeTruthy();

    // Even with a matching unread notification, an ext tile never shows a badge.
    writeStoreValue(NOTIF_KEY, [{ id: "e1", app: "Pomodoro", title: "t", time: 1 }]);
    await tick();
    expect(extBtn!.querySelector('[class*="bg-danger"]')).toBeNull();
  });
});


describe("HomeDock.svelte — grid-shrink page-index clamp (parity with React)", () => {
  test("a stale high page index is clamped, so re-expansion does not auto-jump back", async () => {
    const twelve = [
      "clock", "settings", "calculator", "weather", "notes", "reminders",
      "vmemos", "photos", "files", "android", "messages", "phone",
    ];
    channel().set({ layout: layout([...twelve, "music"], []), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();

    // Go to page 2 (shows "music").
    const dots = [...container.querySelectorAll('button[data-testid="home-dot"]')];
    expect(dots.length).toBe(2);
    await fireEvent.click(dots[1] as HTMLButtonElement);
    expect(byLabel(container, label("app.music"))).toBeTruthy();

    // Shrink to a single page: the stored index must be clamped to 0 (a single
    // page renders no dots).
    channel().set({ layout: layout(twelve, []), ext: [], pulseId: null });
    await tick();
    expect(container.querySelectorAll('button[data-testid="home-dot"]').length).toBe(0);
    expect(byLabel(container, label("app.clock"))).toBeTruthy(); // page 0

    // Re-expand to two pages: we must stay on page 0, NOT auto-jump to page 2.
    channel().set({ layout: layout([...twelve, "music"], []), ext: [], pulseId: null });
    await tick();
    expect(byLabel(container, label("app.clock"))).toBeTruthy();
    expect(byLabel(container, label("app.music"))).toBeNull();
  });
});


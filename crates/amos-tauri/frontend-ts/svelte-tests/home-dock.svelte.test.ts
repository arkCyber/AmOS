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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import HomeDock from "../src/svelte/HomeDock.svelte";
import { propsChannel, resetPropsChannels, type PropsChannel } from "../src/svelte/propsBus";
import { RECENTS_KEY, writeStoreValue } from "../src/lib/amosStore";
import { zh } from "../src/i18n/locales/zh";
import { NOTIF_KEY, SETTINGS_KEY } from "../src/lib/settings";
import { emitDockBounce } from "../src/lib/dockConfig";
import type { StoreTile } from "../src/lib/storeApps";

interface HomeProps {
  layout: { page: string[]; dock: string[]; hidden: string[] };
  ext: StoreTile[];
  pulseId: string | null;
  grid?: { cols: number; rows: number };
  tile?: "regular" | "large";
  form?: "phone" | "tablet" | "desktop" | "robot";
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

  test("home's Spotlight entry is the standalone pill (no dock-parallel one), and it opens search", async () => {
    channel().set({ layout: layout([], ["phone"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();
    // The P2 change removed the *dock-parallel* pill; Spotlight is opened by the
    // standalone pill below the pager (or by a downward swipe — the pure decision in
    // lib/edgeSwipe.ts, covered by that module's unit tests, since happy-dom cannot
    // synthesize touches). Assert by the language-independent hook the component
    // publishes: the old assertion selected `aria-label="search"`, which matched
    // nothing while `shell.search` renders 搜索 — a green assertion that proved
    // nothing, and one that also contradicted the shipped pill (the same defect
    // `scripts/smoke-ui.mjs` was fixed for).
    const entries = container.querySelectorAll('[data-testid="home-search-entry"]');
    expect(entries.length).toBe(1);

    const opened: unknown[] = [];
    const off = channel().on((event, detail) => {
      if (event === "search") opened.push(detail);
    });
    await fireEvent.click(entries[0] as HTMLButtonElement);
    expect(opened.length).toBe(1);
    off();
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


describe("HomeDock.svelte — form-factor grid (tablet is not a stretched phone)", () => {
  const allApps = [
    "clock", "settings", "calculator", "weather", "notes", "reminders",
    "vmemos", "photos", "files", "android", "messages", "phone",
    "music", "maps", "camera", "ai",
  ];

  test("no grid in the payload → the historical phone geometry (4×3 = 12/page)", async () => {
    channel().set({ layout: layout(allApps, []), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();

    const grid = container.querySelector('[data-testid="home-grid"]') as HTMLElement;
    expect(grid.getAttribute("data-cols")).toBe("4");
    expect(grid.getAttribute("data-rows")).toBe("3");
    expect((grid.getAttribute("style") ?? "").replace(/\s/g, "")).toContain(
      "grid-template-columns:repeat(4,",
    );
    // 16 apps / 12 per page → two pages, i.e. the phone paging is intact.
    expect(container.querySelectorAll('button[data-testid="home-dot"]').length).toBe(2);
  });

  test("a tablet portrait grid pages at iPadOS density (4×6 = 24/page)", async () => {
    channel().set({
      layout: layout(allApps, []),
      ext: [],
      pulseId: null,
      grid: { cols: 4, rows: 6 },
    });
    const { container } = render(HomeDock);
    await tick();

    const grid = container.querySelector('[data-testid="home-grid"]') as HTMLElement;
    expect(grid.getAttribute("data-cols")).toBe("4");
    expect(grid.getAttribute("data-rows")).toBe("6");
    expect((grid.getAttribute("style") ?? "").replace(/\s/g, "")).toContain(
      "grid-template-columns:repeat(4,",
    );
    // 16 apps fit on ONE page of 24 → no paging dots.
    expect(container.querySelectorAll('button[data-testid="home-dot"]').length).toBe(0);
    expect(byLabel(container, label("app.ai"))).toBeTruthy();
  });

  test("a tablet landscape grid is 6 columns and 24 per page", async () => {
    channel().set({
      layout: layout(allApps, []),
      ext: [],
      pulseId: null,
      grid: { cols: 6, rows: 4 },
    });
    const { container } = render(HomeDock);
    await tick();

    const grid = container.querySelector('[data-testid="home-grid"]') as HTMLElement;
    expect(grid.getAttribute("data-cols")).toBe("6");
    expect((grid.getAttribute("style") ?? "").replace(/\s/g, "")).toContain(
      "grid-template-columns:repeat(6,",
    );
    expect(container.querySelectorAll('button[data-testid="home-dot"]').length).toBe(0);
  });

  test("a desktop plan is the Launchpad-class grid AND bigger tiles (REQ-A249)", async () => {
    // The plan the shell computes for a maximized Mac window (1496×881 ⇒ 8×4), plus
    // the tile size: a 56 px phone tile in a 183 px cell reads as a phone screenshot
    // pasted onto a desktop.
    channel().set({
      layout: layout(allApps, ["phone"]),
      ext: [],
      pulseId: null,
      grid: { cols: 8, rows: 4 },
      tile: "large",
    });
    const { container } = render(HomeDock);
    await tick();

    const grid = container.querySelector('[data-testid="home-grid"]') as HTMLElement;
    expect(grid.getAttribute("data-cols")).toBe("8");
    expect(grid.getAttribute("data-rows")).toBe("4");
    expect((grid.getAttribute("style") ?? "").replace(/\s/g, "")).toContain(
      "grid-template-columns:repeat(8,",
    );
    // 16 apps fit on one page of 32 → no paging dots (the desktop pages less).
    expect(container.querySelectorAll('button[data-testid="home-dot"]').length).toBe(0);

    const tile = byLabel(container, label("app.clock"));
    expect(tile?.getAttribute("data-tile")).toBe("large");
    expect(tile?.innerHTML).toContain("h-20"); // the large grid icon
    expect(tile?.innerHTML).not.toContain("h-14"); // …not the phone's
    // The dock scales with it (one tile size per class, not per surface). Queried on
    // the dock container: the grid has a `phone` tile too, so a label lookup would
    // find that one first.
    const dock = container.querySelector(".dock-mag") as HTMLElement;
    expect(dock.querySelector("button")?.getAttribute("data-tile")).toBe("large");
    expect(dock.innerHTML).toContain("h-[76px]");
  });

  test("no `tile` in the payload ⇒ today's regular tiles (never a gained capability)", async () => {
    // Same rule as the missing `grid`: an older/preview payload keeps the phone-size
    // icons instead of inventing the larger ones.
    channel().set({ layout: layout(allApps, []), ext: [], pulseId: null, grid: { cols: 8, rows: 4 } });
    const { container } = render(HomeDock);
    await tick();
    const tile = byLabel(container, label("app.clock"));
    expect(tile?.getAttribute("data-tile")).toBe("regular");
    expect(tile?.innerHTML).toContain("h-14");
    expect(tile?.innerHTML).not.toContain("h-20");
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

describe("HomeDock.svelte — the iPad Dock's recently-used section (tablet only)", () => {
  const recents = (ids: string[]) => writeStoreValue(RECENTS_KEY, ids);
  const section = (el: HTMLElement) => el.querySelector('[data-testid="dock-recents"]');

  test("a tablet shows recently-used apps after a divider; a phone shows no such section", async () => {
    recents(["notes", "photos"]);
    channel().set({
      layout: layout([], ["phone", "mail"]),
      ext: [],
      pulseId: null,
      form: "tablet",
    });
    const { container } = render(HomeDock);
    await tick();
    const sec = section(container);
    expect(sec).not.toBeNull();
    expect(container.querySelector('[data-testid="dock-recents-divider"]')).not.toBeNull();
    expect(sec!.querySelector(`button[aria-label="${label("app.notes")}"]`)).not.toBeNull();
    expect(sec!.querySelector(`button[aria-label="${label("app.photos")}"]`)).not.toBeNull();

    // Same recents, a phone: the Dock is pinned-only (its switcher is the Recents
    // surface), so neither the section nor its divider is drawn.
    channel().set({ layout: layout([], ["phone", "mail"]), ext: [], pulseId: null, form: "phone" });
    await tick();
    expect(section(container)).toBeNull();
    expect(container.querySelector('[data-testid="dock-recents-divider"]')).toBeNull();
  });

  test("a payload with no class keeps the phone Dock (a missing field never gains a section)", async () => {
    recents(["notes"]);
    channel().set({ layout: layout([], ["mail"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();
    expect(section(container)).toBeNull();
  });

  test("an app already pinned in the Dock is not repeated in the section", async () => {
    recents(["mail", "notes"]);
    channel().set({
      layout: layout([], ["mail"]),
      ext: [],
      pulseId: null,
      form: "tablet",
    });
    const { container } = render(HomeDock);
    await tick();
    // One tile for mail (the pinned one), not two.
    expect(container.querySelectorAll(`button[aria-label="${label("app.mail")}"]`).length).toBe(1);
    expect(section(container)!.querySelector(`button[aria-label="${label("app.notes")}"]`)).not.toBeNull();
  });

  test("tapping a recent tile opens the app (same UP channel as any Dock tap)", async () => {
    recents(["notes"]);
    channel().set({
      layout: layout([], ["mail"]),
      ext: [],
      pulseId: null,
      form: "tablet",
    });
    const { container } = render(HomeDock);
    await tick();
    const opens: unknown[] = [];
    const un = channel().on((e, d) => {
      if (e === "open") opens.push(d);
    });
    await fireEvent.click(section(container)!.querySelector(`button[aria-label="${label("app.notes")}"]`)!);
    un();
    expect(opens).toEqual(["notes"]);
  });
});

describe("HomeDock.svelte — a Dock bounce reaches the touch shell's Dock (REQ-A1128)", () => {
  /**
   * The `dock-bounce` channel had exactly one subscriber, the **desktop** `Dock.svelte`,
   * while both of its emitters fire on the touch shell (`PhoneApp.svelte` → `"phone"`,
   * `MessagesApp.svelte` → `"messages"`) — and the desktop Dock's tile set is
   * `withoutPhone(layout.dock)`, so the `"phone"` id can never be a tile there. The
   * tests that held this channel asserted on the **event** (the seam), never on a surface
   * that renders it, so "the icon bounces when a call arrives" was green and unreachable.
   */
  const bounced = (container: HTMLElement, appLabel: string): boolean =>
    (byLabel(container, appLabel)?.className ?? "").includes("dock-bounce");

  test("the bounced app's tile carries the animation class and an unrelated tile does not", async () => {
    channel().set({ layout: layout([], ["phone", "messages"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();
    expect(bounced(container, label("app.phone"))).toBe(false);

    emitDockBounce("phone");
    await tick();
    expect(bounced(container, label("app.phone"))).toBe(true);
    expect(bounced(container, label("app.messages"))).toBe(false);
  });

  test("a bounce for an app that is not on this surface changes nothing (no crash, no class)", async () => {
    channel().set({ layout: layout([], ["phone"]), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();
    emitDockBounce("maps"); // not pinned here
    await tick();
    expect(bounced(container, label("app.phone"))).toBe(false);
  });
});

describe("HomeDock.svelte — long-press an icon enters the Edit (jiggle) surface", () => {
  // iOS's arrange gesture. Before this the only door to Edit was the
  // Notification-Center pencil button, so the platform-standard gesture did nothing.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Everything the component emits upward, in order. */
  const watch = () => {
    const seen: Array<[string, unknown]> = [];
    const off = channel().on((e, d) => seen.push([e, d]));
    return { seen, off };
  };

  test("holding an icon emits 'edit' — and the app does NOT also open", async () => {
    channel().set({ layout: layout(["notes"], []), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();
    const { seen, off } = watch();

    const tile = byLabel(container, label("app.notes")) as HTMLButtonElement;
    await fireEvent.mouseDown(tile);
    vi.advanceTimersByTime(500);
    await tick();
    expect(seen).toEqual([["edit", undefined]]);

    // The browser still synthesizes a click after the press; it must be swallowed,
    // or the home screen would open the app *and* enter Edit at once.
    await fireEvent.click(tile);
    await tick();
    expect(seen).toEqual([["edit", undefined]]);
    off();
  });

  test("a short tap still just opens the app (a press is not a tap)", async () => {
    channel().set({ layout: layout(["notes"], []), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();
    const { seen, off } = watch();

    const tile = byLabel(container, label("app.notes")) as HTMLButtonElement;
    await fireEvent.mouseDown(tile);
    await fireEvent.mouseUp(tile);
    await fireEvent.click(tile);
    vi.advanceTimersByTime(1000);
    await tick();
    expect(seen).toEqual([["open", "notes"]]);
    off();
  });

  test("moving off the icon before the threshold cancels the press", async () => {
    channel().set({ layout: layout(["notes"], []), ext: [], pulseId: null });
    const { container } = render(HomeDock);
    await tick();
    const { seen, off } = watch();

    const tile = byLabel(container, label("app.notes")) as HTMLButtonElement;
    await fireEvent.mouseDown(tile);
    vi.advanceTimersByTime(200);
    await fireEvent.mouseLeave(tile);
    vi.advanceTimersByTime(1000);
    await tick();
    expect(seen).toEqual([]);
    off();
  });
});

describe("HomeDock.svelte — a soft launch reveals its tile on the paged grid (REQ-A1361)", () => {
  // Twelve page apps fill the phone grid exactly; "music" is the 13th and therefore
  // the whole of page 2. The default layout is far past this: 36 built-ins − 3 dock =
  // 33 page apps, i.e. 3 phone pages (2 on a tablet at 24/page), so "the pulsed icon
  // is on a page we are not drawing" is the ordinary case, not an exotic one.
  const twelve = [
    "clock", "settings", "calculator", "weather", "notes", "reminders",
    "vmemos", "photos", "files", "android", "messages", "phone",
  ];
  const twoPages = () => layout([...twelve, "music"], []);

  /** One `ext` array for the whole block. The shell re-pushes a payload whose `layout`
   * and `ext` references are the ones it already holds, and the home screen's `known`
   * predicate reads `ext` — so a fresh `[]` per push would churn `pageIds`/`gridPages`
   * by identity and re-run the reveal for a reason no launch is responsible for. */
  const NO_EXT: StoreTile[] = [];

  /** Push a soft launch the way the shell does: `softLaunch` writes the id AND bumps
   * the counter, so a payload carrying only a changed `pulseId` is not a launch. */
  const launch = (id: string, seq: number, base = twoPages()) =>
    channel().set({ layout: base, ext: NO_EXT, pulseId: id, pulseSeq: seq });

  test("an app on a later page turns the grid to it — the pulse is never drawn off-screen", async () => {
    launch("music", 1);
    const { container } = render(HomeDock);
    await tick();

    // Pre-fix the pulse landed on page 2 while the grid stayed on page 1: the sheet
    // had closed, home was shown, and nothing on it changed.
    expect(byLabel(container, label("app.music"))).toBeTruthy();
    expect(byLabel(container, label("app.clock"))).toBeNull();
  });

  test("a launch naming a Dock icon — or an app drawn nowhere — does not turn the grid", async () => {
    launch("music", 1, layout(twelve, ["phone"]));
    const { container } = render(HomeDock);
    await tick();
    expect(byLabel(container, label("app.clock"))).toBeTruthy(); // page 1 of 1

    // "phone" is pinned in the Dock, so it is on screen on every page: there is no
    // page to turn to, and `findIndex` answering -1 must leave the grid where it is.
    launch("phone", 2, layout(twelve, ["phone"]));
    await tick();
    expect(byLabel(container, label("app.clock"))).toBeTruthy();
    // The pulse still highlights it, though — the reveal and the highlight are two
    // different questions.
    expect(byLabel(container, label("app.phone"))!.innerHTML).toContain("animate-pulse");

    // A hidden app is drawn on no page at all (the App Library is where it lives).
    launch("vmemos", 3, { page: twelve.filter((id) => id !== "vmemos"), dock: [], hidden: ["vmemos"] });
    await tick();
    expect(byLabel(container, label("app.clock"))).toBeTruthy();
  });

  test("the SAME app launched twice, with a page swipe in between, is revealed again", async () => {
    // One layout object for both launches: the shell hands the same `_layout`
    // reference down the channel (it re-pushes the payload, not a new layout), so a
    // fixture that rebuilt an equal-but-fresh object here would re-run a value-only
    // effect through `gridPages`' identity and hide the very leaf this test is for.
    const base = twoPages();
    launch("music", 1, base);
    const { container } = render(HomeDock);
    await tick();
    expect(byLabel(container, label("app.music"))).toBeTruthy();

    // The user swipes back to page 1 themselves; the pulse is still set (`pulseId` is
    // only cleared by goHome/open), so re-setting it is not a change at all.
    const dots = [...container.querySelectorAll('button[data-testid="home-dot"]')];
    await fireEvent.click(dots[0] as HTMLButtonElement);
    expect(byLabel(container, label("app.music"))).toBeNull();

    // The second launch writes the id it already holds. It is still a launch, and it
    // must still take the user to the tile.
    launch("music", 2, base);
    await tick();
    expect(byLabel(container, label("app.music"))).toBeTruthy();
  });

  test("a layout push after the reveal does not drag the user back to the pulse", async () => {
    launch("music", 1);
    const { container } = render(HomeDock);
    await tick();
    expect(byLabel(container, label("app.music"))).toBeTruthy();

    const dots = [...container.querySelectorAll('button[data-testid="home-dot"]')];
    await fireEvent.click(dots[0] as HTMLButtonElement);
    expect(byLabel(container, label("app.clock"))).toBeTruthy();

    // The shell re-pushes the layout (an install, a reorder) with the SAME launch
    // still named. The reveal is per-launch, not a standing "keep showing this tile".
    channel().set({
      layout: layout([...twelve, "music", "magnifier"], []),
      ext: [],
      pulseId: "music",
      pulseSeq: 1,
    });
    await tick();
    expect(byLabel(container, label("app.clock"))).toBeTruthy();
    expect(byLabel(container, label("app.music"))).toBeNull();
  });
});


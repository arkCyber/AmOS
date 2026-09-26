/**
 * slide-over.svelte.test.ts — the floating third pane (REQ-A675).
 *
 * Two layers, both about **wiring** rather than geometry:
 *
 *   ① `shellState`'s Slide Over transitions — the measured gate, the persistence, and
 *      the deliberate non-persistence of the hidden flag.
 *   ② `SlideOverSurface` — the panel paints exactly the rect the host answered and
 *      never invents one when the host refuses, the hide/reveal controls flip the same
 *      state the store does not carry, and the resize handle commits through the one
 *      clamp.
 *
 * jsdom/happy-dom report every element as 0×0, so the container's measured size and
 * the `ResizeObserver` that delivers it are stubbed — the same technique
 * `split-surface.svelte.test.ts` uses.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import SlideOverSurface from "../src/svelte/SlideOverSurface.svelte";
import * as backend from "../src/lib/backend";
import {
  canSlideOver,
  closeSlideOver,
  hideSlideOver,
  openSlideOver,
  resetShellState,
  restoreSlideOver,
  setLayoutSnapshot,
  showSlideOver,
  slideOver,
} from "../src/svelte/shellState.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { SLIDE_OVER_KEY, SLIDE_PERCENT_MAX } from "../src/lib/slideOver";
import type { LayoutSnapshot } from "../src/lib/wm";

vi.mock("../src/lib/backend");

const VIEW = { w: 1024, h: 720 };
/** What the host answers for a 33% right-hugging panel of 1024×720 (margin 12). */
const RECT = { label: "slide-over", x: 636, y: 12, width: 376, height: 696 };

function snap(columns: number, form: LayoutSnapshot["form"] = "tablet"): LayoutSnapshot {
  return {
    screen_w: VIEW.w,
    screen_h: VIEW.h,
    split: null,
    candidates: [],
    form,
    columns,
    multi_window: false,
    free_resize: false,
    divider_gap: 8,
  };
}

function stubMeasure(): void {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => VIEW.w });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => VIEW.h });
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    constructor(private cb: () => void) {}
    observe(): void {
      this.cb();
    }
    disconnect(): void {}
    unobserve(): void {}
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetShellState();
});

afterEach(() => {
  vi.clearAllMocks();
  resetShellState();
  for (const key of ["clientWidth", "clientHeight"] as const) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
  delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
});

describe("shellState — Slide Over transitions (REQ-A675)", () => {
  test("a phone (one column) is refused; a tablet is admitted", () => {
    setLayoutSnapshot(snap(1, "phone"));
    expect(canSlideOver()).toBe(false);
    expect(openSlideOver("notes")).toBe(false);
    expect(slideOver()).toBeNull();

    setLayoutSnapshot(snap(2));
    expect(canSlideOver()).toBe(true);
    expect(openSlideOver("notes")).toBe(true);
    expect(slideOver()).toEqual({ id: "notes", axis: "auto", percent: 33, hidden: false });
  });

  test("opening persists the intent to the one key, closing removes it", () => {
    setLayoutSnapshot(snap(2));
    openSlideOver("photos", "vertical", 40);
    expect(readStoreValue(SLIDE_OVER_KEY, null)).toEqual({ id: "photos", axis: "vertical", percent: 40 });

    closeSlideOver();
    expect(slideOver()).toBeNull();
    expect(readStoreValue(SLIDE_OVER_KEY, null), "an absent key is this store's 'no panel'").toBeNull();
  });

  test("the hidden flag toggles but is NOT persisted", () => {
    setLayoutSnapshot(snap(2));
    openSlideOver("notes");
    hideSlideOver();
    expect(slideOver()?.hidden).toBe(true);
    // The stored intent carries no hidden bit — a transient glance, not layout.
    expect(readStoreValue(SLIDE_OVER_KEY, null)).toEqual({ id: "notes", axis: "auto", percent: 33 });

    showSlideOver();
    expect(slideOver()?.hidden).toBe(false);
    showSlideOver(); // idempotent
    expect(slideOver()?.hidden).toBe(false);
  });

  test("restore brings back an installed app, shown, and refuses the rest", () => {
    setLayoutSnapshot(snap(2));
    window.localStorage.setItem(SLIDE_OVER_KEY, JSON.stringify({ id: "notes", axis: "auto", percent: 50, hidden: true }));
    expect(restoreSlideOver()).toBe(true);
    // Always restored shown, even though the stored value said hidden.
    expect(slideOver()).toEqual({ id: "notes", axis: "auto", percent: 50, hidden: false });

    // An uninstalled app, a phone screen and the desktop class all refuse.
    resetShellState();
    setLayoutSnapshot(snap(2));
    window.localStorage.setItem(SLIDE_OVER_KEY, JSON.stringify({ id: "ghost", axis: "auto", percent: 50 }));
    expect(restoreSlideOver()).toBe(false);

    resetShellState();
    setLayoutSnapshot(snap(1, "phone"));
    window.localStorage.setItem(SLIDE_OVER_KEY, JSON.stringify({ id: "notes", axis: "auto", percent: 50 }));
    expect(restoreSlideOver()).toBe(false);

    resetShellState();
    setLayoutSnapshot(snap(4, "desktop"));
    window.localStorage.setItem(SLIDE_OVER_KEY, JSON.stringify({ id: "notes", axis: "auto", percent: 50 }));
    expect(restoreSlideOver()).toBe(false);
  });
});

describe("SlideOverSurface — paints the host's rect, never its own (REQ-A675)", () => {
  test("the host's rect becomes the floating panel with its app", async () => {
    stubMeasure();
    setLayoutSnapshot(snap(2));
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => (cmd === "wm_slide_over_rect" ? RECT : null));
    openSlideOver("notes");

    const { container } = render(SlideOverSurface, { props: { form: "tablet" } });
    await tick();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="slide-over-panel"]')).not.toBeNull();
    });

    const panel = container.querySelector<HTMLElement>('[data-testid="slide-over-panel"]')!;
    const style = (panel.getAttribute("style") ?? "").replace(/\s+/g, "");
    expect(style).toContain("left:636px");
    expect(style).toContain("width:376px");
    expect(container.querySelector('[data-testid="app-pane"]')?.getAttribute("data-pane-app")).toBe("notes");
    expect(panel.getAttribute("data-hidden")).toBe("false");
  });

  test("a null answer paints no panel — a fabricated one is never drawn", async () => {
    stubMeasure();
    setLayoutSnapshot(snap(2));
    vi.mocked(backend.invoke).mockImplementation(async () => null);
    openSlideOver("notes");

    const { container } = render(SlideOverSurface, { props: { form: "tablet" } });
    await tick();
    await new Promise((r) => setTimeout(r, 20));

    expect(container.querySelector('[data-testid="slide-over-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-pane"]')).toBeNull();
  });

  test("hide slides the panel off and reveals a grabber; the grabber brings it back", async () => {
    stubMeasure();
    setLayoutSnapshot(snap(2));
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => (cmd === "wm_slide_over_rect" ? RECT : null));
    openSlideOver("notes");

    const { container } = render(SlideOverSurface, { props: { form: "tablet" } });
    await tick();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="slide-over-panel"]')).not.toBeNull();
    });

    const hide = container.querySelector<HTMLButtonElement>('[data-testid="slide-over-hide"]')!;
    hide.click();
    await tick();
    const panel = container.querySelector<HTMLElement>('[data-testid="slide-over-panel"]')!;
    expect(panel.getAttribute("data-hidden")).toBe("true");
    // Off the screen's trailing edge: translateX(host width − panel x) = 1024 − 636.
    expect((panel.getAttribute("style") ?? "").replace(/\s+/g, "")).toContain("translateX(388px)");

    const show = container.querySelector<HTMLButtonElement>('[data-testid="slide-over-show"]')!;
    expect(show).not.toBeNull();
    show.click();
    await tick();
    expect(container.querySelector<HTMLElement>('[data-testid="slide-over-panel"]')!.getAttribute("data-hidden")).toBe(
      "false",
    );
    expect(container.querySelector('[data-testid="slide-over-show"]')).toBeNull();
  });

  test("the panel's back control closes it", async () => {
    stubMeasure();
    setLayoutSnapshot(snap(2));
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => (cmd === "wm_slide_over_rect" ? RECT : null));
    openSlideOver("notes");

    const { container } = render(SlideOverSurface, { props: { form: "tablet" } });
    await tick();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="slide-over-panel"]')).not.toBeNull();
    });

    const back = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="app-pane"] button')].find(
      (b) => b.getAttribute("aria-label") === "返回",
    );
    expect(back, "the panel must carry a way out").toBeTruthy();
    back!.click();
    await tick();
    expect(slideOver()).toBeNull();
  });

  test("the resize handle's End/Home jump the share to the panel band's ends", async () => {
    stubMeasure();
    setLayoutSnapshot(snap(2));
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => (cmd === "wm_slide_over_rect" ? RECT : null));
    openSlideOver("notes");

    const { container } = render(SlideOverSurface, { props: { form: "tablet" } });
    await tick();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="slide-over-handle"]')).not.toBeNull();
    });

    const handle = container.querySelector<HTMLElement>('[data-testid="slide-over-handle"]')!;
    // End requests 99, which the one clamp pulls to the panel band's ceiling — a
    // "Slide Over" that wide would be a second pane, not a floating panel.
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await tick();
    expect(slideOver()?.percent).toBe(SLIDE_PERCENT_MAX);

    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await tick();
    expect(slideOver()?.percent).toBe(15);
  });
});

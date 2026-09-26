/**
 * split-surface.svelte.test.ts — the tablet's two-pane surface paints what the host
 * says, and never what it does not (REQ-A512).
 *
 * The point of this file is the **wiring**, not the geometry: the pane rectangles come
 * from `wm_pane_rects` (whose rule is `amos_wm::layout::split_panes`, the same one a
 * desktop split uses), so a component that computed its own halves would be a second
 * geometry rule — the drift this design exists to prevent. Here the host is mocked and
 * the assertion is "the panes landed exactly where the host put them".
 *
 * The second half is the honest-failure rule: when the host answers `null` (no bridge, a
 * refused command, or a screen too small for two minimum panes) the surface must render
 * **no** panes. A fabricated 50/50 split would be a screen the user cannot actually use.
 *
 * REQ-A1355: `null` is the answer for two different facts, and the surface used to fold
 * them into one blank frame — "the host has not answered yet" and "the host answered that
 * two panes do not fit here". The first renders nothing on purpose (a frame); the second
 * is terminal and must say so and offer the way out, because the shell draws nothing else
 * on that surface (the split branch is a status bar over this component, and `exitSplit`
 * is reachable only through a pane that was never drawn).
 *
 * jsdom/happy-dom report every element as 0×0, so the container's measured size and the
 * `ResizeObserver` that delivers it are stubbed here — the same technique
 * `dock-context-menu-placement.svelte.test.ts` uses for its measured panel.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import SplitSurface from "../src/svelte/SplitSurface.svelte";
import * as backend from "../src/lib/backend";
import { enterSplit, exitSplit, resetShellState, setLayoutSnapshot, surface } from "../src/svelte/shellState.svelte";
import type { LayoutSnapshot } from "../src/lib/wm";

vi.mock("../src/lib/backend");

/** The measured shell viewport these cases pretend to run in (a tablet in landscape). */
const VIEW = { w: 1024, h: 720 };
/** What the host answers for a 50% vertical split of 1024×720 with an 8 px divider. */
const PANES = [
  { label: "primary", x: 0, y: 0, width: 508, height: 720 },
  { label: "secondary", x: 516, y: 0, width: 508, height: 720 },
];

/** A tablet snapshot whose `columns` admits a split. */
function tabletSnap(): LayoutSnapshot {
  return {
    screen_w: VIEW.w,
    screen_h: VIEW.h,
    split: null,
    candidates: [],
    form: "tablet",
    columns: 2,
    multi_window: false,
    free_resize: false,
    divider_gap: 8,
  };
}

/** The size the stubbed container reports; `remeasure` changes it and re-fires the
 * observer, which is how a real ResizeObserver delivers a rotated/resized window. */
let view = { ...VIEW };
let roCallbacks: Array<() => void> = [];

/** happy-dom has no layout and no `ResizeObserver`: give the container a size and make the
 * observer fire once on observe, exactly as a real one does on the first measurement. */
function stubMeasure(): void {
  view = { ...VIEW };
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => view.w,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => view.h,
  });
  roCallbacks = [];
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    constructor(private cb: () => void) {
      roCallbacks.push(cb);
    }
    observe(): void {
      this.cb();
    }
    disconnect(): void {}
    unobserve(): void {}
  };
}

/** Resize the measured container and deliver it the way the browser would. */
async function remeasure(w: number, h: number): Promise<void> {
  view = { w, h };
  for (const cb of roCallbacks) cb();
  await tick();
}

afterEach(() => {
  vi.clearAllMocks();
  resetShellState();
  roCallbacks = [];
  view = { ...VIEW };
  for (const key of ["clientWidth", "clientHeight"] as const) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
  delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
});

describe("SplitSurface — two panes, placed by the host's rule (REQ-A512)", () => {
  test("the host's two rects become two app panes plus the divider it left between them", async () => {
    stubMeasure();
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "wm_pane_rects") return PANES;
      return null;
    });
    setLayoutSnapshot(tabletSnap());
    expect(enterSplit("notes", "photos", "auto")).toBe(true);

    const { container } = render(SplitSurface, { props: { form: "tablet" } });
    await tick();
    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-testid="app-pane"]').length).toBe(2);
    });

    const panes = [...container.querySelectorAll<HTMLElement>('[data-testid="app-pane"]')];
    expect(panes.map((p) => p.getAttribute("data-pane-app"))).toEqual(["notes", "photos"]);
    // The panes are absolutely positioned at the host's numbers — not at halves this
    // component computed (which would be 0..508 / 516..1024 only by coincidence).
    // The browser re-serialises `width:508px` as `width: 508px`, so compare without spaces.
    const styleOf = (el: Element | null | undefined) =>
      (el?.getAttribute("style") ?? "").replace(/\s+/g, "");
    expect(styleOf(panes[0].parentElement)).toContain("width:508px");
    expect(styleOf(panes[1].parentElement)).toContain("left:516px");

    // The divider is the **gap the host left** (secondary.x − primary.right = 8), so the
    // component never has to know `policy.divider_gap`.
    const divider = container.querySelector<HTMLElement>('[data-testid="split-divider"]');
    expect(divider).toBeTruthy();
    expect(styleOf(divider)).toContain("left:508px");
    expect(styleOf(divider)).toContain("width:8px");
  });

  test("a null answer renders no panes — a fabricated split is never painted", async () => {
    stubMeasure();
    vi.mocked(backend.invoke).mockImplementation(async () => null);
    setLayoutSnapshot(tabletSnap());
    enterSplit("notes", "photos", "auto");

    const { container } = render(SplitSurface, { props: { form: "tablet" } });
    await tick();
    await new Promise((r) => setTimeout(r, 20));

    expect(container.querySelectorAll('[data-testid="app-pane"]').length).toBe(0);
    expect(container.querySelector('[data-testid="split-divider"]')).toBeNull();
  });

  test("a split with a degenerate rect (zero width) is refused as a whole", async () => {
    stubMeasure();
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "wm_pane_rects") return [PANES[0], { label: "secondary", x: 516, y: 0, width: 0, height: 720 }];
      return null;
    });
    setLayoutSnapshot(tabletSnap());
    enterSplit("notes", "photos", "auto");

    const { container } = render(SplitSurface, { props: { form: "tablet" } });
    await tick();
    await new Promise((r) => setTimeout(r, 20));

    expect(container.querySelectorAll('[data-testid="app-pane"]').length).toBe(0);
  });

  test("the divider's close/back affordances collapse the split to the primary app", async () => {
    stubMeasure();
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "wm_pane_rects") return PANES;
      return null;
    });
    setLayoutSnapshot(tabletSnap());
    enterSplit("notes", "photos", "auto");

    const { container } = render(SplitSurface, { props: { form: "tablet" } });
    await tick();
    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-testid="app-pane"]').length).toBe(2);
    });

    // The secondary pane's own back control is the way out of the split (the same step
    // the platform back gesture takes — `backNav`'s `exit-split`).
    const backButtons = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="app-pane"] button')];
    const back = backButtons.find((b) => b.getAttribute("aria-label") === "返回");
    expect(back, "a pane must carry a back control").toBeTruthy();
    back!.click();
    await tick();
    expect(surface()).toEqual({ kind: "app", id: "notes" });
    expect(exitSplit).toBeTypeOf("function");
  });
});

describe("SplitSurface — a refused pair is said out loud, not left blank (REQ-A1355)", () => {
  /** A host that answers `wm_pane_rects` with the given reply (a promise we control for
   * the pending case). */
  function hostSays(reply: unknown): void {
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "wm_pane_rects") return reply as never;
      return null;
    });
  }

  test("a first-answer refusal draws the notice and the way out", async () => {
    stubMeasure();
    hostSays(null);
    setLayoutSnapshot(tabletSnap());
    enterSplit("notes", "photos", "auto");

    const { container } = render(SplitSurface, { props: { form: "tablet" } });
    await tick();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="split-unavailable"]')).toBeTruthy();
    });

    // The original rule still holds: it never invents a split.
    expect(container.querySelectorAll('[data-testid="app-pane"]').length).toBe(0);
    expect(container.querySelector('[data-testid="split-divider"]')).toBeNull();
    // And the frame is no longer mute: the refusal is stated, with the escape the shell
    // otherwise reaches only through a pane's back control (no pane is drawn).
    expect(container.querySelector('[data-testid="split-unavailable"]')!.textContent).toContain(
      "这块屏幕上放不下两个窗格",
    );
    expect(container.querySelector('[data-testid="split-unavailable-exit"]')).toBeTruthy();
  });

  test("the notice's control collapses the split to the primary app", async () => {
    stubMeasure();
    hostSays(null);
    setLayoutSnapshot(tabletSnap());
    enterSplit("notes", "photos", "auto");

    const { container } = render(SplitSurface, { props: { form: "tablet" } });
    await tick();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="split-unavailable-exit"]')).toBeTruthy();
    });

    container.querySelector<HTMLButtonElement>('[data-testid="split-unavailable-exit"]')!.click();
    await tick();
    expect(surface()).toEqual({ kind: "app", id: "notes" });
  });

  test("nothing is claimed before the host has answered — a working split does not flash the notice", async () => {
    stubMeasure();
    let answer: (v: unknown) => void = () => {};
    const pending = new Promise((r) => {
      answer = r;
    });
    hostSays(pending);
    setLayoutSnapshot(tabletSnap());
    enterSplit("notes", "photos", "auto");

    const { container } = render(SplitSurface, { props: { form: "tablet" } });
    await tick();
    // The host has not answered yet: neither panes nor a refusal may be drawn. An
    // initial `refused = true` (or setting it before the await) flashes this on every
    // successful split.
    expect(container.querySelectorAll('[data-testid="app-pane"]').length).toBe(0);
    expect(container.querySelector('[data-testid="split-unavailable"]')).toBeNull();

    answer(PANES);
    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-testid="app-pane"]').length).toBe(2);
    });
    expect(container.querySelector('[data-testid="split-unavailable"]')).toBeNull();
  });

  test("a size that later fits retires the notice and paints the panes", async () => {
    stubMeasure();
    let fits = false;
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "wm_pane_rects") return (fits ? PANES : null) as never;
      return null;
    });
    setLayoutSnapshot(tabletSnap());
    enterSplit("notes", "photos", "auto");

    const { container } = render(SplitSurface, { props: { form: "tablet" } });
    await tick();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="split-unavailable"]')).toBeTruthy();
    });

    fits = true;
    await remeasure(VIEW.w, VIEW.h);
    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-testid="app-pane"]').length).toBe(2);
    });
    expect(container.querySelector('[data-testid="split-unavailable"]')).toBeNull();
  });

  test("a refusal *after* a working pair keeps the panes — a live split is never blanked", async () => {
    stubMeasure();
    let fits = true;
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "wm_pane_rects") return (fits ? PANES : null) as never;
      return null;
    });
    setLayoutSnapshot(tabletSnap());
    enterSplit("notes", "photos", "auto");

    const { container } = render(SplitSurface, { props: { form: "tablet" } });
    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-testid="app-pane"]').length).toBe(2);
    });

    fits = false;
    await remeasure(700, 500);
    await tick();
    expect(container.querySelectorAll('[data-testid="app-pane"]').length).toBe(2);
    expect(container.querySelector('[data-testid="split-unavailable"]')).toBeNull();
  });
});

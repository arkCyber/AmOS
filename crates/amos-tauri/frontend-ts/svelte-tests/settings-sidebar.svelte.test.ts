/**
 * DOM tests for the tablet master-detail Settings sidebar (iPadOS 设置).
 *
 * The *decision* (does this class + measured screen lay the surface out as
 * sidebar + detail) is a pure function with its own unit tests
 * (`src/__tests__/formLayout.test.ts::masterDetail`). Here we verify the **wiring**:
 *
 *   • the sidebar appears only for a tablet whose host-reported `columns >= 2` and
 *     measured width clears the threshold — a phone or a narrow tablet keeps the
 *     byte-identical grouped-list + push-page it has always had;
 *   • a sidebar row selects the detail page (and marks itself `aria-current`);
 *   • the sidebar's search filters the same canonical rows;
 *   • a `layout-changed` push (the host re-measuring the screen) flips the layout
 *     **without a remount** — the property a manual-subscribe snapshot would lose.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import SettingsApp from "../src/svelte/SettingsApp.svelte";
import { resetShellState, setLayoutSnapshot } from "../src/svelte/shellState.svelte";
import type { LayoutSnapshot } from "../src/lib/wm";
import { zh } from "../src/i18n/locales/zh";

afterEach(() => {
  cleanup();
  resetShellState();
});

/** A host snapshot; only the fields the layout decision reads are varied. */
function snap(over: Partial<LayoutSnapshot>): LayoutSnapshot {
  return {
    screen_w: 900,
    screen_h: 1200,
    split: null,
    candidates: [],
    form: "tablet",
    columns: 2,
    multi_window: true,
    free_resize: false,
    divider_gap: 12,
    ...over,
  };
}

const sidebar = (el: HTMLElement) => el.querySelector('[data-testid="settings-sidebar"]');
const detail = (el: HTMLElement) => el.querySelector('[data-testid="settings-detail"]');
const placeholder = (el: HTMLElement) =>
  el.querySelector('[data-testid="settings-detail-placeholder"]');

describe("SettingsApp — tablet master-detail (iPadOS sidebar)", () => {
  test("a phone snapshot renders the grouped list, never a sidebar", () => {
    setLayoutSnapshot(snap({ form: "phone", columns: 1, screen_w: 430, screen_h: 932 }));
    const { container } = render(SettingsApp);
    expect(sidebar(container)).toBeNull();
    expect(container.querySelector('[data-testid="settings-detail"]')).toBeNull();
    // The phone index is still the grouped cards (search field lives under the title).
    expect(container.querySelector("input[type=search]")).not.toBeNull();
  });

  test("a no-host / unmeasured snapshot keeps the phone path (conservative)", () => {
    resetShellState(); // _layoutSnap = null
    const { container } = render(SettingsApp);
    expect(sidebar(container)).toBeNull();
  });

  test("a tablet whose host says columns < 2 gets no sidebar", () => {
    setLayoutSnapshot(snap({ columns: 1, screen_w: 900 }));
    const { container } = render(SettingsApp);
    expect(sidebar(container)).toBeNull();
  });

  test("a tablet narrower than the threshold keeps the push page", () => {
    setLayoutSnapshot(snap({ columns: 2, screen_w: 600 }));
    const { container } = render(SettingsApp);
    expect(sidebar(container)).toBeNull();
  });

  test("a measured tablet shows the sidebar + detail, with a placeholder before a pick", () => {
    setLayoutSnapshot(snap({ screen_w: 900 }));
    const { container } = render(SettingsApp);
    const sb = sidebar(container);
    expect(sb).not.toBeNull();
    expect(detail(container)).not.toBeNull();
    // The sidebar lists the navigable pages (a switch row has no page to show).
    expect(sb!.querySelector('[data-testid="settings-side-wifi"]')).not.toBeNull();
    expect(sb!.querySelector('[data-testid="settings-side-airplane"]')).toBeNull();
    // Nothing chosen yet → the detail says so, rather than showing page one.
    expect(placeholder(container)).not.toBeNull();
    expect(placeholder(container)!.textContent).toContain(zh["settings.sidebarPlaceholder"]);
  });

  test("choosing a sidebar row renders that page's detail and marks the row current", async () => {
    setLayoutSnapshot(snap({ screen_w: 900 }));
    const { container } = render(SettingsApp);
    const about = container.querySelector<HTMLButtonElement>('[data-testid="settings-side-about"]');
    expect(about).not.toBeNull();
    await fireEvent.click(about!);
    await tick();
    expect(placeholder(container)).toBeNull();
    const d = detail(container)!;
    expect(d.textContent).toContain(zh["settings.about"]);
    // The row advertises the selection to assistive tech and to CSS.
    expect(
      container.querySelector('[data-testid="settings-side-about"]')!.getAttribute("aria-current"),
    ).toBe("page");
  });

  test("the sidebar search filters the same canonical rows", async () => {
    setLayoutSnapshot(snap({ screen_w: 900 }));
    const { container } = render(SettingsApp);
    const input = sidebar(container)!.querySelector<HTMLInputElement>("input[type=search]")!;
    // "background" is a documented synonym of the 壁纸 row (its `EXTRA` aliases),
    // not its visible label — so a hit proves the sidebar filters the SAME canonical
    // rows (label + subtitle + synonyms) the phone index searches.
    await fireEvent.input(input, { target: { value: "background" } });
    await tick();
    expect(sidebar(container)!.querySelector('[data-testid="settings-side-wallpaper"]')).not.toBeNull();
    expect(sidebar(container)!.querySelector('[data-testid="settings-side-wifi"]')).toBeNull();
    expect(sidebar(container)!.textContent).toContain(zh["settings.wallpaper"]);
  });

  test("a host re-measure flips phone → tablet layout without a remount", async () => {
    setLayoutSnapshot(snap({ form: "phone", columns: 1, screen_w: 430, screen_h: 932 }));
    const { container } = render(SettingsApp);
    expect(sidebar(container)).toBeNull();
    // The host rotates / the window is widened: it re-measures and pushes.
    setLayoutSnapshot(snap({ form: "tablet", columns: 2, screen_w: 900 }));
    await tick();
    expect(sidebar(container)).not.toBeNull();
    // …and back, honestly (no stale sidebar once the screen says otherwise).
    setLayoutSnapshot(snap({ form: "phone", columns: 1, screen_w: 430, screen_h: 932 }));
    await tick();
    expect(sidebar(container)).toBeNull();
  });
});

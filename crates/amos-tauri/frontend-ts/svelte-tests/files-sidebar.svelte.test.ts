/**
 * DOM tests for the tablet master-detail Files sidebar (iPadOS 文件).
 *
 * The *decision* (does this class + measured screen lay the surface out as sidebar +
 * listing) is the pure `lib/formLayout.ts::masterDetail` — the same rule the Settings
 * sidebar reads, with its own unit tests. This is the **second** built-in app to adopt
 * it (`docs/multi-window.md` §1.5② named "其余 app 仍未采纳"); Files has the navigation
 * model the decision needs (`folderTree`). Here we verify the **wiring**:
 *
 *   • a phone / unmeasured host renders the single-column browser only — and the phone
 *     DOM has no extra box (the detail wrapper's `contents` display), so the phone path
 *     is the one it always had;
 *   • a measured tablet shows the folder hierarchy beside the listing;
 *   • a sidebar row selects the folder (marks itself `aria-current`, changes `cwd`) and
 *     the root row goes back — the same reset `openFolder` performs;
 *   • a `layout-changed` re-measure flips phone → tablet **without a remount**.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import FilesApp from "../src/svelte/FilesApp.svelte";
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

const sidebar = (el: HTMLElement) => el.querySelector('[data-testid="files-sidebar"]');
const detail = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-testid="files-detail"]');
const sideRoot = (el: HTMLElement) => el.querySelector('[data-testid="files-side-root"]');
const sideDoc = (el: HTMLElement) => el.querySelector('[data-testid="files-side-doc"]');
const current = (el: HTMLElement) => el.querySelector('[aria-current="page"]');

describe("FilesApp — tablet master-detail (iPadOS sidebar)", () => {
  test("a phone snapshot renders the single-column browser, never a sidebar", () => {
    setLayoutSnapshot(snap({ form: "phone", columns: 1, screen_w: 430, screen_h: 932 }));
    const { container } = render(FilesApp);
    expect(sidebar(container)).toBeNull();
    // The detail wrapper is `display:contents` on the phone path — no extra layout box —
    // so the screen is exactly the seeded listing it has always drawn.
    expect(detail(container)?.className).toBe("contents");
    expect(container.textContent).toContain("文档");
  });

  test("a no-host / unmeasured snapshot keeps the phone path (conservative)", () => {
    resetShellState(); // _layoutSnap = null
    const { container } = render(FilesApp);
    expect(sidebar(container)).toBeNull();
  });

  test("a tablet narrower than the threshold keeps the single column", () => {
    setLayoutSnapshot(snap({ columns: 2, screen_w: 600 }));
    const { container } = render(FilesApp);
    expect(sidebar(container)).toBeNull();
  });

  test("a measured tablet shows the folder hierarchy beside the listing", () => {
    setLayoutSnapshot(snap({ screen_w: 900 }));
    const { container } = render(FilesApp);
    const sb = sidebar(container);
    expect(sb).not.toBeNull();
    expect(detail(container)).not.toBeNull();
    // The sidebar lists the root and every folder (`folderTree`), not the files.
    expect(sideRoot(container)).not.toBeNull();
    expect(sideDoc(container)).not.toBeNull();
    expect(container.querySelector('[data-testid="files-side-note"]')).toBeNull();
    // The listing is unchanged: both seeded entries are still there.
    expect(container.textContent).toContain("说明.txt");
  });

  test("choosing a folder selects it; the root row goes back", async () => {
    setLayoutSnapshot(snap({ screen_w: 900 }));
    const { container } = render(FilesApp);
    // Initial: the root is the current location.
    expect(current(container)).toBe(sideRoot(container));

    await fireEvent.click(sideDoc(container)!);
    await tick();
    expect(current(container)).toBe(sideDoc(container));
    // `cwd` really moved: 说明.txt lives at the root, so it leaves the listing.
    expect(container.textContent).not.toContain("说明.txt");

    await fireEvent.click(sideRoot(container)!);
    await tick();
    expect(current(container)).toBe(sideRoot(container));
    expect(container.textContent).toContain("说明.txt");
  });

  test("a host re-measure flips phone → tablet layout without a remount", async () => {
    setLayoutSnapshot(snap({ form: "phone", columns: 1, screen_w: 430, screen_h: 932 }));
    const { container } = render(FilesApp);
    expect(sidebar(container)).toBeNull();
    // The host re-measures a wider screen and pushes.
    setLayoutSnapshot(snap({ form: "tablet", columns: 2, screen_w: 900 }));
    await tick();
    expect(sidebar(container)).not.toBeNull();
    // …and back, honestly.
    setLayoutSnapshot(snap({ form: "phone", columns: 1, screen_w: 430, screen_h: 932 }));
    await tick();
    expect(sidebar(container)).toBeNull();
  });

  test("the sidebar's accessible name is the localized 'locations' label", () => {
    setLayoutSnapshot(snap({ screen_w: 900 }));
    const { container } = render(FilesApp);
    expect(sidebar(container)!.getAttribute("aria-label")).toBe(zh["files.locations"]);
  });
});

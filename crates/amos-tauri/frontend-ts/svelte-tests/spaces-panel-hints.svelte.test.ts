/**
 * spaces-panel-hints.svelte.test.ts — the Spaces panel's shortcut legend advertises the keys the
 * shell **really has** (REQ-A553, F-SH-003).
 *
 * Two defects are pinned here, both measured before the fix:
 *
 *  1. The legend printed **hard-coded chords** (`⌃←` / `⌃→` / `F3` / `⌃↑`), so a user who rebound
 *     or disabled a binding in the keyboard settings still read the old key — the "advertised vs
 *     real capability" divergence `TopbarMainMenu` / `DockContextMenu` already forbid (REQ-A342,
 *     REQ-A484).
 *  2. One row was outright **false**: it labelled `⌃↑` as "create a desktop", but `⌃↑` is
 *     `spacesPanel` (the settings page calls it "Show Virtual Desktop Panel") and no create-desktop
 *     binding exists in `SPACES_DEFAULTS` — pressing it opens this very panel.
 *
 * The legend now reads the live merged bindings (`createKeyboardBindings()`), and the false row is
 * gone. The negative control that matters is the disable case: a binding set to `null` must print
 * **nothing**, not the default.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/svelte";
import SpacesPanel from "../src/svelte/SpacesPanel.svelte";
import * as backend from "../src/lib/backend";

vi.mock("../src/lib/backend");

const CONFIG_KEY = "amos.keyboard.config";

function seedSpaces(spaces: Record<string, unknown>): void {
  localStorage.setItem(
    CONFIG_KEY,
    JSON.stringify({ version: 1, overlays: {}, system: {}, spaces, touch: {}, updatedAt: 0 }),
  );
}

/** The three bridge reads SpacesPanel makes on mount, so the legend renders. */
function mockBridge(): void {
  vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "spaces_list":
        return [{ id: "space-0", name: "桌面 1", windows: [] }] as never;
      case "spaces_active":
        return 0 as never;
      case "wm_windows":
        return { windows: [] } as never;
      default:
        return null as never;
    }
  });
}

const hint = (container: HTMLElement, id: string): string | null =>
  container.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? null;

describe("SpacesPanel hints — the keycap follows the user's binding (REQ-A553)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.clearAllMocks());

  test("the default config draws every legend chord", async () => {
    mockBridge();
    const { container } = render(SpacesPanel);
    await vi.waitFor(() => expect(hint(container, "spaces-hint-prev")).toBe("⌃←"));
    expect(hint(container, "spaces-hint-next")).toBe("⌃→");
    expect(hint(container, "spaces-hint-direct")).toBe("⌃1");
    // the Spaces-panel toggle — the row that used to lie about creating a desktop
    expect(hint(container, "spaces-hint-panel")).toBe("⌃↑");
  });

  test("a rebound key is shown instead (the shell matches that one)", async () => {
    seedSpaces({ spacesNext: { key: "ArrowRight", ctrl: true, alt: true } });
    mockBridge();
    const { container } = render(SpacesPanel);
    await vi.waitFor(() => expect(hint(container, "spaces-hint-next")).toBe("⌃⌥→"));
  });

  test("a disabled binding is advertised as nothing, not as its default", async () => {
    seedSpaces({ spacesPrev: null });
    mockBridge();
    const { container } = render(SpacesPanel);
    // wait for the panel body, then assert the disabled row draws no keycap
    await vi.waitFor(() => expect(hint(container, "spaces-hint-next")).toBe("⌃→"));
    expect(hint(container, "spaces-hint-prev")).toBeNull();
  });
});

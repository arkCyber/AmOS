/**
 * dock-context-menu-hints.svelte.test.ts — the Dock menu advertises the key the shell **really
 * matches** (REQ-A484, F-SH-038).
 *
 * Two defects are pinned here, both measured before the fix:
 *
 *  1. The Dock's context menu showed **no** key equivalents at all, while the top-bar menu showed
 *     them for the same actions — and macOS writes them in every Dock row (New Window ⌘N, Hide ⌘H).
 *  2. The hint that *was* drawn (in the top bar) came from the **default table**, so a user who
 *     rebound `newWindow` to ⌥⌘N — or disabled it — still saw `⌘N`: a menu advertising a binding the
 *     shell does not have, which is exactly what `TopbarMainMenu`'s own doc forbids (REQ-A342).
 *
 * The rows that must **not** carry a hint are asserted too, because "no hint" is a decision here,
 * not an omission: 打开/显示 have no chord, 退出 would promise ⌘W (a different action — that closes
 * the *focused* window), and 选项… is a disabled placeholder.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/svelte";
import DockContextMenu from "../src/svelte/modules/DockContextMenu.svelte";
import * as backend from "../src/lib/backend";

vi.mock("../src/lib/backend");

const CONFIG_KEY = "amos.keyboard.config";

function seedConfig(system: Record<string, unknown>): void {
  localStorage.setItem(
    CONFIG_KEY,
    JSON.stringify({ version: 1, overlays: {}, system, spaces: {}, touch: {}, updatedAt: 0 }),
  );
}

function renderMenu(running = true) {
  vi.mocked(backend.invoke).mockImplementation(async () => null);
  return render(DockContextMenu, {
    props: { label: "files", running, x: 100, y: 100, onclose: vi.fn() },
  });
}

const hint = (container: HTMLElement, id: string): string | null =>
  container.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? null;

describe("DockContextMenu hints — the keycap follows the user's binding (REQ-A484)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.clearAllMocks());

  test("the default config draws ⌘N on 新建窗口 and ⌘H on 隐藏", () => {
    const { container } = renderMenu();
    expect(hint(container, "dock-ctx-new-window-hint")).toBe("⌘N");
    expect(hint(container, "dock-ctx-hide-hint")).toBe("⌘H");
  });

  test("a rebound key is shown instead (the shell matches that one)", () => {
    seedConfig({ newWindow: { key: "n", meta: true, alt: true } });
    const { container } = renderMenu();
    expect(hint(container, "dock-ctx-new-window-hint")).toBe("⌥⌘N");
    expect(hint(container, "dock-ctx-hide-hint")).toBe("⌘H");
  });

  test("a disabled binding is advertised as nothing", () => {
    seedConfig({ newWindow: null });
    const { container } = renderMenu();
    expect(hint(container, "dock-ctx-new-window-hint")).toBeNull();
    // the other row is untouched by this disable
    expect(hint(container, "dock-ctx-hide-hint")).toBe("⌘H");
  });

  test("rows whose action is not a bound chord carry no hint", () => {
    const { container } = renderMenu(false);
    // 打开 (open) — no chord opens an app
    const open = container.querySelector('[data-testid="dock-ctx-open"]');
    expect(open?.textContent?.trim()).toBe("打开");
    // 退出 (quit) — macOS writes ⌘Q, which this shell does not bind; ⌘W is a different action
    const quit = container.querySelector('[data-testid="dock-ctx-quit"]');
    expect(quit?.textContent?.trim() ?? "").not.toContain("⌘");
    // 选项… — a disabled placeholder
    const options = container.querySelector('[data-testid="dock-ctx-options"]');
    expect(options?.textContent?.trim() ?? "").not.toContain("⌘");
  });
});

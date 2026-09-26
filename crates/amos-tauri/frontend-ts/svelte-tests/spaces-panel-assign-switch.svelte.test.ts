/**
 * spaces-panel-assign-switch.svelte.test.ts — 归档一个窗口之后的**重新应用**必须读宿主的判决。
 *
 * `SpacesPanel::handleAssignWindow` 收尾时 `await switchSpace(currentIndex)` —— "把窗口搬到另一个
 * 桌面，然后让屏幕与账本对齐" —— 但把 `SpaceSwitchReport | null` 整个丢掉。同一个文件里的
 * `handleSwitch` 读它：`null` 是**宿主拒绝**（`error`），`hide_failed ∕ show_failed` 非空是
 * 「账本动了、屏幕没动」（`warning`，REQ-A513 专门为它立的那条提示）。
 *
 * 丢掉它的后果是这条路径上两个用户可见的状态同时消失：窗口已经归档到别的桌面（`loadWindows()`
 * 也让列表如实反映），而屏幕没跟着走时**一句话也没有** —— 用户看到窗口还在，却不知道是宿主拒绝
 * 还是自己看错了。
 *
 * 用例走真实入口：改窗口那一行的 `<select>`（`onchange` → `handleAssignWindow`），宿主桩让
 * `spaces_move_window` 成功、再让**重新应用**的 `spaces_switch` 以两种方式出问题。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import SpacesPanel from "../src/svelte/SpacesPanel.svelte";
import * as backend from "../src/lib/backend";

vi.mock("../src/lib/backend");

const SPACES = [
  { id: "space-0", name: "桌面 1", windows: ["notes"] },
  { id: "space-1", name: "桌面 2", windows: [] },
];

const WINDOWS = {
  windows: [{ label: "notes", app: "notes", kind: "App", state: "Visible", external: false }],
};

/** `null` = the host refused the re-apply; an object = it happened (possibly partially). */
function mockBridge(switchResult: unknown): void {
  vi.mocked(backend.invoke).mockImplementation((async (cmd: string) => {
    switch (cmd) {
      case "spaces_list":
        return SPACES;
      case "spaces_active":
        return 0;
      case "wm_windows":
        return WINDOWS;
      case "spaces_move_window":
      case "spaces_unfile_window":
        return null; // unit mutations answer `()` on the wire
      case "spaces_switch":
        return switchResult;
      default:
        return null;
    }
  }) as never);

  vi.mocked(backend.bridgeDiag).mockImplementation(((command?: string) => {
    // The two unit mutations already happened — `unitMutationOk` reads this.
    if (command === "spaces_move_window" || command === "spaces_unfile_window") {
      return { ok: true };
    }
    if (command === "spaces_switch") {
      return {
        ok: false,
        kind: "command-failed",
        command: "spaces_switch",
        detail: { code: "amos.spaces.index_out_of_bounds" },
      };
    }
    return { ok: true };
  }) as never);
}

const windowSelect = (container: HTMLElement): HTMLSelectElement | null =>
  container.querySelector('section[aria-labelledby="spaces-windows-heading"] select');

/** Load the panel, then file `notes` into 桌面 2 — the gesture that ends in a re-apply. */
async function assignNotes(container: HTMLElement): Promise<void> {
  await waitFor(() => expect(windowSelect(container)).toBeTruthy());
  await fireEvent.change(windowSelect(container)!, { target: { value: "space-1" } });
}

describe("SpacesPanel — filing a window re-applies the desktop and reports what happened", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  test("a refused re-apply is not swallowed (the sibling control already says so)", async () => {
    mockBridge(null);
    const { container } = render(SpacesPanel);
    await assignNotes(container);

    await waitFor(() => expect(container.textContent).toContain("桌面索引超出范围"));
  });

  test("a re-apply that left windows behind raises the partial hint, not silence", async () => {
    mockBridge({
      index: 0,
      hide_failed: [{ label: "notes", reason: "amos.spaces.lock_failed" }],
      show_failed: [],
    });
    const { container } = render(SpacesPanel);
    await assignNotes(container);

    await waitFor(() =>
      expect(container.querySelector('[data-testid="spaces-switch-partial"]')).toBeTruthy(),
    );
  });

  test("a clean re-apply says nothing — neither error nor warning (the mirror)", async () => {
    mockBridge({ index: 0, hide_failed: [], show_failed: [] });
    const { container } = render(SpacesPanel);
    await assignNotes(container);

    // Let the whole chain settle, then assert the absence of both banners.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="spaces-switch-partial"]')).toBeNull(),
    );
    expect(container.textContent).not.toContain("桌面索引超出范围");
  });
});

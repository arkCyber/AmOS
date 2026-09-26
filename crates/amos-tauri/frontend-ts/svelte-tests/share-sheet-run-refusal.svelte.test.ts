/**
 * share-sheet-run-refusal.svelte.test.ts — a shortcut that fails from the share
 * sheet must be *said*, not swallowed (REQ-A856).
 *
 * `ShareSheet.runTarget` calls `await executeShortcut(...)`, invoked as
 * `onclick={() => void runTarget(id)}`. The comment above it claims "the same
 * stance `ShortcutsApp.handleRun` takes", and the stance has *two* halves.
 *
 * The throw half (REQ-A856): a rejection had no receiver at all, so the overlay
 * had already dismissed and the user saw nothing.
 *
 * The **return** half (REQ-A1140): `handleRun` branches on `result.success`,
 * and that is the half production actually exercises. `executeShortcut` never
 * throws for a gate it *owns* — an unknown id, an unconfirmed run, the lock
 * screen, the MDM blocks, a zero budget, an execution timeout, a failed action
 * all `return { success: false, error }`, and its own timeout throw is caught
 * by its own `catch`. A guard that only catches made a refusal leave through the
 * success door: the await resolved, `dismiss()` ran, and the reason sat unread
 * in the discarded result. Both halves are pinned below.
 *
 * The `catch` remains live for the calls made *outside* `executeShortcut`'s own
 * `try` (`loadShortcuts`, `mdmManager.ensureInitialized`).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { closeShareSheet } from "../src/svelte/shareSheetState.svelte";

const TIMEOUT_ERROR = new Error("快捷指令执行超时（5000ms）");

const target = {
  id: "sc-1",
  name: "发送到备忘录",
  icon: "⚡",
  color: "#007AFF",
  description: "",
  actions: [],
  quickActions: ["shareSheet" as const],
  triggers: [],
  createdAt: 0,
  updatedAt: 0,
  runCount: 0,
  runOnLockScreen: false,
  requiresConfirmation: false,
  tags: [],
};

const loadShortcuts = vi.fn(() => [target]);
const executeShortcut = vi.fn(async () => ({ success: true, actionsCompleted: 1, actionsTotal: 1, duration: 3 }));

vi.mock("../src/lib/shortcuts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/shortcuts")>();
  return {
    ...actual,
    loadShortcuts: (...a: unknown[]) => (loadShortcuts as unknown as (...x: unknown[]) => unknown)(...a),
    executeShortcut: (...a: unknown[]) => (executeShortcut as unknown as (...x: unknown[]) => unknown)(...a),
  };
});

describe("ShareSheet — a refused run is reported, not swallowed (REQ-A856)", () => {
  beforeEach(() => {
    loadShortcuts.mockClear();
    executeShortcut.mockClear();
    executeShortcut.mockImplementation(async () => ({
      success: true, actionsCompleted: 1, actionsTotal: 1, duration: 3,
    }));
    loadShortcuts.mockImplementation(() => [target]);
  });

  afterEach(() => {
    closeShareSheet();
  });

  async function openSheet() {
    const { openShareSheet } = await import("../src/svelte/shareSheetState.svelte");
    const ShareSheet = (await import("../src/svelte/ShareSheet.svelte")).default;
    const rendered = render(ShareSheet);
    expect(openShareSheet({ kind: "text", value: "要分享的正文", title: "备注" })).toBe(true);
    await waitFor(() => expect(screen.getByTestId("share-sheet")).toBeTruthy());
    return rendered;
  }

  test("执行失败时把原因说出来，并且不当作成功把面板收掉", async () => {
    executeShortcut.mockImplementation(async () => {
      throw TIMEOUT_ERROR;
    });
    await openSheet();

    await fireEvent.click(screen.getByTestId("share-target-sc-1"));

    // 1. the reason reaches the user, in the surface that initiated the run.
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(TIMEOUT_ERROR.message);
    });
    // 2. and the overlay is still there: dismissing it is the success gesture,
    //    so a failure that dismisses says "done" while nothing ran.
    expect(screen.getByTestId("share-sheet")).toBeTruthy();
  });

  test("被拒绝的返回（生产里真正的形状）也要说出来，并且不当作成功把面板收掉", async () => {
    // This is the shape `executeShortcut` actually produces for a gate it owns —
    // a plain resolved `{ success: false, error }`, no throw. The case above only
    // enters the defensive `catch`; before the `result.success` branch this one
    // dismissed as success and said nothing.
    executeShortcut.mockImplementation(async () => ({
      success: false,
      error: "执行被 MDM 策略阻止",
      duration: 1,
      actionsCompleted: 0,
      actionsTotal: 1,
    }));
    await openSheet();

    await fireEvent.click(screen.getByTestId("share-target-sc-1"));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("执行被 MDM 策略阻止");
    });
    // Dismissing is the success gesture, so a refusal must leave the sheet up.
    expect(screen.getByTestId("share-sheet")).toBeTruthy();
  });

  test("成功时仍然收起面板（失败路径没有把成功路径改坏）", async () => {
    await openSheet();

    await fireEvent.click(screen.getByTestId("share-target-sc-1"));

    await waitFor(() => {
      expect(screen.queryByTestId("share-sheet")).toBeNull();
    });
    expect(executeShortcut).toHaveBeenCalledTimes(1);
  });
});

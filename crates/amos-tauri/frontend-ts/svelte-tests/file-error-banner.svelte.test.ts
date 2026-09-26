/**
 * DOM tests for the **retry budget** in `FileErrorBanner.svelte` (REQ-A607).
 *
 * The banner used to offer 重试 for as long as `error.retryable` was true — bounded only
 * by the *storm* detector, which fires on **rate** (three same-type errors within 5s) and
 * so lets a user who waits out the window retry a permanently-refused write (disk full)
 * forever. The declared retry policy (`DEFAULT_RETRY_CONFIG`, 3 attempts) is now the
 * bound, and when it is spent the banner says so instead of silently dropping the button.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import FileErrorBanner from "../src/svelte/modules/FileErrorBanner.svelte";
import { createFileError } from "../src/lib/filesError";

afterEach(cleanup);

const retryButton = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="retry-button"]') as HTMLButtonElement | null;
const exhaustedNote = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="retry-exhausted"]');

function mount(error = createFileError("write", "store_unavailable", { store: "amos.files" })) {
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  const host = render(FileErrorBanner, { error, onRetry, onDismiss, isStorm: false });
  return { host, onRetry, onDismiss };
}

describe("FileErrorBanner.svelte — retry budget (REQ-A607)", () => {
  test("offers 重试 while the budget lasts, then says it is spent", async () => {
    const { host, onRetry } = mount();
    expect(retryButton(host)).not.toBeNull();

    // maxAttempts = 3: three re-attempts are offered, the fourth is refused.
    for (let i = 0; i < 3; i++) {
      await fireEvent.click(retryButton(host)!);
      expect(onRetry).toHaveBeenCalledTimes(i + 1);
    }
    expect(retryButton(host)).toBeNull();
    expect(exhaustedNote(host)).not.toBeNull();
    expect(host.container.textContent).toContain("重试已用完");
  });

  test("a different failing action gets a fresh budget", async () => {
    const { host } = mount();
    await fireEvent.click(retryButton(host)!);
    await fireEvent.click(retryButton(host)!);
    expect(retryButton(host)).not.toBeNull();

    // A retry of a *different* action (its error signature differs) must not inherit the spend.
    await host.rerender({
      error: createFileError("write", "store_unavailable", { store: "amos.files.trash" }),
      onRetry: vi.fn(),
      onDismiss: vi.fn(),
      isStorm: false,
    });
    await tick();
    expect(retryButton(host)).not.toBeNull();
    expect(exhaustedNote(host)).toBeNull();
  });

  test("a non-retryable error offers neither a retry nor an exhausted note", () => {
    const { host } = mount(createFileError("rename", "name_conflict", { name: "工作" }));
    expect(retryButton(host)).toBeNull();
    expect(exhaustedNote(host)).toBeNull();
  });

  test("a storm suppresses the retry without claiming the budget is spent", () => {
    const host = render(FileErrorBanner, {
      error: createFileError("write", "store_unavailable", { store: "amos.files" }),
      onRetry: vi.fn(),
      onDismiss: vi.fn(),
      isStorm: true,
    });
    expect(retryButton(host)).toBeNull();
    expect(exhaustedNote(host)).toBeNull();
    expect(host.container.textContent).toContain("检测到多个错误");
  });

  test("no handler means no button (nothing to re-run)", () => {
    const host = render(FileErrorBanner, {
      error: createFileError("write", "store_unavailable", { store: "amos.files" }),
      onDismiss: vi.fn(),
      isStorm: false,
    });
    expect(retryButton(host)).toBeNull();
    expect(exhaustedNote(host)).toBeNull();
  });
});

/**
 * shell-lmk-parity.svelte.test.ts — guards the Svelte shell's parity wiring for
 * the Android LMK surface teardown (added to `Shell.svelte` alongside the React
 * `App.tsx` startup wiring): on mount the shell must start the periodic legacy
 * reconcile AND the `lmk-surface` watcher; on unmount it must release both (no
 * leaked interval / subscription).
 *
 * We mock the `lib/lmk` functions (via importOriginal so real reconcile logic in
 * that module stays intact for callers that need it) and assert mount/unmount
 * lifecycle through the real Svelte `Shell.svelte` component.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tick } from "svelte";
import { render } from "@testing-library/svelte";
import Shell from "../src/svelte/Shell.svelte";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { resetShellState } from "../src/svelte/shellState.svelte";
import {
  startLmkSurfaceWatcher,
  startPeriodicReconcile,
} from "../src/lib/lmk";

vi.mock("../src/lib/lmk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/lmk")>();
  return {
    ...actual,
    startPeriodicReconcile: vi.fn(),
    startLmkSurfaceWatcher: vi.fn(),
  };
});

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
});

afterEach(() => {
  vi.clearAllMocks();
  resetPropsChannels();
  resetShellState();
});

describe("Shell.svelte LMK parity wiring", () => {
  test("mounts both the periodic reconcile and the lmk-surface watcher", async () => {
    vi.mocked(startPeriodicReconcile).mockReturnValue(() => {});
    vi.mocked(startLmkSurfaceWatcher).mockResolvedValue(() => {});

    const { unmount } = render(Shell);
    await tick();
    // `onMount` fires after the component mounts (microtask boundary).
    await Promise.resolve();

    expect(startPeriodicReconcile).toHaveBeenCalledTimes(1);
    expect(startLmkSurfaceWatcher).toHaveBeenCalledTimes(1);
    unmount();
  });

  test("releases both watchers when the shell unmounts (no leaked timer/subscription)", async () => {
    const stopPeriodic = vi.fn();
    const stopWatch = vi.fn();
    vi.mocked(startPeriodicReconcile).mockReturnValue(stopPeriodic);
    vi.mocked(startLmkSurfaceWatcher).mockResolvedValue(stopWatch);

    const { unmount } = render(Shell);
    await tick();
    await Promise.resolve();

    unmount();
    await Promise.resolve();

    expect(stopPeriodic).toHaveBeenCalledTimes(1);
    expect(stopWatch).toHaveBeenCalledTimes(1);
  });
});

/**
 * os-auto-off.test.ts — runtime coverage for the Svelte shell's auto screen-off
 * watcher (`src/svelte/osAutoOff.ts`).
 *
 * The pure decision math is unit-tested in `src/__tests__/osAutoOff.test.ts`; what
 * this file pins is that the *running* loop actually uses that rule and honours the
 * keep-awake hold bus: an active call / video must never let the display sleep.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startOsAutoOff } from "../src/svelte/osAutoOff";
import { assertHold, releaseHold, resetHoldBusForTest } from "../src/lib/keepAwakeCore";
import { writeStoreValue } from "../src/lib/amosStore";
import { AUTOOFF_STORE_KEY } from "../src/lib/display";

describe("osAutoOff — runtime idle watcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    resetHoldBusForTest();
  });

  afterEach(() => {
    releaseHold("call");
    resetHoldBusForTest();
    vi.useRealTimers();
  });

  test("sleeps once idle reaches the persisted timeout, and only once", async () => {
    writeStoreValue(AUTOOFF_STORE_KEY, 15);
    let slept = 0;
    const stop = startOsAutoOff({ onSleep: () => slept++ });

    await vi.advanceTimersByTimeAsync(16_000);
    expect(slept).toBe(1);

    // The loop stops after sleeping — no repeated onSleep calls.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(slept).toBe(1);
    stop();
  });

  test("a keep-awake hold never sleeps the display, however long the idle", async () => {
    writeStoreValue(AUTOOFF_STORE_KEY, 15);
    assertHold("call"); // e.g. an active call holds the screen
    let slept = 0;
    const stop = startOsAutoOff({ onSleep: () => slept++ });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(slept).toBe(0);
    stop();
  });

  test("releasing the hold starts a full timeout window (no instant sleep)", async () => {
    writeStoreValue(AUTOOFF_STORE_KEY, 15);
    assertHold("call");
    let slept = 0;
    const stop = startOsAutoOff({ onSleep: () => slept++ });

    // Long idle while held, then release: the display must get a *fresh* window.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slept).toBe(0);
    releaseHold("call");

    await vi.advanceTimersByTimeAsync(10_000); // < timeout after release
    expect(slept).toBe(0);
    await vi.advanceTimersByTimeAsync(6_000); // now past the fresh timeout
    expect(slept).toBe(1);
    stop();
  });
});

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

    // One sleep per idle period: no repeated onSleep calls while the user stays away.
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

  // REQ-A967: the shell starts this watcher once (Shell.svelte `onMount`), so the
  // timeout must be re-read in place when the user changes it — otherwise Settings →
  //「自动息屏」is a control whose effect waits for an app restart. Both directions are
  // pinned, because the two stale values fail differently (a stale 0 looks like a
  // broken timeout; a stale 15 locks a screen the user just told it never to lock).
  test("a timeout turned on in Settings applies without a restart", async () => {
    writeStoreValue(AUTOOFF_STORE_KEY, 0); // off — the fresh-install default
    let slept = 0;
    const stop = startOsAutoOff({ onSleep: () => slept++ });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(slept).toBe(0); // 0 = never auto-sleep

    // The user picks 15 s in Settings → Display. `writeStoreValue` dispatches the
    // store-change event, which is the only signal this watcher ever gets for it.
    writeStoreValue(AUTOOFF_STORE_KEY, 15);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(slept).toBe(1);
    stop();
  });

  test("a timeout turned off in Settings stops an already-armed sleep", async () => {
    writeStoreValue(AUTOOFF_STORE_KEY, 15);
    let slept = 0;
    const stop = startOsAutoOff({ onSleep: () => slept++ });

    await vi.advanceTimersByTimeAsync(5_000); // still inside the 15 s window
    writeStoreValue(AUTOOFF_STORE_KEY, 0); // user turns it off
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slept).toBe(0);
    stop();
  });

  // REQ-A1401: `onSleep` is `lock()` — a surface change inside the *same* mounted
  // Shell, not the process going away — and the Shell starts this watcher once, in
  // `onMount`. A loop that tore itself down on its first sleep therefore slept
  // exactly once per app launch: unlock, walk away, and the display stays lit
  // forever. `isLocked` is how the loop reads the state it produced.
  test("a wake re-arms the watcher: the next idle period sleeps again", async () => {
    writeStoreValue(AUTOOFF_STORE_KEY, 15);
    let locked = false;
    let slept = 0;
    const stop = startOsAutoOff({
      onSleep: () => {
        slept++;
        locked = true; // the shell navigated to the lock surface
      },
      isLocked: () => locked,
    });

    await vi.advanceTimersByTimeAsync(16_000);
    expect(slept).toBe(1);

    // The user unlocks: the display is awake again and must get a *fresh* window.
    locked = false;
    await vi.advanceTimersByTimeAsync(10_000); // < timeout since the wake
    expect(slept).toBe(1);
    await vi.advanceTimersByTimeAsync(6_000); // now past a full window
    expect(slept).toBe(2);
    stop();
  });

  test("a lock the user made is not slept again, and the unlock gets a full window", async () => {
    writeStoreValue(AUTOOFF_STORE_KEY, 15);
    let locked = true; // e.g. the NC 🔒 button, or a shell that mounts locked
    let slept = 0;
    const stop = startOsAutoOff({ onSleep: () => slept++, isLocked: () => locked });

    // Already off — the idle watcher has nothing to sleep, however long the idle.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slept).toBe(0);

    locked = false;
    await vi.advanceTimersByTimeAsync(10_000); // < timeout after the unlock
    expect(slept).toBe(0);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(slept).toBe(1);
    stop();
  });

  // The latch is per *idle period*, not for the watcher's lifetime: on a surface
  // that cannot lock itself (a desktop app window — `windowOwnsShellNav`), the
  // delivered sleep is a no-op, and a user who stays is owed another sleep the
  // next time they go idle.
  test("activity after a delivered sleep arms a fresh window", async () => {
    writeStoreValue(AUTOOFF_STORE_KEY, 15);
    let slept = 0;
    const stop = startOsAutoOff({ onSleep: () => slept++, isLocked: () => false });

    await vi.advanceTimersByTimeAsync(16_000);
    expect(slept).toBe(1);

    window.dispatchEvent(new Event("pointerdown")); // the user is back
    await vi.advanceTimersByTimeAsync(16_000);
    expect(slept).toBe(2);
    stop();
  });
});

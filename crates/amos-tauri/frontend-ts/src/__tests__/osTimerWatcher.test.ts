import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { NOTIF_KEY } from "../lib/settings";
import { TIMER_KEY, writeTimer } from "../lib/timerStore";
import { timerWatcherTick } from "../svelte/osTimerWatcher";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

const NOW = 1_000_000;

afterEach(() => {
  window.localStorage.removeItem(TIMER_KEY);
  window.localStorage.removeItem(NOTIF_KEY);
});

describe("osTimerWatcher — pure-Svelte host timer notifier", () => {
  test("fires + notifies once when a running timer's deadline is reached", () => {
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW - 100, fired: false });
    expect(timerWatcherTick(null, NOW)).toBe(true);
    const notifs = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as { id: string }[];
    expect(notifs.filter((x) => x.id === "timer:done")).toHaveLength(1);
    // Fires exactly once.
    expect(timerWatcherTick(null, NOW)).toBe(false);
  });

  test("suppressed while the Clock app is the focused surface", () => {
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW - 100, fired: false });
    expect(timerWatcherTick("clock", NOW)).toBe(false);
    // Timer still running in store (the Clock app's in-app timer owns it).
    const t = JSON.parse(window.localStorage.getItem(TIMER_KEY) ?? "{}") as { running?: boolean };
    expect(t.running).toBe(true);
  });

  test("not due yet → no fire", () => {
    writeTimer({ running: true, totalMs: 60_000, remainingMs: 0, endAtMs: NOW + 10_000, fired: false });
    expect(timerWatcherTick(null, NOW)).toBe(false);
  });
});

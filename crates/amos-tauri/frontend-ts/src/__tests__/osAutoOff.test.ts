import { describe, expect, test } from "bun:test";
import {
  osAutoOffDecision,
  osAutoOffTimeout,
  AUTO_OFF_DEFAULT_SEC,
} from "../svelte/osAutoOff";

describe("osAutoOff — pure decisions for the Svelte-shell auto screen-off", () => {
  test("sleeps once idle time reaches the timeout (seconds)", () => {
    const timeout = 30;
    // Just started → not due.
    expect(osAutoOffDecision(1000, 1000 + 10, timeout)).toBe(false);
    // Idle 29s < 30 → not yet.
    expect(osAutoOffDecision(1000, 1000 + 29, timeout)).toBe(false);
    // Idle 30s → due.
    expect(osAutoOffDecision(1000, 1000 + 30, timeout)).toBe(true);
    // Activity resets last → not due again.
    expect(osAutoOffDecision(1030, 1030 + 5, timeout)).toBe(false);
  });

  test("timeout is clamped (garbage/negative → 0 = disabled)", () => {
    expect(osAutoOffTimeout(30)).toBe(30);
    expect(osAutoOffTimeout("bad")).toBe(0); // not finite → disabled
    expect(osAutoOffTimeout(-5)).toBe(0);
    expect(osAutoOffTimeout(6 * 60 * 60 + 100)).toBe(6 * 60 * 60); // capped at 6 h
  });

  test("fresh-install default is OFF (0) so the UI never self-locks", () => {
    // Regression: this used to be 30 here while the React host + Settings UI
    // defaulted to 0 ("关闭"), so a data-cleared device self-locked after 30 s.
    expect(AUTO_OFF_DEFAULT_SEC).toBe(0);
    // An "off" default must never trigger the idle watcher, whatever the idle time.
    expect(osAutoOffDecision(1000, 1000 + 10_000, osAutoOffTimeout(AUTO_OFF_DEFAULT_SEC))).toBe(false);
  });
});

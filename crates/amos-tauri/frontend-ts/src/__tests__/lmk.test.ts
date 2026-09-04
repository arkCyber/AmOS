import { describe, expect, test } from "bun:test";
import {
  legacySurfaceLabel,
  LMK_SURFACE_EVENT,
  shouldTearDown,
  staleLegacySurfaceLabels,
  type AndroidLmkTask,
  type LmkSurfacePayload,
  type WmWindowInfo,
} from "../lib/lmk";

const RECLAIMED: LmkSurfacePayload = {
  window_id: "waydroid_0",
  package_name: "com.tencent.mm",
  kind: "reclaimed",
  close_surface: true,
};

describe("android LMK surface bridge (pure helpers)", () => {
  test("event name matches the Rust bridge const", () => {
    expect(LMK_SURFACE_EVENT).toBe("lmk-surface");
  });

  test("legacySurfaceLabel addresses the amos-wm external surface", () => {
    expect(legacySurfaceLabel("waydroid_0")).toBe("legacy:waydroid_0");
  });

  test("a reclaimed/destroyed surface should be torn down", () => {
    expect(shouldTearDown(RECLAIMED)).toBe(true);
    expect(shouldTearDown({ ...RECLAIMED, kind: "destroyed" })).toBe(true);
  });

  test("frozen/thawed surfaces are kept", () => {
    expect(shouldTearDown({ ...RECLAIMED, kind: "frozen", close_surface: false })).toBe(false);
    expect(shouldTearDown({ ...RECLAIMED, kind: "thawed", close_surface: false })).toBe(false);
  });

  test("no window id (or unknown kind) is never torn down", () => {
    expect(shouldTearDown({ ...RECLAIMED, window_id: "" })).toBe(false);
    expect(shouldTearDown({ ...RECLAIMED, kind: "unknown", close_surface: false })).toBe(false);
    // Defensive: a missing/partial payload must not crash.
    expect(shouldTearDown(undefined as unknown as LmkSurfacePayload)).toBe(false);
  });
});

const W = (label: string): WmWindowInfo => ({ label });
const T = (window_id: string): AndroidLmkTask => ({
  window_id,
  package_name: "com.tencent.mm",
  state: "background",
});

describe("android LMK surface reconciliation (pure)", () => {
  test("closes a legacy surface whose container task is no longer alive", () => {
    const windows = [W("legacy:a"), W("legacy:b"), W("launcher")];
    const tasks = [T("b")]; // "a" died without an event
    expect(staleLegacySurfaceLabels(windows, tasks)).toEqual(["legacy:a"]);
  });

  test("keeps alive surfaces and non-legacy windows", () => {
    const windows = [W("legacy:a"), W("legacy:b"), W("launcher"), W("notes")];
    const tasks = [T("a"), T("b")];
    expect(staleLegacySurfaceLabels(windows, tasks)).toEqual([]);
  });

  test("ignores tasks with no window id yet bound", () => {
    // Task exists but no surface bound yet: it must NOT mark existing surfaces stale.
    const windows = [W("legacy:a")];
    expect(staleLegacySurfaceLabels(windows, [T("")])).toEqual(["legacy:a"]);
  });

  test("daemon-down (empty task list) closes nothing only when no windows; empty both = []", () => {
    expect(staleLegacySurfaceLabels([], [])).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  legacySurfaceLabel,
  LMK_SURFACE_EVENT,
  shouldTearDown,
  type LmkSurfacePayload,
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

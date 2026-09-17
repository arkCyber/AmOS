import { describe, expect, it } from "bun:test";
import { normalizeDockPrefs, DEFAULT_DOCK_PREFS, DOCK_PREFS_KEY } from "../dockPrefs";

describe("normalizeDockPrefs", () => {
  it("returns defaults for undefined", () => {
    const result = normalizeDockPrefs(undefined);
    expect(result).toEqual(DEFAULT_DOCK_PREFS);
  });

  it("returns defaults for null", () => {
    const result = normalizeDockPrefs(null);
    expect(result).toEqual(DEFAULT_DOCK_PREFS);
  });

  it("returns defaults for non-object", () => {
    expect(normalizeDockPrefs("string")).toEqual(DEFAULT_DOCK_PREFS);
    expect(normalizeDockPrefs(123)).toEqual(DEFAULT_DOCK_PREFS);
    expect(normalizeDockPrefs(true)).toEqual(DEFAULT_DOCK_PREFS);
  });

  it("validates position field", () => {
    expect(normalizeDockPrefs({ position: "bottom" }).position).toBe("bottom");
    expect(normalizeDockPrefs({ position: "left" }).position).toBe("left");
    expect(normalizeDockPrefs({ position: "right" }).position).toBe("right");
    expect(normalizeDockPrefs({ position: "invalid" }).position).toBe(DEFAULT_DOCK_PREFS.position);
  });

  it("validates autoHide field", () => {
    expect(normalizeDockPrefs({ autoHide: true }).autoHide).toBe(true);
    expect(normalizeDockPrefs({ autoHide: false }).autoHide).toBe(false);
    expect(normalizeDockPrefs({ autoHide: "yes" }).autoHide).toBe(DEFAULT_DOCK_PREFS.autoHide);
  });

  it("validates magnification field", () => {
    expect(normalizeDockPrefs({ magnification: 1.5 }).magnification).toBe(1.5);
    expect(normalizeDockPrefs({ magnification: 1.0 }).magnification).toBe(1.0);
    expect(normalizeDockPrefs({ magnification: 2.0 }).magnification).toBe(2.0);
    expect(normalizeDockPrefs({ magnification: 0.5 }).magnification).toBe(DEFAULT_DOCK_PREFS.magnification);
    expect(normalizeDockPrefs({ magnification: 3.0 }).magnification).toBe(DEFAULT_DOCK_PREFS.magnification);
  });

  it("validates iconSize field", () => {
    expect(normalizeDockPrefs({ iconSize: 48 }).iconSize).toBe(48);
    expect(normalizeDockPrefs({ iconSize: 32 }).iconSize).toBe(32);
    expect(normalizeDockPrefs({ iconSize: 64 }).iconSize).toBe(64);
    expect(normalizeDockPrefs({ iconSize: 20 }).iconSize).toBe(DEFAULT_DOCK_PREFS.iconSize);
    expect(normalizeDockPrefs({ iconSize: 80 }).iconSize).toBe(DEFAULT_DOCK_PREFS.iconSize);
  });

  it("combines valid and invalid fields", () => {
    const result = normalizeDockPrefs({
      position: "left",
      autoHide: true,
      magnification: 999, // invalid
      iconSize: 40,
    });
    expect(result.position).toBe("left");
    expect(result.autoHide).toBe(true);
    expect(result.magnification).toBe(DEFAULT_DOCK_PREFS.magnification);
    expect(result.iconSize).toBe(40);
  });

  it("has correct default values", () => {
    expect(DEFAULT_DOCK_PREFS.position).toBe("bottom");
    expect(DEFAULT_DOCK_PREFS.autoHide).toBe(false);
    expect(DEFAULT_DOCK_PREFS.magnification).toBe(1.5);
    expect(DEFAULT_DOCK_PREFS.iconSize).toBe(48);
  });

  it("has correct store key", () => {
    expect(DOCK_PREFS_KEY).toBe("dock.prefs.v1");
  });
});

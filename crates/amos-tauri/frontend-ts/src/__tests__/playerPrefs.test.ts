import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  PLAYER_PREFS_KEY,
  POSITION_SAVE_INTERVAL_MS,
  clampPosition,
  clampVolume,
  defaultPlayerPrefs,
  loadPlayerPrefs,
  normalizePlayerPrefs,
  savePlayerPrefs,
  shouldSavePosition,
} from "../lib/playerPrefs";

// Bring up a real DOM for this file (globals are per-process in bun).
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

afterEach(() => {
  window.localStorage.clear();
});

describe("playerPrefs: defaults & normalization (total, never throws)", () => {
  test("defaults are a usable neutral session", () => {
    const d = defaultPlayerPrefs();
    expect(d).toEqual({ trackId: null, positionSec: 0, volume: 1, muted: false, repeat: "all", shuffle: false });
  });

  test("garbage input yields defaults", () => {
    for (const bad of [null, undefined, 42, "x", [], true]) {
      expect(normalizePlayerPrefs(bad)).toEqual(defaultPlayerPrefs());
    }
  });

  test("repairs out-of-range / wrong-typed fields", () => {
    const p = normalizePlayerPrefs({
      trackId: "",
      positionSec: -5,
      volume: 9,
      muted: "yes",
      repeat: "bogus",
      shuffle: 1,
    });
    expect(p).toEqual({ trackId: null, positionSec: 0, volume: 1, muted: false, repeat: "all", shuffle: false });
  });

  test("keeps well-formed fields (including volume 0 and repeat one)", () => {
    const p = normalizePlayerPrefs({
      trackId: "file:/x/song.mp3",
      positionSec: 12.5,
      volume: 0,
      muted: true,
      repeat: "one",
      shuffle: true,
    });
    expect(p).toEqual({ trackId: "file:/x/song.mp3", positionSec: 12.5, volume: 0, muted: true, repeat: "one", shuffle: true });
  });

  test("clamp helpers are finite and never NaN", () => {
    expect(clampVolume(Number.NaN)).toBe(1);
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(0.25)).toBe(0.25);
    expect(clampPosition(Number.NaN)).toBe(0);
    expect(clampPosition(-3)).toBe(0);
    expect(clampPosition(4)).toBe(4);
  });
});

describe("playerPrefs: persistence round-trip", () => {
  test("save → load returns the normalized session", () => {
    savePlayerPrefs({ trackId: "memo:m1", positionSec: 30, volume: 0.4, muted: false, repeat: "one", shuffle: true });
    expect(loadPlayerPrefs()).toEqual({
      trackId: "memo:m1",
      positionSec: 30,
      volume: 0.4,
      muted: false,
      repeat: "one",
      shuffle: true,
    });
  });

  test("absent record loads defaults", () => {
    expect(loadPlayerPrefs()).toEqual(defaultPlayerPrefs());
  });

  test("corrupt stored JSON loads defaults instead of throwing", () => {
    window.localStorage.setItem(PLAYER_PREFS_KEY, "{not json");
    expect(loadPlayerPrefs()).toEqual(defaultPlayerPrefs());
  });
});

describe("playerPrefs: playhead persist throttle", () => {
  test("saves only after the interval", () => {
    expect(shouldSavePosition(1000, 1000 + POSITION_SAVE_INTERVAL_MS - 1)).toBe(false);
    expect(shouldSavePosition(1000, 1000 + POSITION_SAVE_INTERVAL_MS)).toBe(true);
  });

  test("a clock glitch or zero interval never loses progress", () => {
    expect(shouldSavePosition(Number.NaN, 5000)).toBe(true);
    expect(shouldSavePosition(1000, Number.NaN)).toBe(true);
    expect(shouldSavePosition(1000, 1000, 0)).toBe(true);
  });
});

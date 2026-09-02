import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearSegs,
  DEFAULT_PREFS,
  errorOf,
  LANGS,
  langNative,
  loadSegs,
  partialTextOf,
  readPrefs,
  saveSegs,
  segOf,
  sessionEndedOf,
  writePrefs,
} from "../lib/interp";

let realWindow: unknown;
function setWindow(store: Map<string, string>) {
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  };
}
beforeEach(() => {
  realWindow = (globalThis as { window?: unknown }).window;
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

describe("interp helpers", () => {
  test("language catalog offers auto-detect plus a real target set", () => {
    expect(LANGS.some((l) => l.code === "auto")).toBe(true);
    expect(LANGS.some((l) => l.code === "zh" && l.native === "中文")).toBe(true);
    expect(LANGS.some((l) => l.code === "en" && l.native === "English")).toBe(true);
    expect(LANGS.filter((l) => l.code !== "auto").length).toBeGreaterThan(3);
  });

  test("langNative resolves codes and falls back to the raw code", () => {
    expect(langNative("zh")).toBe("中文");
    expect(langNative("fr")).toBe("Français");
    expect(langNative("xx")).toBe("xx");
  });

  test("readPrefs falls back to defaults when nothing stored", () => {
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
  });

  test("prefs round-trip through localStorage", () => {
    setWindow(new Map());
    writePrefs({ source: "en", target: "ja", autospeak: true });
    expect(readPrefs()).toEqual({ source: "en", target: "ja", autospeak: true });
  });

  test("transcript persists and clears", () => {
    setWindow(new Map());
    const seg = { src: "hi", target: "你好", srcLang: "en", targetLang: "zh" };
    saveSegs([seg]);
    expect(loadSegs()).toEqual([seg]);
    clearSegs();
    expect(loadSegs()).toEqual([]);
  });

  test("segOf builds a record from segment_final only", () => {
    expect(
      segOf({
        kind: "segment_final",
        source_text: "hello",
        source_lang: "en",
        target_text: "你好",
        target_lang: "zh",
      }),
    ).toEqual({ src: "hello", target: "你好", srcLang: "en", targetLang: "zh" });
    expect(segOf({ kind: "partial", text: "bo" })).toBeNull();
    expect(segOf(null)).toBeNull();
    // Empty strings / absent langs collapse to undefined, not empty strings.
    expect(
      segOf({ kind: "segment_final", source_text: "x", target_text: "y" }),
    ).toEqual({ src: "x", target: "y" });
  });

  test("partialTextOf / sessionEndedOf / errorOf classify events", () => {
    expect(partialTextOf({ kind: "partial", text: "你好" })).toBe("你好");
    expect(partialTextOf({ kind: "segment_final" })).toBe("");
    expect(sessionEndedOf({ kind: "session_ended" })).toBe(true);
    expect(sessionEndedOf({ kind: "segment_final" })).toBe(false);
    expect(errorOf({ kind: "error", message: "boom" })).toBe("boom");
    expect(errorOf({ kind: "partial" })).toBe("");
  });
});

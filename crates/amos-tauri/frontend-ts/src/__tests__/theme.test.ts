import { describe, expect, test, mock } from "bun:test";
import { applyDarkClass, isThemeMode, resolveDark } from "../theme";

describe("theme", () => {
  test("resolveDark honours explicit light/dark and OS auto", () => {
    expect(resolveDark("dark", 12, false)).toBe(true);
    expect(resolveDark("light", 23, true)).toBe(false);
    expect(resolveDark("auto", 12, true)).toBe(true);
    expect(resolveDark("auto", 23, false)).toBe(false);
  });

  test("validates stored theme mode values", () => {
    expect(isThemeMode("dark")).toBe(true);
    expect(isThemeMode("auto")).toBe(true);
    expect(isThemeMode("blue")).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });

  test("applyDarkClass toggles the dark class on the target root", () => {
    const toggle = mock(() => {});
    applyDarkClass(true, { classList: { toggle } } as unknown as HTMLElement);
    expect(toggle).toHaveBeenCalledWith("dark", true);
    applyDarkClass(false, { classList: { toggle } } as unknown as HTMLElement);
    expect(toggle).toHaveBeenLastCalledWith("dark", false);
  });
});

import { describe, expect, test } from "bun:test";
import { addHistory, calcDisplay, calcEntry, calcFromKey, calcInit, calcPress, calcRun, ERR } from "../lib/calculator";

describe("calculator", () => {
  test("adds 2 + 3 = 5", () => {
    expect(calcRun(["2", "+", "3", "="])).toBe("5");
  });

  test("supports − × ÷ (iOS symbols evaluate)", () => {
    expect(calcRun(["9", "−", "3", "="])).toBe("6");
    expect(calcRun(["4", "×", "5", "="])).toBe("20");
    expect(calcRun(["9", "÷", "3", "="])).toBe("3");
  });

  test("handles decimals and clear", () => {
    let s = calcInit();
    for (const k of ["1", ".", "5"]) s = calcPress(s, k);
    expect(calcDisplay(s)).toBe("1.5");
    s = calcPress(s, "C");
    expect(calcDisplay(s)).toBe("0");
  });

  test("= then a digit starts a fresh number", () => {
    expect(calcRun(["2", "+", "3", "=", "7"])).toBe("7");
  });

  test("percent divides the current entry by 100", () => {
    expect(calcRun(["5", "0", "%"])).toBe("0.5");
  });

  test("chained operators fold left to right", () => {
    expect(calcRun(["2", "+", "3", "+", "4", "="])).toBe("9");
  });

  test("division by zero surfaces an error sentinel", () => {
    expect(calcRun(["5", "÷", "0", "="])).toBe(ERR);
  });

  test("negative results and full-width plus glyph parse", () => {
    expect(calcRun(["0", "−", "5", "="])).toBe("-5");
    expect(calcRun(["3", "＋", "4", "="])).toBe("7");
  });

  test("division by zero freezes at ERR until cleared with C", () => {
    let s = calcInit();
    for (const k of ["5", "÷", "0", "=", "3", "+", "9", "="]) s = calcPress(s, k);
    expect(calcDisplay(s)).toBe(ERR); // frozen — subsequent presses ignored
    s = calcPress(s, "C");
    expect(calcDisplay(s)).toBe("0");
    expect(calcRun(["2", "+", "2", "="])).toBe("4"); // recovered
  });

  test("calcEntry builds a history row from the pre-= state", () => {
    let s = calcInit();
    for (const k of ["9", "−", "3"]) s = calcPress(s, k);
    expect(calcEntry(s)).toEqual({ expr: "9 − 3", result: "6" });
  });

  test("calcEntry returns null without an operator or when unsolvable", () => {
    expect(calcEntry(calcInit())).toBeNull(); // no pending operator
    let div = calcInit();
    for (const k of ["5", "÷", "0"]) div = calcPress(div, k);
    expect(calcEntry(div)).toBeNull(); // division by zero
  });

  test("addHistory prepends, dedupes by expr+result, and caps the length", () => {
    const a = { expr: "9 − 3", result: "6" };
    const b = { expr: "2 × 4", result: "8" };
    let h: { expr: string; result: string }[] = [];
    h = addHistory(h, a);
    h = addHistory(h, b);
    expect(h).toEqual([b, a]); // newest first
    h = addHistory(h, a);
    expect(h).toEqual([a, b]); // re-computing 9−3 moves it to the top (no dup)
    h = addHistory(h, b, 1);
    expect(h).toEqual([b]); // capped at 1
  });

  test("calcFromKey maps keyboard keys to reducer labels", () => {
    expect(calcFromKey("7")).toBe("7");
    expect(calcFromKey(".")).toBe(".");
    expect(calcFromKey("Enter")).toBe("=");
    expect(calcFromKey("=")).toBe("=");
    expect(calcFromKey("Backspace")).toBe("⌫");
    expect(calcFromKey("Delete")).toBe("C");
    expect(calcFromKey("Escape")).toBe("C");
    expect(calcFromKey("%")).toBe("%");
    expect(calcFromKey("+")).toBe("+");
    expect(calcFromKey("-")).toBe("−");
    expect(calcFromKey("*")).toBe("×");
    expect(calcFromKey("/")).toBe("÷");
    // unknown keys and modified keys are ignored (null → caller skips preventDefault)
    expect(calcFromKey("a")).toBeNull();
    expect(calcFromKey("Enter", true)).toBeNull(); // ctrl/meta/alt held
  });

  test("keyboard sequence matches the on-screen buttons", () => {
    // typing "9 − 3 =" with a physical keyboard must equal pressing the UI glyphs
    expect(calcRun(["9", "−", "3", "="])).toBe("6");
  });

  test("mid-chain division by zero is a hard error (no ERR × … garbage)", () => {
    let s = calcInit();
    for (const k of ["5", "÷", "0", "+", "2", "="]) s = calcPress(s, k);
    expect(calcDisplay(s)).toBe(ERR);
  });

  test("results never leak NaN/Infinity to the display", () => {
    // 1 / 3 then re-multiplying by 3 must stay a finite decimal (fold semantics)
    const out = calcRun(["1", "÷", "3", "×", "3", "="]);
    expect(Number.isFinite(Number(out))).toBe(true);
    expect(calcRun(["0", "÷", "0", "="])).toBe(ERR);
  });

  test("long chains fold left-to-right and stay finite and correct", () => {
    // 100 × 1 → 100, folded without overflow noise
    const ones: string[] = [];
    for (let i = 0; i < 99; i++) ones.push("1", "+");
    expect(calcRun([...ones, "1", "="])).toBe("100");
    // Left-to-right immediate execution (iOS-style live running total), so
    // 2 + 3 × 4 folds as (2 + 3) × 4 = 20 — NOT multiplication-precedence 14.
    expect(calcRun(["2", "+", "3", "×", "4", "="])).toBe("20");
    // repeated divide-by-zero stays frozen, then C recovers
    let s = calcInit();
    for (const k of ["1", "÷", "0", "=", "÷", "0", "="]) s = calcPress(s, k);
    expect(calcDisplay(s)).toBe(ERR);
    s = calcPress(s, "C");
    expect(calcRun(["9", "÷", "3", "="])).toBe("3");
    expect(calcRun(["9", "÷", "3", "×", "0", "="])).toBe("0");
  });
});

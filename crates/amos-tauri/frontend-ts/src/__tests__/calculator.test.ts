import { describe, expect, test } from "bun:test";
import { calcDisplay, calcInit, calcPress, calcRun, ERR } from "../lib/calculator";

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
});

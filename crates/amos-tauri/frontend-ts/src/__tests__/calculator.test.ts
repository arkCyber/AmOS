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
});

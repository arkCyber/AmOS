/**
 * Pure unit tests for the ANSI -> colour-span parser (lib/ansi.ts).
 */
import { describe, expect, test } from "bun:test";
import { parseAnsi, hasEscape } from "../lib/ansi";

const esc = (code: number | string) => `\u001b[${code}m`;

describe("parseAnsi", () => {
  test("plain text passes through as a single unstyled span", () => {
    expect(parseAnsi("hello")).toEqual([{ text: "hello" }]);
  });

  test("fg colours and bold are applied and reset", () => {
    const s = parseAnsi(`${esc(32)}green${esc(0)} plain`);
    expect(s[0]).toMatchObject({ text: "green", fg: "#22c55e" });
    expect(s[1]).toEqual({ text: " plain" });
    const b = parseAnsi(`${esc(1)}bold${esc(22)}`);
    expect(b[0]).toMatchObject({ text: "bold", bold: true });
  });

  test("bright fg codes map too, and reset clears fg/bold", () => {
    const s = parseAnsi(`${esc("1;91")}bright red${esc(0)}`);
    expect(s[0]).toMatchObject({ fg: "#f87171", bold: true });
  });

  test("non-SGR CSI (cursor/clear) is stripped and never leaks", () => {
    const s = parseAnsi(`A\u001b[2J\u001b[H B`);
    const joined = s.map((x) => x.text).join("");
    expect(joined).toBe("A B");
    expect(joined.includes("\u001b")).toBe(false);
  });

  test("hasEscape reports raw control sequences", () => {
    expect(hasEscape(`x${esc(31)}y`)).toBe(true);
    expect(hasEscape("plain")).toBe(false);
  });
});

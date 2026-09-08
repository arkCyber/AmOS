/**
 * Pure unit tests for the ANSI -> colour-span parser (lib/ansi.ts).
 */
import { describe, expect, test } from "bun:test";
import { parseAnsi, hasEscape, decodeOutput } from "../lib/ansi";

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

describe("decodeOutput (interactive PTY stream)", () => {
  test("splits CR/LF/CRLF into lines without doubles", () => {
    expect(decodeOutput("a\r\nb\nc").lines).toEqual(["a", "b", "c"]);
    expect(decodeOutput("a\r\nb\nc").clear).toBe(false);
  });

  test("backspace removes the previous character", () => {
    expect(decodeOutput("hello\b\b\b\b\b").lines.join("")).toBe("");
    expect(decodeOutput("abc\x7f").lines).toEqual(["ab"]);
  });

  test("a lone CR overwrites the line (progress bars), CRLF is a newline", () => {
    expect(decodeOutput("10%\r20%\r100%\n").lines).toEqual(["100%"]);
    expect(decodeOutput("abc\r\nb\n").lines).toEqual(["abc", "b"]);
  });

  test("ESC[K erases to end of the current line", () => {
    expect(decodeOutput("hello\x1b[K").lines.join("")).toBe("hello");
    expect(decodeOutput("one\x1b[K").lines).toEqual(["one"]);
  });

  test("ESC[2J requests a full clear", () => {
    const d = decodeOutput("junk\x1b[2Jnew");
    expect(d.clear).toBe(true);
    // everything before the clear is discarded; text after it is a fresh line
    expect(d.lines.join("")).toBe("new");
  });

  test("SGR colour codes survive for the later parseAnsi pass; cursor CSI is dropped", () => {
    const d = decodeOutput(`\x1b[32mgreen\x1b[0m\x1b[2K end`);
    const joined = d.lines.join("");
    expect(joined.includes("\x1b[32m")).toBe(true); // colour kept
    expect(joined.includes("\x1b[2K")).toBe(false); // erase-line dropped
  });
});

/**
 * Pure unit tests for the offline-safe AmOS terminal line model (lib/terminal.ts).
 */
import { describe, expect, test } from "bun:test";
import { runTermLine, pushHistory, termBanner } from "../lib/terminal";

const last = (ls: unknown[]): unknown => ls[ls.length - 1];
const lastText = (ls: readonly { text: string }[]): string | undefined =>
  ls[ls.length - 1]?.text;

describe("terminal demo shell", () => {
  test("help lists the safe command set", () => {
    const r = runTermLine("help", "");
    expect(r.lines.some((l) => l.text.includes("Available commands"))).toBe(true);
    expect(r.lines.some((l) => l.text.includes("help"))).toBe(true);
    expect(r.lines.some((l) => l.text.includes("echo"))).toBe(true);
    expect(r.lines.some((l) => l.text.includes("clear"))).toBe(true);
    expect(r.clear).toBe(false);
  });

  test("echo prints the rest of the line", () => {
    const r = runTermLine("echo hello  world", "");
    expect(last(r.lines)).toEqual({ text: "hello world", kind: "out" });
  });

  test("whoami / about / exit behave", () => {
    expect(lastText(runTermLine("whoami", "").lines)).toBe("amos");
    expect(lastText(runTermLine("about", "AmOS 0.1").lines)).toBe("AmOS 0.1");
    expect(lastText(runTermLine("exit", "").lines)).toBe("session ended");
  });

  test("clear returns the clear marker; blank input is a no-op", () => {
    expect(runTermLine("clear", "").clear).toBe(true);
    expect(runTermLine("   ", "")).toEqual({ lines: [], clear: false });
  });

  test("unknown commands are rejected honestly (no real shell execution)", () => {
    const r = runTermLine("rm -rf /", "");
    expect(r.lines.some((l) => l.kind === "err")).toBe(true);
    expect(r.lines.some((l) => l.text.includes("unknown command"))).toBe(true);
    expect(r.lines.some((l) => l.text.includes("disabled"))).toBe(true);
  });

  test("banner clearly states this is an offline demo", () => {
    const b = termBanner("DEMO");
    expect(b.some((l) => l.text.includes("DEMO"))).toBe(true);
    expect(b[0]?.text).toBe("AmOS Terminal");
  });
});

describe("terminal history", () => {
  test("pushHistory appends, caps, and dedups adjacent repeats", () => {
    expect(pushHistory([], "ls")).toEqual(["ls"]);
    expect(pushHistory(["ls"], "ls")).toEqual(["ls"]); // adjacent repeat dropped
    expect(pushHistory(["ls"], "pwd")).toEqual(["ls", "pwd"]);
    expect(pushHistory([], "   ")).toEqual([]);
    const big = Array.from({ length: 120 }, (_, i) => `cmd${i}`);
    const capped = pushHistory(big, "last", 100);
    expect(capped.length).toBe(100);
    expect(capped[capped.length - 1]).toBe("last");
  });
});

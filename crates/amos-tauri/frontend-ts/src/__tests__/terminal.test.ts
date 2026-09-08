/**
 * Pure unit tests for the offline-safe AmOS terminal line model (lib/terminal.ts).
 */
import { describe, expect, test } from "bun:test";
import { runTermLine, pushHistory, capLines, termBanner } from "../lib/terminal";

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

  test("date / uname / ver add safe built-ins (UTC iso + aliases)", () => {
    const d = lastText(runTermLine("date", "", Date.UTC(2026, 8, 8, 12, 0, 0)).lines);
    expect(d).toBe("2026-09-08T12:00:00.000Z");
    expect(lastText(runTermLine("uname", "").lines)).toBe("amos");
    expect(lastText(runTermLine("ver", "AmOS 0.1").lines)).toBe("AmOS 0.1");
    expect(lastText(runTermLine("version", "AmOS 0.1").lines)).toBe("AmOS 0.1");
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

describe("terminal scrollback", () => {
  test("capLines keeps the newest lines within the buffer", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `L${i}`, kind: "out" as const }));
    expect(capLines(mk(5), 10)).toHaveLength(5); // under cap → unchanged length
    const capped = capLines(mk(20), 10);
    expect(capped).toHaveLength(10);
    expect(capped[0]).toEqual({ text: "L10", kind: "out" });
    expect(capped[9]).toEqual({ text: "L19", kind: "out" });
    expect(capLines([], 5)).toEqual([]);
  });
});

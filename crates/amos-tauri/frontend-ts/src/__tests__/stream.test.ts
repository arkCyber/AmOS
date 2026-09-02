import { describe, expect, test } from "bun:test";
import {
  chatLogInit,
  onAiToken,
  onAiComplete,
  tokenOf,
  onInterpOutput,
  interpInit,
} from "../lib/stream";

describe("stream reducers (fake events)", () => {
  test("ai tokens stream into one text and complete flags the end", () => {
    let log = chatLogInit();
    for (const t of ["Hel", "lo", " world"]) log = onAiToken(log, t);
    expect(log.text).toBe("Hello world");
    expect(log.busy).toBe(true);
    log = onAiComplete(log);
    expect(log.complete).toBe(true);
    expect(log.busy).toBe(false);
  });

  test("tokenOf handles string and {token} payloads", () => {
    expect(tokenOf("x")).toBe("x");
    expect(tokenOf({ token: "y" })).toBe("y");
    expect(tokenOf(42)).toBe("");
  });

  test("interpret segment_final events append transcript lines", () => {
    let s = interpInit();
    s = onInterpOutput(s, { kind: "segment_final", source_text: "hello", target_text: "你好" });
    s = onInterpOutput(s, { kind: "segment_final", source_text: "bye", target_text: "再见" });
    expect(s.lines.length).toBe(2);
    expect(s.lines[0]).toEqual({ src: "hello", target: "你好" });
  });

  test("non-final interp events are ignored", () => {
    const s = onInterpOutput(interpInit(), { kind: "partial", text: "…" });
    expect(s.lines.length).toBe(0);
  });
});

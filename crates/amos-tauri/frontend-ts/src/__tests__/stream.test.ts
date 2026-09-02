import { describe, expect, test } from "bun:test";
import {
  chatLogInit,
  onAiToken,
  onAiComplete,
  tokenOf,
  onInterpOutput,
  interpInit,
  cardOf,
  sessionMetaOf,
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

  test("cardOf parses an ai-card-received semantic card", () => {
    expect(
      cardOf({
        kind: "weather",
        title: "今日天气",
        subtitle: "北京",
        fields: [{ key: "气温", value: "26°" }],
        actions: ["打开地图"],
      }),
    ).toEqual({
      kind: "weather",
      title: "今日天气",
      subtitle: "北京",
      fields: [{ key: "气温", value: "26°" }],
      actions: ["打开地图"],
    });
    // Empty / non-object / no-kind payloads are not cards.
    expect(cardOf(null)).toBeNull();
    expect(cardOf("hi")).toBeNull();
    expect(cardOf({ kind: "" })).toBeNull();
    expect(cardOf({ kind: "x", fields: "nope" })).toEqual({
      kind: "x",
      title: "",
      subtitle: "",
      fields: [],
      actions: [],
    });
  });

  test("sessionMetaOf parses the [sessionId, fullText] completion tuple", () => {
    expect(sessionMetaOf(["conv-1", "你好 world"])).toEqual({ sid: "conv-1", full: "你好 world" });
    expect(sessionMetaOf(["conv-1"])).toEqual({ sid: "conv-1", full: "" });
    expect(sessionMetaOf([])).toBeNull();
    expect(sessionMetaOf("x")).toBeNull();
    expect(sessionMetaOf([""])).toBeNull();
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

describe("ai reducer fault-injection", () => {
  test("tokenOf never throws and coerces arbitrary payloads safely", () => {
    expect(tokenOf(null)).toBe("");
    expect(tokenOf(undefined)).toBe("");
    expect(tokenOf([1, 2, 3])).toBe("");
    expect(tokenOf({ token: 0 })).toBe("0");
    expect(tokenOf({ token: "" })).toBe("");
  });

  test("onAiToken / onAiComplete keep the busy/complete booleans invariant", () => {
    let l = chatLogInit();
    l = onAiToken(l, "hi");
    expect(typeof l.busy).toBe("boolean");
    expect(typeof l.complete).toBe("boolean");
    expect(l.busy).toBe(true);
    l = onAiComplete(l);
    expect(l.complete).toBe(true);
    expect(l.busy).toBe(false);
  });

  test("cardOf ignores hostile card payloads without throwing", () => {
    expect(cardOf({ kind: ["evil"] })).toBeNull(); // non-string kind -> dropped
    expect(cardOf({ kind: "", fields: "x" })).toBeNull();
    expect(
      cardOf({ kind: "a", fields: [{ key: "k", value: { nested: true } }] }),
    ).toEqual({
      kind: "a",
      title: "",
      subtitle: "",
      fields: [{ key: "k", value: "[object Object]" }],
      actions: [],
    });
  });
});

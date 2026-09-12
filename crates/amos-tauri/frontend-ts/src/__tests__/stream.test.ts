import { describe, expect, test } from "bun:test";
import { tokenOf, cardOf, sessionMetaOf, finalSegmentOf } from "../lib/stream";

describe("stream parsers (fake events)", () => {
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
});

describe("ai reducer fault-injection", () => {
  test("tokenOf never throws and coerces arbitrary payloads safely", () => {
    expect(tokenOf(null)).toBe("");
    expect(tokenOf(undefined)).toBe("");
    expect(tokenOf([1, 2, 3])).toBe("");
    expect(tokenOf({ token: 0 })).toBe("0");
    expect(tokenOf({ token: "" })).toBe("");
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

describe("stream — final segment", () => {
  test("finalSegmentOf only accepts speakable segment_final payloads", () => {
    expect(finalSegmentOf({ kind: "segment_final", target_text: "你好", target_lang: "en" })).toEqual({
      text: "你好",
      lang: "en",
    });
    // missing lang defaults to zh
    expect(finalSegmentOf({ kind: "segment_final", target_text: "ok" })).toEqual({ text: "ok", lang: "zh" });
    // empty text / wrong kind / non-object are not speakable
    expect(finalSegmentOf({ kind: "segment_final", target_text: "" })).toBeNull();
    expect(finalSegmentOf({ kind: "partial", target_text: "hi" })).toBeNull();
    expect(finalSegmentOf(null)).toBeNull();
    expect(finalSegmentOf("x")).toBeNull();
  });
});

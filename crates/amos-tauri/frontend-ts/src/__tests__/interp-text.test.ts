import { describe, expect, test } from "bun:test";
import { transcriptText } from "../lib/interp";

describe("transcriptText (同传 copy-all block)", () => {
  test("joins non-empty target lines, skipping blank ones", () => {
    expect(
      transcriptText([
        { src: "hello", target: "你好" },
        { src: "   ", target: "  " }, // blank -> skipped
        { src: "bye", target: "再见" },
      ]),
    ).toBe("你好\n再见");
  });

  test("includeSource prefixes each line with source → target", () => {
    expect(
      transcriptText([{ src: "hi", target: "你好" }, { src: "thanks", target: "谢谢" }], true),
    ).toBe("hi → 你好\nthanks → 谢谢");
  });

  test("empty / all-blank transcripts produce an empty string", () => {
    expect(transcriptText([])).toBe("");
    expect(transcriptText([{ src: "x", target: "" }])).toBe("");
  });
});

import { describe, expect, test } from "bun:test";
import {
  entryText,
  previewClipboard,
  copySelection,
  type ClipboardEntry,
} from "../lib/clipboard";

function textEntry(payload: ClipboardEntry["payload"], seq = 1): ClipboardEntry {
  return { seq, source: "notes", owner: "notes", timestamp_ms: 1, payload };
}

describe("clipboard pure helpers", () => {
  test("entryText picks the plain representation per kind", () => {
    expect(entryText(textEntry({ kind: "text", text: "hello" }))).toBe("hello");
    expect(
      entryText(textEntry({ kind: "html", html: "<b>hi</b>", plain: "hi" })),
    ).toBe("hi");
    expect(
      entryText(textEntry({ kind: "uris", uris: ["a.txt", "b.txt"], text: "two files" })),
    ).toBe("two files");
    expect(
      entryText(textEntry({ kind: "uris", uris: ["a.txt"], text: "" })),
    ).toBe("a.txt");
    expect(
      entryText(textEntry({ kind: "image", mime: "image/png", data_b64: "aA==" })),
    ).toBe("");
  });

  test("previewClipboard labels binary payloads and collapses text", () => {
    expect(
      previewClipboard(textEntry({ kind: "image", mime: "image/png", data_b64: "aA==" })),
    ).toBe("[image · image/png]");
    expect(
      previewClipboard(textEntry({ kind: "text", text: "  a\n  b  " })),
    ).toBe("a b");
  });

  test("copySelection degrades to false when not bridged (no window)", async () => {
    // Outside Tauri the backend bridge is absent, so this is a clean false.
    expect(await copySelection("anything")).toBe(false);
  });
});

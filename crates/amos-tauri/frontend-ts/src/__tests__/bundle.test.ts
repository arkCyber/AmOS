import { describe, expect, test } from "bun:test";
import {
  assetDataUrlMap,
  decodeBase64Text,
  inlineBundle,
  isExternalRef,
  listLocalRefs,
  resolveBundlePath,
  toDataUrl,
} from "../lib/bundle";

const SAMPLE = `<html>
<head><link rel="stylesheet" href="style.css"></head>
<body>
<script src="assets/app.js"></script>
<img src="img/icon.png">
<a href="page2.html">next</a>
</body>
</html>`;

describe("bundle asset reference resolution (pure)", () => {
  test("isExternalRef distinguishes local from absolute/other-scheme", () => {
    expect(isExternalRef("assets/app.js")).toBe(false);
    expect(isExternalRef("style.css")).toBe(false);
    expect(isExternalRef("")).toBe(true);
    expect(isExternalRef("#frag")).toBe(true);
    expect(isExternalRef("https://x/y.js")).toBe(true);
    expect(isExternalRef("data:text/plain;base64,QQ==")).toBe(true);
    expect(isExternalRef("//cdn/x.js")).toBe(true);
  });

  test("resolveBundlePath normalizes relative + root-relative and refuses escapes", () => {
    expect(resolveBundlePath("", "assets/app.js")).toBe("assets/app.js");
    expect(resolveBundlePath("", "/assets/app.js")).toBe("assets/app.js");
    expect(resolveBundlePath("", "./img/icon.png")).toBe("img/icon.png");
    expect(resolveBundlePath("sub", "../style.css")).toBe("style.css");
    expect(resolveBundlePath("", "../secret")).toBeNull();
    expect(resolveBundlePath("", "https://x")).toBeNull();
    expect(resolveBundlePath("", "assets/app.js?v=2#x")).toBe("assets/app.js");
  });

  test("listLocalRefs returns unique resolved local paths only", () => {
    const refs = listLocalRefs(SAMPLE);
    expect(refs).toContain("style.css");
    expect(refs).toContain("assets/app.js");
    expect(refs).toContain("img/icon.png");
    expect(refs).toContain("page2.html");
    // dedup: the string inside the inline script must not add a second entry.
    expect(refs.filter((p) => p === "assets/app.js")).toHaveLength(1);
  });

  test("inlineBundle rewrites listed assets to data: URLs and leaves others", () => {
    const assets = new Map([
      ["style.css", "text/css;base64,QVNTRVRTMQ=="],
      ["assets/app.js", "text/javascript;base64,YWxlcnQoMSk="],
      ["img/icon.png", "image/png;base64,iVBORw0KGgo="],
    ]);
    const out = inlineBundle(SAMPLE, assets);
    expect(out).toContain('href="text/css;base64,QVNTRVRTMQ=="');
    expect(out).toContain('src="text/javascript;base64,YWxlcnQoMSk="');
    expect(out).toContain('src="image/png;base64,iVBORw0KGgo="');
    // Missing asset (page2.html) is left as its original relative ref.
    expect(out).toContain('href="page2.html"');
    expect(out.includes('src="assets/app.js"')).toBe(false);
  });

  test("assetDataUrlMap fills only resolvable assets", () => {
    const map = assetDataUrlMap(["a.css", "gone.js"], (p) =>
      p === "a.css" ? { mime: "text/css", base64: "QUJD" } : null,
    );
    expect(map.get("a.css")).toBe("text/css;base64,QUJD");
    expect(map.has("gone.js")).toBe(false);
  });

  test("decodeBase64Text + toDataUrl round-trip utf-8 text", () => {
    expect(decodeBase64Text("aGVsbG8=")).toBe("hello");
    expect(toDataUrl("image/png", "QQ==")).toBe("image/png;base64,QQ==");
  });

  test("refs inside script/style text and comments are never treated as assets", () => {
    const tricky = `<html><head>
<style>/* src="assets/in-css.png" */ .x{color:red}</style>
</head><body>
<!-- href="assets/comment.css" -->
<script src="assets/real.js"></script>
<script>var a="src=assets/bare.js"; el.src="assets/fake2.js";</script>
<img src="img/real.png">
</body></html>`;
    const refs = listLocalRefs(tricky);
    expect(refs).toContain("assets/real.js"); // real opening-tag attribute
    expect(refs).toContain("img/real.png");
    // Code/CSS/comment text that merely *looks* like a ref must be ignored.
    expect(refs).not.toContain("assets/in-css.png");
    expect(refs).not.toContain("assets/comment.css");
    expect(refs).not.toContain("assets/fake2.js");
    expect(refs).not.toContain("assets/bare.js");

    const assets = new Map([
      ["assets/real.js", "text/javascript;base64,UkVBTA=="],
      ["img/real.png", "image/png;base64,UFBH"],
    ]);
    const out = inlineBundle(tricky, assets);
    expect(out).toContain('src="text/javascript;base64,UkVBTA=="');
    expect(out).toContain('src="image/png;base64,UFBH"');
    // The script/CSS/comment bodies are preserved verbatim (no corruption).
    expect(out).toContain('src="assets/in-css.png"');
    expect(out).toContain('href="assets/comment.css"');
    expect(out).toContain('el.src="assets/fake2.js"');
  });
});

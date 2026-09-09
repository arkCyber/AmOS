import { describe, expect, test } from "bun:test";
import { markdownTitleOf, normalizeMarkdownBody, parseMarkdownImport, stripYamlFrontMatter, toMarkdownFile } from "../lib/markdown";

describe("stripYamlFrontMatter", () => {
  test("removes a leading front-matter block", () => {
    const md = "---\ntitle: 周报\ncreated: 2026-01-01\n---\n# 正文标题\n\n内容";
    expect(stripYamlFrontMatter(md)).toBe("# 正文标题\n\n内容");
  });
  test("handles CRLF and no front-matter (returns body unchanged)", () => {
    expect(stripYamlFrontMatter("正文\r\n第二行")).toBe("正文\n第二行");
    expect(stripYamlFrontMatter("# 无元数据")).toBe("# 无元数据");
  });
  test("an unclosed front-matter block yields an empty body", () => {
    expect(stripYamlFrontMatter("---\ntitle: 只有头部")).toBe("");
  });
});

describe("markdownTitleOf", () => {
  test("prefers the first heading of any level", () => {
    expect(markdownTitleOf("简介文字\n\n## 第二章\n\n内容")).toBe("第二章");
    expect(markdownTitleOf("# 顶层标题\n\n正文")).toBe("顶层标题");
  });
  test("falls back to the first non-empty line, stripping list markers", () => {
    expect(markdownTitleOf("- 待办一\n- 待办二")).toBe("待办一");
    expect(markdownTitleOf("   \n直接正文")).toBe("直接正文");
  });
  test("empty input gives empty title", () => {
    expect(markdownTitleOf("")).toBe("");
  });
});

describe("normalizeMarkdownBody", () => {
  test("strips front matter and normalizes line endings / blank head", () => {
    expect(normalizeMarkdownBody("\r\n---\r\ntitle: x\r\n---\r\n\r\n\r\n正文")).toBe("正文");
  });
  test("plain body is trimmed", () => {
    expect(normalizeMarkdownBody("  hello  ")).toBe("hello");
  });

describe("toMarkdownFile (export)", () => {
  test("writes front matter with title + created/modified ISO and the body", () => {
    const created = Date.UTC(2026, 0, 2, 3, 4, 5);
    const out = toMarkdownFile({
      title: "周报",
      text: "第一行\n第二行",
      created,
      modified: created + 1000,
    });
    expect(out.startsWith("---\ntitle: 周报\ncreated: 2026-01-02T03:04:05.000Z\nmodified: ")).toBe(true);
    expect(out).toContain("---\n\n第一行\n第二行\n");
  });

  test("quotes a title with a colon/# so it doesn't break YAML", () => {
    expect(toMarkdownFile({ title: "要点: A#1", text: "x" }).includes('title: "要点: A#1"')).toBe(true);
  });

  test("round-trips: exporter output → importer recovers the body", () => {
    const md = toMarkdownFile({ title: "T", text: "正文第一行\n\n第二段", created: 1, modified: 2 });
    const body = normalizeMarkdownBody(md);
    expect(body).toBe("正文第一行\n\n第二段");
    expect(stripYamlFrontMatter(md)).not.toContain("title:");
  });

  test("empty body still emits front matter", () => {
    const out = toMarkdownFile({ title: "", text: "" });
    expect(out).toContain("title: 未命名");
    expect(out.trim().endsWith("---")).toBe(true);
  });
});

describe("parseMarkdownImport", () => {
  test("strips front matter and returns a clean body + title", () => {
    const r = parseMarkdownImport("---\ntitle: 周报\n---\n# 周报标题\n\n正文");
    expect(r).toEqual({ body: "# 周报标题\n\n正文", title: "周报标题" });
  });
  test("null when nothing meaningful remains", () => {
    expect(parseMarkdownImport("---\ntitle: only\n---")).toBeNull();
    expect(parseMarkdownImport("   ")).toBeNull();
  });
});


});

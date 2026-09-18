/**
 * pwaIndex.test.ts — PWA 索引归一化与网关读取契约（src/lib/pwaIndex.ts，REQ-A396）。
 *
 * 覆盖：normalizePwaIndex 的身份规则（schema 校验、无 id 条目丢弃、无名工具丢弃、
 * 域名过滤、display 默认值）、纯 URL/glyph 助手，以及 fetchPwaIndex / pwaIndexBaseUrl
 * 在假桥 + 假 fetch 下的每一条结果分支（offline / unreachable / unreadable / ok）。
 */
import { describe, test as it, expect, beforeEach, afterEach } from "bun:test";
import {
  PWA_INDEX_SCHEMA,
  normalizePwaIndex,
  pwaIndexBaseUrl,
  indexDocumentUrlFor,
  fetchPwaIndex,
  pwaEntryGlyph,
  pwaEntryIconUrl,
  pwaAllTools,
} from "../pwaIndex";

let bridgeUrl: unknown = "https://pwa.host";
let fetchImpl: ((url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>) | null = null;

function okDoc() {
  return {
    schema: PWA_INDEX_SCHEMA,
    apps: [
      {
        app: { id: "app.a", name: "Alpha", version: "1.2.3" },
        display: { url: "https://a.example", icon: "icon.png", theme_color: "#fff" },
        permissions: { network: { allowed_domains: ["a.example", 42, "b.example"] } },
        mcp_tools: [
          { name: "search", description: "s", inputSchema: { type: "object", required: ["q", 3], properties: { q: { type: "string", description: "query" } } }, execution: { action: "open", url_template: "https://a.example?q" } },
          { description: "no name" },
          "junk",
        ],
      },
      { app: { name: "no id" }, display: {}, permissions: {} },
    ],
  };
}

beforeEach(() => {
  bridgeUrl = "https://pwa.host/";
  fetchImpl = null;
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => (command === "pwa_index_url" ? bridgeUrl : null),
    },
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe("normalizePwaIndex 归一化", () => {
  it("完整文档：条目/工具/域名/默认值全部就位", () => {
    const doc = normalizePwaIndex(okDoc())!;
    expect(doc).not.toBeNull();
    expect(doc.apps.length).toBe(1); // 无 id 条目被丢弃
    const app = doc.apps[0]!;
    expect(app.id).toBe("app.a");
    expect(app.display.mode).toBe("standalone"); // 默认
    expect(app.display.orientation).toBe("any");
    expect(app.allowedDomains).toEqual(["a.example", "b.example"]); // 非字符串被滤
    expect(app.mcpTools.length).toBe(1);
    const tool = app.mcpTools[0]!;
    expect(tool.name).toBe("search");
    expect(tool.inputSchema.required).toEqual(["q"]);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.action).toBe("open");
    expect(tool.urlTemplate).toBe("https://a.example?q");
  });

  it("诚实拒绝：非对象 / 未知 schema / 条目全部非法", () => {
    expect(normalizePwaIndex(null)).toBeNull();
    expect(normalizePwaIndex("nope")).toBeNull();
    expect(normalizePwaIndex({ schema: 999, apps: [] })).toBeNull();
    expect(normalizePwaIndex({ schema: PWA_INDEX_SCHEMA, apps: "not-array" })).toEqual({
      schema: PWA_INDEX_SCHEMA,
      apps: [],
    });
  });
});

describe("纯 URL / 字形助手", () => {
  it("indexDocumentUrlFor 去尾斜杠拼接 apps.json", () => {
    expect(indexDocumentUrlFor("https://h.example")).toBe("https://h.example/apps.json");
    expect(indexDocumentUrlFor("https://h.example/")).toBe("https://h.example/apps.json");
  });

  it("pwaEntryGlyph：首字符大写；空白回退 🌐", () => {
    expect(pwaEntryGlyph("alpha")).toBe("A");
    expect(pwaEntryGlyph("  x")).toBe("X");
    expect(pwaEntryGlyph("")).toBe("🌐");
    expect(pwaEntryGlyph("   ")).toBe("🌐");
  });

  it("pwaEntryIconUrl：无图标 → null；有图标 → 去重斜杠拼接", () => {
    const entry = (icon: string | null) =>
      normalizePwaIndex({
        schema: PWA_INDEX_SCHEMA,
        apps: [{ app: { id: "e" }, display: { icon }, permissions: {} }],
      })!.apps[0]!;
    expect(pwaEntryIconUrl("https://h", entry(null))).toBeNull();
    expect(pwaEntryIconUrl("https://h", entry("icons/x.png"))).toBe("https://h/icons/x.png");
    expect(pwaEntryIconUrl("https://h/", entry("/icons/y.png"))).toBe("https://h/icons/y.png");
  });

  it("pwaAllTools 展平全部工具并携带所属 app", () => {
    const doc = normalizePwaIndex(okDoc())!;
    const all = pwaAllTools(doc);
    expect(all.length).toBe(1);
    expect(all[0]!.app).toBe("app.a");
    expect(all[0]!.tool.name).toBe("search");
  });
});

describe("pwaIndexBaseUrl / fetchPwaIndex 结果分支", () => {
  it("base：合法 URL 去尾斜杠；空白/非字符串 → null", async () => {
    expect(await pwaIndexBaseUrl()).toBe("https://pwa.host");
    bridgeUrl = "  ";
    expect(await pwaIndexBaseUrl()).toBeNull();
    bridgeUrl = 42;
    expect(await pwaIndexBaseUrl()).toBeNull();
  });

  it("无桥 → failed/offline", async () => {
    delete (globalThis as { window?: unknown }).window;
    const r = await fetchPwaIndex();
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toBe("offline");
  });

  it("fetch 抛错 → failed/unreachable；非 2xx → unreachable + 拒绝理由", async () => {
    (globalThis as { fetch?: unknown }).fetch = (async () => {
      throw new Error("scheme refused");
    });
    const r1 = await fetchPwaIndex();
    expect(r1).toEqual({ kind: "failed", reason: "unreachable", detail: "scheme refused" });

    fetchImpl = async () => ({ ok: false, status: 403, text: async () => "denied", json: async () => ({}) });
    (globalThis as { fetch?: unknown }).fetch = fetchImpl;
    const r2 = await fetchPwaIndex();
    expect(r2).toEqual({ kind: "failed", reason: "unreachable", detail: "denied" });
  });

  it("坏 JSON / 未知 schema → failed/unreadable；好文档 → ok 携带 doc+base", async () => {
    fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => {
        throw new Error("bad json");
      },
    });
    (globalThis as { fetch?: unknown }).fetch = fetchImpl;
    const r1 = await fetchPwaIndex();
    expect(r1.kind).toBe("failed");
    if (r1.kind === "failed") expect(r1.reason).toBe("unreadable");

    fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ schema: 999 }),
    });
    (globalThis as { fetch?: unknown }).fetch = fetchImpl;
    const r2 = await fetchPwaIndex();
    expect(r2.kind).toBe("failed");
    if (r2.kind === "failed") expect(r2.reason).toBe("unreadable");

    fetchImpl = async () => ({ ok: true, status: 200, text: async () => "", json: async () => okDoc() });
    (globalThis as { fetch?: unknown }).fetch = fetchImpl;
    const ok = await fetchPwaIndex();
    expect(ok.kind).toBe("ok");
    if (ok.kind === "ok") {
      expect(ok.base).toBe("https://pwa.host");
      expect(ok.doc.apps[0]!.id).toBe("app.a");
    }
  });
});



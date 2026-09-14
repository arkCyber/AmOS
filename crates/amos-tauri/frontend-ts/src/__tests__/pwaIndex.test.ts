import { describe, expect, test } from "bun:test";
import {
  PWA_INDEX_SCHEMA,
  normalizePwaIndex,
  pwaAllTools,
  pwaEntryGlyph,
  pwaEntryIconUrl,
} from "../lib/pwaIndex";

/**
 * Pure contract tests for the PWA-index client's **normaliser** (no DOM, no
 * bridge — the bridge/fetch half lives in `svelte-tests/pwa-index.test.ts`,
 * because `lib/backend`'s bridge needs `window`).
 *
 * The document shape here is exactly what `amos-appstore::pwa` emits
 * (docs/pwa-index.md §2), so a change on the Rust side that breaks the consumer
 * breaks these too.
 */
function doc(overrides: Record<string, unknown> = {}) {
  return {
    schema: PWA_INDEX_SCHEMA,
    apps: [
      {
        app: { id: "org.amos.demo.odds", name: "Open Odds", version: "1.0.0", description: "d" },
        display: {
          url: "https://odds.example.org",
          icon: "icons/org.amos.demo.odds.png",
          mode: "fullscreen",
          orientation: "portrait",
          theme_color: "#0F172A",
        },
        mcp_tools: [
          {
            name: "query_market_odds",
            description: "查赔率",
            inputSchema: {
              type: "object",
              required: ["event_keywords"],
              properties: { event_keywords: { type: "string", description: "关键词" } },
            },
            execution: {
              action: "url_redirect",
              url_template: "https://odds.example.org/s/{event_keywords}",
            },
          },
        ],
        permissions: { network: { allowed_domains: ["odds.example.org"] } },
      },
    ],
    ...overrides,
  };
}

/** The one app in [`doc`], for the entry-level cases. */
function firstApp(overrides: Record<string, unknown>) {
  return normalizePwaIndex(doc({ apps: [overrides] }))!.apps[0]!;
}

describe("pwaIndex — normalisation", () => {
  test("reads the gateway's own document shape", () => {
    const parsed = normalizePwaIndex(doc())!;
    expect(parsed.schema).toBe(PWA_INDEX_SCHEMA);
    expect(parsed.apps).toHaveLength(1);
    const app = parsed.apps[0]!;
    expect(app.id).toBe("org.amos.demo.odds");
    expect(app.display.mode).toBe("fullscreen");
    expect(app.display.themeColor).toBe("#0F172A");
    expect(app.allowedDomains).toEqual(["odds.example.org"]);
    expect(app.mcpTools[0]!.name).toBe("query_market_odds");
    expect(app.mcpTools[0]!.action).toBe("url_redirect");
    expect(app.mcpTools[0]!.inputSchema.required).toEqual(["event_keywords"]);
    expect(app.mcpTools[0]!.urlTemplate).toContain("{event_keywords}");
  });

  test("refuses an unknown schema instead of half-reading it", () => {
    // The document carries a version so a consumer can *decline*. Guessing here
    // would render a plausible lie about what the system declares.
    expect(normalizePwaIndex(doc({ schema: 2 }))).toBeNull();
    expect(normalizePwaIndex(doc({ schema: "1" }))).toBeNull();
    expect(normalizePwaIndex(doc({ schema: undefined }))).toBeNull();
  });

  test("rejects non-objects without throwing", () => {
    for (const bad of [null, undefined, 42, "x", [], true]) {
      expect(normalizePwaIndex(bad)).toBeNull();
    }
  });

  test("a missing `apps` is an empty index, not an unreadable one", () => {
    expect(normalizePwaIndex({ schema: PWA_INDEX_SCHEMA })).toEqual({
      schema: PWA_INDEX_SCHEMA,
      apps: [],
    });
  });

  test("drops entries with no id (the tile identity) and keeps the rest", () => {
    const parsed = normalizePwaIndex(
      doc({ apps: [{ app: { name: "no id" } }, (doc() as { apps: unknown[] }).apps[0]] }),
    )!;
    expect(parsed.apps.map((a) => a.id)).toEqual(["org.amos.demo.odds"]);
  });
});

describe("pwaIndex — entry fallbacks", () => {
  test("falls back to the id as the name rather than rendering a blank tile", () => {
    const app = firstApp({ app: { id: "org.amos.x" }, display: {}, mcp_tools: [] });
    expect(app.name).toBe("org.amos.x");
    expect(app.version).toBe("");
    expect(app.display.icon).toBeNull();
    expect(app.display.mode).toBe("standalone");
    expect(app.display.orientation).toBe("any");
    expect(app.mcpTools).toEqual([]);
    expect(app.allowedDomains).toEqual([]);
  });

  test("a tool with no name is dropped (it is not addressable at all)", () => {
    const app = firstApp({
      app: { id: "org.amos.x" },
      display: {},
      mcp_tools: [
        { description: "nameless" },
        { name: "kept", description: "", inputSchema: {}, execution: {} },
      ],
    });
    expect(app.mcpTools.map((t) => t.name)).toEqual(["kept"]);
    // The kept tool still gets a usable schema (never `undefined` in the UI).
    expect(app.mcpTools[0]!.inputSchema).toEqual({ type: "object", required: [], properties: {} });
    expect(app.mcpTools[0]!.urlTemplate).toBeNull();
  });

  test("non-string required names / domains are filtered, not stringified", () => {
    const app = firstApp({
      app: { id: "org.amos.x" },
      display: {},
      mcp_tools: [
        {
          name: "t",
          description: "",
          inputSchema: { type: "object", required: ["a", 7, null], properties: {} },
          execution: {},
        },
      ],
      permissions: { network: { allowed_domains: ["ok.example.org", 5] } },
    });
    expect(app.mcpTools[0]!.inputSchema.required).toEqual(["a"]);
    expect(app.allowedDomains).toEqual(["ok.example.org"]);
  });
});

describe("pwaIndex — presentation helpers", () => {
  test("glyph falls back to a globe, never a blank tile", () => {
    expect(pwaEntryGlyph("open odds")).toBe("O");
    expect(pwaEntryGlyph("   ")).toBe("🌐");
    expect(pwaEntryGlyph("")).toBe("🌐");
  });

  test("icon URL is absolute under the platform base, and null when none is declared", () => {
    const withIcon = normalizePwaIndex(doc())!.apps[0]!;
    expect(pwaEntryIconUrl("http://amos-app.index/", withIcon)).toBe(
      "http://amos-app.index/icons/org.amos.demo.odds.png",
    );
    expect(pwaEntryIconUrl("amos-app://index", withIcon)).toBe(
      "amos-app://index/icons/org.amos.demo.odds.png",
    );
    const without = firstApp({ app: { id: "x" }, display: { url: "https://x.example.org" } });
    expect(pwaEntryIconUrl("amos-app://index", without)).toBeNull();
  });

  test("the flat tool dictionary keeps the owning app for every tool", () => {
    const tools = pwaAllTools(normalizePwaIndex(doc())!);
    expect(tools.map((t) => t.app)).toEqual(["org.amos.demo.odds"]);
    expect(tools[0]!.tool.name).toBe("query_market_odds");
    expect(pwaAllTools({ schema: PWA_INDEX_SCHEMA, apps: [] })).toEqual([]);
  });
});


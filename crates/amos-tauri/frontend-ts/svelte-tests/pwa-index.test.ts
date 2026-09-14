/**
 * DOM tests for the PWA-index client's **bridge/fetch** half
 * (`src/lib/pwaIndex.ts`) and the「Web 应用」screen (`PwaHubApp.svelte`).
 *
 * These live under vitest rather than `src/__tests__` because the bridge
 * (`lib/backend`) reads `window.__TAURI_INTERNALS__`, and the bun suite runs with
 * no DOM — a bridge test there cannot even install itself.
 *
 * What is pinned here is the part that would otherwise fail *silently and
 * plausibly*: the index base URL comes from the host (a hard-coded
 * `amos-app://index` is dead on Android and looks like "the index is empty"), and
 * every failure mode is a **different** message rather than a blank screen.
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  PWA_INDEX_SCHEMA,
  fetchPwaIndex,
  indexDocumentUrlFor,
  pwaIndexBaseUrl,
} from "../src/lib/pwaIndex";
import { cleanup, render } from "@testing-library/svelte";
import PwaHubApp from "../src/svelte/PwaHubApp.svelte";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  globalThis.fetch = originalFetch;
});

/** Install a host bridge that answers `pwa_index_url` with `url`. */
function installBridge(url: unknown) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => (cmd === "pwa_index_url" ? url : null),
  };
}

/** Answer the index fetch with `body` (a JSON-able value or a raw response shape). */
function stubFetch(shape: {
  ok?: boolean;
  status?: number;
  json?: () => unknown;
  text?: () => string;
  throws?: Error;
}) {
  globalThis.fetch = (async () => {
    if (shape.throws) throw shape.throws;
    return {
      ok: shape.ok ?? true,
      status: shape.status ?? 200,
      json: async () => (shape.json ? shape.json() : null),
      text: async () => (shape.text ? shape.text() : ""),
    };
  }) as unknown as typeof fetch;
}

function doc(apps: unknown[]) {
  return { schema: PWA_INDEX_SCHEMA, apps };
}

const ONE_APP = {
  app: { id: "org.amos.demo.odds", name: "Open Odds", version: "1.0.0", description: "d" },
  display: { url: "https://odds.example.org", icon: null, mode: "fullscreen" },
  mcp_tools: [
    {
      name: "query_market_odds",
      description: "查赔率",
      inputSchema: { type: "object", required: ["event_keywords"], properties: {} },
      execution: { action: "url_redirect" },
    },
  ],
  permissions: { network: { allowed_domains: ["odds.example.org"] } },
};

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const settle = () => new Promise((r) => setTimeout(r, 40));

describe("pwaIndex — the base URL is the host's, not a literal", () => {
  test("no bridge means no base URL (offline, not 'empty')", async () => {
    expect(await pwaIndexBaseUrl()).toBeNull();
    expect(await fetchPwaIndex()).toEqual({
      kind: "failed",
      reason: "offline",
      detail: "no Tauri bridge",
    });
  });

  test("the host's base URL is used verbatim, trailing slash trimmed", async () => {
    installBridge("amos-app://index");
    expect(await pwaIndexBaseUrl()).toBe("amos-app://index");
    expect(indexDocumentUrlFor("amos-app://index")).toBe("amos-app://index/apps.json");
    expect(indexDocumentUrlFor("amos-app://index/")).toBe("amos-app://index/apps.json");

    // The Windows/Android form. A literal `amos-app://` in the frontend would be
    // dead there — and would present as an empty index, not as a wrong URL.
    installBridge("http://amos-app.index/");
    expect(await pwaIndexBaseUrl()).toBe("http://amos-app.index");
    expect(indexDocumentUrlFor("http://amos-app.index")).toBe("http://amos-app.index/apps.json");
  });

  test("an unusable base URL from the host is refused, not pasted into a fetch", async () => {
    for (const bad of ["", "   ", "amos-app://index app", 42, null]) {
      installBridge(bad);
      expect(await pwaIndexBaseUrl()).toBeNull();
    }
  });
});

describe("pwaIndex — every failure is its own reason", () => {
  test("offline (no bridge) is distinct from unreachable", async () => {
    expect(await fetchPwaIndex()).toEqual({
      kind: "failed",
      reason: "offline",
      detail: "no Tauri bridge",
    });
  });

  test("a refusal carries the gateway's own reason text", async () => {
    installBridge("amos-app://index");
    stubFetch({ ok: false, status: 404, text: () => "no PWA index directory is configured\n" });
    const result = await fetchPwaIndex();
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("unreachable");
      expect(result.detail).toBe("no PWA index directory is configured");
    } else throw new Error("expected a failure");
  });

  test("a bodiless failure still reports the status", async () => {
    installBridge("amos-app://index");
    stubFetch({ ok: false, status: 404, text: () => "" });
    const result = await fetchPwaIndex();
    if (result.kind === "failed") expect(result.detail).toBe("HTTP 404");
    else throw new Error("expected a failure");
  });

  test("a transport error is 'unreachable'", async () => {
    installBridge("amos-app://index");
    stubFetch({ throws: new Error("scheme not registered") });
    const result = await fetchPwaIndex();
    expect(result.kind === "failed" && result.reason === "unreachable").toBe(true);
  });

  test("bad JSON and an unknown schema are both 'unreadable', never a guess", async () => {
    installBridge("amos-app://index");
    stubFetch({
      json: () => {
        throw new Error("not json");
      },
    });
    let result = await fetchPwaIndex();
    expect(result.kind === "failed" && result.reason === "unreadable").toBe(true);

    stubFetch({ json: () => doc([]).schema === PWA_INDEX_SCHEMA ? { schema: 99 } : null });
    result = await fetchPwaIndex();
    expect(result.kind === "failed" && result.reason === "unreadable").toBe(true);
    if (result.kind === "failed") expect(result.detail).toContain("schema");
  });

  test("a 200 with a readable document is 'ok'", async () => {
    installBridge("http://amos-app.index");
    stubFetch({ json: () => doc([ONE_APP]) });
    const result = await fetchPwaIndex();
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.doc.apps[0]!.name).toBe("Open Odds");
      // The base the load actually used travels with the answer.
      expect(result.base).toBe("http://amos-app.index");
    }
  });

  test("one load asks the host for the base exactly once", async () => {
    let baseCalls = 0;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd !== "pwa_index_url") return null;
        baseCalls += 1;
        return "amos-app://index";
      },
    };
    stubFetch({ json: () => doc([ONE_APP]) });
    const result = await fetchPwaIndex();
    expect(result.kind).toBe("ok");
    // The caller used to ask for the base itself and then `fetchPwaIndex` asked
    // again: two control-plane calls and two copies of the same fact. The result
    // now carries the base, so there is exactly one.
    expect(baseCalls).toBe(1);
    if (result.kind === "ok") expect(result.base).toBe("amos-app://index");
  });
});


describe("PwaHubApp.svelte — the「Web 应用」screen", () => {
  test("renders the declared tile + its agent tools, and the platform base URL", async () => {
    installBridge("http://amos-app.index");
    stubFetch({ json: () => doc([ONE_APP]) });
    const host = render(PwaHubApp);
    await settle();
    await settle();

    expect(txt(host)).toContain("Web 应用");
    expect(host.container.querySelectorAll('[data-testid="pwa-tile"]')).toHaveLength(1);
    expect(txt(host)).toContain("Open Odds");
    // The capability total is the screen's reason to exist.
    expect(txt(host)).toContain("1 个智能体工具");
    // The base the host handed over is visible, so a wrong one is diagnosable.
    expect(txt(host)).toContain("http://amos-app.index");

    // Selecting a tile reveals the declaration: entry, domains, tool, and the
    // honest note that a remote entry cannot be launched yet.
    const tile = host.container.querySelector('[data-testid="pwa-tile"]') as HTMLButtonElement;
    tile.click();
    await settle();
    expect(txt(host)).toContain("org.amos.demo.odds");
    expect(txt(host)).toContain("query_market_odds");
    expect(txt(host)).toContain("odds.example.org");
    expect(txt(host)).toContain("没有打开外部站点的能力");
  });

  test("an entry with no icon uses its glyph instead of requesting a picture", async () => {
    installBridge("amos-app://index");
    stubFetch({ json: () => doc([ONE_APP]) });
    const host = render(PwaHubApp);
    await settle();
    await settle();
    expect(host.container.querySelector('[data-testid="pwa-icon"]')).toBeNull();
    expect(txt(host)).toContain("O");
  });

  test("an empty index says so — it is not a failure", async () => {
    installBridge("amos-app://index");
    stubFetch({ json: () => doc([]) });
    const host = render(PwaHubApp);
    await settle();
    await settle();
    expect(host.container.querySelector('[data-testid="pwa-empty"]')).not.toBeNull();
    expect(txt(host)).toContain("未预置 Web 应用");
    expect(txt(host)).toContain("AMOS_PWA_INDEX_DIR");
    expect(host.container.querySelector('[data-testid="pwa-failed"]')).toBeNull();
  });

  test("an unreachable gateway shows its reason, not a blank frame", async () => {
    installBridge("amos-app://index");
    stubFetch({ ok: false, status: 404, text: () => "no PWA index directory is configured" });
    const host = render(PwaHubApp);
    await settle();
    await settle();
    expect(txt(host)).toContain("索引网关无法访问");
    expect(txt(host)).toContain("no PWA index directory is configured");
    expect(host.container.querySelector('[data-testid="pwa-reload"]')).not.toBeNull();
  });

  test("outside AmOS it says so instead of blaming the index", async () => {
    // No bridge installed at all.
    const host = render(PwaHubApp);
    await settle();
    await settle();
    expect(txt(host)).toContain("未在 AmOS 内运行");
  });

  test("an unknown schema is reported as unreadable, never rendered as empty", async () => {
    installBridge("amos-app://index");
    stubFetch({ json: () => ({ schema: 99, apps: [] }) });
    const host = render(PwaHubApp);
    await settle();
    await settle();
    expect(txt(host)).toContain("索引无法按本版本解读");
    expect(host.container.querySelector('[data-testid="pwa-empty"]')).toBeNull();
  });
});


/**
 * __tests__/enterprise-api.test.ts — `enterprise/api.ts` 的行为测试（P2-1 覆盖）
 *
 * 为什么值得单独一个文件：管道修复（REQ-A390，让 DOM 测试的覆盖也算数）之后，`api.ts`
 * 是 `src/lib` 里**未覆盖最多**的文件（351 行 / 34%），而它的每条逻辑都是无头可验的真契约：
 * URL 拼接、三种认证头、JSON 解析、非 2xx 的措辞、指数退避重试、每分钟/小时/每天的限流、
 * 配置与限流计数落盘、`testConnection` 的四种回答。
 *
 * 这个文件**故意不导入 happy-dom**（原因见 enterprise-webhooks.test.ts）：导入即被判为
 * DOM 文件、不进 P2-1 覆盖率。`amosStore` 只用到 `window.localStorage`，给它一个内存实现。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { apiClient } from "../enterprise/api";
import { readStoreValue, writeStoreValue } from "../amosStore";

/**
 * 与 `enterprise-webhooks.test.ts` 同样的两个考虑：**不导入 happy-dom**（否则被判为 DOM
 * 文件、不进 P2-1 覆盖率），以及 `window.localStorage` 桩**只在本文件生命周期内存在**
 * （pure 批次是一个进程跑所有文件，顶层安装会泄漏给同批次的其他文件 —— 实测会改变它们的
 * 分支，让无关用例失败）。
 */
const memory = new Map<string, string>();
const stub = {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => void memory.set(key, String(value)),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  },
};
const globals = globalThis as Record<string, unknown>;
const previousWindow = globals.window;

beforeAll(() => {
  globals.window = stub;
});

afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
});

const realFetch = globalThis.fetch;

/** 每个用例从一个干净的、可用的客户端开始（默认配置是 `enabled: false`）。 */
beforeEach(async () => {
  memory.clear();
  // `apiClient` 是单例，而 `loadRateLimits()` 只在**存储里有记录**时才重建内存计数器
  // （`if (!raw) return;`）—— 所以清空存储并不会清空计数器：前几个用例发过的请求会留在
  // 单例里，让「每分钟 1 次」的用例一上来就被判定超限。写一条空记录强制它重建。
  writeStoreValue("amos.shortcuts.api.rate_limits", JSON.stringify({}));
  apiClient.configure({
    enabled: true,
    baseUrl: "https://api.example.test",
    authType: "api_key", // “不带认证” = api_key + 空 key（buildHeaders 只在 key 非空时加头）
    apiKey: "",
    bearerToken: "",
    username: "",
    password: "",
    timeout: 200,
    retryCount: 0,
    retryDelay: 1,
    debug: false,
    defaultHeaders: { "X-Default": "1" },
    rateLimits: { enabled: true, requestsPerMinute: 1000, requestsPerHour: 1000, requestsPerDay: 1000 },
  });
  await apiClient.initialize();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  memory.clear();
});

describe("APIClient 配置", () => {
  test("默认配置是关闭的，request 直接回「API 未启用」且不发请求", async () => {
    // 用一个**全新**客户端验证默认值（单例已被 configure 过）。
    const { APIClient } = await import("../enterprise/api");
    const fresh = new APIClient();
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fresh.get("/anything");
    expect(res.success).toBe(false);
    expect(res.error).toBe("API 未启用");
    expect(res.statusCode).toBe(0);
    expect(called).toBe(0);
  });

  test("configure/saveConfig 落盘，getConfig 回的是副本", () => {
    apiClient.configure({ baseUrl: "https://saved.example.test" });
    const stored = JSON.parse(readStoreValue<string>("amos.shortcuts.api.config", "{}"));
    expect(stored.baseUrl).toBe("https://saved.example.test");

    const copy = apiClient.getConfig();
    copy.baseUrl = "mutated";
    expect(apiClient.getConfig().baseUrl).toBe("https://saved.example.test");
  });

  test("存储里的配置是坏 JSON 时回落到默认值（不抛）", async () => {
    memory.set("amos.shortcuts.api.config", JSON.stringify("{broken"));
    const { APIClient } = await import("../enterprise/api");
    const fresh = new APIClient();
    await fresh.initialize();
    expect(fresh.getConfig().enabled).toBe(false); // DEFAULT_API_CONFIG
  });

  test("存储里的限流计数是坏 JSON 时 initialize 不抛", async () => {
    memory.set("amos.shortcuts.api.rate_limits", JSON.stringify("{broken"));
    const { APIClient } = await import("../enterprise/api");
    const fresh = new APIClient();
    await fresh.initialize();
    expect(fresh.getConfig()).toBeDefined();
  });
});


describe("APIClient 请求（fetch 打桩）", () => {
  test("URL 拼接 + 查询参数 + 默认头 + JSON 解析", async () => {
    let seen: { url: string; init: RequestInit } = { url: "", init: {} };
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await apiClient.get<{ ok: boolean }>("/v1/things", { q: "a b", page: "2" });
    expect(seen.url).toBe("https://api.example.test/v1/things?q=a+b&page=2");
    const headers = seen.init.headers as Record<string, string>;
    expect(headers["X-Default"]).toBe("1");
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ ok: true });
    expect(res.statusCode).toBe(200);
  });

  test("POST/PUT/DELETE 带上方法、body 与自定义头", async () => {
    const seen: Array<{ method: string; body?: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push({
        method: String(init.method),
        body: init.body as string | undefined,
        headers: init.headers as Record<string, string>,
      });
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;

    await apiClient.request({ method: "POST", path: "/v1/a", body: { n: 1 }, headers: { "X-Custom": "yes" } });
    await apiClient.put("/v1/b", { n: 2 });
    await apiClient.delete("/v1/c");

    expect(seen[0]!.method).toBe("POST");
    expect(JSON.parse(seen[0]!.body!)).toEqual({ n: 1 });
    expect(seen[0]!.headers["X-Custom"]).toBe("yes"); // 自定义头只在 request() 上可传
    expect(seen[1]!.method).toBe("PUT");
    expect(seen[2]!.method).toBe("DELETE");
    expect(seen[2]!.body).toBeUndefined(); // 没有 body 时不发空串
  });

  test("三种认证头：api_key / bearer / basic", async () => {
    const sent: Array<Record<string, string>> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    apiClient.configure({ authType: "api_key", apiKey: "k-123" });
    await apiClient.get("/a");
    apiClient.configure({ authType: "bearer_token", bearerToken: "t-456" });
    await apiClient.get("/b");
    apiClient.configure({ authType: "basic", username: "u", password: "p" });
    await apiClient.get("/c");

    expect(sent[0]!["X-API-Key"]).toBe("k-123");
    expect(sent[1]!["Authorization"]).toBe("Bearer t-456");
    expect(sent[2]!["Authorization"]).toBe(`Basic ${btoa("u:p")}`);
  });

  test("非 2xx：success=false 且措辞是 HTTP <code>: <text>", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
    const res = await apiClient.get("/missing");
    expect(res.success).toBe(false);
    expect(res.error).toBe("HTTP 404: Not Found");
    expect(res.statusCode).toBe(404);
  });

  test("抛异常会按 retryCount 重试，用尽后回最后一条错误", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      throw new Error("boom");
    }) as unknown as typeof fetch;
    apiClient.configure({ retryCount: 2, retryDelay: 1 });
    const res = await apiClient.get("/flaky");
    expect(attempts).toBe(3); // 首次 + 2 次重试
    expect(res.success).toBe(false);
    expect(res.error).toBe("boom");
    expect(res.statusCode).toBe(0);
  });
});

describe("APIClient 速率限制", () => {
  test("超过每分钟限制：429 + 措辞，且被阻止的请求不发出去", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    apiClient.configure({
      rateLimits: { enabled: true, requestsPerMinute: 1, requestsPerHour: 1000, requestsPerDay: 1000 },
    });

    expect((await apiClient.get("/one")).success).toBe(true);
    const blocked = await apiClient.get("/two");
    expect(blocked.success).toBe(false);
    expect(blocked.error).toBe("超过每分钟请求限制");
    expect(blocked.statusCode).toBe(429);
    expect(called).toBe(1);
    expect(readStoreValue<string>("amos.shortcuts.api.rate_limits", "")).toContain("api_requests");
  });

  test("skipRateLimit 可以绕过限流", async () => {
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    apiClient.configure({
      rateLimits: { enabled: true, requestsPerMinute: 0, requestsPerHour: 0, requestsPerDay: 0 },
    });
    const bypass = await apiClient.request({ method: "GET", path: "/x", skipRateLimit: true });
    expect(bypass.success).toBe(true);
  });

  test("限流关闭时不阻止", async () => {
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    apiClient.configure({
      rateLimits: { enabled: false, requestsPerMinute: 0, requestsPerHour: 0, requestsPerDay: 0 },
    });
    expect((await apiClient.get("/y")).success).toBe(true);
  });
});

describe("APIClient.testConnection", () => {
  test("未启用 / 未配置 baseUrl 各有自己的措辞", async () => {
    apiClient.configure({ enabled: false });
    expect(await apiClient.testConnection()).toEqual({ success: false, message: "API 未启用" });
    apiClient.configure({ enabled: true, baseUrl: "" });
    expect(await apiClient.testConnection()).toEqual({ success: false, message: "基础 URL 未配置" });
  });

  test("HEAD 成功 / 非 2xx / 抛异常 的三种回答", async () => {
    const responses: Array<() => Promise<Response>> = [
      async () => new Response("", { status: 200 }),
      async () => new Response("", { status: 500 }),
      async () => {
        throw new Error("ECONNREFUSED");
      },
    ];
    apiClient.configure({ baseUrl: "https://probe.example.test" });

    for (const [i, make] of responses.entries()) {
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        expect(url).toBe("https://probe.example.test");
        expect(init.method).toBe("HEAD");
        return make();
      }) as unknown as typeof fetch;
      const res = await apiClient.testConnection();
      if (i === 0) expect(res).toEqual({ success: true, message: "连接成功" });
      if (i === 1) expect(res).toEqual({ success: false, message: "连接失败: HTTP 500" });
      if (i === 2) expect(res.message).toContain("连接失败: ECONNREFUSED");
    }
  });
});

// 这里曾有一个 `describe("api.ts 自带的 WebhookManager")`：`api.ts` 里那份 `WebhookManager`
// 与 `enterprise/webhooks.ts` 的那一份**重复**，而 `enterprise/index.ts` 只把后者接进生产
// （`APISettings.svelte` 用的是 `webhooks.ts` 的 `testWebhook` 等方法，`api.ts` 那份没有）。
// 按仓库的判据（"wire it, delete it, or baseline it"）删掉重复实现，这一组测试随之作废
// （`webhooks.ts` 的 16 例 `enterprise-webhooks.test.ts` 才是它的真测试）。
// 顺带修掉本文件的结构漂移：`APIClient.testConnection` 曾经嵌在"速率限制"这个 describe 里，
// 而"限流关闭时不阻止"那条用例被挤到了 describe 之外（顶层）。


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
    //
    // 还要把存储里那份也清掉（REQ-A982）：`beforeEach` 的 `configure(…)` 会**落盘**，
    // 而装载修好之后新客户端会读到那一份 —— 「全新客户端的默认值」这个前提，从前只因为
    // `loadConfig()` 根本没有生产调用者才成立。这里把前提写成显式的：**什么都没存过**。
    memory.delete("amos.shortcuts.api.config");
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

/**
 * 装载的**生产入口**（REQ-A982 / F-SH-309）。
 *
 * 上面每一组都由这个文件的 `beforeEach` 显式跑一次 `apiClient.initialize()`，而
 * `initialize()` 的唯一调用者是 `enterprise/index.ts` 的 `initializeEnterprise()` ——
 * 那个函数在生产里**零调用者**（它自己也在 `scripts/unwired-baseline.json` 里）。
 * 生产里真正会被调到的读取口是 `APISettings.svelte` 的 `apiClient.getConfig()`。
 *
 * 所以这里的每一条都**不碰** `initialize()`：它模拟的是「新进程里面板挂载」那一步。
 * 形状即 `project_test_on_helper_not_the_seam`：把 `getConfig()` / `saveConfig()` /
 * `request()` / `testConnection()` 里那四行 `this.ensureInitialized()` 删掉（其余一字不动），
 * 本组四条**全红**（实测：4 red / 21 green），上面所有用例仍然全绿。
 */
describe("APIClient 的装载由生产入口执行", () => {
  const CONFIG_KEY = "amos.shortcuts.api.config";
  const stored = (config: Record<string, unknown>) => writeStoreValue(CONFIG_KEY, JSON.stringify(config));

  test("新进程第一次 getConfig() 回的是存储里那份，不是编译期默认值", async () => {
    stored({ enabled: true, baseUrl: "https://saved.example.test" });
    const { APIClient } = await import("../enterprise/api");
    const fresh = new APIClient();
    // 面板挂载时读的就是这一句 —— 没有任何 `initialize()`。
    expect(fresh.getConfig().baseUrl).toBe("https://saved.example.test");
    expect(fresh.getConfig().enabled).toBe(true);
    // 双侧：没存过的字段仍回落默认值，装载不是「整份替换成存储里那份残缺 JSON」。
    expect(fresh.getConfig().authType).toBe("api_key");
  });

  test("新进程的 request() 判的是存储里那份 enabled（否则用户启用了也拿「API 未启用」）", async () => {
    stored({ enabled: true, baseUrl: "https://saved.example.test" });
    const { APIClient } = await import("../enterprise/api");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const res = await new APIClient().get<{ ok: boolean }>("/v1/things");
    expect(res.success).toBe(true);
    expect(res.error).toBeUndefined();
  });

  test("保存不会用默认值覆盖存储里那份（面板「读默认值 → 整份写回」的破坏路径）", async () => {
    stored({ enabled: true, baseUrl: "https://saved.example.test", timeout: 1234 });
    const { APIClient } = await import("../enterprise/api");
    const fresh = new APIClient();
    // `APISettings.svelte` 的做法：挂载时读一份，改一个字段，把**整份**写回。
    const shown = fresh.getConfig();
    expect(shown.timeout).toBe(1234); // 先证明读到的是存储那份，不是默认的 30000
    fresh.configure({ ...shown, timeout: 999 });
    const after = JSON.parse(readStoreValue<string>(CONFIG_KEY, "{}"));
    // 用户没碰过的字段必须原样活着 —— 这是 `saveConfig` 先装载再合并的理由。
    expect(after.baseUrl).toBe("https://saved.example.test");
    expect(after.enabled).toBe(true);
    expect(after.timeout).toBe(999);
  });

  /**
   * **双侧**：只说「未启用时报未启用」是一句**恒真**的断言 —— 默认值恰好也是 `enabled: false`，
   * 所以它删掉 `testConnection` 里那行 `ensureInitialized()` 仍然全绿（第一版负控实测：四条里
   * 只有三条红，就是这一条没红）。反过来那一侧才是判据：存储里**已启用**时，`testConnection`
   * 必须拿着那份 `baseUrl` 真的去连，而不是回「API 未启用」。
   */
  test("testConnection 判的是存储里那份 enabled（两侧）", async () => {
    stored({ enabled: true, baseUrl: "https://saved.example.test" });
    const { APIClient } = await import("../enterprise/api");
    let probed = "";
    globalThis.fetch = (async (url: string) => {
      probed = String(url);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const enabled = await new APIClient().testConnection();
    expect(enabled.message).toBe("连接成功");
    expect(probed).toBe("https://saved.example.test");

    stored({ enabled: false, baseUrl: "https://saved.example.test" });
    const { APIClient: Fresh } = await import("../enterprise/api");
    expect((await new Fresh().testConnection()).message).toBe("API 未启用");
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

/**
 * REQ-A801 — the auth vocabulary is **total**, and the fourth member is *stated*.
 *
 * The block above covers the three members that produce a header. What it could not cover is
 * the member that produces **none**: `buildHeaders` was an `if`/`else if` chain with three
 * branches over a four-member `APIAuthType`, so `oauth2` fell off the end and a request went
 * out with **no authentication header at all** — a 401 with nothing on screen to explain it.
 *
 * A chain cannot be made exhaustive, so the decision is now a `Record<APIAuthType, AuthTypeInfo>`
 * (a missing member is a compile error) and the "no header" branch had to be written down with a
 * reason. These tests pin that the fourth member is a *decision* rather than an accident.
 */
describe("认证方式的词表是全的（REQ-A801）", () => {
  const allFields = {
    apiKey: "k",
    bearerToken: "t",
    username: "u",
    password: "p",
  };

  test("逐个成员：有实现的就产出请求头，没有实现的就是 null", async () => {
    const { AUTH_TYPES, AUTH_TYPE_INFO } = await import("../enterprise/api");
    // The vocabulary the settings screen renders and the one the request path switches on are
    // the same array — `APIAuthType` is derived from `AUTH_TYPES`, so a member cannot be added
    // to the type without appearing in the screen's list.
    for (const type of AUTH_TYPES) {
      const info = AUTH_TYPE_INFO[type];
      expect(info, `AUTH_TYPE_INFO has no entry for ${type}`).toBeDefined();
      // An implementation always reads at least one credential, and an unimplemented member
      // reads none: the two halves of "this build can / cannot do it" have to agree.
      expect(info.fields.length > 0, `${type}: implemented ⟺ it reads credentials`).toBe(
        info.implemented,
      );
      const full = { authType: type, ...allFields } as Parameters<typeof info.header>[0];
      const header = info.header(full);
      // With every credential filled, a header exists exactly when there is an implementation.
      expect(header !== null, `${type}: implemented ⟺ a filled config produces a header`).toBe(
        info.implemented,
      );
    }
  });

  test("oauth2：填满所有凭据也不会产生认证头——这是**本版本没有流程**，不是配置漏填", async () => {
    const { AUTH_TYPE_INFO } = await import("../enterprise/api");
    const info = AUTH_TYPE_INFO.oauth2;
    expect(info.implemented).toBe(false);
    expect(info.fields).toEqual([]);
    expect(
      info.header({ authType: "oauth2", ...allFields } as Parameters<typeof info.header>[0]),
    ).toBeNull();
  });

  test("oauth2 真的发不出去认证头（不是只写在类型里）", async () => {
    // The end-to-end version of the assertion above: through the real request path.
    const sent: Array<Record<string, string>> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    apiClient.configure({ authType: "oauth2", ...allFields });
    await apiClient.get("/oauth");

    expect(sent[0]!["Authorization"]).toBeUndefined();
    expect(sent[0]!["X-API-Key"]).toBeUndefined();
  });

  test("凭据填了一部分：没有头，而且这与 oauth2 是两回事", async () => {
    // `null` from a *builder* means "nothing to send yet"; `null` from an unimplemented member
    // means "this build cannot". Both send no header, and only `implemented` tells them apart —
    // which is what the screen reads to decide between "enter your credential" and "unavailable".
    const { AUTH_TYPE_INFO } = await import("../enterprise/api");
    const basic = AUTH_TYPE_INFO.basic;
    expect(basic.implemented).toBe(true);
    expect(
      basic.header({ authType: "basic", username: "u", password: "" } as Parameters<
        typeof basic.header
      >[0]),
    ).toBeNull();
  });
});

/**
 * REQ-A806 — a save **reports whether it landed**, and a refusal reaches something with a reader.
 *
 * Before this, `configure()` returned `void` and the refusal stopped at `enterprise/logger.ts`,
 * a `console.*` wrapper nothing in the app reads — while `APISettings.svelte` showed
 * 「配置已保存」 for every attempt. The claim stayed true only until the next launch.
 */
describe("保存要报告它到底有没有落盘（REQ-A806）", () => {
  /** Run `fn` with `localStorage.setItem` refusing, the way a full or unavailable store does. */
  function withRefusingStore<T>(fn: () => T): T {
    const realSet = stub.localStorage.setItem;
    stub.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      return fn();
    } finally {
      stub.localStorage.setItem = realSet;
    }
  }

  test("写进去了回 true，被存储拒绝回 false", async () => {
    // `readStoreValue` 已经解了一层，再解一层拿到对象 —— 与「configure/saveConfig 落盘」那条用例同一读法。
    const persistedBaseUrl = () =>
      JSON.parse(readStoreValue<string>("amos.shortcuts.api.config", "{}")).baseUrl as string;

    expect(apiClient.configure({ baseUrl: "https://landed.example.test" })).toBe(true);
    expect(persistedBaseUrl()).toBe("https://landed.example.test");

    expect(
      withRefusingStore(() => apiClient.configure({ baseUrl: "https://refused.example.test" })),
    ).toBe(false);
    // The refusal is about **storage**, not about the config taking effect: the running client
    // uses the new base URL either way, and that is exactly why "saved" and "in effect" must be
    // two different words on screen.
    expect(apiClient.getConfig().baseUrl).toBe("https://refused.example.test");
    // …and the durable copy still says the last thing that actually landed.
    expect(persistedBaseUrl()).toBe("https://landed.example.test");
  });

  test("被拒绝时不只回 false：还落进有读者的诊断账本", async () => {
    const { recentDiag } = await import("../debugLog");
    // 窗口按**单调的** `seq` 开（`recentDiag(1)[0]?.seq`），不按 `recentDiag(-1).length` 的差：环有上限
    // （`RING_CAP`），一满长度就不再增长 ⇒ 「长度差」在账本最忙的时候**恰好**变成空的，断言会冤枉一个
    // 确实落账了的拒绝（REQ-A853；`src/__tests__/debugLog.test.ts` 把这条钉成断言）。
    const mark = recentDiag(1)[0]?.seq ?? 0;
    expect(withRefusingStore(() => apiClient.configure({ baseUrl: "https://nope.test" }))).toBe(
      false,
    );

    const refusal = recentDiag(-1).find(
      (e) => e.seq > mark && e.area === "api" && e.level === "error",
    );
    // A boolean answers exactly one caller; the ledger answers "what has been going wrong
    // lately" — the question someone whose config keeps vanishing actually has.
    expect(refusal, "the refusal must reach the diagnostics ledger").toBeDefined();
    expect(refusal!.msg).toContain("重启后");
  });

  test("updateConfig 与 configure 是同一件事的两个名字，返回值也一致", async () => {
    expect(apiClient.configure({ retryDelay: 7 })).toBe(true);
    expect(apiClient.updateConfig({ retryDelay: 8 })).toBe(true);
    expect(withRefusingStore(() => apiClient.updateConfig({ retryDelay: 9 }))).toBe(false);
  });
});

// 这里曾有一个 `describe("api.ts 自带的 WebhookManager")`：`api.ts` 里那份 `WebhookManager`
// 与 `enterprise/webhooks.ts` 的那一份**重复**，而 `enterprise/index.ts` 只把后者接进生产
// （`APISettings.svelte` 用的是 `webhooks.ts` 的 `testWebhook` 等方法，`api.ts` 那份没有）。
// 按仓库的判据（"wire it, delete it, or baseline it"）删掉重复实现，这一组测试随之作废
// （`webhooks.ts` 的 16 例 `enterprise-webhooks.test.ts` 才是它的真测试）。
// 顺带修掉本文件的结构漂移：`APIClient.testConnection` 曾经嵌在"速率限制"这个 describe 里，
// 而"限流关闭时不阻止"那条用例被挤到了 describe 之外（顶层）。


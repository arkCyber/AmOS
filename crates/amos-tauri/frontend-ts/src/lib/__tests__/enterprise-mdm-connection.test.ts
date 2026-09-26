/**
 * __tests__/enterprise-mdm-connection.test.ts — 「测试连接」**真的**去问服务器（REQ-A819）
 *
 * 这个文件存在的理由：`MDMPanel.svelte::testConnection` 原先不联系任何东西 —— 它
 * `setTimeout` 1 秒，然后只看 `serverUrl.startsWith("https://")`，就报「连接成功」
 * （mdm.connectOk）。一台拼错的、已下线的、或把我们挡在门外的 MDM 服务器，得到的都是
 * 同一个绿色提示；而这个按钮是管理员用来确认「我指对了服务器、它也确实在」的唯一动作。
 *
 * 测的是 `mdmManager.checkConnection()`：它探 `GET {serverUrl}/health` ——
 * `crates/amos-mdm/src/lib.rs:98` 真挂着的路由（`health_check` 回纯文本 `OK`，未认证），
 * 也正是隔壁「API 集成」面板的测试连接在探的那条。本文件**不新造端点**，并且用
 * 「fetch 打到了哪个 URL」把这一点钉住：端点一改，这里就红。
 *
 * 判据是**判别式**（`reason`），不是 boolean：界面要靠它说出「为什么」，所以每一种
 * 失败都要能被区分开。
 *
 * 不注册 happy-dom（`window.localStorage` / `navigator` 用最小桩，只在本文件生命周期内），
 * 与 `enterprise-mdm-policy.test.ts` 同一套约定。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mdmManager, type MDMConfig, type MDMRestrictions } from "../enterprise/mdm";

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
const previousNavigator = globals.navigator;

beforeAll(() => {
  globals.window = stub;
  globals.navigator = { platform: "test-platform", userAgent: "test-agent" };
});

afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
  if (previousNavigator === undefined) delete globals.navigator;
  else globals.navigator = previousNavigator;
});

const realFetch = globalThis.fetch;

/** 每一次 fetch 的 URL，供断言「探的是哪条路径」。 */
const fetched: string[] = [];

/**
 * 打桩 `fetch`。`handler` 返回一个响应描述，或返回 `Error` 让这次调用抛（DNS／TLS／超时
 * 在真实世界里的形状就是这样）。**故意**提供 `text()` 而不是 `json()`：`/health` 回的是
 * `text/plain`，而 `callMDMApi` 那种「假定 JSON」的助手会把它判成解析失败。
 */
function stubFetch(handler: (url: string) => { status: number; body: string } | Error): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    fetched.push(url);
    const result = handler(url);
    if (result instanceof Error) throw result;
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => result.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** 一份最小可用的配置：只要 `serverUrl` 与 `enabled`。 */
function config(serverUrl: string): MDMConfig {
  const restrictions: MDMRestrictions = {
    disabledCategories: [],
    disabledActions: [],
    maxExecutionTime: 300,
    maxExecutionsPerDay: 1000,
    maxActionsPerShortcut: 100,
    maxShortcutsPerUser: 100,
    allowUserCreate: true,
    allowUserModify: true,
    allowUserDelete: true,
    allowSharing: true,
    allowExport: true,
    allowImport: true,
    requireApprovalForCreate: false,
    requireApprovalForModify: false,
    requireApprovalForSharing: false,
  };
  return {
    enabled: true,
    organizationId: "org-1",
    organizationName: "Acme",
    deviceId: "device-test",
    deviceName: "Test Mac",
    serverUrl,
    apiKey: "key-1",
    policies: [],
    restrictions,
    enforcedShortcuts: [],
    enforcedTemplates: [],
    syncInterval: 3600,
    lastSyncAt: 0,
    lastSyncStatus: "success",
    deviceStatus: "active",
    enrolledAt: 0,
    enrolledBy: "admin",
    version: "1.0.0",
  };
}

beforeEach(() => {
  memory.clear();
  mdmManager.clearConfigForTest();
  fetched.length = 0;
  // 每个用例默认给一个「健康服务器」，需要别的形状的用例自己再打一次桩。
  stubFetch(() => ({ status: 200, body: "OK" }));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mdmManager.clearConfigForTest();
  mdmManager.stopAutoSync();
  mdmManager.shutdown();
  memory.clear();
  fetched.length = 0;
});

describe("checkConnection：真的发一次请求，且探的是那条真实存在的路由", () => {
  test("服务器在（200 + OK）⇒ ok，并且打到的正是 {serverUrl}/health", async () => {
    mdmManager.setConfigForTest(config("https://mdm.example.test"));

    await expect(mdmManager.checkConnection()).resolves.toEqual({ ok: true });
    // **这条**是本文件的核心：端点不是编的。改路径名（或加前缀）在这里就红。
    expect(fetched).toEqual(["https://mdm.example.test/health"]);
  });

  test("serverUrl 尾部有斜杠 ⇒ 仍然打到 /health，而不是 //health", async () => {
    mdmManager.setConfigForTest(config("https://mdm.example.test/"));

    await expect(mdmManager.checkConnection()).resolves.toEqual({ ok: true });
    expect(fetched).toEqual(["https://mdm.example.test/health"]);
  });
});

describe("checkConnection：每一种「连不上」都要能区分开", () => {
  test("服务器应答但状态是 503 ⇒ http-status 带上状态码", async () => {
    stubFetch(() => ({ status: 503, body: "upstream down" }));
    mdmManager.setConfigForTest(config("https://mdm.example.test"));

    await expect(mdmManager.checkConnection()).resolves.toEqual({
      ok: false,
      reason: "http-status",
      status: 503,
    });
  });

  test("404 也是一个回答，不是「连不上」——两者不能混成一个", async () => {
    stubFetch(() => ({ status: 404, body: "not found" }));
    mdmManager.setConfigForTest(config("https://mdm.example.test"));

    // 一台**通了但把 /health 挡在外面**的服务器（错误的路径、反向代理、登录门户）
    // 与一台**根本没有应答**的服务器，是两件不同的事，用户要做的处置也不同。
    await expect(mdmManager.checkConnection()).resolves.toEqual({
      ok: false,
      reason: "http-status",
      status: 404,
    });
  });

  test("200 但不是我们的服务器（门户/代理）⇒ unexpected-body", async () => {
    stubFetch(() => ({ status: 200, body: "<html>Please sign in</html>" }));
    mdmManager.setConfigForTest(config("https://mdm.example.test"));

    await expect(mdmManager.checkConnection()).resolves.toEqual({
      ok: false,
      reason: "unexpected-body",
    });
  });

  test("DNS/TLS/超时（fetch 抛）⇒ unreachable，而且**不抛给调用方**", async () => {
    stubFetch(() => new Error("getaddrinfo ENOTFOUND mdm.example.test"));
    mdmManager.setConfigForTest(config("https://mdm.example.test"));

    // 一个按钮需要的是「成没成 + 为什么」，不是一个异常：这里断言的是 promise
    // **兑现**（resolve）而不是 reject。
    await expect(mdmManager.checkConnection()).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  test("理由里**不含**异常的原文（那是机器话）", async () => {
    stubFetch(() => new Error("TimeoutError: The operation was aborted"));
    mdmManager.setConfigForTest(config("https://mdm.example.test"));

    const result = await mdmManager.checkConnection();
    expect(JSON.stringify(result)).not.toContain("TimeoutError");
  });
});

describe("checkConnection：不该发的请求一个也不发", () => {
  test("没有配置 ⇒ no-server，且**没有**任何请求", async () => {
    await expect(mdmManager.checkConnection()).resolves.toEqual({ ok: false, reason: "no-server" });
    expect(fetched).toEqual([]);
  });

  test("空的 serverUrl ⇒ no-server，且没有请求", async () => {
    mdmManager.setConfigForTest(config("   "));

    await expect(mdmManager.checkConnection()).resolves.toEqual({ ok: false, reason: "no-server" });
    expect(fetched).toEqual([]);
  });

  test("明文 http ⇒ insecure-url，且**在发请求之前**就拒绝", async () => {
    mdmManager.setConfigForTest(config("http://mdm.example.test"));

    // 注册令牌与设备标识都走这条连接，所以 http 不是「连不上」，是根本不该发。
    await expect(mdmManager.checkConnection()).resolves.toEqual({
      ok: false,
      reason: "insecure-url",
    });
    expect(fetched).toEqual([]);
  });
});

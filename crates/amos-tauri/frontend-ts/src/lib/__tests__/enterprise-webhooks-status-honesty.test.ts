/**
 * `enterprise/webhooks.ts::sendWebhook` 必须**读交付的裁决**（REQ-A1529 ∕ F-SH-772）。
 *
 * 修前逐字：拿到回答之后直接
 *   `// 更新统计`
 *   `this.updateWebhookStats(webhook.id!, true);`
 *   `return { success: true, statusCode: response.status, body, duration };`
 * —— `response.ok` 在整个文件里**一次都没出现**。于是任何 HTTP 状态码都算一次
 * **成功投递**：端点回 500／404 时，`successCount` 照涨，设置面板那行
 * 「成功: N (100%)」（英文 `Delivered: N (100%)`）照亮，`testWebhook` 的
 * 「测试成功！」也照弹。返回对象自己就自相矛盾：`success: true` 与 `statusCode: 500`。
 *
 * 判据是**同一目录、同一件事**的兄弟实现：`enterprise/api.ts` 会读 `response.ok`，
 * 非 2xx 直接 `return { success: false, statusCode, error: \`HTTP ${status}: ${statusText}\` }`
 * （`api.ts:299-313`，且**不重试**非 2xx —— 只有传输层抛才重试）。
 * 第二个判据在屏幕那一侧：`svelte/modules/APISettings.svelte::testConnection`（REQ-A819）
 * 修掉的正是**同一个折**，它当时的理由里还写着「隔壁 `testWebhook` 也一直在读
 * `result.success`」—— 而 `result.success` 本身就是要修的这个折。
 *
 * 为什么没有门禁看见它：`write-scan` 问写有没有被读裁决、`void-cmd-scan` 问桥接的
 * `void` 有没有被读，没有一道扫描问「一个 HTTP 回答的状态码有没有被读」；既有投递测试
 * 的桩**全是 200 ∕ 204**，「端点回 4xx ∕ 5xx」这一格为空。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { WebhookManager, type WebhookConfig } from "../enterprise/webhooks";
import { readStoreValue, writeStoreValue } from "../amosStore";

/**
 * 这个文件**故意不注册 happy-dom**（同 `enterprise-webhooks.test.ts` 的注记）：
 * `scripts/bun-iso-test.mjs` 把导入 happy-dom 的文件判为 DOM 文件、不计入 P2-1 覆盖率。
 * `amosStore` 只用到 `window.localStorage` 一个 DOM 面，给它一个内存实现就够。
 *
 * pure 批次是**一个进程跑所有文件**，所以桩只能在**本文件**的生命周期内存在：
 * 顶层装会让同批次后面的文件多出一个可用的 `window`，改变它们走的分支。
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

const STORE_KEY = "amos.shortcuts.webhooks";

/** 与既有 `enterprise-webhooks.test.ts` 的 `config()` 同形；`retryCount: 1` 让每次调用只发一次请求。 */
function config(overrides: Partial<WebhookConfig> = {}): Parameters<WebhookManager["addWebhook"]>[0] {
  return {
    name: "ops",
    description: "",
    url: "https://hooks.example.test/x",
    events: ["shortcut_run"],
    secret: "",
    headers: {},
    enabled: true,
    method: "POST",
    timeout: 5000,
    retryCount: 1,
    ...overrides,
  };
}

/** 落盘的那份数据，按**模块自己的读法**取（`writeJson` 是两层 `JSON.stringify`）。 */
function stored(): WebhookConfig[] {
  const raw = readStoreValue(STORE_KEY, "");
  return raw ? (JSON.parse(raw) as WebhookConfig[]) : [];
}

let manager: WebhookManager;

beforeEach(() => {
  stub.localStorage.clear();
  writeStoreValue(STORE_KEY, JSON.stringify([]));
  // 用**独立实例**（不是单例）：单例的事件队列跨用例共享，任何「入队后等它被投递」
  // 的断言都会被上一用例压进队列的事件搅乱（见 `webhooks.ts` 导出这个类的注记）。
  manager = new WebhookManager();
});

afterEach(() => {
  manager.shutdown();
  stub.localStorage.clear();
});

describe("REQ-A1529 — 非 2xx 是一个回答，不是一次投递成功", () => {
  test("端点回 500 ⇒ success=false、状态码带回来、successCount 不涨", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500, statusText: "Internal Server Error" })) as unknown as typeof fetch;

    const id = manager.addWebhook(config());
    const res = await manager.testWebhook(id);

    // 修前：`{ success: true, statusCode: 500 }` —— 同一个对象里两个和。
    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(500);
    expect(res.error).toContain("500");

    const w = manager.getWebhook(id)!;
    expect(w.triggerCount).toBe(1);
    expect(w.successCount).toBe(0);
    expect(w.failureCount).toBe(1);
  });

  test("端点回 404 ⇒ 同样是失败，不是一个「已投递」", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;

    const id = manager.addWebhook(config());
    const res = await manager.testWebhook(id);

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(404);
    expect(manager.getWebhook(id)!.successCount).toBe(0);
    expect(manager.getWebhook(id)!.failureCount).toBe(1);
  });

  test("失败状态码也**落盘**：重开面板读的是存储里那份统计", async () => {
    globalThis.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;

    const id = manager.addWebhook(config());
    await manager.testWebhook(id);

    const persisted = stored().find((w) => w.id === id)!;
    expect(persisted.successCount).toBe(0);
    expect(persisted.failureCount).toBe(1);
    // 「成功: N (N%)」那行的分子分母 —— 修前这里是 1 ∕ 1 ⇒ 100%。
    expect(persisted.successCount! / persisted.triggerCount!).toBe(0);
  });

  test("正控 · 端点回 201 ⇒ 仍然是一次成功投递（免得把「一律失败」当成修好）", async () => {
    globalThis.fetch = (async () =>
      new Response("made", { status: 201, statusText: "Created" })) as unknown as typeof fetch;

    const id = manager.addWebhook(config());
    const res = await manager.testWebhook(id);

    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(201);
    expect(res.body).toBe("made");
    expect(manager.getWebhook(id)!.successCount).toBe(1);
    expect(manager.getWebhook(id)!.failureCount).toBe(0);
  });

  test("正控 · 端点回 204 ⇒ 也是成功（2xx 的边界另一侧）", async () => {
    globalThis.fetch = (async () => new Response("", { status: 204 })) as unknown as typeof fetch;

    const id = manager.addWebhook(config());
    const res = await manager.testWebhook(id);

    expect(res.success).toBe(true);
    expect(manager.getWebhook(id)!.successCount).toBe(1);
  });
});

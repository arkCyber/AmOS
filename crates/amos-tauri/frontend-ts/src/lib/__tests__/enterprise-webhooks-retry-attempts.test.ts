/**
 * `retryCount` 是**重试次数**，不是**尝试次数** —— 0 次重试仍然要发那第一封（REQ-A1533 ∕ F-SH-775）。
 *
 * 修前逐字：`enterprise/webhooks.ts::sendWebhook` 的循环头是
 *   `let attempts = 0;`
 *   `while (attempts < webhook.retryCount) {`
 * 于是 `retryCount: 0` 一次都不发。而这个 0 是**界面明说合法**的：设置面板那个输入框逐字
 * `<input id="webhookRetry" type="number" min="0" max="5" bind:value={webhookForm.retryCount} />`，
 * 它的标签 `api.retryCount` 中文化作「重试次数」、英文化作 **`Retries`** —— 名字说的是
 * 「重试几次」，不是「总共试几次」。而 `api.ts` 里**同一个字段名**是
 * `while (attempt <= this.config.retryCount)`（`api.ts:297`）：0 次重试 = 发一次。
 *
 * 后果有两层，第二层更坏：
 * ①一次都不发的 webhook，其「测试」按钮读到的是 `{ success: false, error: "" }`
 *   （`lastError` 从未被赋值），面板把空串折成 `api.unknownError`，于是弹
 *   「测试失败: 未知错误」—— **一个从未发生过的失败，被报成一个说不出原因的失败**；
 * ②`retryCount: 3` 在这份实现里意味着**最多 3 次尝试**（2 次重试），比界面承诺的少一次。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { WebhookManager, type WebhookConfig } from "../enterprise/webhooks";
import { writeStoreValue } from "../amosStore";

/**
 * 这个文件**故意不注册 happy-dom**（同 `enterprise-webhooks.test.ts` 的注记）：
 * `scripts/bun-iso-test.mjs` 把导入 happy-dom 的文件判为 DOM 文件、不计入 P2-1 覆盖率。
 * 桩只在**本文件**生命周期内存在 —— pure 批次是一个进程跑所有文件。
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

/** 一个记数的 fetch 桩：`always` 决定每次回答是抛还是回 200。 */
function countingFetch(always: "ok" | "throw"): { calls: () => number } {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    if (always === "throw") throw new Error("connection refused");
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls: () => n };
}

let manager: WebhookManager;

beforeEach(() => {
  stub.localStorage.clear();
  writeStoreValue(STORE_KEY, JSON.stringify([]));
  manager = new WebhookManager();
});

afterEach(() => {
  manager.shutdown();
  stub.localStorage.clear();
});

describe("REQ-A1533 — `retryCount` 是重试次数，0 也要发第一封", () => {
  test("`retryCount: 0` 也要真的发一次（修前一次都没发）", async () => {
    const fetchStub = countingFetch("ok");
    const id = manager.addWebhook(config({ retryCount: 0 }));

    const res = await manager.testWebhook(id);

    expect(fetchStub.calls()).toBe(1);
    expect(res.success).toBe(true);
    expect(manager.getWebhook(id)!.successCount).toBe(1);
  });

  test("`retryCount: 0` 且端点不通时，失败要**带原因**，不是空串（面板因此印「未知错误」）", async () => {
    const fetchStub = countingFetch("throw");
    const id = manager.addWebhook(config({ retryCount: 0 }));

    const res = await manager.testWebhook(id);

    expect(fetchStub.calls()).toBe(1);
    expect(res.success).toBe(false);
    // 修前：循环体一次没进 ⇒ `lastError` 还是 `""`，界面把它折成「未知错误」。
    expect(res.error).not.toBe("");
    expect(res.error).toBe("connection refused");
    expect(manager.getWebhook(id)!.failureCount).toBe(1);
  });

  test("`retryCount: 1` ⇒ 全失败时共 2 次尝试（1 次首发 + 1 次重试）", async () => {
    const fetchStub = countingFetch("throw");
    const id = manager.addWebhook(config({ retryCount: 1 }));

    await manager.testWebhook(id); // 内含一次 2s 退避

    expect(fetchStub.calls()).toBe(2);
  }, 10_000);

  test("`retryCount: 2` ⇒ 第 3 次才成功时仍然成功，共 3 次尝试（与 `api.ts` 同义）", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      if (n < 3) throw new Error("flaky");
      return new Response("third", { status: 200 });
    }) as unknown as typeof fetch;
    const id = manager.addWebhook(config({ retryCount: 2 }));

    const res = await manager.testWebhook(id); // 内含两次 2s 退避

    expect(n).toBe(3);
    expect(res.success).toBe(true);
    expect(manager.getWebhook(id)!.successCount).toBe(1);
  }, 15_000);

  test("正控 · 一次就成功时仍然只发一次（免得把「重试」修成「多打几封」）", async () => {
    const fetchStub = countingFetch("ok");
    const id = manager.addWebhook(config({ retryCount: 3 }));

    await manager.testWebhook(id);

    expect(fetchStub.calls()).toBe(1);
    expect(manager.getWebhook(id)!.successCount).toBe(1);
    expect(manager.getWebhook(id)!.failureCount).toBe(0);
  });

  test("正控 · 统计仍然是「每个事件计一次」：重试不发大 `triggerCount`", async () => {
    const fetchStub = countingFetch("throw");
    const id = manager.addWebhook(config({ retryCount: 2 }));

    await manager.testWebhook(id);

    expect(fetchStub.calls()).toBe(3);
    expect(manager.getWebhook(id)!.triggerCount).toBe(1);
    expect(manager.getWebhook(id)!.failureCount).toBe(1);
  }, 15_000);
});

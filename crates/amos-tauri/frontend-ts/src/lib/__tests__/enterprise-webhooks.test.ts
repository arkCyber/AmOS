/**
 * __tests__/enterprise-webhooks.test.ts — `enterprise/webhooks.ts` 的行为测试（P2-1 覆盖）
 *
 * 为什么值得单独一个文件：这个模块在 2026-09-08 的覆盖率门禁里是绿的，之后 `make cov`
 * 掉到 75.4%（阈值 90%）——`webhooks.ts` 一个文件就占了 288 行未覆盖，而它的每个方法都是
 * **能在无头环境里验的真契约**：配置落到 `amos.shortcuts.webhooks`、重试次数、超时中止、
 * HMAC-SHA256 签名覆盖的**正是发出去的那个 body**、统计计数。没有一条断言依赖真机。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test";
import { webhookManager, type WebhookConfig } from "../enterprise/webhooks";
import { readStoreValue, writeStoreValue } from "../amosStore";

/**
 * 这个文件**故意不注册 happy-dom**：`scripts/bun-iso-test.mjs` 把导入 happy-dom 的文件
 * 判为 DOM 文件、只为"正确性"跑，**不计入 P2-1 覆盖率**（`coverage:gate` 只跑 pure 批次）。
 * 第一版注册了 happy-dom，于是 16 个用例跑绿、覆盖率数字一动没动。
 *
 * `amosStore` 只用到一个 DOM 面：`window.localStorage`。给它一个内存实现就够，于是这个文件
 * 留在 pure 批次里、它的覆盖算进 P2-1，也不需要整套 happy-dom。
 *
 * **但 pure 批次是"一个进程跑所有文件"**，所以这个桩只能在**本文件**的生命周期内存在：
 * 装在模块顶层会让同一批次里后面的文件（例如 `enterprise-audit.test.ts`）多出一个可用的
 * `window` —— 实测那样会让一个与审计日志无关的用例失败（存储从"写不进去"变成"写得进去"，
 * 代码走了另一条分支）。因此 `beforeAll` 装、`afterAll` 还原。
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

/**
 * 落盘的那份数据，按**模块自己的读法**取：`amosStore.writeJson` 把
 * `JSON.stringify(JSON.stringify(data))` 两层都写进去，所以这里与
 * `webhooks.ts::initialize` 用同一个 `readStoreValue` + 一次 `JSON.parse`。
 */
function stored(): WebhookConfig[] {
  const raw = readStoreValue<string>(STORE_KEY, "");
  return raw ? (JSON.parse(raw) as WebhookConfig[]) : [];
}

/** `addWebhook` 要的完整配置（Omit 掉的统计字段由管理器补）。 */
function config(overrides: Partial<WebhookConfig> = {}) {
  return {
    name: "audit-sink",
    description: "",
    url: "https://example.test/hook",
    events: ["audit.log"],
    secret: "",
    headers: {},
    enabled: true,
    method: "POST" as const,
    timeout: 200,
    retryCount: 1,
    ...overrides,
  };
}

const realFetch = globalThis.fetch;

beforeEach(async () => {
  webhookManager.shutdown(); // 先停上一用例可能留下的处理器
  for (const w of webhookManager.getWebhooks()) webhookManager.deleteWebhook(w.id!);
  memory.clear();
  await webhookManager.initialize(); // 起事件处理器 + 读存储
});

afterEach(() => {
  webhookManager.shutdown(); // 不留 interval：前端有 lifetime 门禁，测试也不该泄漏
  globalThis.fetch = realFetch;
  mock.restore();
  memory.clear();
});



describe("webhookManager 生命周期与存储", () => {
  test("addWebhook 补齐 id/时间戳/统计字段并落盘，id 有前缀", () => {
    const id = webhookManager.addWebhook(config({ name: "persisted" }));
    expect(id.startsWith("webhook-")).toBe(true);

    const dump = stored();
    expect(dump).toHaveLength(1);
    expect(dump[0]!.id).toBe(id);
    expect(dump[0]!.name).toBe("persisted");

    const w = webhookManager.getWebhook(id)!;
    expect(w.triggerCount).toBe(0);
    expect(w.successCount).toBe(0);
    expect(w.failureCount).toBe(0);
    expect(w.createdAt).toBeGreaterThan(0);
    expect(w.updatedAt).toBe(w.createdAt);
  });

  test("initialize 读回存储里的配置（重启语义）；shutdown 幂等", async () => {
    const id = webhookManager.addWebhook(config());
    const dump = stored();
    webhookManager.deleteWebhook(id);

    // 用模块自己的写入路径塞数据（`writeJson` 会把 JSON 串再序列化一层，直接写
    // `window.localStorage` 会得到另一种编码 —— 第一版就是这么读不到的）。
    writeStoreValue(STORE_KEY, JSON.stringify([{ ...dump[0]!, name: "from-store" }]));
    await webhookManager.initialize();
    expect(webhookManager.getWebhook(id)?.name).toBe("from-store");

    webhookManager.shutdown();
    webhookManager.shutdown(); // 第二次是 no-op
  });

  test("存储里是坏 JSON 时 initialize 不抛，只记错误（面板不该因此崩）", async () => {
    // 绕过写入路径，直接往存储里放一段坏数据（`readJson` 会隔离并回落到默认值）。
    memory.set(STORE_KEY, JSON.stringify("{not json"));
    await webhookManager.initialize();
    expect(webhookManager.getWebhooks()).toHaveLength(0);
  });

  test("getWebhook 对未知 id 回 null；getWebhooks 按 enabled 过滤", () => {
    const on = webhookManager.addWebhook(config({ enabled: true }));
    const off = webhookManager.addWebhook(config({ enabled: false, name: "off" }));
    expect(webhookManager.getWebhook("nope")).toBeNull();
    expect(webhookManager.getWebhooks()).toHaveLength(2);
    expect(webhookManager.getWebhooks({ enabled: true }).map((w) => w.id)).toEqual([on]);
    expect(webhookManager.getWebhooks({ enabled: false }).map((w) => w.id)).toEqual([off]);
  });

  test("updateWebhook 改字段、刷新 updatedAt、**不允许改 id**；未知 id 回 false", () => {
    const id = webhookManager.addWebhook(config());
    const before = webhookManager.getWebhook(id)!;
    const ok = webhookManager.updateWebhook(id, {
      name: "renamed",
      id: "hacked",
    } as Partial<WebhookConfig>);
    expect(ok).toBe(true);
    const after = webhookManager.getWebhook(id)!;
    expect(after.name).toBe("renamed");
    expect(after.id).toBe(id); // id 不可改：否则统计与存储键会脱钩
    expect(after.updatedAt ?? 0).toBeGreaterThanOrEqual(before.updatedAt ?? 0);
    expect(webhookManager.updateWebhook("missing", { name: "x" })).toBe(false);
  });

  test("deleteWebhook 删掉并落盘；重复删除回 false", () => {
    const id = webhookManager.addWebhook(config());
    expect(webhookManager.deleteWebhook(id)).toBe(true);
    expect(webhookManager.getWebhook(id)).toBeNull();
    expect(stored()).toHaveLength(0);
    expect(webhookManager.deleteWebhook(id)).toBe(false);
  });
});


describe("webhookManager 事件队列", () => {
  test("trigger 只入队、不立刻发送，且没有订阅者时不崩", async () => {
    await webhookManager.trigger("audit.log", { a: 1 });
    expect(webhookManager.getWebhooks()).toHaveLength(0); // 发送交给事件处理器
  });

  test("队列超过上限时丢掉最旧的（不无限增长）", async () => {
    let called: number = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    // 事件名**故意不与任何 webhook 的 events 匹配**：队列是单例的、每个用例都会往同一个
    // 处理器里放事件，若这里塞 "audit.log"，后面注册了 audit.log 订阅的用例就会被这个
    // 间隔处理器多发几次 fetch（第一版的重试用例正是因此多算了一次尝试）。
    for (let i = 0; i < 1005; i++) await webhookManager.trigger("queue-overflow-test", { i });
    expect(called).toBe(0); // 队列私有：能验的是“这条路径被走过”
  });
});

describe("webhookManager 发送（fetch 打桩）", () => {
  test("testWebhook 成功：头正确 + 计数落盘", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const id = webhookManager.addWebhook(config());
    const res = await webhookManager.testWebhook(id);
    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("ok");

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe("https://example.test/hook");
    expect(headers["X-Webhook-Event"]).toBe("webhook_test");
    expect(headers["Content-Type"]).toBe("application/json");

    const w = webhookManager.getWebhook(id)!;
    expect(w.triggerCount).toBe(1);
    expect(w.successCount).toBe(1);
    expect(w.failureCount).toBe(0);
    expect(w.lastTriggeredAt).toBeGreaterThan(0);
    expect(stored()[0]!.successCount).toBe(1);
  });

  test("自定义头可以覆盖默认头（`...webhook.headers` 在最后）", async () => {
    let sent: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = init.headers as Record<string, string>;
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;
    const id = webhookManager.addWebhook(
      config({ headers: { "Content-Type": "text/plain", "X-Trace": "abc" } }),
    );
    await webhookManager.testWebhook(id);
    expect(sent["Content-Type"]).toBe("text/plain");
    expect(sent["X-Trace"]).toBe("abc");
  });

  test("testWebhook 对未知 id 直接回错误，不发请求", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await webhookManager.testWebhook("missing");
    expect(res.success).toBe(false);
    expect(res.error).toBe("Webhook 不存在");
    expect(res.duration).toBe(0);
    expect(called).toBe(0);
  });

  test("失败：只涨 failureCount，错误文本带出来", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const id = webhookManager.addWebhook(config({ retryCount: 1 }));
    const res = await webhookManager.testWebhook(id);
    expect(res.success).toBe(false);
    expect(res.error).toBe("connection refused");
    const w = webhookManager.getWebhook(id)!;
    expect(w.failureCount).toBe(1);
    expect(w.successCount).toBe(0);
    expect(w.triggerCount).toBe(1);
  });

  test("重试：第一次抛、第二次成功 ⇒ 发两次，只记一次成功", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts === 1) throw new Error("flaky");
      return new Response("second", { status: 200 });
    }) as unknown as typeof fetch;
    const id = webhookManager.addWebhook(config({ retryCount: 2 }));
    const res = await webhookManager.testWebhook(id); // 内含一次 2s 退避
    expect(attempts).toBe(2);
    expect(res.success).toBe(true);
    expect(res.body).toBe("second");
    const w = webhookManager.getWebhook(id)!;
    expect(w.successCount).toBe(1);

describe("webhookManager 签名", () => {
  test("X-Webhook-Signature 是**发出去那个 body** 的 HMAC-SHA256", async () => {
    let sent: { headers: Record<string, string>; body: string } = { headers: {}, body: "" };
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = { headers: init.headers as Record<string, string>, body: String(init.body) };
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const id = webhookManager.addWebhook(config({ secret: "s3cret" }));
    await webhookManager.testWebhook(id);

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode("s3cret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = Array.from(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(sent.body))),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    // 签名必须与被签名的字节一致 —— 这条把“签名覆盖的是 body 而不是别的串”钉住。
    expect(sent.headers["X-Webhook-Signature"]).toBe(expected);
    expect(sent.headers["X-Webhook-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("没有 secret 时不带签名头", async () => {
    let sent: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = init.headers as Record<string, string>;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const id = webhookManager.addWebhook(config({ secret: "" }));
    await webhookManager.testWebhook(id);
    expect(sent["X-Webhook-Signature"]).toBeUndefined();
  });
});

    expect(w.failureCount).toBe(0);
  }, 10000);

  test("超时：到点中止请求，算一次失败（timeout 来自配置）", async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
      })) as unknown as typeof fetch;
    const id = webhookManager.addWebhook(config({ timeout: 20, retryCount: 1 }));
    const res = await webhookManager.testWebhook(id);
    expect(res.success).toBe(false);
    expect(res.error).toContain("aborted");
    expect(webhookManager.getWebhook(id)!.failureCount).toBe(1);
  });
});

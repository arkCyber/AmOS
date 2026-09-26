/**
 * enterprise-logger.test.ts — the enterprise family's log channel (REQ-A807 / FMEA F-SH-249).
 *
 * **The defect these pin.** `src/lib/enterprise/logger.ts` was a 25-line `console.*` wrapper with
 * **no reader anywhere in the app**: imported by four modules, consumed by none. That is not a
 * style question, because those four modules used it as their **only** channel for the sentences
 * that matter most, and every one of them was written for a human:
 *
 *   • `templates.ts` — 「模板写入被存储拒绝 —— N 个模板重启后会丢失」 ×3
 *   • `audit.ts`    — 「审计配置／日志／同步队列写入被存储拒绝 —— N 条重启后会丢失」 ×3
 *   • `webhooks.ts` — 「Webhook failed after N attempts」／「Event queue full…」 ×6
 *
 * A `console.warn` in a packaged Tauri WebView is not a disclosure — so *your audit log will be
 * gone after a restart* was written, sent, and read by nobody. The repo already carried the right
 * ledger (`lib/debugLog`, the ring `settings/AiPage.svelte` renders), and REQ-A806 had to hand-add
 * a **second** channel to `api.ts` for that same sentence, because `logger` structurally could not
 * reach the screen. REQ-A807 makes `logger` itself an adapter onto the ledger and reverts the
 * hand-added channel, so the family has one spelling again.
 *
 * **Negative control (this suite's job).** Put `console.*` back in `logger`, or drop any of the
 * four levels off the ledger, and the tests below go red — including the two that drive *real*
 * call sites (`templateManager`, `webhookManager`), not the adapter in isolation.
 *
 * 这个文件**故意不导入 happy-dom**（同文件族里 `enterprise-api.test.ts`／`enterprise-webhooks.test.ts`
 * 的理由）：导入即被判为 DOM 文件、不进 P2-1 覆盖率；而且 happy-dom 的 `window.localStorage`
 * **挡不住**对 `setItem` 的替换（实测：赋值成功、写入却仍走原实现），断言之下的「存储拒绝」
 * 会静默变成「写入成功」。这里给 `window.localStorage` 一个内存实现，只在本文件生命周期内存在
 * （pure 批次是一个进程跑所有文件，顶层安装会泄漏给同批次的其他文件）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { logger } from "../enterprise/logger";
import { clearDiag, diagStats, recentDiag, setDiagMinLevel } from "../debugLog";
import { templateManager } from "../enterprise/templates";
import { webhookManager } from "../enterprise/webhooks";

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

/**
 * The webhook this file registers lives on the **process-wide** `webhookManager` singleton, and
 * bootstrapping that singleton starts a 1 s `setInterval` event processor. In the pure batch (one
 * process, every file) both outlive this file: a later file that spies on `fetch` sees this file's
 * webhook dispatching to `https://hooks.example.test/x` and goes red at random — observed on
 * `enterprise-mdm-policy.test.ts`, which found four extra calls beside its own two (order-dependent,
 * so the same batch passed on one run and failed on the next). Nothing here is production state, so
 * the fix is the file's own cleanup. The window stub is re-installed for the delete's `save()` so the
 * write lands in the in-memory store rather than the real one this file deliberately does not have.
 */
let addedWebhookId: string | null = null;
afterAll(() => {
  globals.window = stub;
  try {
    if (addedWebhookId) webhookManager.deleteWebhook(addedWebhookId);
    webhookManager.shutdown(); // stops the interval and clears `initialized` for the next file
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});

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

beforeEach(() => {
  memory.clear();
  clearDiag();
  setDiagMinLevel("info");
});

afterEach(() => {
  clearDiag();
  setDiagMinLevel("info");
});

describe("enterprise 的 logger 就是账本本身，不是第二个 console（REQ-A807）", () => {
  test("warn／error／info 三级各自落进账本，级别、区域、细节都对得上", () => {
    logger.info("templates", "info-msg", { n: 1 });
    logger.warn("webhooks", "warn-msg");
    logger.error("audit", "error-msg", "detail");

    const got = recentDiag(-1);
    // newest first
    expect(got.map((e) => [e.level, e.area, e.msg])).toEqual([
      ["error", "audit", "error-msg"],
      ["warn", "webhooks", "warn-msg"],
      ["info", "templates", "info-msg"],
    ]);
    // the detail travels too — a refusal is useless without the key/payload it names
    expect(got[0]!.detail).toBe("detail");
    expect(got[2]!.detail).toBe(JSON.stringify({ n: 1 }));
  });

  test("debug 级被阈值挡住时**计数**，不是悄悄消失——「没显示」不能等于「没发生」", () => {
    const before = diagStats().suppressed;

    logger.debug("webhooks", "queued-event");

    expect(recentDiag(-1)).toHaveLength(0);
    expect(diagStats().suppressed).toBe(before + 1);
  });

  test("阈值调低后 debug 级就记下来了——这是个能用的旋钮，不是原来那个没人赋值的 window.DEBUG_MODE", () => {
    setDiagMinLevel("debug");

    logger.debug("webhooks", "queued-event", { event: "x" });

    const got = recentDiag(-1);
    expect(got).toHaveLength(1);
    expect(got[0]!.level).toBe("debug");
    expect(got[0]!.msg).toBe("queued-event");
  });

  test("四个级别都通向账本——少一个就是又一个只写 console 的分支", () => {
    setDiagMinLevel("debug");
    logger.debug("a", "d");
    logger.info("b", "i");
    logger.warn("c", "w");
    logger.error("d", "e");

    expect(recentDiag(-1).map((e) => e.level)).toEqual(["error", "warn", "info", "debug"]);
  });
});

describe("真实的调用点也落进账本，不只是适配器本身（REQ-A807）", () => {
  test("templates：模板不存在这条 warn 进账本（一条真的 templates.ts 调用点）", () => {
    expect(templateManager.deleteTemplate("no-such-template")).toBe(false);

    const hit = recentDiag(-1).find((e) => e.area === "templates");
    expect(hit).toBeDefined();
    expect(hit!.level).toBe("warn");
    expect(hit!.msg).toContain("模板不存在");
  });

  test("存储拒绝写入时，那句「重启后会消失」进账本——这正是它过去唯一到不了的地方", () => {
    withRefusingStore(() => {
      addedWebhookId = webhookManager.addWebhook({
        name: "ops",
        description: "",
        url: "https://hooks.example.test/x",
        events: ["*"],
        secret: "",
        headers: {},
        enabled: true,
        method: "POST",
        timeout: 10000,
        retryCount: 1,
      });
    });

    const hit = recentDiag(-1).find((e) => e.area === "webhooks" && e.level === "error");
    expect(hit).toBeDefined();
    expect(hit!.msg).toContain("写入被存储拒绝");
    expect(hit!.msg).toContain("重启后这些 Webhook 会消失");
  });
});

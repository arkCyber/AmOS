/**
 * 「重试次数」设成 0 时，那枚「测试」按钮仍然要**真的发一封**，且失败要说得出原因（REQ-A1533 ∕ F-SH-775）。
 *
 * 面板自己声明 0 是合法值：`APISettings.svelte` 里逐字
 *   `<input id="webhookRetry" type="number" min="0" max="5" bind:value={webhookForm.retryCount} />`
 * 标签 `api.retryCount` 英文作 **`Retries`**、中文件「重试次数」。但
 * `webhooks.ts::sendWebhook` 的循环头是 `while (attempts < webhook.retryCount)`，
 * 于是 0 一次都不发：请求根本没离开应用，`lastError` 停在 `""`，
 * `APISettings::testWebhook` 把空串折成 `api.unknownError` —— 用户按了「测试」，
 * 看到「测试失败: 未知错误」，而真正发生的事是**什么都没发生**。
 *
 * 这一面测两件事：请求真的发出去了（用记数桩），以及弹出来的那句是「失败 + 原因」
 * 而不是「失败 + 未知错误」。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import APISettings from "../src/svelte/modules/APISettings.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { webhookManager } from "../src/lib/enterprise";

/** 一枚 `retryCount: 0` 的 enabled webhook —— 即面板上「重试次数 = 0」保存下来的那一枚。 */
function seedZeroRetryWebhook(): string {
  return webhookManager.addWebhook({
    name: "ops",
    description: "",
    url: "https://hooks.example.test/x",
    events: ["shortcut_run"],
    secret: "",
    headers: {},
    enabled: true,
    method: "POST",
    timeout: 5000,
    retryCount: 0,
  });
}

function testButton(container: HTMLElement): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Test",
  );
  if (!btn) throw new Error("webhook 列表里没有「测试」按钮");
  return btn as HTMLButtonElement;
}

let alerts: string[];

beforeEach(() => {
  localStorage.clear();
  setLocale("en");
  for (const w of webhookManager.getWebhooks()) webhookManager.deleteWebhook(w.id!);
  alerts = [];
  vi.spyOn(window, "alert").mockImplementation((msg?: string) => {
    alerts.push(String(msg));
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  setLocale("en");
  vi.restoreAllMocks();
});

describe("REQ-A1533 — 重试次数 0 时，「测试」仍然发得出一次请求", () => {
  test("Retries = 0 · 端点正常 ⇒ 请求真的发出去了，弹的是「Test succeeded」", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    seedZeroRetryWebhook();

    const { container } = render(APISettings);
    await fireEvent.click(testButton(container as unknown as HTMLElement));

    expect(calls).toBe(1); // 修前：0 —— 一次请求都没离开应用
    expect(alerts.join("\n")).toContain("Test succeeded");
    expect(alerts.join("\n")).not.toContain("Test failed");
  });

  test("Retries = 0 · 端点不通 ⇒ 弹的是**真实原因**，不是「未知错误」", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    seedZeroRetryWebhook();

    const { container } = render(APISettings);
    await fireEvent.click(testButton(container as unknown as HTMLElement));

    expect(calls).toBe(1);
    expect(alerts.join("\n")).toContain("Test failed");
    // 修前：`result.error` 是空串，`|| t("api.unknownError")` 兜成 "Unknown error"。
    expect(alerts.join("\n")).toContain("connection refused");
    expect(alerts.join("\n")).not.toContain("Unknown error");
  });

  test("面板自己把 0 当成合法值：那个输入框 min 是 0、标签说的是「Retries」", async () => {
    const { container, getByText } = render(APISettings);
    await fireEvent.click(getByText("+ Add webhook"));

    const retry = container.querySelector<HTMLInputElement>("#webhookRetry")!;
    expect(retry.min).toBe("0");
    // 名字说的是「重试几次」，不是「总共试几次」—— 于是 0 次重试 = 发一次。
    expect(container.querySelector('label[for="webhookRetry"]')?.textContent?.trim()).toBe("Retries");
  });
});

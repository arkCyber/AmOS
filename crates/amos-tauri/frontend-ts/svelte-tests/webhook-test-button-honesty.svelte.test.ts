/**
 * 「API 集成」webhook 列表上那枚「测试」按钮读到的是一个**没被读过的裁决**（REQ-A1529 ∕ F-SH-772）。
 *
 * 屏幕这一面的形状：`APISettings.svelte::testWebhook` 逐字写的是
 *   `const result = await webhookManager.testWebhook(webhookId);`
 *   `if (result.success) { alert(t("api.testOk", { ms: result.duration })); }`
 *   `else { alert(t("api.testFailed", { reason: result.error || t("api.unknownError") })); }`
 * —— 它**确实读了** `result.success`（这也是同一个文件里 `testConnection` 的注记
 * 把它举为正面例子的理由：「隔壁 `testWebhook` 也一直在读 `result.success`」）。
 * 但 `result.success` 本身是折出来的：`webhooks.ts::sendWebhook` 从不看 `response.ok`，
 * 任何状态码都走成功分支，于是**一个用 500 拒掉每一次投递的端点，这枚按钮会弹
 * 「测试成功！响应时间: Nms」**。
 *
 * 所以这一面测的不是这个组件，而是它信的那个裁决：`Delivered:` 那行的分子
 * （`successCount`）与这枚按钮的弹窗必须和「端点真的收下了」是同一件事。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import APISettings from "../src/svelte/modules/APISettings.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { webhookManager } from "../src/lib/enterprise";

/** 一枚 enabled、订阅了 `shortcut_run` 的 webhook —— 「测试」按钮只要求 enabled。 */
function seedWebhook(): string {
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
    retryCount: 1,
  });
}

/** 列表里那枚「测试」按钮（`api.test` 是列表里唯一叫这个名字的控件）。 */
function testButton(container: HTMLElement): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Test",
  );
  if (!btn) throw new Error("webhook 列表里没有「测试」按钮");
  return btn as HTMLButtonElement;
}

/** 那一行「成功: N (N%)」的原文。 */
function deliveredLine(container: HTMLElement): string {
  const el = [...container.querySelectorAll(".webhook-stats")].find((n) =>
    n.textContent?.includes("Delivered:"),
  );
  return el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
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

describe("REQ-A1529 — 端点拒掉投递时，「测试」不能报成功", () => {
  test("端点回 500 ⇒ 弹的是失败并带上状态码，不是「Test succeeded」", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500, statusText: "Internal Server Error" })) as unknown as typeof fetch;
    seedWebhook();

    const { container } = render(APISettings);
    await fireEvent.click(testButton(container as unknown as HTMLElement));

    expect(alerts.join("\n")).toContain("Test failed");
    expect(alerts.join("\n")).toContain("500");
    expect(alerts.join("\n")).not.toContain("Test succeeded");
  });

  test("端点回 404 ⇒ 重开面板时那行统计是「Delivered: 0」，不是「1 (100%)」", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const id = seedWebhook();

    // 「测试」按钮只弹窗、不重画列表，所以「重开面板读到什么」必须是**另一次挂载** ——
    // 否则断言会在元件还没更新的旧 DOM 上通过（通过得对，理由错）。
    const first = render(APISettings);
    await fireEvent.click(testButton(first.container as unknown as HTMLElement));
    cleanup();

    const w = webhookManager.getWebhook(id)!;
    expect(w.successCount).toBe(0);
    expect(w.failureCount).toBe(1);

    const { container } = render(APISettings);
    const line = deliveredLine(container as unknown as HTMLElement);
    expect(line).toContain("Delivered: 0"); // 正控：这一行真的在屏幕上
    expect(line).not.toContain("(100%)"); // 修前：404 也被记成一次成功投递 ⇒ 1 (100%)
  });

  test("对照组：端点回 200 ⇒ 弹「Test succeeded」（否则上面「不出现」没有意义）", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    seedWebhook();

    const { container } = render(APISettings);
    await fireEvent.click(testButton(container as unknown as HTMLElement));

    expect(alerts.join("\n")).toContain("Test succeeded");
    expect(alerts.join("\n")).not.toContain("Test failed");
  });
});

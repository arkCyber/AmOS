/**
 * connect-buttons-honesty.svelte.test.ts — 两个「测试连接」按钮能不能报出「连不上」（REQ-A819）
 *
 * 为什么这个文件存在：两个面板的「测试连接」按钮都**报不出失败**，各用各的办法 ——
 *
 *   * `MDMPanel.svelte::testConnection` **不联系任何东西**：`setTimeout` 1 秒，然后只看
 *     `serverUrl.startsWith("https://")`，就报「连接成功」。拼错的域名、已下线的服务器、
 *     把我们挡在门外的服务器，得到的都是同一个绿色提示。
 *   * `APISettings.svelte::testConnection` **发了真请求但把回答丢掉了**：
 *     `apiClient.request` 对 4xx/5xx 不抛，而是返回 `{ success: false, statusCode }`
 *     （`api.ts:299-313`），面板 `await` 之后无条件说「连接成功」。一个 401／404／500／503
 *     的服务器全被报成连上了；只有传输层真的抛才走失败分支。同一个文件里 `saveConfig`
 *     已因**同一个形状**被修过（REQ-A806），隔壁 `testWebhook` 也一直在读 `result.success`。
 *
 * 两条都由一个**行为**钉住（不是断言调用了哪个函数）：点那个按钮，看屏幕上出现的是
 * 「连接成功」还是「连不上」。这正是原先两个实现都躲过去的那一关 —— 它们各自绿着，
 * 因为**没有任何测试点过这个按钮**。
 *
 * 用的是真 `render` + 真 `fireEvent`（`@testing-library/svelte`），`fetch` 打桩：
 * 判据是「界面上那句话」，不是内部状态。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MDMPanel from "../src/svelte/modules/MDMPanel.svelte";
import APISettings from "../src/svelte/modules/APISettings.svelte";
import { mdmManager, type MDMConfig } from "../src/lib/enterprise/mdm";
import { apiClient } from "../src/lib/enterprise/api";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const settle = () => new Promise((r) => setTimeout(r, 40));

/**
 * 等到界面**已经给出结论**（按钮不再显示「进行中」那句话）。
 *
 * 判据不能是「睡了多久」：一次失败的真实路径还要落 `saveConfig`（存储 + 加密）与写一条
 * 审计日志，在满载的套件里会明显超过一个固定延时 —— 一个 40 ms 的 `settle()` 在单独跑时
 * 绿、在整套跑时红（本轮实测到过，`同步中...` 就是那一刻的屏幕）。
 */
async function untilOutcome(container: HTMLElement, busy: readonly string[]): Promise<void> {
  await vi.waitFor(
    () => {
      const text = container.textContent ?? "";
      for (const b of busy) expect(text, `still busy: ${b}`).not.toContain(b);
    },
    { timeout: 3000 },
  );
}

/** 让这次 `fetch` 返回一个固定响应（`/health` 在真服务上回的是纯文本 `OK`）。 */
function stubHealth(status: number, body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(body, { status, headers: { "content-type": "text/plain" } }),
    ),
  );
}

/** 让这次 `fetch` 直接失败 —— DNS／TLS／超时在页面里就是这个形状。 */
function stubFetchThrows(message: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error(message);
    }),
  );
}

function mdmConfig(serverUrl: string): MDMConfig {
  return {
    enabled: true,
    organizationId: "org-1",
    organizationName: "Acme",
    deviceId: "device-test",
    deviceName: "Test Mac",
    serverUrl,
    apiKey: "key-1",
    policies: [],
    restrictions: {
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
    },
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
  setLocale("zh");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mdmManager.clearConfigForTest();
  mdmManager.stopAutoSync();
  mdmManager.shutdown();
  setLocale("zh");
  window.localStorage.clear();
});

describe("MDM 面板的「测试连接」：服务器不在时必须说出来", () => {
  test("服务器回答 200 OK ⇒ 显示「连接成功」", async () => {
    stubHealth(200, "OK");
    mdmManager.setConfigForTest(mdmConfig("https://mdm.example.test"));
    const { container } = render(MDMPanel);

    await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="mdm-test-connection"]')!);
    await tick();
    await untilOutcome(container, [zh["mdm.testing"]]);

    const text = container.textContent ?? "";
    expect(text).toContain(zh["mdm.connectOk"]);
    // 而且它**真的问了**：这一秒里没有任何请求的实现在这里就红。
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe("https://mdm.example.test/health");
  });

  test("连不上（fetch 抛）⇒ 说「连不上服务器」，**不是**「连接成功」", async () => {
    stubFetchThrows("getaddrinfo ENOTFOUND mdm.example.test");
    mdmManager.setConfigForTest(mdmConfig("https://mdm.example.test"));
    const { container } = render(MDMPanel);

    await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="mdm-test-connection"]')!);
    await tick();
    await untilOutcome(container, [zh["mdm.testing"]]);

    const text = container.textContent ?? "";
    expect(text).toContain(zh["mdm.connectUnreachable"]);
    // 这两条是同一件事的两半：**不许**同时出现那句成功。
    expect(text).not.toContain(zh["mdm.connectOk"]);
    // 异常的原文是机器话，不该出现在给用户看的句子里（同 REQ-A811 的规则）。
    expect(text).not.toContain("getaddrinfo");
  });

  test("服务器回了 503 ⇒ 把状态码说出来，而不是笼统的「连接失败」", async () => {
    stubHealth(503, "upstream down");
    mdmManager.setConfigForTest(mdmConfig("https://mdm.example.test"));
    const { container } = render(MDMPanel);

    await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="mdm-test-connection"]')!);
    await tick();
    await untilOutcome(container, [zh["mdm.testing"]]);

    const text = container.textContent ?? "";
    expect(text).toContain(zh["mdm.connectHttpStatus"].replace("{status}", "503"));
    expect(text).not.toContain(zh["mdm.connectOk"]);
  });

  test("URL 是明文 http ⇒ 说出来，且**一个请求都不发**", async () => {
    stubHealth(200, "OK");
    mdmManager.setConfigForTest(mdmConfig("http://mdm.example.test"));
    const { container } = render(MDMPanel);

    await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="mdm-test-connection"]')!);
    await tick();
    await settle();

    expect(container.textContent ?? "").toContain(zh["mdm.invalidServerUrl"]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("MDM 面板的「同步配置」：服务器拒绝时不许说同步成功", () => {
  test("服务器回 success:false ⇒ 说同步失败并带上理由，而不是「配置同步成功」", async () => {
    // `mdmManager.syncWithServer()` **从不抛**：它把 `{success:false, message}` 返回给
    // 调用方。原先这里 `await` 之后无条件说「配置同步成功」，于是「服务器把我们拒了」
    // 与「同步成功」在屏幕上逐字相同（与 REQ-A806 的 `saveConfig` 同一形状）。
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: false, message: "device not enrolled" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    mdmManager.setConfigForTest(mdmConfig("https://mdm.example.test"));
    const { container } = render(MDMPanel);

    await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="mdm-sync-config"]')!);
    await tick();
    await untilOutcome(container, [zh["mdm.syncing"]]);

    const text = container.textContent ?? "";
    expect(text).toContain(zh["mdm.syncFailedReason"].replace("{reason}", "device not enrolled"));
    expect(text).not.toContain(zh["mdm.syncOk"]);
  });

  test("服务器回 success:true ⇒ 说「配置同步成功」", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    mdmManager.setConfigForTest(mdmConfig("https://mdm.example.test"));
    const { container } = render(MDMPanel);

    await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="mdm-sync-config"]')!);
    await tick();
    await untilOutcome(container, [zh["mdm.syncing"]]);

    expect(container.textContent ?? "").toContain(zh["mdm.syncOk"]);
  });
});

describe("「API 集成」的「测试连接」：非 2xx 是一个回答，不是「连上了」", () => {
  test("服务器回 401 ⇒ 说「服务器返回 HTTP 401」，**不是**「连接成功」", async () => {
    apiClient.configure({ enabled: true, baseUrl: "https://api.example.test" });
    // `apiClient.request` 对 401 返回 `{success:false}` 而**不抛** —— 原先那条无条件的
    // 「连接成功」正是在这里撒的谎。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const { container } = render(APISettings);

    await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="api-test-connection"]')!);
    await tick();
    await untilOutcome(container, [zh["api.testing"]]);

    const text = container.textContent ?? "";
    expect(text).toContain(zh["api.connectHttpStatus"].replace("{status}", "401"));
    expect(text).not.toContain(zh["api.connectOk"]);
  });

  test("服务器回 200 ⇒ 显示「连接成功」", async () => {
    apiClient.configure({ enabled: true, baseUrl: "https://api.example.test" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("OK", { status: 200, headers: { "content-type": "text/plain" } })),
    );
    const { container } = render(APISettings);

    await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="api-test-connection"]')!);
    await tick();
    await untilOutcome(container, [zh["api.testing"]]);

    expect(container.textContent ?? "").toContain(zh["api.connectOk"]);
  });

  test("传输层失败 ⇒ 说「连不上服务器」，而不是把异常原文还给用户", async () => {
    // `retryCount: 0`：这条用例问的是「失败之后屏幕上说什么」，而客户端的重试循环
    // （每次 retryDelay 毫秒）只会让这次断言等在一句「测试中…」上。
    apiClient.configure({ enabled: true, baseUrl: "https://api.example.test", retryCount: 0 });
    stubFetchThrows("TimeoutError: The operation was aborted");
    const { container } = render(APISettings);

    await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="api-test-connection"]')!);
    await tick();
    await untilOutcome(container, [zh["api.testing"]]);

    const text = container.textContent ?? "";
    expect(text).toContain(zh["api.connectUnreachable"]);
    expect(text).not.toContain("TimeoutError");
  });
});

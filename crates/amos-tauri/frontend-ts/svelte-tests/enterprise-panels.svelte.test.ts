/**
 * enterprise-panels.svelte.test.ts — 四个企业面板的**渲染 + i18n 接线**门（REQ-A385）。
 *
 * 为什么是这四条：它们此前**没有任何测试**——2026-09-17 之前那批 `enterprise-ui-*.test.ts`
 * 断言的是测试里自己写的 lambda。**这句话原先写的是「已删除」，而那是假的**：四个文件都在
 * `src/__tests__/` 里、跟着 `bun run test` 一直跑着（`git log --diff-filter=D` 里那些
 * 「删除」记录是 stash 条目，不是提交）。直到 **REQ-A821**（2026-09-21）才真的删掉：83 条里
 * 69 条是自证式的（25 条在测试体里定义函数再断言它、44 条**不碰任何生产符号**），其中 21 条
 * 测的函数在产品里根本不存在；三个只剩空壳的文件整个删除，`enterprise-ui-mdm.test.ts` 里
 * 真的调用 `mdmManager` 的 10 条保留并改名为 `enterprise-mdm-manager.test.ts`。此处如实记下
 * ——**一行注释声称做过的事，与真的做过，是两回事**。
 *
 * 本次还把它们 156 条硬编码文案全部迁移到 `t()`。静态扫描能证明"没有硬编码"，但证明不了
 * "渲染时真的从词典取到了值" —— 一个拼错的键、一个在模块初始化时被"冻"住的 t() 调用，
 * 扫描器都看不见，用户看得见。
 *
 * 所以这里只钉两件事：面板渲染时不抛错、且其可见文案确实来自当前语言的词典；
 * 外加一次**切语言**断言（只有真正响应式的 t() 才会跟着变）。
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MDMPanel from "../src/svelte/modules/MDMPanel.svelte";
import APISettings from "../src/svelte/modules/APISettings.svelte";
import AuditLogViewer from "../src/svelte/modules/AuditLogViewer.svelte";
import TemplateLibrary from "../src/svelte/modules/TemplateLibrary.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { mdmManager } from "../src/lib/enterprise/mdm";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

afterEach(() => {
  cleanup();
  setLocale("zh");
  window.localStorage.clear();
});

describe("企业面板：文案来自词典，而不是硬编码（REQ-A385）", () => {
  test("MDMPanel 渲染出 MDM 的标题与分区，且值等于 zh 词典", () => {
    const { container } = render(MDMPanel);
    const text = container.textContent ?? "";
    expect(text).toContain(zh["mdm.title"]);
    expect(text).toContain(zh["mdm.permissionsSection"]);
    expect(text).toContain(zh["mdm.limitsSection"]);
    // 加密存储卡片（REQ-A1440）：把"配置是加密落盘的"放到界面上，而不是只留在文档里。
    // 卡片一定在；两句话（有/无 Web Crypto）按环境二选一，所以只钉"这一节渲染出来了"。
    expect(text).toContain(zh["mdm.cryptoSection"]);
    expect(text).toMatch(/AES-GCM-256|Web Crypto/);
  });

  test("APISettings 渲染出 API 标题、分区与 Webhook 区块", () => {
    const { container } = render(APISettings);
    const text = container.textContent ?? "";
    expect(text).toContain(zh["api.title"]);
    expect(text).toContain(zh["api.configSection"]);
    expect(text).toContain(zh["api.webhooksSection"]);
  });

  test("AuditLogViewer 渲染出筛选器与空态文案", () => {
    const { container } = render(AuditLogViewer);
    const text = container.textContent ?? "";
    expect(text).toContain(zh["audit.title"]);
    expect(text).toContain(zh["audit.filtersSection"]);
    // 没有日志时应当是**空态**，而不是一行假数据。
    expect(text).toContain(zh["audit.emptyTitle"]);
  });

  test("TemplateLibrary 渲染出模板库标题与筛选文案", () => {
    const { container } = render(TemplateLibrary);
    const text = container.textContent ?? "";
    expect(text).toContain(zh["templates.title"]);
    expect(text).toContain(zh["templates.allCategories"]);
  });

  test("切换语言后同一面板跟着变（t() 是响应式的，不是初始化时冻住的）", async () => {
    const { container } = render(MDMPanel);
    expect(container.textContent ?? "").toContain(zh["mdm.title"]);

    setLocale("en");
    await tick();
    const text = container.textContent ?? "";
    expect(text).toContain(en["mdm.title"]);
    expect(text).not.toContain(zh["mdm.title"]);
  });
});

/**
 * 「上次同步」这一行只能读**真的同步时刻**（REQ-A1861 / F-MDM-011）。
 *
 * 这一行原先逐字 `formatDate(lastSyncTime || config?.enrolledAt || 0)`：面板自己
 * 在 `syncConfig()` 上写着「拒绝时**不**更新「上次同步」——那会让它显示成刚刚，而什么
 * 都没同步」，可这行的兜底恰恰是从人没同步的那件事（**注册** `enrolledAt`）上取时间来
 * 顶替。此外它把**落盘的** `config.lastSyncAt`（`syncWithServer` 只在成功时推进）
 * 整个丢掉，只用会话内的一次 `lastSyncTime`。于是：注册后同步过一次再重开面板，
 * 显示的会是**注册那一刻**，而不是上次同步那一刻 —— 一个用户已知的事实被另一件事顶替。
 */
describe("MDM 上次同步：读真的同步时刻，不是注册时刻（REQ-A1861 / F-MDM-011）", () => {
  /** 与 `formatDate` 同一个格式化契约（同一进程同一时区求值，故可逐字比较）。 */
  const fmtLocal = (ts: number): string =>
    new Date(ts).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  test("注册之后同步过：显示同步那一刻，而不是注册那一刻", async () => {
    const enrolled = Date.UTC(2026, 0, 2, 3, 4); // 2026-01-02
    const synced = Date.UTC(2026, 5, 7, 8, 9); // 2026-06-07
    await mdmManager.configure({
      enabled: true,
      enrolledAt: enrolled,
      lastSyncAt: synced,
      lastSyncStatus: "success",
    });

    const { container } = render(MDMPanel);
    await tick();
    const node = container.querySelector('[data-testid="mdm-last-sync"]');
    expect(node).not.toBeNull();
    expect(node?.textContent).toBe(fmtLocal(synced));
    // 负控：注册时间不得出现在这行里 —— 注册不是同步。
    expect(node?.textContent).not.toBe(fmtLocal(enrolled));
  });

  test("从未同步过：说「从未同步」，不拿注册时间冒充（正控：同一句仍从词典取）", async () => {
    await mdmManager.configure({
      enabled: true,
      enrolledAt: Date.UTC(2026, 0, 2, 3, 4),
      lastSyncAt: 0,
      lastSyncStatus: "pending",
    });
    const { container } = render(MDMPanel);
    await tick();
    const node = container.querySelector('[data-testid="mdm-last-sync"]');
    expect(node?.textContent).toBe(zh["mdm.neverSynced"]);
  });
});

/**
 * enterprise-panels.svelte.test.ts — 四个企业面板的**渲染 + i18n 接线**门（REQ-A385）。
 *
 * 为什么是这四条：它们此前**没有任何测试**（2026-09-17 之前那批 `enterprise-ui-*.test.ts`
 * 断言的是测试里自己写的 lambda，已删除），而本次把它们 156 条硬编码文案全部迁移到
 * `t()`。静态扫描能证明"没有硬编码"，但证明不了"渲染时真的从词典取到了值" ——
 * 一个拼错的键、一个在模块初始化时被"冻"住的 t() 调用，扫描器都看不见，用户看得见。
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

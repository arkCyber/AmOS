/**
 * webman-sandbox.test.ts —— 内联 iframe 的 `sandbox` 由**设置**派生（REQ-A600 / FMEA F-SH-082）。
 *
 * 为什么单开一个文件：`WebManSettings` 声明了 `blockPopups`（默认 `true`，注释就写
 * 「阻止弹窗」）与 `javaScriptEnabled`（默认 `true`），而修前 `WebManApp.svelte` 的
 * `sandbox` 是**字面量** `"allow-scripts allow-popups allow-forms"` —— 两个设置在全 crate
 * 里没有任何消费者，于是「默认阻止弹窗」是假声明（`allow-popups` 恒被授予）。
 * 缺陷能活下来的原因与 F-SH-046 同族：判据住在组件模板里，无头测试够不着。
 *
 * 现在判据被抽成纯函数 `iframeSandbox(settings)`，本文件把 Chrome「网站设置」语义逐条钉住。
 * 本文件不注册 happy-dom：考的全是不碰 DOM 的纯逻辑。
 */
import { describe, test, expect } from "bun:test";
import { DEFAULT_SETTINGS, iframeSandbox, type WebManSettings } from "../webman";

/** 只覆盖要考的两个开关，其余取默认。 */
const withSettings = (over: Partial<WebManSettings>): WebManSettings => ({
  ...DEFAULT_SETTINGS,
  ...over,
});

describe("iframeSandbox —— 默认姿态", () => {
  test("默认（阻止弹窗 / 开 JavaScript）⇒ 有 allow-scripts，**没有** allow-popups", () => {
    const sandbox = iframeSandbox(DEFAULT_SETTINGS);
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-popups");
    expect(sandbox).toContain("allow-forms");
  });

  test("永不授予 allow-same-origin（这个帧必须是不透明来源）", () => {
    // 四种开关组合都不许出现。
    for (const blockPopups of [true, false]) {
      for (const javaScriptEnabled of [true, false]) {
        const sandbox = iframeSandbox(withSettings({ blockPopups, javaScriptEnabled }));
        expect(sandbox).not.toContain("allow-same-origin");
      }
    }
  });
});

describe("iframeSandbox —— 每个开关都真的改变输出", () => {
  test("关掉 JavaScript ⇒ allow-scripts 消失（脚本不执行）", () => {
    const sandbox = iframeSandbox(withSettings({ javaScriptEnabled: false }));
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).toContain("allow-forms");
  });

  test("取消阻止弹窗 ⇒ allow-popups 出现（用户页面可开新窗口）", () => {
    const sandbox = iframeSandbox(withSettings({ blockPopups: false }));
    expect(sandbox).toContain("allow-popups");
    expect(sandbox).toContain("allow-scripts");
  });

  test("两个开关都关 ⇒ 只剩 allow-forms", () => {
    expect(iframeSandbox(withSettings({ blockPopups: true, javaScriptEnabled: false }))).toBe(
      "allow-forms",
    );
  });
});

describe("iframeSandbox —— 令牌顺序固定（可逐字节断言）", () => {
  test("全开时的完整串", () => {
    expect(iframeSandbox(withSettings({ blockPopups: false, javaScriptEnabled: true }))).toBe(
      "allow-scripts allow-popups allow-forms",
    );
  });

  test("默认时的完整串", () => {
    expect(iframeSandbox(DEFAULT_SETTINGS)).toBe("allow-scripts allow-forms");
  });
});

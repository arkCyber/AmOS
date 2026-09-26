/**
 * DOM tests for Settings ▸ 企业功能 (EnterprisePage.svelte, REQ-A584).
 *
 * The three panels behind the tabs (MDMPanel / AuditLogViewer / APISettings) are 700–1140 lines of
 * finished, i18n'd, store-backed UI that **nothing could reach**: the spec
 * (`docs/SHORTCUTS_ENTERPRISE_UI_SPEC.md`) puts them in this section and the section was never
 * built. These tests pin the two things that make it real:
 *   * switching tabs really swaps the mounted panel (each panel renders its own title), and
 *   * all four spec tabs are mounted — including the fourth (企业模板), which used to be withheld
 *     behind a note reading "its catalogue has no producer". REQ-A1320 falsified that claim
 *     (`TemplateManager` now bootstraps its own tables from every read and write path), so the
 *     note and its i18n key are gone and the tab mounts `TemplateLibrary`.
 *
 * The panels own their own state (via `lib/enterprise/*`, which reads the local store), so they
 * mount without a Tauri bridge — the same "honest offline" path every settings page has.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import EnterprisePage from "../src/svelte/settings/EnterprisePage.svelte";
import { setLocale } from "../src/svelte/locale.svelte";

afterEach(() => {
  cleanup();
  setLocale("en");
});

describe("Settings ▸ 企业功能 (EnterprisePage)", () => {
  test("默认打开 MDM 标签，另外三个标签是真正的 tab 角色", () => {
    setLocale("en");
    const { getByTestId } = render(EnterprisePage);
    expect(getByTestId("enterprise-tab-mdm").getAttribute("aria-selected")).toBe("true");
    expect(getByTestId("enterprise-tab-templates").getAttribute("aria-selected")).toBe("false");
    expect(getByTestId("enterprise-tab-audit").getAttribute("aria-selected")).toBe("false");
    expect(getByTestId("enterprise-tab-api").getAttribute("aria-selected")).toBe("false");
    expect(getByTestId("enterprise-tab-mdm").getAttribute("role")).toBe("tab");
    // The MDM panel is the mounted one.
    expect(document.body.textContent ?? "").toContain("MDM device management");
  });

  test("切到「审计日志」挂载审计面板（它也是 VirtualList 的唯一消费者）", async () => {
    setLocale("en");
    const { getByTestId } = render(EnterprisePage);
    await fireEvent.click(getByTestId("enterprise-tab-audit"));
    expect(getByTestId("enterprise-tab-audit").getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent ?? "").toContain("Audit log");
    // The MDM panel is gone, not merely hidden behind the new one.
    expect(document.body.textContent ?? "").not.toContain("MDM device management");
  });

  test("切到「API 集成」挂载 API 面板", async () => {
    setLocale("en");
    const { getByTestId } = render(EnterprisePage);
    await fireEvent.click(getByTestId("enterprise-tab-api"));
    expect(document.body.textContent ?? "").toContain("API integration");
  });

  test("规格里的第四块（企业模板）就在标签条上，切过去真的挂载模板库", async () => {
    setLocale("en");
    const { getByTestId } = render(EnterprisePage);
    const tab = getByTestId("enterprise-tab-templates");
    expect(tab.getAttribute("role")).toBe("tab");
    expect(tab.getAttribute("aria-selected")).toBe("false");

    await fireEvent.click(tab);
    expect(tab.getAttribute("aria-selected")).toBe("true");
    // 模板库自己那条标题 —— 挂载了，而不是又一个「永远空的屏幕」。
    expect(document.body.textContent ?? "").toContain("Enterprise templates");
    // 上一块面板真的被卸掉了。
    expect(document.body.textContent ?? "").not.toContain("MDM device management");
  });

  test("中文界面下标签都是中文（键在两边都存在）", () => {
    setLocale("zh");
    const { getByTestId } = render(EnterprisePage);
    expect(getByTestId("enterprise-tab-audit").textContent ?? "").toContain("审计日志");
    expect(getByTestId("enterprise-tab-templates").textContent ?? "").toContain("企业模板");
  });
});

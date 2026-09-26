/**
 * mdm-reset-defaults.svelte.test.ts — 「重置为默认」必须真的恢复默认（REQ-A1328）
 *
 * 为什么这个文件存在：`MDMPanel.svelte::resetToDefault()` 自己**又写了一份**限制默认表，
 * 与 `src/lib/enterprise/mdm.ts` 的 `DEFAULT_RESTRICTIONS` 并列 —— 而这份抄本已经漂了：
 * `maxShortcutsPerUser` 写的是 `500`，而 `DEFAULT_RESTRICTIONS`（`mdm.ts:186`）与
 * `deletePolicy()` 的恢复表都是 `100`。于是只有这一个按钮会产出 `500`：
 *
 *   * 用户按下「重置为默认」（确认框逐字写着「这将清除所有自定义设置」），屏幕上
 *     显示的是 500 —— 一个**不是**默认值的数；
 *   * 而同一个面板上「删除策略 ⇒ 恢复默认值」恢复出来的是 100（那条路走
 *     `DEFAULT_RESTRICTIONS`），两条路对「默认」给出两个答案；
 *   * 出厂默认（首次配置 / `normalizeRestrictions()` 的兜底 / 重装）也是 100。
 *
 * 这是这台闸门自己记着的那个病的第二种形态：`scripts/mdm-restriction-scan.mjs` 的
 * 判据③（「限制的数值只能写在默认表里」）在 `mdm.ts` 里把副本写死成红色 —— 但它的
 * **扫描面是 `mdm.ts` 一个文件**（写在它自己的「边界（量出来的）」一节里：判据说的是
 * `MDMRestrictions`/`MDMConfig` 与 `MDMManager` 之间的内部一致性），所以面板这第二份
 * 抄本它看不见。面板这一侧的棘轮就是本文件：**逐项相等**，多一项、少一项、值不同都红。
 *
 * 判据：不读面板的内部状态，读两个可观察的面 —— 管理器真的持有的限制表，以及屏幕上
 * 那个数字框里显示的数。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MDMPanel from "../src/svelte/modules/MDMPanel.svelte";
import { DEFAULT_RESTRICTIONS, mdmManager, type MDMConfig } from "../src/lib/enterprise/mdm";
import { setLocale } from "../src/svelte/locale.svelte";

/** 一份**处处偏离默认**的配置：这样「重置」若不发生（或只发生一半）都看得出来。 */
function driftedConfig(): MDMConfig {
  return {
    enabled: true,
    organizationId: "org-drifted",
    organizationName: "Acme",
    deviceId: "device-test",
    deviceName: "Test Mac",
    serverUrl: "https://mdm.example.test",
    apiKey: "key-1",
    policies: [],
    restrictions: {
      disabledCategories: ["media"],
      disabledActions: ["delete_all"],
      maxExecutionTime: 42,
      maxExecutionsPerDay: 7,
      maxActionsPerShortcut: 3,
      maxShortcutsPerUser: 42,
      allowUserCreate: false,
      allowUserModify: false,
      allowUserDelete: false,
      allowSharing: false,
      allowExport: false,
      allowImport: false,
      requireApprovalForCreate: true,
      requireApprovalForModify: true,
      requireApprovalForSharing: true,
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

const resetButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[data-testid="mdm-reset"]');

const capInput = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>("#maxShortcutsPerUser");

beforeEach(() => {
  setLocale("zh");
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  mdmManager.clearConfigForTest();
  mdmManager.stopAutoSync();
  mdmManager.shutdown();
  window.localStorage.clear();
});

describe("MDM 面板：「重置为默认」必须真的恢复默认（REQ-A1328）", () => {
  test("确认之后，限制表逐项等于 DEFAULT_RESTRICTIONS", async () => {
    mdmManager.setConfigForTest(driftedConfig());
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const { container } = render(MDMPanel);
    await tick();

    const button = resetButton(container);
    expect(button).not.toBeNull();
    await fireEvent.click(button!);
    await tick();

    expect(confirmSpy).toHaveBeenCalled();

    // 逐项相等（不是「大于/小于」）：默认表将来加一项而这里没跟上，这一条也会红。
    expect(mdmManager.getRestrictions()).toEqual(DEFAULT_RESTRICTIONS);
    // 单独把那个漂了的数点出来 —— 失败信息里要能直接读到名字和两侧的值。
    expect(mdmManager.getRestrictions().maxShortcutsPerUser).toBe(
      DEFAULT_RESTRICTIONS.maxShortcutsPerUser,
    );
  });

  test("屏幕上的数字框显示的就是默认值（不是那份抄本里的数）", async () => {
    mdmManager.setConfigForTest(driftedConfig());
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const { container } = render(MDMPanel);
    await tick();
    await fireEvent.click(resetButton(container)!);
    await tick();

    // 面:用户在「重置为默认」之后读到的那一格。
    expect(capInput(container)?.value).toBe(String(DEFAULT_RESTRICTIONS.maxShortcutsPerUser));
  });

  test("拒绝确认 ⇒ 一个字段都不改（撤销不是空转）", async () => {
    mdmManager.setConfigForTest(driftedConfig());
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const { container } = render(MDMPanel);
    await tick();
    await fireEvent.click(resetButton(container)!);
    await tick();

    expect(mdmManager.getRestrictions()).toEqual(driftedConfig().restrictions);
  });
});

/**
 * mdm-save-refused.svelte.test.ts — MDM 面板改动没能落盘时，屏幕上说了什么（REQ-A826）
 *
 * 为什么这个文件存在：面板上四个控件（启用开关、服务器 URL、组织 ID、使用限制）都走
 * `mdmManager.configure()`，而它的最后一步 `await this.saveConfig()` 在存储拒收时**抛**
 * （`throw new Error("写入加密配置失败")`）。四个调用点原先都是即发即忘，于是那条拒绝
 * 变成一条**没人接的 rejection**：
 *
 *   * 屏幕上照旧显示新值、一个字都不说 —— 用户以为改好了；
 *   * 磁盘上还是上一次的配置 ⇒ 重启后静默回落到旧值；
 *   * 在测试里它表现为一条 `Unhandled Rejection`（`bun run test:svelte` 因此退出码 1，
 *     而 152 个文件 1770 个用例全绿），因为 `encryptMDMData` 的 await 在用例结束、
 *     环境拆掉之后才走到 `window.localStorage.setItem`。
 *
 * 判据（与这一族一贯的判据一致）：不看内部状态，看**屏幕上出现了什么** —— 拒绝有没有
 * 一个渲染点、渲染点是不是在**按下按钮的那个视图**里，以及「拒绝之后屏幕上说的那句
 * 是不是真的」：内存里的值仍然是新值（`configure()` 先改内存再落盘），所以提示说的是
 * 「本次生效、重启后回落」，而不是把面板退回旧值。
 *
 * 负控（实测，逐字节还原）：把任一调用点换回 `mdmManager.configure(...)` 即发即忘
 * ⇒ 本文件三条用例红（提示根本不出现），且 `bun run test:svelte` 重现 3 条
 * `Unhandled Rejection`。存储正常时最后一条断言（提示消失）是它的反向一侧。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MDMPanel from "../src/svelte/modules/MDMPanel.svelte";
import { mdmManager, type MDMConfig } from "../src/lib/enterprise/mdm";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

/** `crates/amos-tauri/frontend-ts/src/lib/enterprise/mdm.ts` 里 `STORE_KEYS.MDM_CONFIG`
 *  的**字面量**（那边的表不是导出的；这里逐字写出，改了键这个名字就得跟着改）。 */
const MDM_CONFIG_KEY = "amos.shortcuts.mdm.config";

function mdmConfig(): MDMConfig {
  return {
    enabled: true,
    organizationId: "org-1",
    organizationName: "Acme",
    deviceId: "device-test",
    deviceName: "Test Mac",
    serverUrl: "https://mdm.example.test",
    apiKey: "key-1",
    policies: [],
    restrictions: {
      disabledCategories: [],
      disabledActions: [],
      maxExecutionTime: 300,
      maxExecutionsPerDay: 1000,
      maxActionsPerShortcut: 50,
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

/** 让对 `key` 的写入**真的**失败（其余键照旧）—— 存储拒收在这里就是 `setItem` 抛。 */
function refuseWritesTo(key: string): void {
  const real = window.localStorage.setItem.bind(window.localStorage);
  vi.spyOn(window.localStorage, "setItem").mockImplementation((k: string, v: string) => {
    if (String(k) === key) throw new Error("QuotaExceededError");
    real(k, v);
  });
}

async function type(container: HTMLElement, id: string, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  input.value = value;
  await fireEvent.input(input);
  await tick();
}

const notice = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="mdm-save-refusal"]');

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

describe("MDM 面板：改动没能落盘时说了什么（REQ-A826）", () => {
  test("存储拒收 ⇒ 面板说出这件事（本次生效、重启后回落），并且不退回旧值", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);
    refuseWritesTo(MDM_CONFIG_KEY);

    await type(container, "maxExecutionsPerDay", "500");

    // 提示要有渲染点，而且是在**按下控件的这个视图**里。
    await vi.waitFor(() => expect(notice(container)).not.toBeNull());
    expect(notice(container)?.textContent).toContain(zh["mdm.saveRefused"]);

    // 另一半：被拒的是**磁盘**那一半。`configure()` 先更新内存再落盘，所以模型里
    // 仍然是新值 —— 提示不该假装什么都没发生（那会让屏幕和系统重新各说各话）。
    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(500);
    // 而且确实**没有**落盘：这正是提示那句话的依据。
    expect(window.localStorage.getItem(MDM_CONFIG_KEY)).toBeNull();
  });

  test("存储恢复之后的下一次改动 ⇒ 提示自己消失", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);
    refuseWritesTo(MDM_CONFIG_KEY);
    await type(container, "maxExecutionsPerDay", "500");
    await vi.waitFor(() => expect(notice(container)).not.toBeNull());

    vi.restoreAllMocks(); // 存储恢复了

    await type(container, "maxExecutionsPerDay", "250");

    await vi.waitFor(() => expect(window.localStorage.getItem(MDM_CONFIG_KEY)).not.toBeNull());
    expect(notice(container)).toBeNull();
    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(250);
  });

  test("存储正常 ⇒ 一个字都不多说（提示不是常亮的）", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);

    await type(container, "maxExecutionsPerDay", "500");

    // 等到**写入真的落地**再断言「没有提示」：这样这一条问的是
    // 「成功时不报警」，而不是「还没来得及报警」。
    await vi.waitFor(() => expect(window.localStorage.getItem(MDM_CONFIG_KEY)).not.toBeNull());
    expect(notice(container)).toBeNull();
  });

  test("启用开关这条路也走同一个落盘点（提示不在某个控件的私处）", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);
    refuseWritesTo(MDM_CONFIG_KEY);

    const toggle = container.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(toggle.checked).toBe(true);
    await fireEvent.change(toggle);
    await tick();

    await vi.waitFor(() => expect(notice(container)).not.toBeNull());
    expect(notice(container)?.textContent).toContain(zh["mdm.saveRefused"]);
  });
});

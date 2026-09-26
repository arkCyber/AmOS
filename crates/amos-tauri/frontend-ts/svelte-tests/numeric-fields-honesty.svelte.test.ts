/**
 * numeric-fields-honesty.svelte.test.ts — 数字框里打进去的数，是不是系统真正持有的那个数（REQ-A821）
 *
 * 为什么这个文件存在：两个面板的每一个数字输入原先都是 `parseInt(value) || <默认值>`，
 * 而输入框用 `value={…}`（**非** `bind:`）渲染 —— 于是三种输入都被静默换成一个用户没写
 * 过的数，屏幕上却继续显示用户打的那串字符：
 *
 *   * `0`：`0 || 1000` 是 `1000`。「重试次数」填 `0`（不重试）会被存成 `3`；
 *   * 空串 / 打不成数的东西：`NaN || 1000` 同样是 `1000`；
 *   * 超过声明的 `max`：**没有任何一处强制它**，越界值原样进模型并落盘。
 *
 * 判据是这个家族一贯的那个：不看内部状态，看**屏幕上出现了什么**，并同时问一句
 * 「模型里的数是不是用户打的那个」。两条都要成立，因为原来正是「屏幕与模型各说各话」
 * 才让这件事无声地过去。
 *
 * 负控（实测，逐字节还原）：把任一 `onNumericRestriction` 换回 `parseInt(v) || 默认值`
 * ⇒ 对应用例红；`src/lib/__tests__/numericField.test.ts` 里的源码检查同时红（那个文件
 * 读的是**去注释后的代码**，注释里逐字引用的旧形状不会把它满足）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MDMPanel from "../src/svelte/modules/MDMPanel.svelte";
import APISettings from "../src/svelte/modules/APISettings.svelte";
import { mdmManager, type MDMConfig } from "../src/lib/enterprise/mdm";
import { apiClient } from "../src/lib/enterprise/api";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

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

/** 往一个数字框里打字（真 `input` 事件，与用户输入同一条路径）。 */
async function type(container: HTMLElement, id: string, value: string): Promise<HTMLInputElement> {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  input.value = value;
  await fireEvent.input(input);
  await tick();
  return input;
}

const refusal = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="mdm-number-refusal"], [data-testid="api-number-refusal"]');

/**
 * 按下「保存配置」—— API 面板的数字**只在保存时**离开面板（`saveAPIConfig` 才调
 * `apiClient.configure`），所以「系统真正持有的数」要在这一步之后读。
 */
async function save(container: HTMLElement): Promise<void> {
  await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="api-config-save"]')!);
  await tick();
}

beforeEach(() => {
  setLocale("zh");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  mdmManager.clearConfigForTest();
  mdmManager.stopAutoSync();
  mdmManager.shutdown();
  window.localStorage.clear();
});

describe("MDM「使用限制」：型号收下了吗、为什么没收", () => {
  test("打一个范围内的整数 ⇒ 进模型，且不显示任何拒绝", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);

    await type(container, "maxExecutionsPerDay", "500");

    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(500);
    expect(refusal(container)).toBeNull();
  });

  test("打 `0` ⇒ **不收**，说出最小值 1，且模型保持原值（原来会静默变成 1000）", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);

    await type(container, "maxExecutionsPerDay", "0");

    expect(refusal(container)?.textContent).toContain(
      zh["common.numberBelowMin"].replace("{min}", "1"),
    );
    // 关键的一半：模型**没有**被塞进 1000（默认值）或 0（用户打的）。
    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(1000);
  });

  test("打超出上限的数 ⇒ 说出上限 10000，且模型保持原值（原来越界值直接落盘）", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);

    await type(container, "maxExecutionsPerDay", "99999");

    expect(refusal(container)?.textContent).toContain(
      zh["common.numberAboveMax"].replace("{max}", "10000"),
    );
    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(1000);
  });

  test("清空输入框 ⇒ 说「请输入一个整数」，而不是把默认值塞进模型", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);

    await type(container, "maxActionsPerShortcut", "");

    expect(refusal(container)?.textContent).toContain(zh["common.numberNotInteger"]);
    expect(mdmManager.getRestrictions().maxActionsPerShortcut).toBe(50);
  });

  test("离焦后框里的字回到模型的值 —— 屏幕与系统不再各说各话", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);

    // 用一个**越界**的数：它不会被任何「默认值」兜住，所以「离焦后回到什么」这一问
    // 只有「回到模型里的原值」一个正确答案（拿 `0` 来问是问不出区别的 —— 旧的
    // `|| 1000` 恰好也落在 1000 上）。
    const input = await type(container, "maxExecutionsPerDay", "99999");
    expect(input.value).toBe("99999"); // 打字期间保留用户的输入，好让他看见自己打了什么

    await fireEvent.blur(input);
    await tick();

    expect(input.value).toBe("1000"); // 模型里的那个数
  });

  test("拒绝之后打一个合法的数 ⇒ 提示消失、新值进模型", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);

    await type(container, "maxExecutionsPerDay", "0");
    expect(refusal(container)).not.toBeNull();

    await type(container, "maxExecutionsPerDay", "250");

    expect(refusal(container)).toBeNull();
    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(250);
  });
});

describe("MDM「单次执行时长」：这一格此前根本不存在（REQ-A824）", () => {
  test("面板显示这一格，值来自模型 —— 管理员看得见它，才谈得上改它", () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);

    // 这是本条的**前门**部分：四条限制此前只显示三条，而缺的那一条正是唯一没有
    // 任何执行路径去读的一条。字号/文案来自词典，值来自模型。
    expect(container.textContent ?? "").toContain(zh["mdm.maxExecutionTime"]);
    const input = container.querySelector<HTMLInputElement>("#maxExecutionTime")!;
    expect(input.value).toBe("300");
  });

  test("打一个合法的秒数 ⇒ 进模型（引擎随后就是拿这个数当预算）", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);

    await type(container, "maxExecutionTime", "45");

    expect(mdmManager.getRestrictions().maxExecutionTime).toBe(45);
    expect(refusal(container)).toBeNull();
  });

  test("打 `0` ⇒ 不收（最小 1 秒），且模型保持原值", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);

    await type(container, "maxExecutionTime", "0");

    expect(refusal(container)?.textContent).toContain(
      zh["common.numberBelowMin"].replace("{min}", "1"),
    );
    expect(mdmManager.getRestrictions().maxExecutionTime).toBe(300);
  });

  test("打超出面板上限 3600 ⇒ 不收，模型不变", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);

    await type(container, "maxExecutionTime", "99999");

    expect(refusal(container)?.textContent).toContain(
      zh["common.numberAboveMax"].replace("{max}", "3600"),
    );
    expect(mdmManager.getRestrictions().maxExecutionTime).toBe(300);
  });

  test("min/max 同样来自那张表", () => {
    mdmManager.setConfigForTest(mdmConfig());
    const { container } = render(MDMPanel);

    const input = container.querySelector<HTMLInputElement>("#maxExecutionTime")!;
    expect(input.min).toBe("1");
    expect(input.max).toBe("3600");
  });
});

describe("API 集成的三个数字字段：同一个判据", () => {
  test("重试次数打 `0` ⇒ 照收（**这是本轮的回归**：`0 || 3` 曾经把它变成 3）", async () => {
    apiClient.configure({ enabled: true, baseUrl: "https://api.example.test" });
    const { container } = render(APISettings);

    await type(container, "retryCount", "0");
    expect(refusal(container)).toBeNull();

    await save(container);
    expect(apiClient.getConfig().retryCount).toBe(0);
  });

  test("重试次数打 6（上限是 5）⇒ 说出上限，且保存下去的还是原来的数", async () => {
    apiClient.configure({ enabled: true, baseUrl: "https://api.example.test", retryCount: 3 });
    const { container } = render(APISettings);

    await type(container, "retryCount", "6");

    expect(refusal(container)?.textContent).toContain(
      zh["common.numberAboveMax"].replace("{max}", "5"),
    );
    await save(container);
    expect(apiClient.getConfig().retryCount).toBe(3);
  });

  test("超时打空 ⇒ 说「请输入一个整数」，而不是静默变成 30000", async () => {
    apiClient.configure({ enabled: true, baseUrl: "https://api.example.test", timeout: 15000 });
    const { container } = render(APISettings);

    await type(container, "timeout", "");

    expect(refusal(container)?.textContent).toContain(zh["common.numberNotInteger"]);
    await save(container);
    expect(apiClient.getConfig().timeout).toBe(15000);
  });

  test("重试间隔打 100（下限是 500）⇒ 说出下限，保存下去的还是原来的数", async () => {
    apiClient.configure({ enabled: true, baseUrl: "https://api.example.test", retryDelay: 2000 });
    const { container } = render(APISettings);

    await type(container, "retryDelay", "100");

    expect(refusal(container)?.textContent).toContain(
      zh["common.numberBelowMin"].replace("{min}", "500"),
    );
    await save(container);
    expect(apiClient.getConfig().retryDelay).toBe(2000);
  });

  test("离焦时框里的字回到面板持有的数（API 面板的模型在面板里）", async () => {
    apiClient.configure({ enabled: true, baseUrl: "https://api.example.test", timeout: 15000 });
    const { container } = render(APISettings);

    const input = await type(container, "timeout", "1"); // 低于下限 1000
    await fireEvent.blur(input);
    await tick();

    expect(input.value).toBe("15000");
  });

  test("三个 min/max 属性真的来自那张表（改表就改标记）", async () => {
    apiClient.configure({ enabled: true, baseUrl: "https://api.example.test" });
    const { container } = render(APISettings);

    const timeout = container.querySelector<HTMLInputElement>("#timeout")!;
    expect(timeout.min).toBe("1000");
    expect(timeout.max).toBe("120000");
    const retryCount = container.querySelector<HTMLInputElement>("#retryCount")!;
    expect(retryCount.min).toBe("0"); // 「0 是合法的」在标记上也是显式的
    expect(retryCount.max).toBe("5");
  });
});

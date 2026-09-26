/**
 * shortcuts-execution-reason.svelte.test.ts
 *   — 执行结果那句话里的**理由**到底上没上屏（REQ-A848 的屏幕侧 + REQ-A849）
 *
 * 两个缺陷，同一个渲染点（`ShortcutsApp.svelte` 里那个 `role="status"` 的执行结果 toast）：
 *
 * **REQ-A849** —— 调用点一直在**递**理由，模板一直**不接**。三处调用写成
 * `t("shortcuts.executionFailed", { error: result.error ?? "Unknown error" })`，
 * 而 `zh["shortcuts.executionFailed"]` 的字面量是光秃秃的「执行失败」，**没有 `{error}`**。
 * `translate()` 的实现是 `base.replace(/\{(\w+)\}/g, …)` —— 只替换**字符串里存在**的占位符，
 * 所以多出来的 `error` 被静默丢掉，用户看到的就是一句没有内容的「执行失败」。
 * 成功那句更明显：调用点递了 `{completed, total, duration}` 三个数，字面量也是三个占位符
 * 一个都没有 —— 于是「20 步里跑完第 1 步就崩了」和「5 步全跑完」在屏幕上长得一模一样。
 * 这就是 F-MDM-004（判决没说到用户耳朵里）再往外一层：判决已经到了**渲染调用**，
 * 被**模板**丢掉了 —— 记录着的那句话（审计行里有完整的 `errorMessage`）用户看不到。
 *
 * **REQ-A848 的屏幕侧** —— 操作黑名单（`disabledCategories` / `disabledActions`）从来没有
 * 被执行路径读过；本轮把它接到 `executeShortcut()` 的预检上。这一条测的是那半句：
 * 管理员勾掉的分类/操作，用户在**按下运行之后**看得见管理员的理由。
 *
 * 判据是这个家族一贯的那条：**看屏幕上出现了什么**。A849 的两条都用**非 MDM** 的失败
 * （非法正则）当证人 —— 否则「理由上屏了」与「黑名单生效了」会互相冒充。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ShortcutsApp from "../src/svelte/ShortcutsApp.svelte";
import { saveShortcuts, type ActionInstance, type Shortcut } from "../src/lib/shortcuts";
import { mdmManager, type MDMConfig } from "../src/lib/enterprise/mdm";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

let seq = 0;
const action = (
  actionTypeId: string,
  parameters: Record<string, unknown> = {},
): ActionInstance => ({
  id: `act-${++seq}`,
  actionTypeId,
  parameters,
  position: seq,
});

const seedShortcut = (actions: ActionInstance[]): Shortcut => ({
  id: "sc-seed",
  name: "收藏文章",
  icon: "⚡",
  color: "#007AFF",
  description: "",
  actions,
  quickActions: [],
  triggers: [],
  createdAt: 0,
  updatedAt: 0,
  runCount: 0,
  runOnLockScreen: false,
  requiresConfirmation: false,
  tags: [],
});

function mdmConfig(
  restrictions: Partial<MDMConfig["restrictions"]> = {},
  enabled = true,
): MDMConfig {
  return {
    enabled,
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
      ...restrictions,
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
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mdmManager.clearConfigForTest();
  mdmManager.stopAutoSync();
  mdmManager.shutdown();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** 屏幕上那句执行结果（没有就是空串）。 */
const toast = (container: HTMLElement) =>
  container
    .querySelector<HTMLElement>('[data-testid="shortcut-execution-result"]')
    ?.textContent?.trim() ?? "";

/**
 * 打开指令详情（运行按钮与分享开关在同一个面板里）。
 *
 * 走的是用户真的会按的那个按钮：列表卡片上的「编辑」（`aria-label` 取本地化文案，
 * 不是位置，也不是内部函数）。与 `shortcuts-mdm-refusal` 同一个入口。
 */
async function openDetail(host: { container: HTMLElement }) {
  const edit = [...host.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === zh["shortcuts.edit"],
  ) as HTMLButtonElement | undefined;
  expect(edit).toBeTruthy();
  await fireEvent.click(edit!);
  await settle();
}

/** 按下运行，并等屏幕上出现结果那句话（不用固定 sleep 去赌）。 */
async function runAndReadToast(host: { container: HTMLElement }): Promise<string> {
  const run = [...host.container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === zh["shortcuts.runShortcut"],
  ) as HTMLButtonElement | undefined;
  expect(run, "运行按钮应该在详情面板里").toBeTruthy();
  await fireEvent.click(run!);

  await vi.waitFor(
    () => expect(toast(host.container), "按下运行之后屏幕上必须有一句话").not.toBe(""),
    { timeout: 2000 },
  );
  return toast(host.container);
}

describe("REQ-A849: 执行结果那句话必须带上理由，不能只有一句「执行失败」", () => {
  test("非 MDM 的失败（非法正则）⇒ 屏幕上那句话里有引擎给的原因", async () => {
    saveShortcuts([
      seedShortcut([action("text", { text: "abc" }), action("replace_text", { text: "abc", find: "[", replace: "x" })]),
    ]);
    const host = render(ShortcutsApp);
    await settle();
    await openDetail(host);

    const shown = await runAndReadToast(host);

    // 修之前这里是光秃秃的「执行失败」——`error` 被 `translate()` 静默丢掉。
    expect(shown).not.toBe(zh["shortcuts.executionFailed"]);
    expect(shown).toContain("执行失败");
    expect(shown).toMatch(/Invalid regular expression/i);
  });

  test("成功的那一跑把步数与耗时也说出来（调用点一直在递这三个数）", async () => {
    saveShortcuts([seedShortcut([action("text", { text: "a" }), action("text", { text: "b" })])]);
    const host = render(ShortcutsApp);
    await settle();
    await openDetail(host);

    const shown = await runAndReadToast(host);

    expect(shown).toContain("执行成功");
    // 「2/2 步」：总数与被拒绝时的「0/2」一样，是用户唯一能判断跑了几步的读数。
    expect(shown).toContain("2/2");
    expect(shown).not.toContain("{completed}");
    expect(shown).not.toContain("{total}");
    expect(shown).not.toContain("{duration}");
  });

  test("兜底那句也不留裸占位符（`result.error` 为空时才走它）", () => {
    // 两处调用点都写 `result.error ?? "Unknown error"`；先把**模板**这一侧钉住：
    // 占位符存在，才不会在 `reason` 缺失时又把内容丢掉。
    expect(zh["shortcuts.executionFailed"]).toContain("{error}");
    expect(zh["shortcuts.executionError"]).toContain("{error}");
  });
});

describe("REQ-A848 的屏幕侧: 被禁的操作在按下运行之后要说出来", () => {
  test("黑名单里有这个操作 ⇒ 屏幕上出现**管理员那句**，而且那个操作真的没跑", async () => {
    mdmManager.setConfigForTest(mdmConfig({ disabledActions: ["copy_to_clipboard"] }));
    saveShortcuts([
      seedShortcut([action("text", { text: "before" }), action("copy_to_clipboard", { text: "x" })]),
    ]);
    const host = render(ShortcutsApp);
    await settle();
    await openDetail(host);

    const shown = await runAndReadToast(host);

    // 理由点名了那个操作 —— 用户能拿这句话回去问管理员。
    expect(shown).toContain("copy_to_clipboard");
    expect(shown).toContain("已被管理员禁用");
  });

  test("整类被禁 ⇒ 屏幕上点名分类（管理员禁的是分类）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ disabledCategories: ["device"] }));
    saveShortcuts([seedShortcut([action("text", { text: "before" }), action("vibrate", { pattern: "short" })])]);
    const host = render(ShortcutsApp);
    await settle();
    await openDetail(host);

    const shown = await runAndReadToast(host);

    expect(shown).toContain("device");
    expect(shown).toContain("已被管理员禁用");
  });

  test("补集：黑名单清空 ⇒ 屏幕上说的是成功（拦住它的确实是黑名单，不是别的东西）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ disabledActions: [] }));
    saveShortcuts([
      seedShortcut([action("text", { text: "before" }), action("copy_to_clipboard", { text: "x" })]),
    ]);
    const host = render(ShortcutsApp);
    await settle();
    await openDetail(host);

    const shown = await runAndReadToast(host);

    expect(shown).toContain("执行成功");
    expect(shown).not.toContain("已被管理员禁用");
  });
});

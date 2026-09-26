/**
 * shortcuts-duplicate-refusal.svelte.test.ts — 「复制」被拒的时候，屏幕说话了吗（REQ-A1442）
 *
 * 为什么这个文件存在：`duplicateShortcut()` 返回 `Shortcut | null`，而它的 `null` 有两层
 * 来源 —— 原指令找不到，或者内层那次 `createShortcut()` 被拒（MDM 的 `checkCanCreate`：
 * 「禁止创建」／「需要审批」／每用户上限，以及应用自己的 `LIMITS.MAX_SHORTCUTS`）。
 * 而 `ShortcutsApp.svelte::handleDuplicate` 原先逐字是
 * `const duplicate = duplicateShortcut(id); if (duplicate) { refreshShortcuts(); }`
 * —— **没有 else**。于是管理员禁止创建、或每用户上限已满时，用户按列表卡片上的 📋（或编辑器里
 * 按 ⌘D），屏幕**毫无反应**，列表里也没有新副本，用户分不清是「没点上」还是「不让复制」。
 *
 * 这个形状在这个文件里已经被修过两次：**创建**那条路一直说话（`alert(createRefusal(...))`，
 * REQ-A842），**修改／删除／分享**在 REQ-A837 里补齐了 `mutationNote`。复制是同一份列表里
 * 第四条写路径，却是唯一一条**读了自己的裁决又把拒绝丢掉**的 —— 判据就是这个家族的判据：
 * 不看内部状态，只看**屏幕上出现了什么**，以及**模型里的东西是不是真的没变**。
 *
 * 负控（逐字节 `cp` + `shasum -a 256`，不用 `git checkout --`）：
 * ①把 `handleDuplicate` 的 else 整个删回「只有 if」⇒ 前三条红、两条对照绿；
 * ②把 else 里的 `createRefusal(...)` 换成裸 `t("shortcuts.duplicateFailed")` ⇒ 三条
 * 说理的红（那三条钉的是**管理员的原话**，不是兜底句）。
 *
 * 诚实边界：应用硬上限 `LIMITS.MAX_SHORTCUTS`（1000）那条分支**没有**被本文件覆盖 ——
 * 造 1000 条种子太重，而它与「每用户上限」在 UI 上共用同一句 `createRefusal` 的兜底，
 * 逻辑与覆盖到的上限那条同路。登记为边界，不冒充已复现。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ShortcutsApp from "../src/svelte/ShortcutsApp.svelte";
import { loadShortcuts, saveShortcuts, type Shortcut } from "../src/lib/shortcuts";
import { mdmManager, type MDMConfig } from "../src/lib/enterprise/mdm";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const seedShortcut = (): Shortcut => ({
  id: "sc-seed",
  name: "收藏文章",
  icon: "⚡",
  color: "#007AFF",
  description: "",
  actions: [],
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
  saveShortcuts([seedShortcut()]);
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

/** 屏幕上的那句话（没有就是空串）。 */
const refusal = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="shortcut-mutation-note"]')?.textContent?.trim() ??
  "";

/** 列表卡片上的「复制」按钮（按 `aria-label` 找，不用位置猜）。 */
async function pressDuplicate(container: HTMLElement) {
  const dup = [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === zh["shortcuts.duplicate"],
  ) as HTMLButtonElement | undefined;
  expect(dup).toBeTruthy();
  await fireEvent.click(dup!);
  await settle();
}

describe("REQ-A1442: 「复制」被 MDM 拒绝时，屏幕上必须有一句话", () => {
  test("禁止创建 ⇒ 按复制：说出管理员的原话，且**列表里没有多出副本**", async () => {
    mdmManager.setConfigForTest(mdmConfig({ allowUserCreate: false }));
    const host = render(ShortcutsApp);
    await settle();
    expect(refusal(host.container)).toBe(""); // 还没操作过，屏幕是干净的

    await pressDuplicate(host.container);

    // ① 屏幕说了话，而且用的是 MDM 自己的理由（不是另写一句文案）。
    expect(refusal(host.container)).toBe("管理员已禁止创建快捷指令");
    // ② 模型侧真的没多出东西 —— 只说不做、或只做不说，都过不了这一条。
    expect(loadShortcuts()).toHaveLength(1);
  });

  test("创建需审批 ⇒ 同一句话里说清是「审批」而不是「禁止」", async () => {
    mdmManager.setConfigForTest(mdmConfig({ requireApprovalForCreate: true }));
    const host = render(ShortcutsApp);
    await settle();

    await pressDuplicate(host.container);

    expect(refusal(host.container)).toBe("创建快捷指令需要管理员审批");
    expect(loadShortcuts()).toHaveLength(1);
  });

  test("每用户上限已满 ⇒ 说出上限那条理由（seed 的 1 条就占满了 cap 1）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ maxShortcutsPerUser: 1 }));
    const host = render(ShortcutsApp);
    await settle();

    await pressDuplicate(host.container);

    expect(refusal(host.container)).toBe("每用户快捷指令数已达上限（1）");
    expect(loadShortcuts()).toHaveLength(1);
  });

  test("管理员允许 ⇒ 复制真的发生，列表多一条，且没有拒绝读数（补集）", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    const host = render(ShortcutsApp);
    await settle();

    await pressDuplicate(host.container);

    expect(refusal(host.container)).toBe("");
    expect(loadShortcuts()).toHaveLength(2);
    expect(loadShortcuts()[1]!.name).toBe("收藏文章 副本");
  });

  test("MDM 关闭 ⇒ 没有任何拒绝读数，复制照常生效（补集）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ allowUserCreate: false }, false));
    const host = render(ShortcutsApp);
    await settle();

    await pressDuplicate(host.container);

    expect(refusal(host.container)).toBe("");
    expect(loadShortcuts()).toHaveLength(2);
  });
});

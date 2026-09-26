/**
 * shortcut-show-notification-refusal.svelte.test.ts — 拒写的通知不得被当成一次成功的运行
 * （REQ-A1947 / FMEA F-SH-943）。
 *
 * `shortcuts.ts::show_notification` / `show_alert` 这两条动作**唯一**的产物就是
 * `amos.notifications` 里的一行。`postNotification` 以前是 `void`，末尾
 * `writeStoreValue(NOTIF_KEY, next)` 把判决扔掉了 —— `writeStoreValue` 不返回，
 * `writeJson` 在 `setItem` 拒写时连 `STORE_CHANGED_EVENT` 都不派发。于是 store
 * 写不进（满 ∕ 不可用）的那一趟：
 *
 *   1. 屏幕上什么通知也没出现（store 没动）；
 *   2. 动作照旧 `return input`，`executeShortcut` 以 `success:true` 收尾 ——
 *      `runCount` 加一、审计与 `appendExecutionLog` 各记一条成功。
 *
 * 这与同一文件里 `open_app` 早已修掉的形状（REQ-A1193 ∕ F-SH-481）逐字相同：
 * **产物没落地却报成功**。同商店的兄弟生产者（`reminderCore` ∕ `calendarCore` 的
 * tick、`pushNotifBridge`）都已把判决带出去（`writeStoreValueChecked` + `delivered`），
 * 这里是最后的例外。
 *
 * 判据（这个家族一贯的那条）：**看 `executeShortcut` 答了什么**，不看它有没有抛。
 * 第三/四条用例是**反向守卫** —— store 正常时这一步必须照旧成功、通知必须真的落地，
 * 修法不许把正常路径判红。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  executeShortcut,
  saveShortcuts,
  type ActionInstance,
  type Shortcut,
} from "../src/lib/shortcuts";
import { NOTIF_KEY, normalizeNotifs } from "../src/lib/settings";

const seed = (actions: ActionInstance[]): Shortcut => ({
  id: "sc-notify",
  name: "发一条通知",
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

const notify = (params: Record<string, unknown>): ActionInstance => ({
  id: "act-1",
  actionTypeId: "show_notification",
  parameters: params,
  position: 1,
});

const alert = (params: Record<string, unknown>): ActionInstance => ({
  id: "act-2",
  actionTypeId: "show_alert",
  parameters: params,
  position: 1,
});

/** A store that refuses to accept the notifications key — a full/unavailable store.
 *  Only `amos.notifications` is refused so an unrelated bookkeeping write
 *  (`runCount`, MDM) cannot masquerade as the refusal under test. */
function refuseNotifWrites(): void {
  const real = window.localStorage.setItem.bind(window.localStorage);
  vi.spyOn(window.localStorage, "setItem").mockImplementation((k: string, v: string) => {
    if (k === NOTIF_KEY) throw new Error("QuotaExceededError");
    real(k, v);
  });
}

const storedNotifs = () => normalizeNotifs(JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]"));

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("REQ-A1947 — 拒写的通知是一次失败的运行，不是成功的", () => {
  test("show_notification：store 拒写时这一趟不得报成功", async () => {
    saveShortcuts([seed([notify({ title: "你好", body: "世界" })])]);
    refuseNotifWrites();

    const result = await executeShortcut("sc-notify");

    expect(
      result.success,
      "通知没有落进 store —— 屏幕上什么都没出现，这一趟不能记成成功",
    ).toBe(false);
    expect(storedNotifs(), "store 拒写了，就不该有通知落地").toHaveLength(0);
  });

  test("show_notification：理由要说「没写进通知」", async () => {
    saveShortcuts([seed([notify({ title: "你好", body: "世界" })])]);
    refuseNotifWrites();

    const result = await executeShortcut("sc-notify");

    expect(result.error ?? "", "拒写必须带上理由").toContain("通知");
  });

  test("show_alert：同一条规矩", async () => {
    saveShortcuts([seed([alert({ title: "警告", message: "磁盘将满" })])]);
    refuseNotifWrites();

    const result = await executeShortcut("sc-notify");

    expect(result.success, "show_alert 与 show_notification 是同一个产物，同一条规矩").toBe(
      false,
    );
    expect(storedNotifs()).toHaveLength(0);
  });

  test("store 正常时照旧成功，且通知真的落地 —— 修法不许把正常路径判红", async () => {
    saveShortcuts([seed([notify({ title: "你好", body: "世界" })])]);

    const result = await executeShortcut("sc-notify");

    expect(result.success, "一次成功的通知不该被修成失败").toBe(true);
    const list = storedNotifs();
    expect(list, "成功就必须真的有一行通知落在 store 里").toHaveLength(1);
    expect(list[0].title).toBe("你好");
    expect(list[0].body).toBe("世界");
  });
});

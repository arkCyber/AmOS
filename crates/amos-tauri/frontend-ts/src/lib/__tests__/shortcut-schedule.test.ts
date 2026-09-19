/**
 * shortcut-schedule.test.ts — the plan translation between stored shortcuts and the
 * Rust `shortcuts_trigger_*` ledger (`src/lib/shortcutSchedule.ts`).
 *
 * Pure on purpose: no bridge is installed here, so these assertions pin exactly what
 * the shell *sends* (and what it never sends), independent of the platform binding.
 */
import { describe, test as it, expect } from "bun:test";
import {
  parseTriggerKey,
  timeTriggerSpecs,
  triggerKey,
} from "../shortcutSchedule";
import type { Shortcut, Trigger, TriggerType } from "../shortcuts";

const trigger = (
  id: string,
  type: TriggerType,
  config: Record<string, unknown> = {},
  enabled = true
): Trigger => ({ id, type, enabled, config });

const shortcut = (id: string, triggers: Trigger[]): Shortcut => ({
  id,
  name: id,
  icon: "⚡",
  color: "#000",
  description: "",
  actions: [],
  quickActions: [],
  triggers,
  createdAt: 0,
  updatedAt: 0,
  runCount: 0,
  runOnLockScreen: false,
  requiresConfirmation: false,
  tags: [],
});

describe("触发器计划翻译", () => {
  it("key 格式与反解析是同一套", () => {
    expect(triggerKey("sc1", "trg1")).toBe("sc1:trg1");
    expect(parseTriggerKey("sc1:trg1")).toEqual({ shortcutId: "sc1", triggerId: "trg1" });
    // 值里带冒号时按**第一个**冒号切分（id 由 localId 生成，不含冒号）
    expect(parseTriggerKey("sc1:trg:2")).toEqual({ shortcutId: "sc1", triggerId: "trg:2" });
    expect(parseTriggerKey("nocolon")).toBeNull();
    expect(parseTriggerKey(":trg")).toBeNull();
    expect(parseTriggerKey("sc1:")).toBeNull();
  });

  it("只翻译启用的 time 触发器，其余类型留给 WebView 侧的信号", () => {
    const specs = timeTriggerSpecs([
      shortcut("a", [
        trigger("t1", "time", { time: "08:00" }),
        trigger("t2", "time", { time: "09:00" }, false), // 已禁用
        trigger("t3", "wifi", { ssid: "Home" }),
        trigger("t4", "app", { appId: "safari" }),
      ]),
      shortcut("b", [trigger("t5", "time", { time: "23:30", days: [1, 7] })]),
    ]);
    expect(specs).toEqual([
      { key: "a:t1", time: "08:00" },
      { key: "b:t5", time: "23:30", days: [1, 7] },
    ]);
  });

  it("空的 days 不下发（= 每天），非法星期被丢掉", () => {
    const specs = timeTriggerSpecs([
      shortcut("a", [
        trigger("t1", "time", { time: "08:00", days: [] }),
        trigger("t2", "time", { time: "08:00", days: [0, 8, "x", 3] }),
      ]),
    ]);
    expect(specs).toEqual([
      { key: "a:t1", time: "08:00" },
      { key: "a:t2", time: "08:00", days: [3] },
    ]);
  });

  it("读不懂的 time **照样下发**：让 Rust 按名字拒绝并说明原因，而不是静默丢掉", () => {
    const specs = timeTriggerSpecs([
      shortcut("a", [
        trigger("t1", "time", { time: "8:0" }), // 分钟必须两位
        trigger("t2", "time", {}), // 缺 time
      ]),
    ]);
    expect(specs).toEqual([
      { key: "a:t1", time: "8:0" },
      { key: "a:t2", time: "" },
    ]);
  });

  it("没有触发器 / 没有 shortcuts 时得到空计划", () => {
    expect(timeTriggerSpecs([])).toEqual([]);
    expect(timeTriggerSpecs([shortcut("a", [])])).toEqual([]);
  });
});

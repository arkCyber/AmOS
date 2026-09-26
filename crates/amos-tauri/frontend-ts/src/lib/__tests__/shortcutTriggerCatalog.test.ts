/**
 * shortcutTriggerCatalog.test.ts — pins the *capability* fact the trigger editor
 * leans on: which `TriggerType` values the host can actually fire (REQ-A702).
 *
 * The catalog is only worth having if it stays true to the runtime, so this file
 * does not just count entries — for every "available" kind it feeds the default
 * config through the real `triggerMatches` and asserts it fires. A catalog entry
 * that claims a type works while the matcher would never match it is the exact
 * defect (a switch nobody can make fire) this module exists to prevent.
 */
import { describe, expect, test as it } from "bun:test";
import { TRIGGER_KINDS, kindOf } from "../shortcutTriggerCatalog";
import { triggerMatches, type Trigger, type TriggerType } from "../shortcuts";

const ALL_TYPES: TriggerType[] = [
  "time",
  "location",
  "app",
  "nfc",
  "email",
  "message",
  "notification",
  "wifi",
  "bluetooth",
  "battery",
  "airplane",
];

const triggerFrom = (kind: (typeof TRIGGER_KINDS)[number]): Trigger => ({
  id: `t-${kind.type}`,
  type: kind.type,
  enabled: true,
  config: { ...kind.defaultConfig },
});

describe("触发器目录 (REQ-A702)", () => {
  it("覆盖每一种 TriggerType，且不重不漏", () => {
    const types = TRIGGER_KINDS.map((k) => k.type);
    expect(new Set(types).size).toBe(types.length);
    expect([...types].sort()).toEqual([...ALL_TYPES].sort());
  });

  it("恰好 4 种有信号源（time/app/wifi/battery），其余 7 种都给出不可用原因", () => {
    const available = TRIGGER_KINDS.filter((k) => k.unavailableReasonKey === null).map(
      (k) => k.type,
    );
    expect(available).toEqual(["time", "app", "wifi", "battery"]);

    const unavailable = TRIGGER_KINDS.filter((k) => k.unavailableReasonKey !== null);
    expect(unavailable.map((k) => k.type).sort()).toEqual(
      ["airplane", "bluetooth", "email", "location", "message", "nfc", "notification"],
    );
    // 不可用类型的默认配置必须是空的 —— 它们连编辑器都不展开配置。
    for (const kind of unavailable) {
      expect(kind.defaultConfig).toEqual({});
    }
  });

  it("目录里的每个 labelKey 都能被字典回答", () => {
    // 由 i18n-scan 兜底（死键/缺键），这里只钉住"名字非空"。
    for (const kind of TRIGGER_KINDS) {
      expect(kind.labelKey).toMatch(/^shortcuts\.trigger\.type\./);
    }
  });

  it("每一种可用类型的**默认配置**都能真的命中一次事件（否则等于画了个不响的开关）", () => {
    const at0800 = new Date(2026, 0, 5, 8, 0, 30).getTime();

    const cases: Array<{ kind: TriggerType; event: Parameters<typeof triggerMatches>[1] }> = [
      { kind: "time", event: { type: "time", at: at0800 } },
      { kind: "app", event: { type: "app", at: 0, data: { appId: "clock", event: "open" } } },
      { kind: "wifi", event: { type: "wifi", at: 0, data: { ssid: "Home", connected: true } } },
      { kind: "battery", event: { type: "battery", at: 0, data: { levelPct: 10 } } },
    ];

    for (const { kind, event } of cases) {
      const entry = kindOf(kind);
      expect(entry?.unavailableReasonKey).toBeNull();
      expect(triggerMatches(triggerFrom(entry!), event)).toBe(true);
    }
  });

  it("电池默认（低于 20%）不会在电量充足时误触发", () => {
    const entry = kindOf("battery")!;
    expect(
      triggerMatches(triggerFrom(entry), { type: "battery", at: 0, data: { levelPct: 80 } }),
    ).toBe(false);
  });

  it("时间默认（每天 08:00）在别的分钟不触发", () => {
    const entry = kindOf("time")!;
    const at0801 = new Date(2026, 0, 5, 8, 1, 0).getTime();
    expect(triggerMatches(triggerFrom(entry), { type: "time", at: at0801 })).toBe(false);
  });
});

/**
 * devcare.test.ts — 设备照料视图层的纯函数与桥接包装契约（src/lib/devcare.ts，REQ-A396）。
 *
 * 覆盖：i18n 标签回退（未知 op/结果/类别诚实地回退而不是渲染原串）、careAreaSplit
 * 的观测/缺失二分、validateCleanRequest 的客户端守卫（空选择 / 未知类别 /
 * review 类别需确认）、内存用量换算，以及每个 devcare_* 包装器在未桥接时的
 * null 降级与有桥时的归一化落地。
 */
import { describe, test as it, expect, beforeEach, afterEach } from "bun:test";
import {
  JUNK_KINDS,
  CARE_AREAS,
  opLabelKey,
  outcomeLabelKey,
  junkKindLabelKey,
  areaLabelKey,
  severityLabelKey,
  resourceLabelKey,
  careAreaSplit,
  validateCleanRequest,
  memUsedBytes,
  memUsedPct,
  normalizeStatus,
  normalizeApps,
  normalizeMemory,
  normalizeBoost,
  normalizeTrail,
  normalizeReport,
  reportHasData,
  hhmm,
  devcareStatus,
  devcareScan,
  devcareStorage,
  devcareClean,
  devcareApps,
  devcareUninstall,
  devcarePermissions,
  devcareReport,
  devcareTrail,
  devcareMemory,
  devcareBoost,
} from "../devcare";
import type { ReportView } from "../devcare";

// 桥接缝：与 backend-bridge.test.ts 同款的假 __TAURI_INTERNALS__
let respond: (command: string, args?: Record<string, unknown>) => unknown = () => null;

function installBridge(): void {
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: Record<string, unknown>) => respond(command, args),
    },
  };
}

beforeEach(() => {
  installBridge();
  respond = () => null;
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("devcare i18n 标签回退", () => {
  it("未知键回退到专用 fallback，而不是渲染原串", () => {
    expect(opLabelKey("__nope__")).toBe("care.op.unknown");
    expect(outcomeLabelKey("__nope__")).toBe("care.outcome.unknown");
    expect(junkKindLabelKey("__nope__")).toBe("care.junk.unknown");
    expect(areaLabelKey("__nope__")).toBe("care.area.unknown");
    expect(severityLabelKey("__nope__")).toBe("care.severity.unknown");
    expect(resourceLabelKey("__nope__")).toBe("perm.cap.unknown");
  });

  it("已知键命中各自的 i18n 键", () => {
    expect(opLabelKey("scan")).toMatch(/^care\.op\./);
    expect(outcomeLabelKey("success")).toBe("care.outcome.success");
    expect(junkKindLabelKey(JUNK_KINDS[0]!)).toMatch(/^care\.junk\./);
    expect(areaLabelKey(CARE_AREAS[0]!)).toMatch(/^care\.area\./);
    expect(severityLabelKey("high")).toMatch(/^care\.severity\./);
    expect(resourceLabelKey("contacts")).toMatch(/^perm\.cap\./);
  });
});

describe("devcare 纯视图助手", () => {
  it("careAreaSplit：null 报告 → 全部缺失；部分评估 → 观测/缺失二分", () => {
    // `ReportView` 的真实形状：`assessed` 只是其中一个字段，构造器必须给全
    // （早先这里只写了 `{ assessed, generatedAt }` —— `generatedAt` 在类型里根本不存在）。
    const report = (assessed: string[]): ReportView => ({ score: 0, grade: "", findings: [], assessed });
    const none = careAreaSplit(null);
    expect(none.observed).toEqual([]);
    expect(none.missing).toEqual([...CARE_AREAS]);
    const some = careAreaSplit(report(CARE_AREAS.slice(0, 2)));
    expect(some.observed).toEqual(CARE_AREAS.slice(0, 2));
    expect(some.missing).toEqual(CARE_AREAS.slice(2));
    // 屏幕没建模的键被忽略，既不算观测也不算缺失
    const extra = careAreaSplit(report(["not-an-area"]));
    expect(extra.observed).toEqual([]);
    expect(extra.missing).toEqual([...CARE_AREAS]);
  });

  it("validateCleanRequest：空选择 / 未知类别 / review 需确认 / 合法放行", () => {
    expect(validateCleanRequest([], true)).toBe("care.err.noSelection");
    expect(validateCleanRequest(["__mystery__"], true)).toBe("care.err.unknownKind");
    expect(validateCleanRequest(["stale_download"], false)).toBe("care.err.needsReview");
    expect(validateCleanRequest(["stale_download"], true)).toBeNull();
    expect(validateCleanRequest([JUNK_KINDS[0]!], false)).toBeNull();
  });

  it("内存视图换算：null / 缺字段诚实返回 null，有值时算出用量", () => {
    expect(memUsedBytes(null)).toBeNull();
    expect(memUsedPct(null)).toBeNull();
    const m = normalizeMemory({ total_bytes: 1000, available_bytes: 250 });
    const used = memUsedBytes(m);
    expect(used).toBe(750);
    const pct = memUsedPct(m);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThanOrEqual(100);
  });

  it("报告/时间助手的基本契约", () => {
    expect(reportHasData(null)).toBe(false);
    expect(hhmm(0)).toBe(""); // 0 视为无效时间戳
    expect(hhmm(1700000000123)).toMatch(/\d{2}:\d{2}/);
    const r = normalizeReport({ sensitiveGrants: 2, reviewableApps: 3, assessed: ["storage"] });
    expect(typeof r).toBe("object");
  });
});

describe("devcare 归一化器对畸形输入的诚实性", () => {
  it("normalizeStatus/normalizeApps/normalizeMemory/normalizeBoost 对空对象给出安全视图", () => {
    expect(typeof normalizeStatus({})).toBe("object");
    expect(Array.isArray(normalizeApps(null))).toBe(true);
    expect(typeof normalizeMemory(null)).toBe("object");
    expect(typeof normalizeBoost({})).toBe("object");
    expect(typeof normalizeTrail(null)).toBe("object");
    // normalizeApps 不以 id 为硬身份：无 id 项保留（name 回退 id=""），字符串项被剔除
    expect(normalizeApps([{ id: "app.a", name: "A" }, "junk", { name: "no-id" }]).length).toBe(2);
  });
});

describe("devcare_* 桥接包装器", () => {
  const wrappers = [
    () => devcareStatus(),
    () => devcareScan(),
    () => devcareStorage(),
    () => devcareClean(["junk_cache"], true),
    () => devcareApps(),
    () => devcareUninstall("app.a"),
    () => devcarePermissions(),
    () => devcareReport(1, 2),
    () => devcareTrail(5),
    () => devcareMemory(),
    () => devcareBoost(),
  ] as const;

  it("假桥应答 null 时每个包装器都诚实返回 null", async () => {
    for (const w of wrappers) {
      expect(await w()).toBeNull();
    }
  });

  it("假桥应答空对象时归一化产出视图（或诚实拒绝），绝不抛错", async () => {
    respond = () => ({});
    for (const w of wrappers) {
      const out = await w();
      expect(out === null || typeof out === "object").toBe(true);
    }
  });
});


/**
 * devcare.test.ts — 设备照料视图层的纯函数与桥接包装契约（src/lib/devcare.ts，REQ-A396）。
 *
 * 覆盖：i18n 标签回退（未知 op/结果/类别诚实地回退而不是渲染原串）、careAreaSplit
 * 的观测/缺失二分、validateCleanRequest 的客户端守卫（空选择 / 未知类别 /
 * review 类别需确认）、内存用量换算，以及每个 devcare_* 包装器在未桥接时的
 * null 降级与有桥时的归一化落地。
 */
import { describe, test as it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import {
  JUNK_KINDS,
  SENSITIVE_RESOURCES,
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
  devcareStatusOutcome,
  devcareBackendName,
  printableBackend,
  normalizeScan,
  normalizeStorage,
} from "../devcare";
import type { ReportView, DevCareStatusView, ScanView } from "../devcare";

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
    expect(validateCleanRequest([], true, [])).toBe("care.err.noSelection");
    expect(validateCleanRequest(["__mystery__"], true, [])).toBe("care.err.unknownKind");
    expect(validateCleanRequest(["stale_download"], false, ["stale_download"])).toBe(
      "care.err.needsReview",
    );
    expect(validateCleanRequest(["stale_download"], true, ["stale_download"])).toBeNull();
    expect(validateCleanRequest([JUNK_KINDS[0]!], false, [])).toBeNull();
  });

  // REQ-A1409 ∕ F-SH-667：review-ness 取自**宿主**的 `review_kinds`，不是字面量。
  it("validateCleanRequest：需确认的那一类由宿主列表决定，而不是 stale_download 字面量", () => {
    // 宿主把另一类标为需确认 ⇒ 未确认即拒（字面量实现会放行）
    expect(validateCleanRequest(["crash_dump"], false, ["crash_dump"])).toBe(
      "care.err.needsReview",
    );
    // 宿主没有把它标为需确认 ⇒ 即使叫 stale_download 也放行（字面量实现会拒）
    expect(validateCleanRequest(["stale_download"], false, [])).toBeNull();
    // 只有被点名的那几类被门住
    expect(validateCleanRequest(["app_cache", "crash_dump"], false, ["crash_dump"])).toBe(
      "care.err.needsReview",
    );
    expect(validateCleanRequest(["app_cache"], false, ["crash_dump"])).toBeNull();
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

/**
 * REQ-A793 / F-DEV-097 —— 「读取失败」与「主机真的没有后端」必须分开。
 *
 * `devcareStatus()` 对两种情况都回答 `null`：命令**没落地**（无桥／守护进程不可达），
 * 以及（本函数的输入里）主机回答了但没有后端。屏幕过去把两者折成
 * `available = st?.available ?? false`，于是**读取失败**被渲染成主机那句诚实的
 * 「未连接 + 在真机运行，或设置 AMOS_DEVCARE_ROOT …」——一句关于设备的话，而那次读取
 * 什么也没确立；并且因为重扫按钮在 `{:else}` 分支里，失败态没有重试。
 */
describe("devcareStatusOutcome —— 读取失败 vs 诚实的「没有后端」", () => {
  const ok = (): DevCareStatusView => normalizeStatus({ available: false, backend: "none" });

  it("主机回答了（即使 available=false）就是「读到了」，不是失败", () => {
    const out = devcareStatusOutcome(ok(), { ok: false, kind: "not-bridged", command: "x" });
    // 读到的那次**不看** diag：主机说了话，它说的就是答案。
    expect(out.kind).toBe("read");
    if (out.kind === "read") expect(out.status.available).toBe(false);
  });

  it("null + 命令失败 → failed，并带上主机自己的话", () => {
    const out = devcareStatusOutcome(null, {
      ok: false,
      kind: "command-failed",
      command: "devcare_status",
      detail: { code: "amos.devocare.rpc_failed", message: "daemon unreachable" },
    });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.detail).toBe("daemon unreachable");
      // 机器码不得出现在给用户看的句子里（SpacesPanel::spacesErrorLabel 同规）。
      expect(out.detail).not.toContain("amos.devocare.rpc_failed");
    }
  });

  it("null + 只有机器码 / 无桥 → failed 但没有话可说（而不是编一句）", () => {
    const onlyCode = devcareStatusOutcome(null, {
      ok: false,
      kind: "command-failed",
      command: "devcare_status",
      detail: { code: "amos.devocare.rpc_failed" },
    });
    expect(onlyCode).toEqual({ kind: "failed", detail: "" });
    const bridged = devcareStatusOutcome(null, {
      ok: false,
      kind: "not-bridged",
      command: "devcare_status",
    });
    expect(bridged).toEqual({ kind: "failed", detail: "" });
  });

  it("两种现实的折是不对称的：失败态永远不是 read", () => {
    // 关键断言：修前的 `st?.available ?? false` 让这两条路径产出**同一个** available。
    const failed = devcareStatusOutcome(null, {
      ok: false,
      kind: "command-failed",
      command: "devcare_status",
      detail: "boom",
    });
    const readNoBackend = devcareStatusOutcome(ok(), { ok: true });
    expect(failed.kind).toBe("failed");
    expect(readNoBackend.kind).toBe("read");
    expect(readNoBackend.kind === "read" && readNoBackend.status.available).toBe(false);
  });
});

describe("devcareBackendName —— 不为没跑过的扫描编一个后端名", () => {
  const status = normalizeStatus({ available: true, backend: "host-fs" });
  const scanOf = (backend: string): ScanView =>
    normalizeScan({ status: { ...status, backend }, report: {}, auto_kinds: [], review_kinds: [] })!;

  it("扫描没跑（null）时用状态里的名字，而不是硬编码 host-fs", () => {
    expect(devcareBackendName(status, null)).toBe("host-fs");
    expect(devcareBackendName(normalizeStatus({ backend: "android" }), null)).toBe("android");
  });

  it("扫描报告了自己的后端时以扫描为准", () => {
    expect(devcareBackendName(status, scanOf("android"))).toBe("android");
  });

  it("两侧都没有名字 → null（渲染成「未知」），绝不发明一个", () => {
    // 修前模板是 `scan?.status.backend ?? "host-fs"`：扫描失败 ⇒ scan=null ⇒ 这行
    // 断言设备正通过 host-fs 清理，而那次扫描从未发生。
    expect(devcareBackendName(null, null)).toBeNull();
    expect(devcareBackendName(normalizeStatus({}), null)).toBeNull();
  });

  it("线上的 `none` 是机器词，不算一个后端名", () => {
    expect(devcareBackendName(normalizeStatus({ available: false, backend: "none" }), null)).toBeNull();
  });
});

describe("printableBackend —— 一个字段、两处引用、同一条规则", () => {
  // `devcare_storage` 的 backend 与 status 的 backend 用的是同一个线上词表（无后端
  // = `none`，且缺字段也会被 normalize 成 `none`）。存储卡片曾经原样打印它，于是
  // 「none」作为机器码出现在用户面前；这条规则只写一次，谁引用谁就跟着走。
  it("有名字就给名字", () => {
    expect(printableBackend("host-fs")).toBe("host-fs");
    expect(printableBackend("android")).toBe("android");
  });

  it("`none` / 空串 / 缺失都读作「没有名字」", () => {
    expect(printableBackend("none")).toBeNull();
    expect(printableBackend("")).toBeNull();
    expect(printableBackend(null)).toBeNull();
    expect(printableBackend(undefined)).toBeNull();
  });

  it("存储载荷缺 backend 时归一化成 `none` —— 于是确实落在这条规则上", () => {
    // 无后端时 Rust 侧发的是 BACKEND_NONE = "none"；字段整个缺失时归一化也补 `none`。
    // 两种情况都必须由这条规则拦住，否则同一个机器词会在存储卡片上被打印出来。
    const s = normalizeStorage({ measured: false })!;
    expect(s.backend).toBe("none");
    expect(printableBackend(s.backend)).toBeNull();
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
    () => devcareReport(1),
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


// REQ-A1009：把 devcare.ts 声明的四个 Rust 枚举镜像（JunkKind / SensitiveResource /
// CareArea / Severity）绑定到权威 `crates/amos-devocare/src/spec.rs`，而不是同文件里
// 手打的数组。四处消费点都带「未知即诚实回退」的兜底（`?? "care.…unknown"`），
// 故一处漂移会渲染成 "unknown" 而看起来正常——与 F-SH-234／F-SH-254 同族。
// 尤其 `careAreaSplit` 只按 CARE_AREAS 二分：Rust 若新增一个 CareArea 变体，
// 该变体会**既不算已观测也不算缺失**（被静默忽略），一份残缺报告于是渲染成
// 一个不带任何提示的自信评级——正是该模块文档警告的 aerospace P0-3。
describe("devcare.ts enum mirrors == amos-devocare/src/spec.rs (four snake_case enums)", () => {
  const spec = readFileSync(new URL("../../../../../amos-devocare/src/spec.rs", import.meta.url), "utf8");
  const ts = readFileSync(new URL("../devcare.ts", import.meta.url), "utf8");

  /** `AppCache` → `app_cache`, the `#[serde(rename_all = "snake_case")]` spelling. */
  const snake = (v: string) => v.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

  function rustVariants(name: string): string[] {
    const at = spec.indexOf(`pub enum ${name} {`);
    expect(at, `pub enum ${name} not found in spec.rs`).toBeGreaterThan(0);
    const attrs = spec.slice(spec.lastIndexOf("\n}", at) + 1, at);
    expect(attrs, `${name} must be #[serde(rename_all = "snake_case")]`).toContain('rename_all = "snake_case"');
    const body = spec.slice(at, spec.indexOf("\n}", at));
    return [...body.matchAll(/^ {4}([A-Z]\w*),/gm)].map((m) => snake(m[1] ?? ""));
  }

  // The imported bindings ARE the contract the screen consumes — assert those,
  // not a re-parse of the source text.
  const mirrors: ReadonlyArray<[string, string, readonly string[]]> = [
    ["JunkKind", "JUNK_KINDS", JUNK_KINDS],
    ["SensitiveResource", "SENSITIVE_RESOURCES", SENSITIVE_RESOURCES],
    ["CareArea", "CARE_AREAS", CARE_AREAS],
  ];

  it("每个被镜像的标签数组 == 其 Rust 枚举的 snake_case 变体集合", () => {
    for (const [rustName, tsName, tsArr] of mirrors) {
      const rust = rustVariants(rustName);
      expect(rust.length, `${rustName} parsed no variants`).toBeGreaterThan(0);
      expect([...tsArr].sort(), `${tsName} vs ${rustName}`).toEqual([...rust].sort());
    }
  });

  it("SeverityKey 联合类型 == Rust `Severity` 枚举（它是类型不是数组）", () => {
    const rust = rustVariants("Severity");
    expect(rust.length).toBeGreaterThan(0);
    const at = ts.indexOf("export type SeverityKey = ");
    expect(at).toBeGreaterThan(0);
    const union = ts.slice(at, ts.indexOf(";", at));
    const keyed = [...union.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1] ?? "");
    expect(keyed.sort(), "SeverityKey vs Severity").toEqual([...rust].sort());
  });

  it("CARE_AREAS 保持 careAreaSplit 依赖的域顺序（不只是集合相等）", () => {
    expect([...CARE_AREAS] as string[]).toEqual(rustVariants("CareArea"));
  });
});

/**
 * enterprise-audit-restore.test.ts — 一次「从备份恢复」**不能把审计查看器弄坏**。
 *
 * `AUDIT_LOGS_KEY` 是 `SYNC_STORES` 的一员（`lib/cloud.ts`），而 `restoreStores`
 * 把备份里的值**原样**写回每一个键 —— 逐个键都不做形状检查。所以「恢复」是一条
 * 合法通路，能把任意形状塞进这个键；同一类缺陷此前在四个别的键上修过
 * （REQ-A1422 ∕ F-SH-680），那一轮枚举的四个键里**没有审计日志**。
 *
 * 这里钉两件事，两件都从同一条通路（`restoreStores` → `writeStoreValueChecked`
 * → `loadLogs`）走：
 *
 *  ① 值不是数组时，读者要**看得见**（「没有日志」），而不是把整个查看器抛死；
 *  ② 值是数组（还原后本来就是这个形状）时，那些行要**真的读回来**，不能悄悄丢。
 *
 * 负对照：把 `loadLogs` 换回 `JSON.parse(raw) as AuditLog[]`，
 * 「不是数组」那条会以 `this.logs.filter is not a function` 红，
 * 「数组」那条会以「恢复成功但一行都没有」红。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { AuditLogger, AUDIT_LOGS_KEY } from "../enterprise/audit";
import { restoreStores } from "../cloud";
import { readStoreValue, writeStoreValueChecked } from "../amosStore";

// 存储是 `window.localStorage`：没有 DOM 时读写一律失败，用例断言的会是「存储坏了」
// 而不是被测逻辑（与 `enterprise.test.ts` 同一理由、同一写法）。
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

/**
 * One archived row, in the shape every reader assumes (`filterLogs` / `query`).
 *
 * `timestamp` is a *recent* time on purpose: `bootstrap()` runs
 * `cleanupExpiredLogs()`, which drops `synced` rows older than `retentionDays`
 * (90). A hardcoded epoch would be swept as expired and the assertions below
 * would read "the reader dropped the rows" instead of "the reader found none".
 */
function row(id: string, ageMs = 0) {
  return {
    id,
    timestamp: Date.now() - ageMs,
    level: "info",
    userId: "user-1",
    userName: "User",
    deviceId: "device-1",
    organizationId: "org-1",
    eventType: "shortcut_create",
    eventCategory: "management",
    eventDescription: id,
    actionDetails: {},
    result: "success",
    metadata: { tags: [] },
    synced: true,
  };
}

/**
 * Restore exactly one key through the real restore path, and **prove the value
 * landed** — otherwise a test could pass because the write was refused rather than
 * because the reader coped (the failure mode the `toEqual(undefined)` pitfall
 * describes).
 */
function restoreAuditLogs(value: unknown): void {
  const report = restoreStores(
    { v: 1, at: 1, stores: { [AUDIT_LOGS_KEY]: value } },
    (k, v) => writeStoreValueChecked(k, v),
  );
  expect(report.ok).toBe(true);
  expect(report.restored).toContain(AUDIT_LOGS_KEY);
}

describe("恢复备份里的审计日志", () => {
  let live: AuditLogger[] = [];

  beforeEach(() => {
    window.localStorage.clear();
    live = [];
  });

  afterEach(async () => {
    // 每个实例都起来了一只刷新定时器，收尾时停掉（lifetime 判据）。
    for (const l of live) await l.shutdown();
  });

  /** A logger that has booted against the current store contents. */
  function boot(): AuditLogger {
    const l = new AuditLogger();
    live.push(l);
    return l;
  }

  test("值不是数组时读者看得见「没有日志」，而不是把查看器抛死", async () => {
    // 备份里这个键是一段 **JSON 字符串**（不是数组）。`readStoreValue` 解过一次，
    // 旧代码又 `JSON.parse` 一次 —— `"{}"` 于是变成对象、`"5"` 变成数字，
    // `bootstrap()` 的 `cleanupExpiredLogs`（`this.logs.filter`）当场抛。
    // `AuditLogViewer` 在 `$derived` 里调 `getStatistics`，渲染即抛 ⇒ 查看器打不开。
    restoreAuditLogs("{}");

    const l = boot();
    expect(() => l.getStatistics({})).not.toThrow();
    expect(l.getStatistics({}).totalLogs).toBe(0);
    expect(l.query({})).toHaveLength(0);
  });

  test("值是一个数字时同样只是「没有日志」", async () => {
    restoreAuditLogs(5);

    const l = boot();
    expect(() => l.query({})).not.toThrow();
    expect(l.query({})).toHaveLength(0);
  });

  test("还原后的数组行真的读得回来 —— 「恢复成功」不能等于「日志全没了」", async () => {
    // 这是恢复之后本该出现的形状：一个**真正的**行数组。旧代码把
    // `JSON.parse(数组)` 变成 `JSON.parse("[object Object]")`，抛掉之后静默 `[]`：
    // 界面说恢复成功，历史却空了。
    restoreAuditLogs([row("audit-b"), row("audit-a", 1000)]);

    const l = boot();
    const got = l.query({});
    expect(got.map((r) => r.id)).toEqual(["audit-b", "audit-a"]);
    expect(l.getStatistics({}).totalLogs).toBe(2);
  });

  test("混在数组里的非对象行被丢掉，同批的好行不受牵连", async () => {
    restoreAuditLogs([null, 7, row("audit-keep")]);

    const l = boot();
    expect(l.query({}).map((r) => r.id)).toEqual(["audit-keep"]);
  });

  test("正面控制：本类自己写下的存档（双重编码的字符串）照旧读得回来", async () => {
    const writer = boot();
    await writer.log({
      eventType: "shortcut_create",
      eventCategory: "management",
      eventDescription: "写进存档的一行",
      result: "success",
    });
    await writer.flushBuffer();
    // 确认盘上真的是「字符串套数组」那种双重编码 —— 这条格式是 `saveLogs` 写出来的，
    // 收口必须同时认它，否则修好恢复通路会把正常启动读档弄坏。
    expect(typeof readStoreValue(AUDIT_LOGS_KEY, "")).toBe("string");

    expect(boot().query({}).map((r) => r.eventDescription)).toEqual(["写进存档的一行"]);
  });
});

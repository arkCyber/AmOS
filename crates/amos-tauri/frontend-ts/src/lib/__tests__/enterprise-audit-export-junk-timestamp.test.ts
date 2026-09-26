/**
 * enterprise-audit-export-junk-timestamp.test.ts — 一行「没有可用时刻」的日志**不能把 CSV 导出整个抛死**。
 *
 * `AUDIT_LOGS_KEY` 是 `SYNC_STORES` 的一员，`restoreStores` 把备份里的值**原样**写回，
 * 逐个键都不做形状检查（同 `enterprise-audit-restore.test.ts` 的那条通路）。读者那道
 * 收口 `normalizeAuditLogs` 只认「是个对象」——**它不检查 `timestamp`**，这是有意的：
 * 它要救回的是「恢复后本该读得回来的行」。
 *
 * 但导出这条支路把 `timestamp` 当成了**一定合法**的日期：
 * `new Date(log.timestamp).toISOString()`（`audit.ts` 的 CSV 分支）。`toISOString()`
 * 在 Invalid Date 上抛 `RangeError: Invalid time value`，而 Invalid Date 有五种来法：
 *
 *   * 字段缺失（备份里 `undefined` 被 `JSON.stringify` 丢掉 ⇒ 行成了 `{ … }`）；
 *   * 字符串（`"not-a-date"`）；
 *   * `NaN` / `±Infinity`；
 *   * 超范围毫秒数（`1e20`，上限 ±8.64e15）；
 *   * `null` 之外的一切非数字。
 *
 * 于是「恢复成功」之后，审计查看器里的「导出 CSV」按钮点下去**整份导出**都抛异常 ——
 * 一份审计凭据直接导不出来。而**同一个方法的 JSON 分支**（`JSON.stringify`）不会抛、
 * 照样把这一行写出去；查看器自己画时间戳的 `formatTimestamp`（`toLocaleString`）也不抛、
 * 画成「Invalid Date」。三处里只有 CSV 这一处把「不合法日期」升级成了「整份导出失败」。
 *
 * 这里钉两件事：
 *  ① 一条时刻不可用的行**不再让 CSV 导出抛异常**，那一格留空（「没有记录到时刻」），
 *     而不是伪造一个 1970 时刻；
 *  ② 它**不被丢出导出** —— JSON 分支照旧带着它（正面控制），所以「删掉这行来避抛」
 *     那种修法过不了。
 *
 * 负对照：把 `csvTimestamp` 换回 `new Date(log.timestamp).toISOString()`，
 * 用例①以 `RangeError: Invalid time value` 红。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { AuditLogger, AUDIT_LOGS_KEY } from "../enterprise/audit";
import { restoreStores } from "../cloud";
import { writeStoreValueChecked } from "../amosStore";

// 存储是 `window.localStorage`：没有 DOM 时读写一律失败（与 `enterprise-audit-restore.test.ts`
// 同一理由、同一写法）。
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

/** A row with every field the CSV columns read, and a **deliberately chosen** `timestamp`. */
function row(id: string, timestamp: unknown, hasTimestamp = true): Record<string, unknown> {
  const r: Record<string, unknown> = {
    id,
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
  if (hasTimestamp) r.timestamp = timestamp;
  return r;
}

/**
 * Restore exactly one key through the real restore path, and **prove the value landed** —
 * otherwise the assertions could pass because the write was refused, not because the reader
 * coped.
 */
function restoreAuditLogs(value: unknown): void {
  const report = restoreStores(
    { v: 1, at: 1, stores: { [AUDIT_LOGS_KEY]: value } },
    (k, v) => writeStoreValueChecked(k, v),
  );
  expect(report.ok).toBe(true);
  expect(report.restored).toContain(AUDIT_LOGS_KEY);
}

/** The first (timestamp) cell of each CSV data line, in file order. */
function csvTimestampCells(csv: string): string[] {
  return csv
    .split("\n")
    .slice(1) // drop the header line
    .map((line) => line.slice(0, line.indexOf(",")));
}

describe("审计 CSV 导出：一行时刻不可用不能把整份导出抛死（REQ-A1552）", () => {
  let live: AuditLogger[] = [];

  beforeEach(() => {
    window.localStorage.clear();
    live = [];
  });

  afterEach(async () => {
    for (const l of live) await l.shutdown();
  });

  function boot(): AuditLogger {
    const l = new AuditLogger();
    live.push(l);
    return l;
  }

  test("缺字段 / 字符串 / 超范围三种坏时刻，CSV 导出照常返回，格子里留空", async () => {
    const good = Date.now();
    restoreAuditLogs([
      row("no-ts", undefined, false), // 备份 JSON 里字段被丢掉
      row("bad-ts", "not-a-date"),
      row("huge-ts", 1e20),
      row("good-ts", good),
    ]);

    const l = boot();
    // 修前：new Date(undefined).toISOString() 抛 RangeError，整份导出失败。
    const csv = await l.exportLogs({}, "csv");

    const cells = csvTimestampCells(csv);
    expect(cells).toHaveLength(4);
    // 三格没有可用时刻 —— 留空，不是伪造的 1970 时刻。
    expect(cells.filter((c) => c === "")).toHaveLength(3);
    // 那一行好数据照旧格式化成 ISO，且这一格恰好是它的。
    expect(cells).toContain(new Date(good).toISOString());
  });

  test("坏时刻的行**不被丢出导出** —— JSON 分支照旧带着它（正面控制）", async () => {
    restoreAuditLogs([row("no-ts", undefined, false), row("good-ts", Date.now())]);

    const l = boot();
    const json = await l.exportLogs({}, "json");
    const parsed = JSON.parse(json) as Array<{ id: string }>;
    // 修法若是「把坏行丢掉来避抛」，这条会红。
    expect(parsed.map((r) => r.id).sort()).toEqual(["good-ts", "no-ts"]);
    // 且 JSON 分支从来不会因为坏时刻抛 —— 它就是这个缺陷旁边的对照支路。
    const csv = await l.exportLogs({}, "csv");
    expect(csv.split("\n")).toHaveLength(3); // 表头 + 两行
  });

  test("正面控制：全是合法时刻时，CSV 的时间列逐格等于 ISO 串", async () => {
    const t1 = Date.parse("2026-09-25T08:00:00.000Z");
    const t2 = Date.parse("2026-09-24T08:00:00.000Z");
    restoreAuditLogs([row("b", t1), row("a", t2)]);

    const l = boot();
    const csv = await l.exportLogs({}, "csv");
    // 默认按 timestamp 倒序 ⇒ t1 在前。
    expect(csvTimestampCells(csv)).toEqual([
      new Date(t1).toISOString(),
      new Date(t2).toISOString(),
    ]);
  });
});

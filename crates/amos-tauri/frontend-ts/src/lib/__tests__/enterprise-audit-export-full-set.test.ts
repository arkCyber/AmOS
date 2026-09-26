/**
 * 审计导出必须写出**整个匹配集**，不是 `query()` 的默认 100 条那一页（REQ-A1514 ∕ F-SH-759）。
 *
 * 修前逐字：`src/lib/enterprise/audit.ts::exportLogs` 的第一行是
 * `const logs = this.query(query);`，而 `query()` 的末尾是
 * `const limit = params.limit || 100;` / `return results.slice(offset, offset + limit);`。
 * 查看器从不传 `limit`，于是「导出」按钮写出的 JSON ∕ CSV 里只有**最新的 100 条**，
 * 其余行被静默丢掉 —— 一份审计凭据少了东西，屏幕上却没有任何一句话提到它。
 *
 * 判据：同一份 `query` 的三个消费者里，统计（`getStatistics`）数的是**整个匹配集**
 * （它上方的 `filterLogs` 注释自己写着「Statistics must aggregate the *whole* matching set
 * while the reader caps what it draws」），只有导出偷偷走上了分页那条路。
 * 修法：把「排序后的匹配集」提成 `matchedSorted()`，`query()` 在它之上切一页，
 * `exportLogs()` 直接取整份。
 */
import { describe, test as it, expect, beforeEach, afterEach } from "bun:test";
import { auditLogger } from "../enterprise/audit";

/** 越过 `query()` 的默认上限（100）。 */
const TOTAL = 105;

beforeEach(() => {
  auditLogger.clearAllLogs();
  auditLogger.updateConfig({ bufferSize: 1000 });
});

afterEach(() => {
  auditLogger.clearAllLogs();
});

async function seed(n: number, eventType: "shortcut_execute" | "system_start" = "shortcut_execute"): Promise<void> {
  for (let i = 0; i < n; i++) {
    await auditLogger.log({
      eventType,
      eventCategory: eventType === "system_start" ? "system" : "execution",
      eventDescription: `第 ${i} 条`,
      result: "success",
    });
  }
  await auditLogger.flushBuffer();
}

describe("REQ-A1514 — 审计导出写出整个匹配集", () => {
  it("JSON 导出含全部匹配行，不止默认的一页", async () => {
    await seed(TOTAL);

    // 正控：匹配集本身就是 105 条 —— 统计与导出必须同集。
    expect(auditLogger.getStatistics({}).totalLogs).toBe(TOTAL);

    const parsed = JSON.parse(await auditLogger.exportLogs({}, "json"));
    expect(parsed).toHaveLength(TOTAL);
  });

  it("CSV 导出含全部匹配行（表头 + 105 行）", async () => {
    await seed(TOTAL);

    const csv = await auditLogger.exportLogs({}, "csv");
    expect(csv.split("\n")).toHaveLength(TOTAL + 1);
  });

  it("带筛选的导出同样是整个匹配集，没有被 100 条上限截断", async () => {
    await seed(TOTAL, "shortcut_execute");
    await seed(10, "system_start");

    // 「执行」类有 105 条（>100），「系统」类 10 条 —— 筛选后导出必须是 105。
    const parsed = JSON.parse(
      await auditLogger.exportLogs({ eventCategories: ["execution"] }, "json"),
    );
    expect(parsed).toHaveLength(TOTAL);
  });

  it("正控 · `query()` 自己仍然分页（重构不许把读者的分页弄丢）", async () => {
    await seed(TOTAL);

    // 修法只把排序之后的**切片**留给 `query()`；这两条钉住分页契约还在。
    expect(auditLogger.query({}).length).toBe(100);
    expect(auditLogger.query({ limit: 2, offset: 0 }).length).toBe(2);
    expect(auditLogger.query({ limit: 2, offset: 2 }).length).toBe(2);
    expect(auditLogger.query({ limit: 100, offset: 100 }).length).toBe(TOTAL - 100);
  });
});

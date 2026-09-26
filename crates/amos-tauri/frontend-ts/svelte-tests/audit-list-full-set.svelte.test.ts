/**
 * AuditLogViewer — 列表 ∕ 统计卡 ∕ 筛选候选项必须描述**同一个匹配集**（REQ-A1514 / FMEA F-SH-759）。
 *
 * 修前逐字：`AuditLogViewer.svelte::loadLogs` 是 `logs = auditLogger.query(query);`，而
 * `query()` 末尾的 `const limit = params.limit || 100;` 把结果切成 100 条。于是匹配集
 * 一旦超过 100：
 *   列表标题 → 日志列表 (100)  （数的是被截断的那一页）
 *   统计卡   → 总计 105        （数的却是整个匹配集 —— 它上方的注释自己写着这个契约）
 *   筛选下拉 → 只从这 100 条里取候选项，于是**只出现在第 101 条之后**的用户 ∕ 事件类型
 *              在界面上根本筛不到。
 * 同一个屏幕，同一份数据，三个和。判据：统计卡在数整个集合，列表却只画一页，且没有任何
 * 「还有 N 条」的说明 —— 一个**静默**的上限。
 *
 * 测试注记：日志的时间戳来自 `Date.now()`，而排序是按时间倒序，所以这里把 `Date` 冻住并
 * 逐条推进，让「哪几条落在第 101 条之后」是确定的 —— 最早播种的 5 条用一个别处没有的
 * 事件类型 `system_start`，它们正是修前被上限丢掉的那批。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AuditLogViewer from "../src/svelte/modules/AuditLogViewer.svelte";
import { auditLogger } from "../src/lib/enterprise/audit";
import { zh } from "../src/i18n/locales/zh";

const TOTAL = 105; // 越过 `query()` 的默认 100 条上限
const BASE = new Date("2026-09-25T10:00:00Z").getTime();

beforeEach(() => {
  // 只冻 `Date`：组件里的 `setInterval`（自动刷新）仍走真定时器，不干扰 tick。
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE);
  auditLogger.clearAllLogs();
  auditLogger.updateConfig({ bufferSize: 1000 });
});

afterEach(() => {
  cleanup();
  auditLogger.clearAllLogs();
  window.localStorage.clear();
  vi.useRealTimers();
});

/** 105 条日志，时间戳逐秒递增；最早的 5 条事件类型是别处没有的 `system_start`。 */
async function seed(): Promise<void> {
  for (let i = 0; i < TOTAL; i++) {
    vi.setSystemTime(BASE + i * 1000);
    const early = i < 5;
    await auditLogger.log({
      eventType: early ? "system_start" : "shortcut_execute",
      eventCategory: early ? "system" : "execution",
      eventDescription: `第 ${i} 条`,
      result: "success",
    });
  }
  await auditLogger.flushBuffer();
  // 「现在」落在全部日志之后 1 秒 —— 105 条都在组件的默认 24 小时窗内。
  vi.setSystemTime(BASE + TOTAL * 1000 + 1000);
}

function statOf(container: HTMLElement, label: string): string {
  const item = [...container.querySelectorAll(".stat-item")].find(
    (el) => el.querySelector(".stat-label")?.textContent?.trim() === label,
  );
  return item?.querySelector(".stat-value")?.textContent?.trim() ?? "";
}

function listTitle(container: HTMLElement): string {
  return container.querySelector(".logs-header .section-title")?.textContent?.trim() ?? "";
}

function eventTypeOptions(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLOptionElement>("#filter-event-type option")].map(
    (o) => o.value,
  );
}

describe("REQ-A1514 — 审计列表画整个匹配集，不是默认的一页", () => {
  test("列表标题数整个匹配集（与统计卡同集），被上限丢掉的行不再隐形", async () => {
    await seed();
    const { container } = render(AuditLogViewer);
    await tick();
    await tick();

    // 正控：统计卡一直在数整个匹配集。
    expect(statOf(container, zh["audit.statTotal"])).toBe(String(TOTAL));

    // 修前这里是「日志列表 (100)」—— 统计卡写 105、列表标题写 100，同一个屏幕两个和。
    expect(listTitle(container)).toBe(zh["audit.listTitle"].replace("{count}", String(TOTAL)));
  });

  test("只出现在第 101 条之后的事件类型，筛选下拉里筛得到", async () => {
    await seed();
    const { container } = render(AuditLogViewer);
    await tick();
    await tick();

    // 修前候选项只从被截断的 100 条里取 ⇒ `system_start` 不在菜单里，用户无法按它筛。
    expect(eventTypeOptions(container)).toContain("system_start");
  });
});

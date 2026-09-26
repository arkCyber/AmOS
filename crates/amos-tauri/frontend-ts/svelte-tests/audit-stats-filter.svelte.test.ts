/**
 * AuditLogViewer — 统计概览必须描述**列表正在显示的那个集合**（REQ-A1495 / FMEA F-SH-736）。
 *
 * 修前逐字：`auditLogger.getStatistics(query.startTime, query.endTime)` —— 统计卡只收时间窗，
 * 而它正下方的列表收整个 `query`（`auditLogger.query(query)`），导出也收整个 `query`
 * （`auditLogger.exportLogs(query, format)`）。于是把「结果」筛成「失败」之后：
 *   列表标题 → 日志列表 (1)，只剩失败行；
 *   统计卡   → 总计 2 · 成功 1（列表刚刚剔除掉的那一行）· 失败 1。
 * 同一个屏幕、同一份数据，两个和。判据就是那三个消费者里的**兄弟**：列表与导出都传整个对象，
 * 只有统计传了两个数字。修法：`getStatistics` 收 `AuditLogQuery`，与 `query()` ∕ `exportLogs()`
 * 共用同一条 `filterLogs()`。
 *
 * 测试注记：这里的筛选器是 `<select bind:value={resultFilter} onchange={applyFilters}>`，
 * 而 Svelte 5 的 `bind_select_value` 靠 `select.querySelector(':checked')` 取值 —— jsdom 没有实现
 * option 的 `:checked`（连一个手搭的 `<select>` 都选不中），于是绑定会退回第一个 option（空值）。
 * `selectOption()` 因此只在**这一次调用**上把该 select 的 `querySelector` 顶替掉，让真实的
 * `bind_select_value` 路径读到我们指定的 option；浏览器里的行为不受影响。
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AuditLogViewer from "../src/svelte/modules/AuditLogViewer.svelte";
import { auditLogger } from "../src/lib/enterprise/audit";
import { zh } from "../src/i18n/locales/zh";

afterEach(() => {
  cleanup();
  auditLogger.clearAllLogs();
  window.localStorage.clear();
});

/** 一条「执行」类日志；`result` 决定它落在统计卡的哪一格。 */
async function seedOne(desc: string, result: "success" | "failure", id: string): Promise<void> {
  await auditLogger.log({
    eventType: "shortcut_execute",
    eventCategory: "execution",
    eventDescription: desc,
    result,
    resourceType: "shortcut",
    resourceId: id,
    resourceName: id,
    tags: ["exec"],
  });
}

/** 造出 1 成功 ∕ 2 失败，全部落在组件的默认 24 小时窗内。 */
async function seed(): Promise<void> {
  await seedOne("执行成功的一条", "success", "ok");
  await seedOne("执行失败的一条", "failure", "bad-1");
  await seedOne("执行失败的另一条", "failure", "bad-2");
}

/** 统计卡某一格的数字：按它自己的标签认（`总计` ∕ `成功` ∕ `失败` …），不看位置。 */
function statOf(container: HTMLElement, label: string): string {
  const item = [...container.querySelectorAll(".stat-item")].find(
    (el) => el.querySelector(".stat-label")?.textContent?.trim() === label,
  );
  return item?.querySelector(".stat-value")?.textContent?.trim() ?? "";
}

/** 列表标题里的条数 —— `audit.listTitle` 是「日志列表 ({count})」。 */
function listTitle(container: HTMLElement): string {
  return container.querySelector(".logs-header .section-title")?.textContent?.trim() ?? "";
}

/**
 * 把某个筛选器拨到某个值。`bind:value` 走 `':checked'`，jsdom 未实现（见文件头注记），
 * 所以这一次调用把这枚 select 的 `querySelector` 顶替成「返回我们指定的 option」。
 */
async function pick(container: HTMLElement, id: string, value: string): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>(id);
  expect(select).toBeTruthy();
  const option = [...select!.options].find((o) => (o as unknown as { __value: string }).__value === value);
  expect(option).toBeTruthy();
  const orig = select!.querySelector.bind(select);
  (select as unknown as { querySelector: (q: string) => Element | null }).querySelector = (q: string) =>
    q === ":checked" ? option : orig(q);
  await fireEvent.change(select!);
  await tick();
  await tick();
}

describe("REQ-A1495 — 统计概览与列表读同一份查询", () => {
  test("正控 · 不筛选：统计卡的总计与列表标题一致", async () => {
    await seed();
    const { container } = render(AuditLogViewer);
    await tick();
    await tick();
    expect(statOf(container, zh["audit.statTotal"])).toBe("3");
    expect(statOf(container, zh["audit.statSuccess"])).toBe("1");
    expect(statOf(container, zh["audit.statFailure"])).toBe("2");
    expect(listTitle(container)).toBe(zh["audit.listTitle"].replace("{count}", "3"));
  });

  test("结果筛成「失败」：统计卡跟着列表走，不再印时间窗里的成功数", async () => {
    await seed();
    const { container } = render(AuditLogViewer);
    await tick();
    await tick();
    await pick(container, "#filter-result", "failure");

    // 列表已经只剩失败行……
    expect(listTitle(container)).toBe(zh["audit.listTitle"].replace("{count}", "2"));
    // ……所以统计卡必须描述这两行：总计 2、失败 2，而**成功是 0**（不是那个被筛掉的 1）。
    expect(statOf(container, zh["audit.statTotal"])).toBe("2");
    expect(statOf(container, zh["audit.statFailure"])).toBe("2");
    expect(statOf(container, zh["audit.statSuccess"])).toBe("0");
  });

  test("筛成一条都没有的结果：列表是空态，统计卡也不许再说有", async () => {
    await seed();
    const { container } = render(AuditLogViewer);
    await tick();
    await tick();
    // 「阻止」在种子里一条都没有 —— 列表空态，统计卡的四格必须全是 0。
    await pick(container, "#filter-result", "blocked");
    expect(container.textContent ?? "").toContain(zh["audit.emptyTitle"]);
    expect(listTitle(container)).toBe(zh["audit.listTitle"].replace("{count}", "0"));
    expect(statOf(container, zh["audit.statTotal"])).toBe("0");
    expect(statOf(container, zh["audit.statSuccess"])).toBe("0");
    expect(statOf(container, zh["audit.statFailure"])).toBe("0");
    expect(statOf(container, zh["audit.statWarning"])).toBe("0");
    expect(statOf(container, zh["audit.statBlocked"])).toBe("0");
  });
});

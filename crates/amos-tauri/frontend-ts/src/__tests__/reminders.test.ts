import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIST_ID,
  addList,
  addReminder,
  complete,
  completedOf,
  counts,
  formatDueAt,
  isOverdueNow,
  isPastDue,
  normalizeLists,
  normalizeReminders,
  pendingOf,
  removeList,
  removeReminder,
  remindersInSmart,
  seedLists,
  seedReminders,
  searchReminders,
  startOfDay,
  toggleComplete,
  uncomplete,
  DAY_MS,
  type Reminder,
} from "../lib/reminders";

const NOW = new Date(2026, 8, 4, 14, 0, 0, 0).getTime(); // 2026-09-04 14:00
const TODAY = startOfDay(NOW);
const r = (over: Partial<Reminder>): Reminder => ({
  id: "x1",
  title: "默认",
  listId: DEFAULT_LIST_ID,
  priority: 0,
  flagged: false,
  createdAt: NOW,
  ...over,
});

describe("reminders domain", () => {
  test("seeds give a sane default list set + a few reminders", () => {
    const lists = seedLists(NOW);
    expect(lists.some((l) => l.id === DEFAULT_LIST_ID && !l.custom)).toBe(true);
    const all = seedReminders(NOW);
    expect(all.length).toBeGreaterThan(0);
    const c = counts(all, NOW);
    // exactly one completed in the seed; the rest pending.
    expect(c.completed).toBe(1);
    expect(c.total).toBe(all.length - 1);
    expect(c.scheduled).toBeGreaterThanOrEqual(4);
    expect(c.flagged).toBe(1);
  });

  test("smart-view membership reflects today/scheduled/flagged/completed", () => {
    const list: Reminder[] = [
      r({ id: "a", title: "今天截止", dueAt: TODAY + 20 * 3_600_000 }),
      r({ id: "b", title: "明天", dueAt: TODAY + DAY_MS }),
      r({ id: "c", title: "已逾期", dueAt: TODAY - DAY_MS, priority: 3 }),
      r({ id: "d", title: "旗标", flagged: true }),
      r({ id: "e", title: "无排期" }),
      r({ id: "f", title: "已完成", completed: true, completedAt: NOW }),
    ];
    expect(remindersInSmart(list, "today", NOW).map((x) => x.id).sort()).toEqual(["a", "c"]);
    expect(remindersInSmart(list, "scheduled", NOW).map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
    expect(remindersInSmart(list, "flagged", NOW).map((x) => x.id)).toEqual(["d"]);
    expect(remindersInSmart(list, "completed", NOW).map((x) => x.id)).toEqual(["f"]);
    expect(remindersInSmart(list, "all", NOW).length).toBe(5); // pending only
    // 'today' surfaces the overdue one first (sorted by dueAt ascending).
    expect(remindersInSmart(list, "today", NOW)[0]!.id).toBe("c");
  });
  test("counts tally pending vs completed and overdue/badge buckets", () => {
    const list: Reminder[] = [
      r({ id: "a", title: "今天", dueAt: TODAY + 20 * 3_600_000 }), // 20:00 — later than NOW
      r({ id: "b", title: "错过", dueAt: TODAY - DAY_MS }), // reached/overdue
      r({ id: "c", title: "done", completed: true, completedAt: NOW }),
    ];
    const c = counts(list, NOW);
    expect(c.total).toBe(2);
    expect(c.today).toBe(2); // today due + earlier/overdue
    expect(c.completed).toBe(1);
    expect(c.scheduled).toBe(2);
    expect(c.due).toBe(1); // only the reached/overdue one
  });

  test("add / complete / uncomplete / toggle / remove", () => {
    let list: Reminder[] = [];
    list = addReminder(list, { title: "  新事项  ", listId: DEFAULT_LIST_ID, priority: 1, flagged: true }, NOW);
    expect(list).toHaveLength(1);
    const id = list[0]!.id;
    expect(list[0]!.title).toBe("新事项"); // trimmed? — trimmed by UI commit, lib keeps as-is
    expect(pendingOf(list, DEFAULT_LIST_ID)).toHaveLength(1);
    expect(completedOf(list, DEFAULT_LIST_ID)).toHaveLength(0);

    list = complete(list, id, NOW + 1);
    expect(completedOf(list, DEFAULT_LIST_ID)).toHaveLength(1);
    list = uncomplete(list, id);
    expect(completedOf(list, DEFAULT_LIST_ID)).toHaveLength(0);

    list = toggleComplete(list, id, NOW + 2);
    expect(completedOf(list, DEFAULT_LIST_ID)).toHaveLength(1);
    list = toggleComplete(list, id, NOW + 3); // back to pending
    expect(completedOf(list, DEFAULT_LIST_ID)).toHaveLength(0);

    list = removeReminder(list, id);
    expect(list).toHaveLength(0);
  });

  test("due helpers distinguish reached vs not-yet", () => {
    const past = r({ id: "a", dueAt: NOW - 1000 });
    expect(isOverdueNow(past, NOW)).toBe(true);
    const later = r({ id: "b", dueAt: NOW + 3_600_000 });
    expect(isOverdueNow(later, NOW)).toBe(false);
    expect(isPastDue(later, NOW)).toBe(false);
    const doneOverdue = r({ id: "c", completed: true, completedAt: NOW, dueAt: NOW - DAY_MS });
    expect(isOverdueNow(doneOverdue, NOW)).toBe(false);
  });

  test("formatDueAt localizes today/tomorrow and honours all-day", () => {
    const w = { today: "今天", tomorrow: "明天", yesterday: "昨天" };
    expect(formatDueAt(TODAY + 10 * 3_600_000, false, NOW, w)).toBe("今天 10:00");
    expect(formatDueAt(TODAY + 10 * 3_600_000, true, NOW, w)).toBe("今天");
    expect(formatDueAt(TODAY + DAY_MS + 3_600_000, true, NOW, w)).toBe("明天");
  });

  test("list management creates + removes custom lists", () => {
    const lists = seedLists(NOW);
    const added = addList(lists, { name: " 出差 ", color: "red" }, NOW + 1);
    expect(added).toHaveLength(lists.length + 1);
    const list = added.find((l) => l.name === "出差");
    expect(list?.color).toBe("red");
    const removed = removeList(added, list!.id);
    expect(removed).toHaveLength(lists.length);
    // addList refuses a blank name.
    expect(addList(lists, { name: "   ", color: "blue" }, NOW)).toBe(lists);
  });

  test("searchReminders filters title and notes case-insensitively", () => {
    const list: Reminder[] = [
      r({ id: "a", title: "买牛奶", notes: "晚点去超市" }),
      r({ id: "b", title: "整理会议纪要", notes: "关于咖啡机" }),
      r({ id: "c", title: "去健身" }),
    ];
    expect(searchReminders(list, "牛奶").map((x) => x.id)).toEqual(["a"]); // title hit
    expect(searchReminders(list, "咖啡").map((x) => x.id)).toEqual(["b"]); // notes hit
    expect(searchReminders(list, "MEETING").length).toBe(0); // case-insensitive, still no match
    expect(searchReminders(list, "   ").length).toBe(3); // blank query passes all
    expect(searchReminders(list, "zzz")).toEqual([]);
  });

  test("normalization tolerates malformed persisted rows", () => {
    const raw = [
      { title: "ok", createdAt: NOW },
      { title: "   ", id: "blank" },
      null,
      { title: "dup", id: "x" },
      { title: "dup2", id: "x" },
      42,
    ];
    const out = normalizeReminders(raw);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((x) => x.id)).size).toBe(3);
    expect(out.every((x) => x.listId === DEFAULT_LIST_ID)).toBe(true);
    expect(out.every((x) => x.priority === 0)).toBe(true);
    // lists: drop nameless custom, keep built-in inbox even when unnamed.
    const lists = normalizeLists([
      { id: DEFAULT_LIST_ID, custom: false },
      { id: "zz", custom: true, name: "" },
    ]);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.id).toBe(DEFAULT_LIST_ID);
  });
});

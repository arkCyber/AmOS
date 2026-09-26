/**
 * focusSchedule.test.ts — REQ-A684 · 专注日程的纯内核 + 结构性负控。
 *
 * Why this file exists:
 *   * `lib/focusSchedule.ts` is the **only** place a scheduled Do-Not-Disturb window is
 *     decided. A shell that re-derived "is a window running" would drift from it.
 *   * The dangerous half is **ownership**: a schedule that blindly wrote `dnd = desired`
 *     would clobber a DND the user set by hand, and would strand a scheduled DND on
 *     after its window. `advanceDnd` is that state machine, and it is pinned here.
 *   * The engine may only ever touch the **one real DND bit** — the structural tests read
 *     the source to prove the UI edits *intent* and the watcher (not the UI) flips the bit.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  FOCUS_AUTO_KEY,
  FOCUS_SCHEDULE_KEY,
  activeScenario,
  advanceDnd,
  dayOfWeek,
  defaultSchedule,
  formatMinutes,
  minutesOfDay,
  normalizeFocusAuto,
  normalizeSchedule,
  parseMinutes,
  windowContains,
  type FocusWindow,
} from "../focusSchedule";

const here = import.meta.dir;
const readSrc = (rel: string) => readFileSync(`${here}/${rel}`, "utf8");

const win = (p: Partial<FocusWindow>): FocusWindow => ({
  days: [1],
  start: 600,
  end: 720,
  enabled: true,
  ...p,
});

describe("focusSchedule · 词表与常量", () => {
  test("两个 store key 各只声明一次", () => {
    expect(FOCUS_SCHEDULE_KEY).toBe("amos.focus.schedule");
    expect(FOCUS_AUTO_KEY).toBe("amos.focus.auto");
  });

  test("默认日程两个场景都关着（不替用户静音）", () => {
    const d = defaultSchedule();
    expect(d.work.enabled).toBe(false);
    expect(d.sleep.enabled).toBe(false);
  });
});

describe("focusSchedule · normalizeSchedule（损坏守卫）", () => {
  test("非对象 ⇒ 默认日程", () => {
    expect(normalizeSchedule(null)).toEqual(defaultSchedule());
    expect(normalizeSchedule([])).toEqual(defaultSchedule());
    expect(normalizeSchedule("x")).toEqual(defaultSchedule());
  });

  test("合法行被保留：星期去重/排序，enabled 只认 true", () => {
    const s = normalizeSchedule({
      work: { days: [2, 1, 1, 9, -1], start: 600, end: 1200, enabled: true },
    });
    expect(s.work).toEqual({ days: [1, 2], start: 600, end: 1200, enabled: true });
    // 未提供的场景保持默认
    expect(s.sleep).toEqual(defaultSchedule().sleep);
  });

  test("enabled 不是 true（含 1/缺失）⇒ 视为关", () => {
    expect(normalizeSchedule({ work: { days: [1], start: 0, end: 60, enabled: 1 } }).work.enabled).toBe(
      false,
    );
    expect(normalizeSchedule({ work: { days: [1], start: 0, end: 60 } }).work.enabled).toBe(false);
  });

  test("时间越界/非整数 ⇒ 该场景回默认（不猜、不夹）", () => {
    const def = defaultSchedule().work;
    expect(normalizeSchedule({ work: { days: [1], start: 1500, end: 60, enabled: true } }).work).toEqual(def);
    expect(normalizeSchedule({ work: { days: [1], start: 60.5, end: 120, enabled: true } }).work).toEqual(def);
    expect(normalizeSchedule({ work: { days: [1], start: 0, end: -1, enabled: true } }).work).toEqual(def);
  });

  test("days 非数组 ⇒ 该场景回默认", () => {
    expect(normalizeSchedule({ work: { days: "mon", start: 0, end: 60, enabled: true } }).work).toEqual(
      defaultSchedule().work,
    );
  });
});

describe("focusSchedule · windowContains（含跨午夜）", () => {
  test("同日窗口半开区间 [start, end)", () => {
    const w = win({ days: [1], start: 600, end: 720 });
    expect(windowContains(w, 1, 600)).toBe(true);
    expect(windowContains(w, 1, 719)).toBe(true);
    expect(windowContains(w, 1, 720)).toBe(false);
    expect(windowContains(w, 2, 660)).toBe(false);
  });

  test("关着的窗口从不生效", () => {
    expect(windowContains(win({ enabled: false }), 1, 660)).toBe(false);
  });

  test("零长度（start === end）是空窗口 —— 绝不读成整天", () => {
    expect(windowContains(win({ start: 600, end: 600 }), 1, 600)).toBe(false);
    expect(windowContains(win({ start: 600, end: 600 }), 1, 700)).toBe(false);
  });

  test("没有星期 ⇒ 从不生效", () => {
    expect(windowContains(win({ days: [] }), 1, 660)).toBe(false);
  });

  test("跨午夜：同日尾段 + 次日头段", () => {
    const w = win({ days: [1], start: 1320, end: 420 }); // 周一 22:00 → 周二 07:00
    expect(windowContains(w, 1, 1320)).toBe(true);
    expect(windowContains(w, 1, 1439)).toBe(true);
    expect(windowContains(w, 2, 0)).toBe(true); // 次日（周二）头段
    expect(windowContains(w, 2, 419)).toBe(true);
    expect(windowContains(w, 2, 420)).toBe(false);
    expect(windowContains(w, 3, 0)).toBe(false); // 周三不属于周一开的窗口
    expect(windowContains(w, 1, 1000)).toBe(false); // 周一下午不在窗口里
  });
});

describe("focusSchedule · activeScenario（重叠取最近开始）", () => {
  const none = defaultSchedule();

  test("都不生效 ⇒ null", () => {
    expect(activeScenario(none, 1, 660)).toBeNull();
  });

  test("唯一生效的场景被选出", () => {
    const s = normalizeSchedule({ sleep: { days: [1], start: 0, end: 1439, enabled: true } });
    expect(activeScenario(s, 1, 660)).toBe("sleep");
  });

  test("重叠时取开始更晚的那个", () => {
    const s = normalizeSchedule({
      work: { days: [1], start: 480, end: 1200, enabled: true }, // 08:00–20:00
      sleep: { days: [1], start: 660, end: 720, enabled: true }, // 11:00–12:00
    });
    // 11:30：work 已跑 210 分钟，sleep 才 30 分钟 ⇒ 最近开始的 sleep 赢
    expect(activeScenario(s, 1, 690)).toBe("sleep");
    // 10:00：只有 work 在跑
    expect(activeScenario(s, 1, 600)).toBe("work");
  });
});

describe("focusSchedule · advanceDnd（所有权状态机）", () => {
  const owned = { auto: true };
  const manual = { auto: false };

  test("窗口内 ⇒ 开，且声明所有权", () => {
    expect(advanceDnd(true, false, manual)).toEqual({ dnd: true, auto: { auto: true } });
    expect(advanceDnd(true, true, manual)).toEqual({ dnd: true, auto: { auto: true } });
  });

  test("窗口外 + 日程所有 ⇒ 关（释放）", () => {
    expect(advanceDnd(false, true, owned)).toEqual({ dnd: false, auto: { auto: false } });
  });

  test("窗口外 + 用户自己开 ⇒ 绝不动它", () => {
    expect(advanceDnd(false, true, manual)).toEqual({ dnd: true, auto: { auto: false } });
  });

  test("窗口外 + 本来就关 ⇒ 保持关", () => {
    expect(advanceDnd(false, false, manual)).toEqual({ dnd: false, auto: { auto: false } });
    expect(advanceDnd(false, false, owned)).toEqual({ dnd: false, auto: { auto: false } });
  });
});

describe("focusSchedule · normalizeFocusAuto", () => {
  test("只有 auto === true 才算拥有", () => {
    expect(normalizeFocusAuto({ auto: true })).toEqual({ auto: true });
    expect(normalizeFocusAuto({ auto: 1 })).toEqual({ auto: false });
    expect(normalizeFocusAuto(null)).toEqual({ auto: false });
    expect(normalizeFocusAuto("yes")).toEqual({ auto: false });
  });
});

describe("focusSchedule · 时间工具", () => {
  test("minutesOfDay / dayOfWeek 从传入的 Date 读（纯）", () => {
    expect(minutesOfDay(new Date(2024, 0, 1, 9, 30))).toBe(570);
    expect(dayOfWeek(new Date(2024, 0, 7))).toBe(0); // 2024-01-07 是周日
    expect(dayOfWeek(new Date(2024, 0, 8))).toBe(1);
  });

  test("formatMinutes 夹进一天；parseMinutes 只认 HH:MM", () => {
    expect(formatMinutes(570)).toBe("09:30");
    expect(formatMinutes(1440)).toBe("23:59");
    expect(formatMinutes(-5)).toBe("00:00");
    expect(parseMinutes("09:30")).toBe(570);
    expect(parseMinutes("23:59")).toBe(1439);
    expect(parseMinutes("24:00")).toBeNull();
    expect(parseMinutes("9:5")).toBeNull();
    expect(parseMinutes("abc")).toBeNull();
  });
});

describe("focusSchedule · 结构性负控（谁有权改 DND）", () => {
  test("全天只有一个 DND 开关：watcher 只经 SETTINGS_KEY 写，不自造 DND key", () => {
    const watcher = readSrc("../../svelte/osFocusWatcher.ts");
    expect(watcher.includes("SETTINGS_KEY")).toBe(true);
    expect(watcher.includes("dndActive")).toBe(true);
    // 不得出现任何自造的 store key 字面量（键全部来自 lib 常量）
    expect(/"amos\./.test(watcher)).toBe(false);
    // 不得直接写通知列表来"静音"（没有第二条静音路径）
    expect(watcher.includes("NOTIF_KEY")).toBe(false);
  });

  test("设置页只编辑意图（schedule key），不自己翻 DND bit", () => {
    const ui = readSrc("../../svelte/settings/FocusSchedule.svelte");
    expect(ui.includes("FOCUS_SCHEDULE_KEY")).toBe(true);
    expect(ui.includes("SETTINGS_KEY")).toBe(false);
    expect(ui.includes("dnd")).toBe(false);
  });

  test("壳里只有一处启动专注日程 watcher", () => {
    const shell = readSrc("../../svelte/Shell.svelte");
    expect(shell.includes("startFocusWatcher")).toBe(true);
  });
});

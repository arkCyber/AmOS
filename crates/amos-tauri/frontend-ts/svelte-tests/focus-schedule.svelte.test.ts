/**
 * focus-schedule.svelte.test.ts — REQ-A684 · runtime coverage for the automatic DND
 * schedule.
 *
 * The pure kernel (windowContains / activeScenario / advanceDnd) is unit-tested in
 * `src/lib/__tests__/focusSchedule.test.ts`. What this file pins is the **runtime**:
 *
 *   • `osFocusWatcher` actually writes the one real DND bit (`amos.settings.dnd`) — on
 *     inside a window, off after it, and it **never** clobbers a DND the user set by
 *     hand;
 *   • the watcher reacts to a schedule edit without waiting for the next tick, and
 *     `stop()` really clears the interval + the store listener;
 *   • the Settings editor (`FocusSchedule.svelte`) edits *intent* only — it writes the
 *     schedule key and never touches the DND bit itself.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import FocusSchedule from "../src/svelte/settings/FocusSchedule.svelte";
import { focusWatcherTick, startFocusWatcher } from "../src/svelte/osFocusWatcher";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { SETTINGS_KEY, dndActive, normalizeQuick } from "../src/lib/settings";
import {
  FOCUS_AUTO_KEY,
  FOCUS_SCHEDULE_KEY,
  normalizeFocusAuto,
  type FocusWindow,
} from "../src/lib/focusSchedule";
import { controlByName } from "./a11y-name";

const readDnd = () => dndActive(normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {})));
const readAuto = () => normalizeFocusAuto(readStoreValue<unknown>(FOCUS_AUTO_KEY, {}));

/** Monday 2024-01-08 — a day the sample windows below start on. */
const MON = (h: number, m = 0) => new Date(2024, 0, 8, h, m);

/** One enabled window in the store (the shape `normalizeSchedule` accepts). */
const putWindow = (w: Partial<FocusWindow>) =>
  writeStoreValue(FOCUS_SCHEDULE_KEY, {
    work: { days: [1], start: 540, end: 660, enabled: true, ...w },
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MON(10, 0));
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("osFocusWatcher — 到点翻那唯一的 DND bit", () => {
  test("窗口内 ⇒ DND 开，且日程声明所有权", () => {
    putWindow({ start: 540, end: 660 }); // 09:00–11:00
    expect(focusWatcherTick(MON(10, 0))).toBe(true);
    expect(readDnd()).toBe(true);
    expect(readAuto()).toEqual({ auto: true });
  });

  test("窗口结束后 ⇒ 释放日程自己开的 DND", () => {
    putWindow({ start: 540, end: 660 });
    focusWatcherTick(MON(10, 0)); // owns it
    expect(focusWatcherTick(MON(12, 0))).toBe(true); // past end
    expect(readDnd()).toBe(false);
    expect(readAuto()).toEqual({ auto: false });
  });

  test("用户自己开的 DND，窗口外绝不被关掉", () => {
    writeStoreValue(SETTINGS_KEY, { dnd: true }); // manual DND, no schedule active
    expect(focusWatcherTick(MON(10, 0))).toBe(true);
    expect(readDnd()).toBe(true); // untouched
    expect(readAuto()).toEqual({ auto: false }); // and not claimed
  });

  test("startFocusWatcher 即时响应日程编辑（不等下一次 tick）", async () => {
    const stop = startFocusWatcher();
    expect(readDnd()).toBe(false); // default schedule is off — nothing silenced
    putWindow({ start: 540, end: 660 }); // an edit now fires the store event
    await tick();
    expect(readDnd()).toBe(true);
    stop();
  });

  test("stop() 清掉定时器 + 监听：之后既不 tick 也不响事件", async () => {
    putWindow({ start: 540, end: 660 });
    const stop = startFocusWatcher();
    expect(readDnd()).toBe(true);
    stop();
    // Turn it off by hand. If the interval or the listener survived, a tick would
    // see the window still active and force it back on.
    writeStoreValue(SETTINGS_KEY, { dnd: false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(readDnd()).toBe(false);
  });
});

describe("FocusSchedule.svelte — 只编辑意图，不自己翻 bit", () => {
  const switchByLabel = (el: HTMLElement, aria: string) =>
    controlByName<HTMLButtonElement>(el, '[role="switch"]', aria);

  test("默认两场景都关：无星期/时间控件，store 不被写动", () => {
    const { container } = render(FocusSchedule);
    expect(container.querySelectorAll('input[type="time"]').length).toBe(0);
    expect(readStoreValue<unknown>(FOCUS_SCHEDULE_KEY, null)).toBeNull();
  });

  test("打开某场景只是写日程键 —— 绝不碰 DND bit", async () => {
    const { container } = render(FocusSchedule);
    const sw = switchByLabel(container, "工作自动勿扰时段");
    expect(sw).toBeTruthy();
    await fireEvent.click(sw);
    await tick();
    const sched = readStoreValue<Record<string, FocusWindow>>(FOCUS_SCHEDULE_KEY, {});
    expect(sched.work.enabled).toBe(true);
    expect(readStoreValue<unknown>(SETTINGS_KEY, null)).toBeNull(); // no DND write
    // Enabling reveals the day chips + time inputs.
    expect(container.querySelectorAll('input[type="time"]').length).toBe(2);
  });

  test("切换星期写进 days（去重排序由内核守卫）", async () => {
    writeStoreValue(FOCUS_SCHEDULE_KEY, {
      work: { days: [1, 2, 3, 4, 5], start: 540, end: 660, enabled: true },
    });
    const { container } = render(FocusSchedule);
    // "三" is Wednesday (day 3) and starts pressed.
    const wed = container.querySelector('button[aria-pressed="true"][aria-label$="三"]');
    expect(wed).toBeTruthy();
    await fireEvent.click(wed as HTMLButtonElement);
    await tick();
    const sched = readStoreValue<Record<string, FocusWindow>>(FOCUS_SCHEDULE_KEY, {});
    expect(sched.work.days).toEqual([1, 2, 4, 5]);
  });

  test("当前落在窗口里时给出「正在生效」读数", () => {
    writeStoreValue(FOCUS_SCHEDULE_KEY, {
      work: { days: [1], start: 540, end: 660, enabled: true }, // Mon 09:00–11:00
    });
    vi.setSystemTime(MON(10, 0));
    const { container } = render(FocusSchedule);
    const hint = container.querySelector('[data-testid="focus-schedule-hint"]');
    expect(hint?.textContent).toContain("正在生效");
    expect(hint?.textContent).toContain("工作");
  });
});

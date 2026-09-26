/**
 * HealthApp.svelte — 「今日步数」 的读数来自**历史**里今天那一条，而不是「实时累计计数器可读」。
 *
 * `todaySteps` 修前逐字：
 *
 *   `latest && latest.steps_total !== null ? (history.days.find((d) => d.day === todayKey)?.steps ?? null) : null`
 *
 * 它要画的那个数来自 `history`（`ReadHealthState` 读回的那张表），却先过了一道关于
 * **实时计数器**的闸：`latest.steps_total !== null` 问的是「设备的累计步数计数器这次可读吗」。
 * 两件事不是一回事 —— 宿主答了 `sensor_host_snapshot` 但 `steps_total` 为 `null`（缺权限、
 * 平台上没有计步器），或**根本没有宿主**（桌面壳 + 一份被同步/备份恢复回来的历史）时，闸就落下，
 * 于是标题印「—」，而**同一屏**的七日条按 `history` 直接画着今天那根柱、`title` 里就是那个真值
 * —— 一天两个答案，正是 REQ-A1454 修掉的那一对的**镜像**（那次是「没有行却印 0」，这次是
 * 「有行却印无读数」）。闸要问的问题就是它下一句已经问的：今天有没有记录。
 *
 * 下面四条是判别对：宿主答不出计数器 ⇒ 仍报历史里的真值；没有宿主 ⇒ 同理；
 * **正控** 没有记录 ⇒ 仍是「—」（不得退化成有行没行都印数）；有记录且计数器可读 ⇒ 照常。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import HealthApp from "../src/svelte/HealthApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { dayKey, HEALTH_HISTORY_KEY, type HealthState } from "../src/lib/health";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const settle = () => new Promise((r) => setTimeout(r, 30));

/** A host that answers the sensor snapshot with `vitals` (`null` ⇒ no wellness block). */
function installBridge(vitals: unknown) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => (cmd === "sensor_host_snapshot" ? { vitals } : null),
    listen: async () => () => {},
  };
}

/** The value printed under the tile whose label is `label` (the big number's div). */
function tileValue(container: HTMLElement, label: string): string | null {
  const labelEl = [...container.querySelectorAll("div")].find(
    (d) => d.children.length === 0 && (d.textContent ?? "").trim() === label,
  );
  return labelEl?.nextElementSibling?.textContent?.trim() ?? null;
}

const STEPS_TODAY = zh["health.stepsToday"];
const NO_READING = zh["health.noReading"];

/** A history whose only row is today's, at `steps`. */
function seedToday(steps: number): void {
  const state: HealthState = {
    days: [{ day: dayKey(Date.now()), steps, steps_recorded: true, hr_min: null, hr_max: null }],
    workouts: [],
  };
  writeStoreValue(HEALTH_HISTORY_KEY, state);
}

describe("HealthApp.svelte — 「今日步数」 读历史，不读计数器的可读性 (REQ-A1555)", () => {
  test("宿主答了快照但没答步数计数器 ⇒ 仍报历史里今天那一条", async () => {
    seedToday(512);
    // The host *answers*, with a heart rate but no step counter — so the "no sensor" banner
    // is not the case, and the live counter is simply not a source for this figure.
    installBridge({ timestamp_ms: Date.now(), steps_total: null, heart_rate_bpm: 72 });
    const h = render(HealthApp);
    await settle();

    expect(h.container.textContent).not.toContain(zh["health.noSensor"]);
    expect(tileValue(h.container, STEPS_TODAY)).toBe("512");
  });

  test("完全没有宿主 ⇒ 同一屏的七日条画着今天，标题也必须报同一个值", async () => {
    seedToday(512);
    const h = render(HealthApp);
    await settle();

    // The strip draws today's bar from the same `history` row; the title carries the figure.
    const titles = [...h.container.querySelectorAll<HTMLElement>("[title]")].map((el) => el.title);
    expect(titles.some((tt) => tt.endsWith(": 512"))).toBe(true);
    expect(tileValue(h.container, STEPS_TODAY)).toBe("512");
  });

  test("今天没有记录 ⇒ 仍是「—」，不得退化成有行没行都印数（对照）", async () => {
    installBridge({ timestamp_ms: Date.now(), steps_total: 5000, heart_rate_bpm: null });
    const h = render(HealthApp);
    await settle();

    expect(tileValue(h.container, STEPS_TODAY)).toBe("—");
    expect(h.container.textContent).toContain(NO_READING);
  });

  test("有记录且计数器可读 ⇒ 照常报历史里的值（对照）", async () => {
    seedToday(120);
    installBridge({ timestamp_ms: Date.now(), steps_total: 1234, heart_rate_bpm: null });
    const h = render(HealthApp);
    await settle();

    expect(tileValue(h.container, STEPS_TODAY)).toBe("120");
  });
});

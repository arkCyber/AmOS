/**
 * measure-store-load-order.svelte.test.ts — 打开 Measure 之前先**写**了一次盘。
 *
 * REQ-A1407 ∕ FMEA F-SH-665。核实如下（对工作树，逐字）：
 *
 *   • 修前 `MeasureApp.svelte:31-32` 逐字
 *     `let settings = $state<MeasureSettings>(defaultMeasureSettings()); let history = $state<Measurement[]>([]);`
 *     —— 状态先以**初始值**（默认设置 + 空历史）诞生。
 *   • 修前 `:59-70` 的 `onMount(async () => { settings = normalizeMeasureSettings(await readStoreValue(MEASURE_SETTINGS_KEY, {})); history = normalizeMeasureHistory(await readStoreValue(MEASURE_HISTORY_KEY, [])); … })`
 *     —— 真正的读在**异步**回调里，而且第一句就 `await`。
 *   • 而 `:73-80` 两个 `$effect` 逐字 `writeStoreValue(MEASURE_SETTINGS_KEY, settings)` ∕
 *     `writeStoreValue(MEASURE_HISTORY_KEY, history)`。
 *   • `onMount` 本身就是一枚 effect（Svelte 5 里它就是 `user_effect`），且在两个 `$effect` **之前**创建，
 *     于是同一次 mount flush 里先跑它 —— 它一 `await` 就挂起，flush 继续跑两个 persist effect，
 *     把**初始值**写进存储；等到异步体恢复，`readStoreValue` 读到的是**自己刚写下的** `[]`。
 *   • 实测（临时探针，已删）：种下一条历史后 `render()` **同步**返回时盘上已是 `[]`
 *     （同一刻 `settings` 也被写成默认值），下一个 tick 恢复后 `settings` 被写回
 *     （因为它的读表达式在 clobber **之前**同步求值，值已被捕获），
 *     `history` 则永远停在 `[]` —— 也就是**每次打开这个应用都会抹掉用户的量测历史**。
 *
 * 修法：两份持久状态都改成**声明处同步读**（与 CompassApp ∕ MagnifierApp ∕ WeatherApp 同一形状），
 * `onMount` 只剩「等 DOM、开相机」。这样 persist effect 写出的永远是读回来的真实值。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MeasureApp from "../src/svelte/MeasureApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { formatDistance } from "../src/lib/measure";
import type { Measurement } from "../src/lib/measure";
import { zh } from "../src/i18n/locales/zh";

const SETTINGS_KEY = "amos.measure.settings";
const HISTORY_KEY = "amos.measure.history";

const zhLabel = (key: string): string => zh[key as keyof typeof zh] ?? key;

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
});

afterEach(() => {
  cleanup();
  setLocale("zh");
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

/** A stored measurement the loader must keep (`normalizeMeasureHistory`'s required shape). */
const MEASURED: Measurement = {
  id: "m1",
  start: { x: 0.1, y: 0.1 },
  end: { x: 0.9, y: 0.9 },
  distance: 1.234,
  timestamp: 1700000000000,
};

const STORED_SETTINGS = { unit: "imperial", referenceDistance: 0.42, showGuides: false };

function seedStore(): void {
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify([MEASURED]));
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(STORED_SETTINGS));
}

const storedHistory = (): string | null => window.localStorage.getItem(HISTORY_KEY);
const storedSettings = (): string | null => window.localStorage.getItem(SETTINGS_KEY);

/** A real `MediaStream` so `stopCamera`'s `getTracks()` works on unmount. */
function makeStream(): MediaStream {
  const s = new MediaStream();
  (s as unknown as { getTracks: () => Array<{ stop: () => void }> }).getTracks = () => [
    { stop: () => {} },
  ];
  return s;
}

function setupMedia(): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve(makeStream()) },
  });
}

/** Let the async camera chain and the effects flush. */
async function settle(): Promise<void> {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
}

describe("Measure 打开时的装载顺序 —— 读必须发生在写之前（REQ-A1407 ∕ F-SH-665）", () => {
  test("盘上已存的量测历史必须**原封不动**地活过这次打开", async () => {
    setupMedia();
    seedStore();
    render(MeasureApp);
    await settle();

    // 修前：mount 的 persist effect 把初始值 `[]` 写了上去，随后异步体读回这个 `[]`，
    // 于是用户的历史被永久抹掉。
    expect(storedHistory()).toBe(JSON.stringify([MEASURED]));
  });

  test("已存的设置也不得**哪怕一瞬间**被重置成默认值", async () => {
    setupMedia();
    seedStore();
    render(MeasureApp);

    // 同步读 —— mount flush 已经在 `render()` 内跑完，这正是 persist effect 写下初始值的那一刻。
    // 修前这里读到的逐字是 `{"unit":"metric","referenceDistance":1000,"showGuides":true}`。
    expect(storedSettings()).toBe(JSON.stringify(STORED_SETTINGS));
  });

  test("对照：历史那一页画得出还原回来的那一条", async () => {
    setupMedia();
    seedStore();
    const { container } = render(MeasureApp);
    await settle();

    const historyTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((b) =>
      (b.textContent ?? "").includes(zhLabel("measure.history")),
    );
    expect(historyTab).toBeTruthy();
    await fireEvent.click(historyTab!);
    await tick();

    // 修前：`history` 是 `[]`，这一页只剩空态文案。
    // 单位取**还原回来的**那一份存储设置（imperial）—— 它同时钉住了「设置也没被重置」。
    expect(container.textContent).not.toContain(zhLabel("measure.noHistory"));
    expect(container.textContent).toContain(formatDistance(MEASURED.distance, "imperial"));
  });

  test("守卫：全新安装仍然落下一份可用的默认设置", async () => {
    setupMedia();
    render(MeasureApp);
    await settle();

    // 装载不写 ≠ 不写 —— 空存储上仍然要留下归一化后的默认值（否则「修法」可以
    // 简单地把两个 persist effect 删掉，而那是另一个缺陷）。
    expect(storedSettings()).toBe(
      JSON.stringify({ unit: "metric", referenceDistance: 1000, showGuides: true }),
    );
    expect(storedHistory()).toBe("[]");
  });
});

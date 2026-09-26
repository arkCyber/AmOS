/**
 * nc-brightness-refusal.svelte.test.ts — 手机通知中心那一枚亮度滑杆的写入判决。
 *
 * REQ-A1368 ∕ F-SH-632 swept the family "a store-authoritative flip must not be adopted
 * before the store says the write landed", and its own table lists the leaf
 * `ControlCenter.setBrightnessPct / amos.brightness / DesktopShell (the dim overlay)`.
 * The sweep's search face was the **desktop** panel and the settings pages — it never
 * asked who else writes `amos.brightness`, and the phone's quick-settings sheet does:
 * `NotificationCenter.svelte::setBrightnessPct` wrote the key with the **void**
 * `writeStoreValue` and only then moved its own `brightnessPct`. The readout under the
 * slider (`[data-testid="nc-brightness-readout"]`) is that local copy, while the screen's
 * authoritative reader is the dim overlay Shell renders for the *non-desktop* branch off
 * the same key — so a refused write printed "40%" over a screen that never dimmed.
 *
 * The rule and the fix are written verbatim two files over, in `ControlCenter.svelte`
 * (「这一枚键的**权威读者是 `DesktopShell` 的降亮遮罩**……所以拒写时本地 `brightnessPct`
 * 必须原样不动」). Same key, same reader, same discipline — the other writer of it.
 *
 * The existing suite could not see it: `notification-center.svelte.test.ts`'s brightness
 * block only runs inside the landed world, where "stored" and "refused" are one shape.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationCenter from "../src/svelte/NotificationCenter.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { clearCellularRadio } from "../src/svelte/cellularRadio";
import { BRIGHTNESS_KEY } from "../src/lib/brightness";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  clearCellularRadio();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetPropsChannels();
  clearCellularRadio();
  window.localStorage.clear();
});

async function renderOpen(): Promise<HTMLElement> {
  propsChannel<{ open: boolean }>("nc").set({ open: true });
  const { container } = render(NotificationCenter);
  await tick();
  return container;
}

const slider = (c: HTMLElement) => c.querySelector('[data-testid="nc-brightness"]') as HTMLInputElement;
const readout = (c: HTMLElement) =>
  c.querySelector('[data-testid="nc-brightness-readout"]')?.textContent ?? "";
/** 共用 `StoreErrorBar` 的那一枚 testid（与这一族其余叶子同一个靶子）。 */
const refusal = (c: HTMLElement) => c.querySelector('[data-testid="store-write-error"]');

describe("NotificationCenter 亮度滑杆 — 拒写不得被当成降亮（REQ-A1368 漏掉的同键写入者）", () => {
  test("拒写：读数不动、盘上没有这一位、滑杆自己那一块给出拒绝", async () => {
    const c = await renderOpen();
    expect(readout(c)).toContain("100%");
    expect(refusal(c)).toBeNull();

    // 存储已满 / 不可用：`setItem` 抛错。读仍然工作，所以组件看到的是盘上**真实**内容，
    // 只有写入被拒 —— 与 `ControlCenter` 那一例同一条路径。
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    slider(c).value = "40";
    await fireEvent.input(slider(c));
    await tick();

    // 盘上一位也没有……
    expect(window.localStorage.getItem(BRIGHTNESS_KEY)).toBeNull();
    // ……所以滑杆与读数必须**原样**停在 100%：遮罩没有降亮，屏上就不能说它降了。
    expect(readout(c)).toContain("100%");
    // 不断言 `slider.value`：原生 `range` 的拇指会停在用户拖到的位置，直到下一次因别的
    // 原因重渲染 —— `brightnessPct` 没动，所以没有一次重渲染去覆盖那个属性。**读数才是
    // 页面的权威声明**，它没动；这条残留与 `ControlCenter` 那一处逐字同形（REQ-A1368）。
    expect(refusal(c)?.textContent).toContain(zh["common.storeWriteFailed"]);
  });

  test("落盘：读数跟着走、盘上写下 {pct}、没有拒绝", async () => {
    const c = await renderOpen();
    await fireEvent.input(slider(c), { target: { value: "40" } });
    await tick();

    expect(JSON.parse(window.localStorage.getItem(BRIGHTNESS_KEY) ?? "null")).toEqual({ pct: 40 });
    expect(readout(c)).toContain("40%");
    expect(refusal(c)).toBeNull();
  });
});

/**
 * REQ-A1382 / F-SH-645 — 被存储拒写的快速开关必须说话（控制中心 + 通知中心）。
 *
 * The quick tiles are the one control family in these two panels whose display is
 * **store-driven**: `on` reads `settings`, which is subscribed from `SETTINGS_KEY`. So a
 * refused `setItem` cannot produce a false reading — the tile simply does not move — and
 * that is exactly why it was easy to miss: the panel shows *nothing at all*. Meanwhile the
 * same panels speak for every other control: a platform-owned radio offers
 * `radio.openSettingsFailed` ∕ its refusal note, and the brightness slider two rows down
 * reports through `brightnessErr` + `StoreErrorBar` (`common.storeWriteFailed`). Only the
 * switches had `const persist = (next) => writeStoreValue(SETTINGS_KEY, next)` — the
 * verdict handed to `void`. The tap did nothing and said nothing.
 *
 * 与上一轮 `ai-save-refused.svelte.test.ts`（REQ-A1379）同族但**形状不同**：那一处是
 * 「写字没落地就先报成功 + 起副作用」，这一处是**本地压根没动、屏幕也对、就是一声不吭**。
 * 所以这里断言的「没有假读数」是本轮**故意保持**的性质（拒写时 `aria-pressed` 不动），
 * 而新增的是那一句话 —— 负控因此打在「那句话」上，不在开关上。
 *
 * 如实边界：①深色那一枚走同一条 `persist`，但它的可见结果由另一枚键（`amos-ui.theme`）
 * 立即决定，断言它需要翻转主题模块的单例，会给同文件其它用例留下状态，故**不单独断言**；
 * ②通知中心的通知行动词（清空 ∕ 单条删除 ∕ 标为已读）把 `NOTIF_KEY` 的裁决同样丢进
 * `void`，但那条路径已有自己的设备侧拒绝位（`pushNote` ∕ `nc-push-refused`），且它的
 * 说明文字是围绕「设备那一半才是破坏性的」写的 —— 属于另一轮，本轮不碰。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ControlCenter from "../src/svelte/ControlCenter.svelte";
import NotificationCenter from "../src/svelte/NotificationCenter.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { clearCellularRadio } from "../src/svelte/cellularRadio";
import { SETTINGS_KEY } from "../src/lib/settings";
import { t } from "../src/svelte/locale.svelte";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  clearCellularRadio();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetPropsChannels();
  clearCellularRadio();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** Every `localStorage.setItem` throws — a full or unavailable store, the real refusal path. */
const refuseWrites = () =>
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });

/** The shared refusal line (`StoreErrorBar`), or null. */
const refusal = (container: HTMLElement) =>
  container.querySelector('[data-testid="store-write-error"]');

const tileByIcon = (c: HTMLElement, dataIcon: string) =>
  [...c.querySelectorAll("button[aria-pressed]")].find((b) =>
    b.querySelector(`[data-icon="${dataIcon}"]`),
  ) as HTMLButtonElement | undefined;

async function renderNc() {
  propsChannel<{ open: boolean }>("nc").set({ open: true });
  const { container } = render(NotificationCenter);
  await settle();
  return container;
}

describe("REQ-A1382 — 被拒的快速开关不得一声不吭", () => {
  test("控制中心 · 勿扰：被拒的写入不移动开关，但把话说出来", async () => {
    const { container } = render(ControlCenter);
    await settle();
    const tile = () => container.querySelector<HTMLButtonElement>('[data-testid="cc-dnd"]')!;
    expect(tile().getAttribute("aria-pressed")).toBe("false");
    expect(refusal(container)).toBeNull();

    refuseWrites();
    await fireEvent.click(tile());
    await settle();

    // The store holds nothing, so the tile must stay exactly where it was (no false reading)…
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBeNull();
    expect(tile().getAttribute("aria-pressed")).toBe("false");
    // …and the tap must not be a silent no-op — the same line the slider in this panel uses.
    expect(refusal(container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("通知中心 · 勿扰：同一条纪律（同一个显示来源、同一句话）", async () => {
    const container = await renderNc();
    const tile = () => tileByIcon(container, "dnd")!;
    expect(tile().getAttribute("aria-pressed")).toBe("false");
    expect(refusal(container)).toBeNull();

    refuseWrites();
    await fireEvent.click(tile());
    await settle();

    expect(window.localStorage.getItem(SETTINGS_KEY)).toBeNull();
    expect(tile().getAttribute("aria-pressed")).toBe("false");
    expect(refusal(container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("通知中心 · 定位（默认开）：被拒时开关仍亮着，并说明为什么", async () => {
    const container = await renderNc();
    const tile = () => tileByIcon(container, "location")!;
    expect(tile().getAttribute("aria-pressed")).toBe("true"); // location defaults ON

    refuseWrites();
    await fireEvent.click(tile());
    await settle();

    expect(window.localStorage.getItem(SETTINGS_KEY)).toBeNull();
    // The master is still ON — nothing was turned off, and the screen must not pretend it was.
    expect(tile().getAttribute("aria-pressed")).toBe("true");
    expect(refusal(container)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("写落地的开关照常翻转，且拒写那一行随之消失（正控）", async () => {
    const { container } = render(ControlCenter);
    await settle();
    const tile = () => container.querySelector<HTMLButtonElement>('[data-testid="cc-dnd"]')!;

    vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(() => {
      throw new Error("QuotaExceededError");
    });
    await fireEvent.click(tile());
    await settle();
    expect(refusal(container)).not.toBeNull();

    await fireEvent.click(tile());
    await settle();

    expect(refusal(container)).toBeNull();
    expect(tile().getAttribute("aria-pressed")).toBe("true");
    expect(
      JSON.parse(window.localStorage.getItem(SETTINGS_KEY)!) as { dnd?: boolean },
    ).toMatchObject({ dnd: true });
  });
});

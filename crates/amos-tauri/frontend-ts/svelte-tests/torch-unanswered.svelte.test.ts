/**
 * REQ-A1463 / F-SH-715 — 桥接路径上的手电筒：两条命令都没回答时，那一下点击是**无声的空操作**。
 *
 * `toggleFlash` 的桥接支（`NotificationCenter.svelte`）先问 `flashlight_set`，拿到 `null`
 * 再退一步问 `flashlight_status`；两条都答 `null` 时函数就 `return` 了 —— 没写任何东西，
 * 也没说任何话。而 `flash` 这一枚读数**只由 store 驱动**（`flashStore.subscribe`），所以
 * 拒答时 tile 一动不动：一次被宿主拒掉的手电筒点击，与一枚坏按钮在像素上完全一样。
 *
 * 这是 F-SH-648（REQ-A1385）为**存储**路径点名的同一形状，隔壁一条缝：
 *  * 那轮把三处写入收进 `commitFlash`，只处理了 `writeStoreValueChecked` 变 `false` 的情形
 *    （`flashErr = common.storeWriteFailed`），F-SH-648 的缓解语也只写了这一支；
 *  * 宿主这一支（`invoke` 答 `null`，REQ-A296）从没被提起，同族的 `tapRotation` 桥接支
 *    却总会留下一句话（`rotationNote`），`commitFlash` 也早就拥有这一枚 tile 自己的错误槽
 *    （`flashErr`，渲染在 torch 正下方）。
 *
 * 修法：双 `null` 时把**已确立的事实**说出来 —— 命令发出去了、宿主没回答，状态未能确认 ——
 * 而**不**借用 `common.storeWriteFailed`（那条路陈述的是「本机存储写入失败」，本路径从未建立
 * 这个原因）。tile 依旧不动：没有设备读数，就不许有设备读数。
 *
 * 正控（不许被这次修法误伤）：
 *  ① `set` 没答但 `status` 答了 ⇒ 退路照样走，tile 跟着设备报的状态走，不留那句话；
 *  ② `set` 直接答了 ⇒ tile 跟着答，不留那句话；
 *  ③ 双 `null` 之后一次成功（走退路）的点击 ⇒ 那句话消失，tile 恢复（拒绝不是粘住的）。
 *
 * 三条负控各自打在不同的测试集合上，互不重叠：去掉那句话 ⇒ 只红测试 1；掐掉退路的
 * 提交 ⇒ 红测试 2 与 4（都走退路）；漏掉 `snap` 成功后的 `return` ⇒ 只红测试 3。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationCenter from "../src/svelte/NotificationCenter.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { clearCellularRadio } from "../src/svelte/cellularRadio";
import { readStoreValue } from "../src/lib/amosStore";
import { FLASHLIGHT_KEY } from "../src/lib/settings";
import { t } from "../src/svelte/locale.svelte";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  clearCellularRadio();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  vi.restoreAllMocks();
  resetPropsChannels();
  clearCellularRadio();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

async function renderOpen() {
  propsChannel<{ open: boolean }>("nc").set({ open: true });
  const { container } = render(NotificationCenter);
  await tick();
  return container;
}

const torch = (c: HTMLElement) =>
  [...c.querySelectorAll("button[aria-pressed]")].find((b) =>
    b.querySelector('[data-icon="flashlight"]'),
  ) as HTMLButtonElement;
const bars = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-testid="store-write-error"]')].map((e) => e.textContent ?? "");

/**
 * Let every awaited command in `toggleFlash` settle. `vi.waitFor` returns the instant the
 * tile moves — which the store write does **synchronously** — so a "no line" assertion made
 * straight after it reads before the handler's fall-through could ever speak. Settling first
 * is what makes the absence assertions mean something (it is also what reds the missing-`return`
 * negative control: a successful `set` must not then fall through and blame the host).
 */
const settle = () => new Promise((r) => setTimeout(r, 20));

type Flash = { on: boolean; torch_present: boolean; available: boolean };

/** A bridged host whose flashlight commands are answered by the two supplied replies. */
function installBridge(setReply: () => Flash | null, statusReply: () => Flash | null) {
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      switch (cmd) {
        case "flashlight_set":
          return setReply();
        case "flashlight_status":
          return statusReply();
        default:
          return null;
      }
    },
    listen: async () => () => {},
  };
}

const on = (): Flash => ({ on: true, torch_present: true, available: true });
const nullReply = () => null;

describe("REQ-A1463 — 手电筒的桥接支不得把无应答做成无声的空操作", () => {
  test("两条命令都没回答：tile 不动，但把话说出来（修法前为红）", async () => {
    installBridge(nullReply, nullReply);
    const c = await renderOpen();
    const tile = () => torch(c)!;
    expect(tile().getAttribute("aria-pressed")).toBe("false");
    expect(bars(c)).toEqual([]);

    await fireEvent.click(tile());
    await tick();

    // 没有设备读数 —— 就不许有设备读数。
    expect(tile().getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem(FLASHLIGHT_KEY)).toBeNull();
    // …而这一下不许是无声的空操作。那句话陈述的是**这条路径确立的事实**。
    expect(bars(c)).toEqual([t("nc.torchUnanswered")]);
  });

  test("正控 · set 没答但 status 答了：退路照走，tile 跟设备走，不留那句话", async () => {
    installBridge(nullReply, on);
    const c = await renderOpen();

    await fireEvent.click(torch(c));
    await vi.waitFor(() => expect(torch(c).getAttribute("aria-pressed")).toBe("true"));
    await settle();

    expect(bars(c)).toEqual([]);
    expect(readStoreValue<{ on: boolean }>(FLASHLIGHT_KEY, { on: false }).on).toBe(true);
  });

  test("正控 · set 直接答了：tile 跟着答，不留那句话", async () => {
    installBridge(on, nullReply);
    const c = await renderOpen();

    await fireEvent.click(torch(c));
    await vi.waitFor(() => expect(torch(c).getAttribute("aria-pressed")).toBe("true"));
    await settle();

    expect(bars(c)).toEqual([]);
  });

  test("正控 · 拒绝不是粘住的：双 null 之后一次走退路落地的点击让 tile 恢复且不留那句话", async () => {
    installBridge(nullReply, nullReply);
    const c = await renderOpen();

    // 先把退路也掐断一次（两条都答 null）：什么也没落下来。
    await fireEvent.click(torch(c));
    await tick();
    expect(torch(c).getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem(FLASHLIGHT_KEY)).toBeNull();

    // 宿主恢复应答（走退路）：状态跟着设备走，而那一句不留存。
    installBridge(nullReply, on);
    await fireEvent.click(torch(c));
    await vi.waitFor(() => expect(torch(c).getAttribute("aria-pressed")).toBe("true"));
    await settle();

    expect(bars(c)).toEqual([]);
  });
});

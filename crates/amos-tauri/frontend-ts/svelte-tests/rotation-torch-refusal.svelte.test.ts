/**
 * REQ-A1385 / F-SH-648 — 通知中心这一栏最后两枚把存储裁决丢进 `void` 的控件：旋转锁与手电筒。
 *
 * 与上一轮 `quick-tile-refusal.svelte.test.ts`（REQ-A1382）同族（同一张面板、同一枚
 * `StoreErrorBar`、同一句 `common.storeWriteFailed`），但**形状不同**，正是这一轮之所以
 * 独立的原因：
 *
 *  * **手电筒**和那些快速开关一样是「本地不动、屏幕也对、就是一声不吭」——`flash` 由
 *    `flashStore.subscribe` 驱动，拒写时读数不动，缺的只是那句话。
 *  * **旋转锁**是**假读数**：`tapRotation` 走的是 `rotation = mode;
 *    writeStoreValue(ROTATION_KEY, …)`（store-refusal-sweep 枚举过的那个形状）。未桥接
 *    时 store 是唯一真源，`writeJson` 拒写又**不派发 `STORE_CHANGED_EVENT`**，镜像订阅
 *    因此不会再把它拉回来：Pill 亮起、`data-frozen` 变 `true`、标题换成新模式，而
 *    `amos.rotation` 里 `null` —— 整块面板陈述一个从未存下来的偏好，且一句话也没有。
 *
 * 如实边界（本轮**故意保留**的不对称，不是遗漏）：
 *  ① 桥接路径上 `next` 来自设备自己的应答（`reply.mode`），本地必须跟设备走 —— 把读数
 *     按在原地才是假读数。所以那一支只补那句话（未落地时），并在设备自己也说了话
 *     （`rotation.notApplied`）时让位给设备那句：一个槽只放一句，而「这台宿主没转过去」
 *     更贴近用户刚做的那一下。测试 2 钉的正是「设备事实照样显示 + 那句话在」。
 *  ② 桥接的手电筒路径上设备可能**真的**把灯打开/关上了，而镜像拒绝记下来（读数不动是
 *     这条路径既有的形状，本轮不改它）—— 那句话让这件事至少可见，但本组件并不声称
 *     读数等于设备。本测试只钉未桥接那一支。
 *  ③ 通知中心的三个通知动词（清空 ∕ 单条删除 ∕ 标为已读）对 `NOTIF_KEY` 的裁决同样丢进
 *     `void`，但那条路径已有自己的设备侧拒绝位（`pushNote` ∕ `nc-push-refused`），
 *     且行本身会被下一次轮询写回 —— 属于另一轮，本轮不碰（与 REQ-A1382 的边界一致）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationCenter from "../src/svelte/NotificationCenter.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { clearCellularRadio } from "../src/svelte/cellularRadio";
import { readStoreValue } from "../src/lib/amosStore";
import { ROTATION_KEY } from "../src/lib/rotation";
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

/** Every `localStorage.setItem` throws — a full or unavailable store, the real refusal path. */
const refuseWrites = () =>
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });

const rotationTile = (c: HTMLElement) => c.querySelector('[data-testid="nc-rotation"]')!;
const modeOf = (c: HTMLElement, m: string) =>
  c.querySelector(`[data-testid="nc-rotation-${m}"]`)!.getAttribute("aria-pressed");
const note = (c: HTMLElement) => c.querySelector('[data-testid="nc-rotation-note"]');
const torch = (c: HTMLElement) =>
  [...c.querySelectorAll("button[aria-pressed]")].find((b) =>
    b.querySelector('[data-icon="flashlight"]'),
  ) as HTMLButtonElement;
const bars = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-testid="store-write-error"]')].map((e) => e.textContent ?? "");

/** A bridged host that answers `rotation_get` / `rotation_set` with `outcomeState`. */
function installBridge(outcomeState: string) {
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "rotation_get":
          return { mode: "auto", available: true };
        case "rotation_set":
          return {
            mode: String(args?.mode ?? "auto"),
            available: true,
            outcome: { state: outcomeState },
          };
        default:
          return null;
      }
    },
    listen: async () => () => {},
  };
}

describe("REQ-A1385 — 旋转锁与手电筒不得把存储裁决丢进 void", () => {
  test("旋转锁 · 无宿主：被拒的写入不移动 Pill、不冻结、不改标题，但把话说出来", async () => {
    const c = await renderOpen();
    expect(modeOf(c, "auto")).toBe("true");
    expect(rotationTile(c).getAttribute("data-frozen")).toBe("false");
    expect(note(c)).toBeNull();

    refuseWrites();
    await fireEvent.click(c.querySelector('[data-testid="nc-rotation-locked"]') as HTMLButtonElement);
    await tick();

    // 未桥接时 store 是唯一真源：什么也没存下来，面板就一处也不许动（假读数）。
    expect(window.localStorage.getItem(ROTATION_KEY)).toBeNull();
    expect(modeOf(c, "locked")).toBe("false");
    expect(modeOf(c, "auto")).toBe("true");
    expect(rotationTile(c).getAttribute("data-frozen")).toBe("false");
    expect(rotationTile(c).textContent ?? "").toContain(t("rotation.auto"));
    // …而这一下不许是无声的空操作。
    expect(note(c)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("旋转锁 · 有宿主：设备事实照样显示，而「没存下来」照样要说", async () => {
    installBridge("applied");
    const c = await renderOpen();
    await vi.waitFor(() => expect(modeOf(c, "auto")).toBe("true"));

    refuseWrites();
    await fireEvent.click(
      c.querySelector('[data-testid="nc-rotation-landscape"]') as HTMLButtonElement,
    );
    await vi.waitFor(() => expect(modeOf(c, "landscape")).toBe("true"));

    // `next` 是设备报的状态 —— 把它按回去才是假读数，所以 Pill 就该亮着。
    expect(rotationTile(c).getAttribute("data-frozen")).toBe("true");
    // 但偏好确实没落盘，而这句话正是不许丢的那个裁决。
    expect(window.localStorage.getItem(ROTATION_KEY)).toBeNull();
    expect(note(c)?.textContent).toContain(t("common.storeWriteFailed"));
  });

  test("手电筒 · 无宿主：被拒的写入不点亮，但把话说出来（正控见下一条）", async () => {
    const c = await renderOpen();
    const tile = () => torch(c)!;
    expect(tile().getAttribute("aria-pressed")).toBe("false");
    expect(bars(c)).toEqual([]);

    refuseWrites();
    await fireEvent.click(tile());
    await tick();

    expect(window.localStorage.getItem(FLASHLIGHT_KEY)).toBeNull();
    expect(tile().getAttribute("aria-pressed")).toBe("false");
    expect(bars(c)).toEqual([t("common.storeWriteFailed")]);
  });

  test("写落地的两次点击照常生效，且拒写那一行随之消失（正控）", async () => {
    const c = await renderOpen();
    vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(() => {
      throw new Error("QuotaExceededError");
    });
    await fireEvent.click(c.querySelector('[data-testid="nc-rotation-locked"]') as HTMLButtonElement);
    await tick();
    expect(note(c)).not.toBeNull();

    await fireEvent.click(c.querySelector('[data-testid="nc-rotation-locked"]') as HTMLButtonElement);
    await tick();

    expect(note(c)).toBeNull();
    expect(modeOf(c, "locked")).toBe("true");
    expect(readStoreValue<{ mode: string }>(ROTATION_KEY, { mode: "" }).mode).toBe("locked");

    // 手电筒同一条纪律：拒写一次留下那一行，再点一次落地后它消失。
    vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(() => {
      throw new Error("QuotaExceededError");
    });
    await fireEvent.click(torch(c));
    await tick();
    expect(bars(c)).toEqual([t("common.storeWriteFailed")]);

    await fireEvent.click(torch(c));
    await tick();
    expect(bars(c)).toEqual([]);
    expect(torch(c).getAttribute("aria-pressed")).toBe("true");
    expect(readStoreValue<{ on: boolean }>(FLASHLIGHT_KEY, { on: false }).on).toBe(true);
  });
});

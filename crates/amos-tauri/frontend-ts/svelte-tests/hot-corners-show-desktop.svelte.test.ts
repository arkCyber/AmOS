/**
 * hot-corners-show-desktop.svelte.test.ts — 「显示桌面」的还原半场必须读宿主的判决。
 *
 * `HotCornersListener.toggleShowDesktop()` 有对称的两半：**隐藏**半场读 `wmHide` 的返回值
 * （只有宿主确认隐藏了的窗口才被记进 `deskHidden`），**还原**半场却 `await wmFocus(label)`
 * 把布尔丢掉。而 `wmFocus` 的 `false`（宿主拒绝 ∕ 无桥）意味着那扇窗**没有回来** —— 又因为
 * `deskHidden` 在循环**之前**就被清空，一次被拒的还原会把那扇窗**既留在隐藏状态、又从记忆里
 * 抹掉**。下一次触发只会去隐藏当前**可见**的窗口（`state === "Hidden"` 的直接跳过），所以它
 * 再也回不来：这正是「记不住就等于丢」。
 *
 * 这里的用例走**真实入口**：向 `window` 派发 `mousemove`，穿过 `isInHotZone` 的判定与
 * `delay` 计时器，落在 `triggerAction("desktop")` 上。三次「进角落」足以把两种语义分开 ——
 * 第二次是**被拒的还原**，第三次修好后**重试 `wm_focus`**、未修时**重新 `wm_windows` 并再
 * `wm_hide`**（同一扇窗被隐藏两次）。
 *
 * 宿主桩对 `wm_focus` **reject**：`invoke` 从不 reject，它把理由记进 per-command 账本并答
 * `null`；Tauri 2 把宿主的 `Err` 走 error 回调 ⇒ JS promise reject ⇒ `catch` 记
 * `command-failed`、答 `null`。一个只 resolve 的桩够不到拒绝分支。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import HotCornersListener from "../src/svelte/modules/HotCornersListener.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { HOT_CORNER_KEY } from "../src/lib/hotCorners";

type Call = { cmd: string; args: Record<string, unknown> | undefined };
let calls: Call[] = [];

const WINDOW = { label: "a", kind: "App", state: "Visible" };

function installHost(opts: { refuseFocus: boolean; hideOk?: boolean }): void {
  calls = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      switch (cmd) {
        case "wm_windows":
          return { windows: [WINDOW] };
        case "wm_hide":
          if (opts.hideOk === false) throw { code: "host-refused", message: "hide refused" };
          return { windows: [WINDOW] };
        case "wm_focus":
          if (opts.refuseFocus) throw { code: "host-refused", message: "focus refused" };
          return { windows: [WINDOW] };
        default:
          return null;
      }
    },
    listen: async () => () => {},
  };
}

const count = (cmd: string): number => calls.filter((c) => c.cmd === cmd).length;

/** Let the per-corner delay timer fire and every `await` inside the action settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await tick();
  }
}

/** Enter (or leave) the top-left hot zone — leaving is any point outside all four zones. */
async function moveTo(x: number, y: number): Promise<void> {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
  await flush();
}

const INTO_CORNER = [0, 0] as const;
const OUT_OF_ZONE = [500, 500] as const;

describe("HotCornersListener — Show Desktop restore reads the host's verdict", () => {
  beforeEach(() => {
    localStorage.clear();
    // A refused restore means `wm_focus` answered `Err` — the only shape that reaches the
    // refusal branch (`backend.invoke` records a *rejected* call as `command-failed`).
    writeStoreValue(HOT_CORNER_KEY, [
      { corner: "top-left", action: "desktop", delay: 0 },
    ]);
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("keeps a refused un-hide remembered, so the next trigger retries it (and says so)", async () => {
    installHost({ refuseFocus: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(HotCornersListener);
    await flush();

    // 1. into the corner → the visible window is hidden (and only because the host said so).
    await moveTo(...INTO_CORNER);
    expect(count("wm_hide")).toBe(1);
    expect(count("wm_focus")).toBe(0);

    // 2. out, then back in → the restore is attempted and the host refuses it.
    await moveTo(...OUT_OF_ZONE);
    await moveTo(...INTO_CORNER);
    expect(count("wm_focus")).toBe(1);

    // 3. out, then back in → the window is *still hidden*, so this trigger must try to bring
    //    it back again. On the old shape `deskHidden` had already been emptied, so it went to
    //    the hide half instead and hid the same window a second time.
    await moveTo(...OUT_OF_ZONE);
    const hidBefore = count("wm_hide");
    await moveTo(...INTO_CORNER);
    expect(count("wm_focus")).toBe(2);
    expect(count("wm_hide")).toBe(hidBefore);

    // The refusal is not just remembered, it is *reported* — with the surface tag, not only
    // the typed code (`backend.invoke`'s own warn line already carries the code).
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes("[HotCorners] wm_focus(a) refused"),
      ),
    ).toBe(true);
  });

  it("clears the memory once a restore succeeds — the next trigger hides again (the mirror)", async () => {
    installHost({ refuseFocus: false });
    render(HotCornersListener);
    await flush();

    await moveTo(...INTO_CORNER);
    expect(count("wm_hide")).toBe(1);

    await moveTo(...OUT_OF_ZONE);
    await moveTo(...INTO_CORNER);
    expect(count("wm_focus")).toBe(1);

    // A confirmed restore empties the memory, so the gesture goes back to hiding.
    await moveTo(...OUT_OF_ZONE);
    await moveTo(...INTO_CORNER);
    expect(count("wm_hide")).toBe(2);
    expect(count("wm_focus")).toBe(1);
  });
});

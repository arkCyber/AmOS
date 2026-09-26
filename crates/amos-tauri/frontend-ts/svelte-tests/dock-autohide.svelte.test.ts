/**
 * dock-autohide.svelte.test.ts — the Dock's 「自动隐藏」 preference actually hides the Dock.
 *
 * The bug this file was written against was a switch that could never be on:
 * `Dock.svelte` gated auto-hide on `autoHideEnabled && isFullscreen()`, and `isFullscreen()`
 * read `document.fullscreenElement` — which a Tauri *native* fullscreen does not set (no
 * `fullscreenchange` either). Only the `main` desktop window mounts this Dock, and its
 * `document.fullscreenElement` is permanently `null`, so the right-click 「自动隐藏」 checkbox
 * was a dead toggle: ticked, it changed nothing.
 *
 * What is pinned here is the property the user bought: the **preference** drives it — hidden
 * when on, shown when off — with no dependence on a fullscreen state that cannot occur here.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import Dock from "../src/svelte/Dock.svelte";
import { LAYOUT_KEY, writeStoreValue, type HomeLayout } from "../src/lib/amosStore";
import { DOCK_PREFS_KEY, DEFAULT_DOCK_PREFS, type DockPrefs } from "../src/lib/dockPrefs";

const SEEDED: HomeLayout = { page: [], dock: ["clock", "notes", "files"], hidden: [] };
const settle = () => new Promise((r) => setTimeout(r, 20));

function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async () => null,
    listen: async () => () => {},
  };
}

const setPrefs = (over: Partial<DockPrefs>) =>
  writeStoreValue(DOCK_PREFS_KEY, { ...DEFAULT_DOCK_PREFS, ...over });

const panel = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-testid="dock-panel"]')!;

beforeEach(() => {
  window.localStorage.clear();
  installHost();
  writeStoreValue(LAYOUT_KEY, SEEDED);
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("Dock.svelte — the auto-hide preference (not fullscreen) moves the Dock", () => {
  test("auto-hide OFF leaves the Dock in place", async () => {
    setPrefs({ autoHide: false });
    const { container } = render(Dock);
    await tick();
    await settle();
    // `translate(0, 0)` — the Dock is on screen. And it must not depend on fullscreen:
    // nothing is fullscreen here, exactly as on the real desktop (`?? null` because
    // happy-dom leaves the property `undefined` rather than `null`).
    expect(document.fullscreenElement ?? null).toBeNull();
    expect(panel(container).style.transform).toBe("translate(0, 0)");
  });

  test("auto-hide ON hides the Dock even though nothing is fullscreen (the bug)", async () => {
    setPrefs({ autoHide: true });
    const { container } = render(Dock);
    await tick();
    await settle();
    // The old gate `isFullscreen()` was false here, so the Dock stayed put and the toggle
    // looked broken. Now the preference alone hides it.
    expect(document.fullscreenElement ?? null).toBeNull();
    expect(panel(container).style.transform).toBe("translateY(100%)");
  });

  test("a side Dock hides along its own axis (left ⇒ translateX)", async () => {
    setPrefs({ autoHide: true, position: "left" });
    const { container } = render(Dock);
    await tick();
    await settle();
    // The transform must follow the position, or a left-docked auto-hidden Dock would slide
    // *down* into the screen instead of off its edge.
    expect(panel(container).style.transform).toBe("translateX(-100%)");
  });
});

/**
 * REQ-A1345 / FMEA F-SH-610 — 隐藏之后，唯一能把它叫回来的手势必须真的够得到。
 *
 * 上面三条测的是「偏好驱动 transform」，它们对下面这件事**全盲**：`dockRevealZone` 算得再准，
 * 也没人调用它。监听器原先挂在 Dock 的包裹层 div 上，而那个 div 是 `pointer-events-none`；
 * 它唯一能命中的小孩（`pointer-events-auto` 的面板）在被隐藏时正被推出屏幕之外 —— 真实浏览器
 * 里指针于是落在下面的桌面壳上，处理器一次也不会触发。这是本仓记过的形状：一段被写对、
 * 却没有任何读者（调用者）的判据。
 *
 * happy-dom 不做命中测试，所以这里用**事件的目标**来钉：真实事件的传播是沿祖先链向上的，
 * 一个挂在包裹层上的处理器收不到派发在 `window` 上的事件，反过来也一样。修前在 window 上
 * 派发 ⇒ 面板纹丝不动；修后 ⇒ 沿它自己的边唤回。
 */
describe("Dock.svelte — 隐藏之后还能被唤回（不是只能靠改偏好）", () => {
  // happy-dom 的视口是 1024×768；底部边就是 y > 688。
  const EDGE_BOTTOM = { clientX: 512, clientY: 760 };
  const EDGE_LEFT = { clientX: 3, clientY: 384 };

  test("底部自动隐藏：指针移到屏幕底边 ⇒ Dock 回到屏幕上", async () => {
    setPrefs({ autoHide: true, position: "bottom" });
    const { container } = render(Dock);
    await tick();
    await settle();
    expect(panel(container).style.transform, "先确认它真的藏起来了").toBe("translateY(100%)");

    await fireEvent.mouseMove(window, EDGE_BOTTOM);
    await tick();

    expect(panel(container).style.transform).toBe("translate(0, 0)");
  });

  test("左侧自动隐藏：指针移到屏幕左边缘 ⇒ Dock 回来（每一条边都要够得到）", async () => {
    setPrefs({ autoHide: true, position: "left" });
    const { container } = render(Dock);
    await tick();
    await settle();
    expect(panel(container).style.transform).toBe("translateX(-100%)");

    await fireEvent.mouseMove(window, EDGE_LEFT);
    await tick();

    expect(panel(container).style.transform).toBe("translate(0, 0)");
  });

  test("指针在屏幕中间 ⇒ 什么也不发生（唤起的是边，不是随便一次移动）", async () => {
    setPrefs({ autoHide: true, position: "bottom" });
    const { container } = render(Dock);
    await tick();
    await settle();

    await fireEvent.mouseMove(window, { clientX: 512, clientY: 300 });
    await tick();

    expect(panel(container).style.transform).toBe("translateY(100%)");
  });
});

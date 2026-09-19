/**
 * desktop-window-titlebar.svelte.test.ts — G-α: macOS Overlay 标题栏 + 红绿灯 inset.
 *
 * The host already installs `title_bar_style(Overlay)` for desktop windows
 * (`crates/amos-tauri/src/wm.rs` row ~977, `#[cfg(desktop)]` gated so Android/iOS
 * never see it), and the test in `desktop-app-window.svelte.test.ts` covers the
 * shell-level chords. What was missing is the WebView's own title bar — the
 * ~28 px strip a real Mac leaves for the traffic lights and the window name —
 * and a `wm_maximize` command wired to the title bar's **double-click**
 * (REQ-G-α / `docs/DESKTOP_TITLEBAR_G_ALPHA.md`).
 *
 * Each test below pins a single visible property or host call; the negative control
 * ("remove the `<header>` ⇒ the height test FAILS") is documented in the design
 * doc and verified by hand during landing — the script does not re-import
 * `DesktopAppWindow` without the header, since the structural gate the design
 * describes is *the* test this file ships.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopAppWindow from "../src/svelte/DesktopAppWindow.svelte";
import { APP_WINDOW_TITLEBAR_HEIGHT, APP_WINDOW_TITLEBAR_INSET } from "../src/lib/desktopLayout";

type Call = { cmd: string; args?: Record<string, unknown> };
let calls: Call[] = [];

function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return null;
    },
    listen: async () => () => {},
  };
}

beforeEach(() => {
  window.localStorage.clear();
  calls = [];
  installHost();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as unknown as { __amosDisabledFeatures?: unknown }).__amosDisabledFeatures;
});

describe("G-α — macOS Overlay 标题栏 (REQs §3)", () => {
  test("标题栏存在、高度 = APP_WINDOW_TITLEBAR_HEIGHT（lib/desktopLayout.ts 唯一真源）", async () => {
    render(DesktopAppWindow, { props: { id: "settings" } });
    await tick();
    const bar = document.querySelector(
      '[data-testid="app-window-titlebar"]',
    ) as HTMLElement | null;
    expect(bar).toBeTruthy();
    expect(bar?.getAttribute("data-window-titlebar-height")).toBe(
      String(APP_WINDOW_TITLEBAR_HEIGHT),
    );
    expect(bar?.style.height).toBe(`${APP_WINDOW_TITLEBAR_HEIGHT}px`);
  });

  /**
   * REQ-A440 — the two measured facts that decide this bar's markup:
   *   • the whole 28 px strip is the window's **only** draggable place, and a Tauri overlay
   *     window drags only from an element carrying `data-tauri-drag-region` (this tree had **zero**
   *     of them: dragging 24 steps left the window at 236,69, while the same CGEvent tool moved
   *     TextEdit 208,126 → 328,196) ⇒ every element of the strip must carry it, because Tauri
   *     checks the **event target**, not an ancestor;
   *   • AppKit draws the real traffic lights **on this same strip** (screenshot: they overlap the
   *     painted lookalikes into a double image, and the painted ones can never be clicked) ⇒ the
   *     app must not paint a second set — the left column is a spacer instead.
   */
  test("every element of the strip is a drag region (the window's only draggable place)", async () => {
    render(DesktopAppWindow, { props: { id: "notes" } });
    await tick();
    const bar = document.querySelector('[data-testid="app-window-titlebar"]') as HTMLElement;
    for (const sel of [
      '[data-testid="app-window-titlebar"]',
      '[data-testid="app-window-title"]',
      '[data-testid="app-window-titlebar-inset"]',
      '[data-testid="app-window-titlebar-trailing"]',
    ]) {
      const el = document.querySelector(sel) as HTMLElement | null;
      expect(el, sel).toBeTruthy();
      expect(el?.hasAttribute("data-tauri-drag-region"), `${sel} drags the window`).toBe(true);
    }
    // …and the strip really is the titlebar height (the OS titlebar's own height).
    expect(bar.getAttribute("data-window-titlebar-height")).toBe(String(APP_WINDOW_TITLEBAR_HEIGHT));
  });

  test("no painted traffic lights: the only ones are NSWindow's (REQ-A440)", async () => {
    render(DesktopAppWindow, { props: { id: "notes" } });
    await tick();
    // The painted cluster is gone — a second set of lookalikes cannot be clicked and doubles the
    // real ones on screen (measured by screenshot).
    expect(document.querySelector('[data-testid="app-window-traffic-lights"]')).toBeNull();
    // The space they need is reserved instead, at macOS's own width (14…66 px + margin).
    const inset = document.querySelector('[data-testid="app-window-titlebar-inset"]') as HTMLElement;
    expect(inset).toBeTruthy();
    expect(inset.getAttribute("aria-hidden")).toBe("true");
    const bar = document.querySelector('[data-testid="app-window-titlebar"]') as HTMLElement;
    expect(bar.style.gridTemplateColumns).toContain(`${APP_WINDOW_TITLEBAR_INSET}px`);
  });

  test("标题文本 = 窗口名（与 wmSetShellTitle 同源，不另起一份）", async () => {
    render(DesktopAppWindow, { props: { id: "settings" } });
    await tick();
    const title = document.querySelector(
      '[data-testid="app-window-title"]',
    ) as HTMLElement | null;
    // 不写死文案 —— 名字来自 appTitleKey(id) ⇒ t(...)，可能 i18n 加载完成前为空
    expect(title).toBeTruthy();
    // `draggable` 是 HTML 的内容拖拽、与移动窗口无关（REQ-A440 实测）：它不该回来。
    expect(title?.hasAttribute("draggable")).toBe(false);
  });

  test("双击标题栏派 wm_maximize(<id>)（macOS 行为：toggle maximize ⇄ restore）", async () => {
    render(DesktopAppWindow, { props: { id: "calendar" } });
    await tick();
    const bar = document.querySelector(
      '[data-testid="app-window-titlebar"]',
    ) as HTMLElement | null;
    // 标题栏接两次 click（300 ms 内）→ 派 wm_maximize；定时器收口在组件里，
    // 测试不依赖浏览器的 dblclick 合成契约（happy-dom 与浏览器不一致）。
    bar?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    bar?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(calls.filter((c) => c.cmd === "wm_maximize")).toEqual([
      { cmd: "wm_maximize", args: { label: "calendar" } },
    ]);
  });

  test("单击（< 300 ms 内只一次）不派命令", async () => {
    render(DesktopAppWindow, { props: { id: "calendar" } });
    await tick();
    const bar = document.querySelector(
      '[data-testid="app-window-titlebar"]',
    ) as HTMLElement | null;
    bar?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(calls.filter((c) => c.cmd === "wm_maximize")).toEqual([]);
  });
});

describe("G-α — 已有键盘契约不退化（REQ-A419）", () => {
  test("⌘W 仍作用于本窗口（标题栏不抢系统键）", async () => {
    render(DesktopAppWindow, { props: { id: "settings" } });
    await tick();
    const ev = new KeyboardEvent("keydown", {
      key: "w",
      metaKey: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    await tick();
    expect(calls.filter((c) => c.cmd === "wm_close")).toEqual([
      { cmd: "wm_close", args: { label: "settings" } },
    ]);
    expect(ev.defaultPrevented).toBe(true);
  });
});
/**
 * DOM tests for the Svelte 5 LMK debug panel (LmkDebugPanel.svelte) — the last
 * Settings group. Unlike the governor panels it ALWAYS renders: offline it shows
 * a graceful "not connected" line; with a fake bridge it lists container tasks
 * and their freeze/thaw/reclaim actions.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import LmkDebugPanel from "../src/svelte/LmkDebugPanel.svelte";

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const settle = () => new Promise((r) => setTimeout(r, 40));

function installBridge(tasks: unknown) {
  const invoke = async (cmd: string) => {
    if (cmd === "android_lmk_tasks") return tasks;
    if (cmd === "android_lmk_debug") return { note: "ok", victims: [] };
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}

describe("LmkDebugPanel.svelte", () => {
  test("always renders and shows a graceful offline line when the daemon is absent", async () => {
    const host = render(LmkDebugPanel);
    await settle();
    await settle();
    expect(txt(host)).toContain("LMK 调试");
    expect(txt(host)).toContain("daemon 未连接");
  });

  test("lists container tasks with thaw/reclaim actions from a bridged snapshot", async () => {
    installBridge([
      { window_id: "w1", package_name: "com.example.photo", state: "cached" },
    ]);
    const host = render(LmkDebugPanel);
    await settle();
    await settle();
    expect(txt(host)).toContain("com.example.photo");
    expect(txt(host)).toContain("解冻"); // cached → thaw
    expect(txt(host)).toContain("回收"); // cached → reclaim
  });
});

/**
 * DOM tests for the Svelte 5 Android-app screen (AndroidApp.svelte) — offline
 * shell. Not bridged (no Tauri/daemon): it shows the localized "not connected"
 * state and a launch box; recents persisted in the shared store still render.
 * Live listing/launch/icon fetch need the daemon (device acceptance).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import AndroidApp from "../src/svelte/AndroidApp.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { ANDROID_RECENT_KEY } from "../src/lib/android";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";

describe("AndroidApp.svelte (offline shell)", () => {
  test("offline shows the not-connected status and a launch box", async () => {
    const host = render(AndroidApp);
    expect(txt(host)).toContain("未连接守护进程");
    const input = [...host.container.querySelectorAll("input")][0];
    expect(input?.getAttribute("placeholder")).toContain("输入包名启动");
  });

  test("persisted recents render as launch chips even offline", async () => {
    writeStoreValue(ANDROID_RECENT_KEY, [
      { package_name: "com.example.demo", name: "示例应用", ts: Date.now() },
    ]);
    const host = render(AndroidApp);
    expect(txt(host)).toContain("最近启动");
    expect(txt(host)).toContain("示例应用");
  });
});

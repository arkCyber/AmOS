/**
 * DOM tests for the Svelte 5 Android-app screen (AndroidApp.svelte):
 *  - offline shell: not bridged → localized "not connected" state + a launch box;
 *    persisted recents still render.
 *  - bridged: with an injected `__TAURI_INTERNALS__` (fake daemon snapshot) the
 *    grid lists apps and labels each with its container lifecycle tier
 *    (running / background) from `android_lmk_tasks`.
 * Live launch/icon fetch beyond this need the daemon (device acceptance).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import AndroidApp from "../src/svelte/AndroidApp.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { ANDROID_RECENT_KEY } from "../src/lib/android";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

describe("AndroidApp.svelte (bridged lifecycle tiers)", () => {
  const settle = () => new Promise((r) => setTimeout(r, 40));

  function installBridge(apps: unknown, tasks: unknown) {
    const invoke = async (cmd: string) => {
      if (cmd === "get_android_apps") return apps;
      if (cmd === "android_lmk_tasks") return tasks;
      if (cmd === "get_android_app_icon") return []; // no icon bytes -> emoji
      return null;
    };
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      listen: async () => () => {},
    };
  }

  test("labels running vs background apps from the LMK snapshot", async () => {
    installBridge(
      [
        { name: "微信", package_name: "com.tencent.mm" },
        { name: "抖音", package_name: "com.ss.android.ugc.aweme" },
      ],
      [
        { package_name: "com.tencent.mm", window_id: "w1", state: "foreground" },
        { package_name: "com.ss.android.ugc.aweme", window_id: "w2", state: "cached" },
      ],
    );
    const host = render(AndroidApp);
    await settle();
    await settle();

    const running = host.container.querySelector(
      '[data-testid="android-tier-com.tencent.mm"]',
    );
    const bg = host.container.querySelector(
      '[data-testid="android-tier-com.ss.android.ugc.aweme"]',
    );
    expect(running?.textContent).toContain("运行中");
    expect(bg?.textContent).toContain("后台");
    // An app with no task at all must show no tier chip (never "running").
    expect(
      host.container.querySelector('[data-testid="android-tier-com.none"]'),
    ).toBeNull();
  });

  test("shows no tier chips when the LMK snapshot is empty", async () => {
    installBridge(
      [{ name: "微信", package_name: "com.tencent.mm" }],
      [],
    );
    const host = render(AndroidApp);
    await settle();
    await settle();
    expect(
      host.container.querySelector('[data-testid="android-tier-com.tencent.mm"]'),
    ).toBeNull();
  });

  test("recents chips carry a live status dot for running/background packages", async () => {
    writeStoreValue(ANDROID_RECENT_KEY, [
      { package_name: "com.tencent.mm", name: "微信", ts: 1 },
      { package_name: "com.ss.android.ugc.aweme", name: "抖音", ts: 2 },
      { package_name: "com.idle.app", name: "闲置", ts: 3 },
    ]);
    installBridge(
      [
        { name: "微信", package_name: "com.tencent.mm" },
        { name: "抖音", package_name: "com.ss.android.ugc.aweme" },
      ],
      [
        { package_name: "com.tencent.mm", window_id: "w1", state: "foreground" },
        { package_name: "com.ss.android.ugc.aweme", window_id: "w2", state: "cached" },
      ],
    );
    const host = render(AndroidApp);
    await settle();
    await settle();

    const dot = (pkg: string) =>
      host.container.querySelector(`[data-testid="recent-dot-${pkg}"]`);
    const running = dot("com.tencent.mm");
    const bg = dot("com.ss.android.ugc.aweme");
    expect(running?.className).toContain("bg-emerald-500");
    expect(bg?.className).toContain("bg-neutral-400");
    // A package with no live task (not installed / not running) has no dot.
    expect(dot("com.idle.app")).toBeNull();
  });

  test("live-refreshes badges when a container lmk-surface kill event arrives", async () => {
    let liveTasks: unknown = [
      { package_name: "com.tencent.mm", window_id: "w1", state: "foreground" },
      { package_name: "com.ss.android.ugc.aweme", window_id: "w2", state: "cached" },
    ];
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    const invoke = async (cmd: string) => {
      if (cmd === "get_android_apps") {
        return [
          { name: "微信", package_name: "com.tencent.mm" },
          { name: "抖音", package_name: "com.ss.android.ugc.aweme" },
        ];
      }
      if (cmd === "android_lmk_tasks") return liveTasks;
      if (cmd === "get_android_app_icon") return [];
      return null;
    };
    const listen = async (ch: string, h: (e: { payload: unknown }) => void) => {
      handlers[ch] = h;
      return () => {
        delete handlers[ch];
      };
    };
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      listen,
    };

    const host = render(AndroidApp);
    await settle();
    await settle();

    const tierChip = (pkg: string) =>
      host.container.querySelector(`[data-testid="android-tier-${pkg}"]`);
    expect(tierChip("com.tencent.mm")?.textContent).toContain("运行中");
    expect(tierChip("com.ss.android.ugc.aweme")?.textContent).toContain("后台");

    // The container reclaims (kills) 抖音: the authoritative snapshot drops it,
    // and the daemon broadcasts an `lmk-surface` event the screen subscribes to.
    liveTasks = [
      { package_name: "com.tencent.mm", window_id: "w1", state: "foreground" },
    ];
    handlers["lmk-surface"]?.({
      payload: {
        window_id: "w2",
        package_name: "com.ss.android.ugc.aweme",
        kind: "reclaimed",
        close_surface: true,
      },
    });
    await settle();
    await settle();

    // No reopen needed: the killed app's badge is gone; the survivor stays live.
    expect(tierChip("com.ss.android.ugc.aweme")).toBeNull();
    expect(tierChip("com.tencent.mm")?.textContent).toContain("运行中");
  });

  test("tapping an already-running app surfaces it instead of relaunching", async () => {
    let launches = 0;
    const invoke = async (cmd: string) => {
      if (cmd === "get_android_apps") {
        return [
          { name: "微信", package_name: "com.tencent.mm" },
          { name: "抖音", package_name: "com.ss.android.ugc.aweme" },
        ];
      }
      if (cmd === "android_lmk_tasks") {
        return [{ package_name: "com.tencent.mm", window_id: "w1", state: "foreground" }];
      }
      if (cmd === "launch_android_app") {
        launches++;
        return { success: true, window_id: "w9", error: "" };
      }
      if (cmd === "get_android_app_icon") return [];
      return null;
    };
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      listen: async () => () => {},
    };

    const host = render(AndroidApp);
    await settle();
    await settle();

    const btnFor = (name: string) =>
      [...host.container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes(name),
      );

    // Running app (微信 is foreground): tapping must NOT cold-launch a duplicate.
    await fireEvent.click(btnFor("微信")!);
    await settle();
    expect(launches).toBe(0);
    expect(host.container.textContent).toContain("已在运行");

    // A non-running app (抖音, not in the snapshot) still launches.
    await fireEvent.click(btnFor("抖音")!);
    await settle();
    expect(launches).toBe(1);
  });

  test("launching a non-running app refreshes its tier so a repeat tap is gated", async () => {
    // A launch makes the container foreground the app: after the first
    // `launch_android_app` the authoritative snapshot includes it. AndroidApp must
    // refresh tiers on success so the badge appears at once and a second tap is
    // stopped by the "already running" guard (no duplicate cold-launch).
    let launched = false;
    const invoke = async (cmd: string) => {
      if (cmd === "get_android_apps") {
        return [
          { name: "微信", package_name: "com.tencent.mm" },
          { name: "抖音", package_name: "com.ss.android.ugc.aweme" },
        ];
      }
      if (cmd === "android_lmk_tasks") {
        const base = [
          { package_name: "com.tencent.mm", window_id: "w1", state: "foreground" },
        ];
        if (launched) {
          base.push({ package_name: "com.ss.android.ugc.aweme", window_id: "w9", state: "foreground" });
        }
        return base;
      }
      if (cmd === "launch_android_app") {
        launched = true;
        return { success: true, window_id: "w9", error: "" };
      }
      if (cmd === "get_android_app_icon") return [];
      return null;
    };
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      listen: async () => () => {},
    };

    const host = render(AndroidApp);
    await settle();
    await settle();

    const btnFor = (name: string) =>
      [...host.container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes(name),
      );
    const chip = (pkg: string) =>
      host.container.querySelector(`[data-testid="android-tier-${pkg}"]`);

    // 抖音 is not running yet: no tier chip, so a tap cold-launches.
    expect(chip("com.ss.android.ugc.aweme")).toBeNull();
    await fireEvent.click(btnFor("抖音")!);
    await settle();
    await settle();
    // The post-launch tier refresh picked up the now-foreground app → badge shows.
    expect(chip("com.ss.android.ugc.aweme")?.textContent).toContain("运行中");
    // A second tap is gated by the already-running guard — not another launch.
    await fireEvent.click(btnFor("抖音")!);
    await settle();
    expect(host.container.textContent).toContain("已在运行");
  });

});

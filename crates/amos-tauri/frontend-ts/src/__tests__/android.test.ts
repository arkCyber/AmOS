import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addRecent,
  ANDROID_RECENT_KEY,
  bytesToDataUri,
  displayName,
  readRecents,
  runTierForPackage,
} from "../lib/android";
import { getAndroidAppIcon, getAndroidApps, launchAndroidApp } from "../lib/backend";

let realWindow: unknown;
function setWindow(store: Map<string, string>, tauri?: unknown) {
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: tauri,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  };
}
beforeEach(() => {
  realWindow = (globalThis as { window?: unknown }).window;
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

describe("android helpers", () => {
  test("readRecents defaults to an empty list", () => {
    setWindow(new Map());
    expect(readRecents()).toEqual([]);
  });

  test("addRecent dedups by package and caps at 6, persisting to amos.android.recent", () => {
    const store = new Map<string, string>();
    setWindow(store);
    let l = addRecent([], { package_name: "a", name: "A", ts: 1 });
    l = addRecent(l, { package_name: "a", name: "A", ts: 2 }); // dedup, moves to front
    l = addRecent(l, { package_name: "b", name: "B", ts: 3 });
    expect(l.map((x) => x.package_name)).toEqual(["b", "a"]);
    expect(readRecents().length).toBe(2);
    expect(store.has(ANDROID_RECENT_KEY)).toBe(true);
  });

  test("bytesToDataUri renders a base64 PNG data URI", () => {
    // PNG "PNG" magic: 0x89 0x50 0x4e 0x47
    const out = bytesToDataUri([0x89, 0x50, 0x4e, 0x47]);
    expect(out.startsWith("data:image/png;base64,")).toBe(true);
    expect(out).toBe("data:image/png;base64," + btoa("\x89PNG"));
  });

  test("displayName prefers name over package", () => {
    expect(displayName({ name: "WeChat", package_name: "com.tencent.mm" })).toBe("WeChat");
    expect(displayName({ package_name: "com.tencent.mm" })).toBe("com.tencent.mm");
  });

  test("runTierForPackage classifies running, background and absent packages", () => {
    const tasks = [
      { package_name: "com.tencent.mm", window_id: "w1", state: "foreground" },
      { package_name: "com.a.b", window_id: "w2", state: "cached" },
      { package_name: "com.c.d", window_id: "w3", state: "visible" },
      { package_name: "com.e.f", window_id: "w4", state: "foreground_service" },
    ];
    expect(runTierForPackage("com.tencent.mm", tasks)).toBe("running");
    expect(runTierForPackage("com.a.b", tasks)).toBe("background");
    expect(runTierForPackage("com.c.d", tasks)).toBe("running");
    expect(runTierForPackage("com.e.f", tasks)).toBe("running");
    expect(runTierForPackage("com.not.running", tasks)).toBeNull();
  });

  test("runTierForPackage treats stopped/unknown as no indicator", () => {
    const tasks = [
      { package_name: "com.tencent.mm", window_id: "w1", state: "stopped" },
      { package_name: "com.weird", window_id: "w2", state: "mystate" },
    ];
    expect(runTierForPackage("com.tencent.mm", tasks)).toBeNull();
    expect(runTierForPackage("com.weird", tasks)).toBeNull();
  });
});

describe("android backend bridge", () => {
  test("invokes get_android_apps / launch / icon with camelCase packageName", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    const tauri = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        if (cmd === "get_android_apps") {
          return [{ name: "WeChat", package_name: "com.tencent.mm", activity: "Main" }];
        }
        if (cmd === "launch_android_app") return { success: true, window_id: "7" };
        if (cmd === "get_android_app_icon") return [1, 2, 3];
        return null;
      },
      listen: async () => async () => {},
    };
    setWindow(new Map(), tauri);
    const apps = await getAndroidApps();
    expect(apps?.[0]?.package_name).toBe("com.tencent.mm");
    const res = await launchAndroidApp("com.tencent.mm");
    expect(res?.success).toBe(true);
    const icon = await getAndroidAppIcon("com.tencent.mm");
    expect(icon).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.cmd)).toEqual([
      "get_android_apps",
      "launch_android_app",
      "get_android_app_icon",
    ]);
    expect(calls[1]!.args.packageName).toBe("com.tencent.mm");
    expect(calls[2]!.args.packageName).toBe("com.tencent.mm");
  });
});

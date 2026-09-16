import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  DESKTOP_FEATURES,
  isDesktopFeatureEnabled,
  loadDesktopFeatures,
  resetDesktopFeaturesForTest,
} from "../desktopFeatures";
import { bridgeDiag } from "../backend";

/**
 * desktopFeatures 的核心是「一个能力是否启用」——它的真源有**两处**:
 *   1. 测试/e2e 钩子:`window.__amosDisabledFeatures`(数组或字符串)
 *   2. **宿主**(REQ-A287):`AMOS_DESKTOP_SHORTCUTS` / `AMOS_DOCK_CONTEXT_MENU` 由 Rust
 *      宿主读取,UI 在 boot 时通过 `desktop_features_disabled` 取回并缓存
 *
 * 这里验证:
 *   - 默认两个能力都是开(诚实 UI 默认启用声明的能力)
 *   - 宿主回答 `["shortcuts"]` ⇒ 关;回答别的不影响另一个能力
 *   - 两路同时设置 ⇒ 关(并集,任一路关都关)
 *   - 没有桥(不在 Tauri 里)/ 命令失败 ⇒ 保持默认"开",且**原因**进诊断账本
 *   - `loadDesktopFeatures` 幂等(一次往返)
 *   - **回归钉子**:`process.env.AMOS_DESKTOP_SHORTCUTS=disabled` 不再有任何作用 ——
 *     前端读不到宿主的环境变量,旧代码那两条读法(Vite `import.meta.env` 只内联
 *     `VITE_*`;WebView 里没有 `process`)在发布版里永远是 undefined(REQ-A287)
 */
describe("isDesktopFeatureEnabled", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalInternals = (globalThis as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;

  /** Install a fake Tauri bridge whose `desktop_features_disabled` answers `answer`. */
  function installBridge(answer: unknown, opts: { throw?: boolean } = {}): { calls: string[] } {
    const calls: string[] = [];
    const internals = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        if (cmd !== "desktop_features_disabled") return null;
        if (opts.throw) throw new Error("refused");
        return answer;
      },
      listen: async () => () => {},
    };
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = internals;
    (globalThis as { window?: unknown }).window = globalThis;
    return { calls };
  }

  beforeEach(() => {
    resetDesktopFeaturesForTest();
    delete process.env.AMOS_DESKTOP_SHORTCUTS;
    delete process.env.AMOS_DOCK_CONTEXT_MENU;
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
    if (originalWindow && typeof originalWindow === "object") {
      delete (originalWindow as { __amosDisabledFeatures?: unknown }).__amosDisabledFeatures;
    }
  });

  afterEach(() => {
    resetDesktopFeaturesForTest();
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = originalInternals;
    // 严格还原到测试进入时的状态,避免污染后续套件(jsdom/happy-dom 装的 window)。
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("默认两个能力都启用", () => {
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(true);
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(true);
  });

  it("宿主回答 [\"shortcuts\"] ⇒ 关掉该能力,另一能力不受影响", async () => {
    installBridge(["shortcuts"]);
    await loadDesktopFeatures();
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(false);
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(true);
  });

  it("宿主回答两者 ⇒ 两个都关;回答空数组 ⇒ 都开", async () => {
    installBridge(DESKTOP_FEATURES);
    await loadDesktopFeatures();
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(false);
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(false);

    resetDesktopFeaturesForTest();
    installBridge([]);
    await loadDesktopFeatures();
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(true);
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(true);
  });

  it("宿主回答被当作**取值**而不是信任的形状:`null`/字符串/未知键都退回默认", async () => {
    // `null` = 没桥或命令失败(见下一个用例);字符串不是数组 ⇒ 不是回答。
    installBridge(null);
    await loadDesktopFeatures();
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(true);

    resetDesktopFeaturesForTest();
    installBridge("shortcuts");
    await loadDesktopFeatures();
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(true);

    // 宿主送来 UI 不认识的能力键(它自己那一侧新增的能力)⇒ 忽略,不影响已知能力。
    resetDesktopFeaturesForTest();
    installBridge(["shortcuts", "some-future-capability"]);
    await loadDesktopFeatures();
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(false);
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(true);
  });

  it("没有桥(不在 Tauri 里)⇒ 默认开,且诊断账本记下原因", async () => {
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    await loadDesktopFeatures();
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(true);
    expect(bridgeDiag()).toEqual({ ok: false, kind: "not-bridged", command: "desktop_features_disabled" });
  });

  it("命令失败 ⇒ 默认开,且诊断账本记下是哪一个命令失败", async () => {
    installBridge(null, { throw: true });
    await loadDesktopFeatures();
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(true);
    const diag = bridgeDiag();
    expect(diag.ok).toBe(false);
    if (!diag.ok) expect(diag.command).toBe("desktop_features_disabled");
  });

  it("loadDesktopFeatures 幂等:boot 里被调用多次也只走一次往返", async () => {
    const bridge = installBridge(["shortcuts"]);
    await Promise.all([loadDesktopFeatures(), loadDesktopFeatures(), loadDesktopFeatures()]);
    await loadDesktopFeatures();
    expect(bridge.calls.filter((c) => c === "desktop_features_disabled").length).toBe(1);
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(false);
  });

  it("window 钩子(数组)⇒ 关掉列出的能力", () => {
    (globalThis as { window?: unknown }).window = globalThis;
    (window as { __amosDisabledFeatures?: unknown }).__amosDisabledFeatures = ["shortcuts"];
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(false);
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(true);
  });

  it("window 钩子(逗号字符串)⇒ 关掉列出的能力", () => {
    (globalThis as { window?: unknown }).window = globalThis;
    (window as { __amosDisabledFeatures?: unknown }).__amosDisabledFeatures =
      "shortcuts, dock-context-menu";
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(false);
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(false);
  });

  it("宿主与 window 钩子同时设置 ⇒ 仍关(并集)", async () => {
    (globalThis as { window?: unknown }).window = globalThis;
    (window as { __amosDisabledFeatures?: unknown }).__amosDisabledFeatures = ["shortcuts"];
    installBridge(["dock-context-menu"]);
    await loadDesktopFeatures();
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(false);
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(false);
  });

  it("回归钉子:前端不再读 process.env(发布版里那两条读法永远是 undefined)", () => {
    // 旧代码在这里读 `import.meta.env.AMOS_*` / `process.env.AMOS_*`。Vite 只内联
    // `VITE_*`(本仓没有 envPrefix),WebView 里也没有 `process` —— 于是这两个开关在
    // 发布版里**不可能生效**(REQ-A287)。现在 env 由宿主读取,前端写 env 不再有任何
    // 作用;这条用例就是防止有人把那条死路重新接回来。
    process.env.AMOS_DESKTOP_SHORTCUTS = "disabled";
    process.env.AMOS_DOCK_CONTEXT_MENU = "disabled";
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(true);
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(true);
  });
});

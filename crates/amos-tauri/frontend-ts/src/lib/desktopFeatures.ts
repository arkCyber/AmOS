/**
 * desktopFeatures.ts — desktop shell capability switches (run-time toggles).
 *
 * Why this lives here:
 *   macOS 真机上 `⌘H` 已经被系统"隐藏应用"接管,如果桌面壳的前端也消费它,
 *   就会与 OS 抢键造成"按了没反应"的错觉。开发者与 e2e 也经常需要"临时关掉
 *   某个壳能力"——比如做截图、做断言。
 *
 * 两个开关的真源(REQ-A287 改成**宿主**):
 *   1. `window.__amosDisabledFeatures` —— 测试/e2e 钩子(数组或逗号串),不需要桥;
 *   2. 宿主:`AMOS_DESKTOP_SHORTCUTS` / `AMOS_DOCK_CONTEXT_MENU` 由 Rust 宿主在启动时读
 *      (`crates/amos-tauri/src/desktop_features.rs`),UI 在 boot 时通过
 *      `desktop_features_disabled` 取一次并缓存(`loadDesktopFeatures`)。
 *
 * **前端自己读不到这两个环境变量** —— 这正是 REQ-A287 修掉的缺陷:旧代码读
 * `import.meta.env.AMOS_*`(Vite 只内联 `VITE_*`,本仓没有 `envPrefix`)与 `process.env`
 * (WebView 里没有 `process` 全局),两条路径在发布版里**永远是 undefined**,于是
 * `docs/ENV_VARIABLES.md` 承诺的生产开关**根本不可能生效**(而单测在 bun 下跑得过,
 * 因为 Node 有 `process`)。环境变量的读取回到它真正存在的地方 —— 宿主。
 *
 * 默认值是"开"(与"诚实 UI"一致:能力默认就是声明的,关掉才需要理由)。宿主还没回答
 * (boot 取回之前的同步调用)时同样是"开";这两个能力只挡用户手势(键位、右键),而这个
 * 窗口在任何手势之前就结束了。
 */
import { invoke } from "./backend";

export type DesktopFeature = "shortcuts" | "dock-context-menu";

/** Every capability the host can switch off (keys are pinned on both sides). */
export const DESKTOP_FEATURES: readonly DesktopFeature[] = ["shortcuts", "dock-context-menu"];

function parseList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function readDisabledFromWindow(): Set<string> {
  if (typeof window === "undefined") return new Set();
  const hook = (window as { __amosDisabledFeatures?: unknown }).__amosDisabledFeatures;
  if (Array.isArray(hook)) {
    return new Set(hook.map((x) => String(x).toLowerCase()));
  }
  if (typeof hook === "string") return parseList(hook);
  return new Set();
}

/** What the host answered, or `null` while it has not been asked / could not answer. */
let hostDisabled: Set<string> | null = null;
/** Single-flight handle so any number of boot callers share one round-trip. */
let loadInFlight: Promise<void> | null = null;

/**
 * Ask the host which capabilities the operator switched off (idempotent, one round-trip).
 *
 * Call once from the shell boot (`Shell.onMount`, next to the layout snapshot). A missing
 * bridge or a failed command leaves the answer `null` ⇒ every capability keeps its
 * documented default ("on"); `lib/backend` records *why* in the diagnostics ledger
 * (`bridgeDiag()`), so "the switch did nothing" is diagnosable instead of mysterious.
 */
export function loadDesktopFeatures(): Promise<void> {
  if (loadInFlight) return loadInFlight;
  loadInFlight = invoke<unknown>("desktop_features_disabled")
    .then((answer) => {
      // Only an array is a host answer; anything else (including `null`) means "not
      // answered", and the default stands.
      if (Array.isArray(answer)) {
        const known = new Set<string>(DESKTOP_FEATURES);
        const named = answer
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim().toLowerCase())
          // A key the UI does not have is a host-side capability we cannot act on:
          // dropped, but only after being named by a *known* key check, so a typo in
          // this file's own list would show up as "the switch did nothing" in tests.
          .filter((x) => known.has(x));
        hostDisabled = new Set(named);
      }
    })
    .catch(() => {
      // `invoke` never rejects; this only guards a future change to it.
      hostDisabled = null;
    });
  return loadInFlight;
}

/** Test seam: forget the host answer so a suite starts from the real "not asked" state. */
export function resetDesktopFeaturesForTest(): void {
  hostDisabled = null;
  loadInFlight = null;
}

/**
 * 查询某个桌面壳能力是否启用。默认启用。任何一个开关把它列在"禁用"集合中 ⇒ 返回 false:
 *   - `window.__amosDisabledFeatures` 数组或字符串(测试 / e2e 钩子)
 *   - 宿主在 boot 时回答的 `desktop_features_disabled`(生产路径:读 env 的是宿主)
 * 取并集,任一路关都关;只有显式写 "enabled" 才允许(留出口给运维反向表达,但默认仍是
 * "启用")。
 */
export function isDesktopFeatureEnabled(feature: DesktopFeature): boolean {
  if (readDisabledFromWindow().has(feature)) return false;
  if (hostDisabled?.has(feature)) return false;
  return true;
}

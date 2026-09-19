/**
 * brightness.ts — G-β-1 · 屏幕降亮（WebView 内）的真源。
 *
 * Why this file exists:
 *   * Control Center 的「屏幕亮度」slider 写到 `amos.brightness` store，
 *     DesktopShell 订阅同一个 key 渲染黑色遮罩。
 *   * 两边**必须**走 `brightnessToAlpha(pct)`，**不允许**内联 `1 - pct / 100`
 *     或 `(100 - pct) / 100`（被 src/lib/__tests__/brightness.test.ts 的负控钉住）。
 *
 * 诚实边界（重要，请勿省略注释）：
 *   * 本仓做不到 macOS 系统亮度 —— WebView 内**没有**控制 `NSScreen.brightness`
 *     的 API，Tauri 2 也不暴露。所以这是一个**显示降亮**（display dimming）：
 *     在 WebView 内容之上盖一层 `rgba(0,0,0, alpha)` 透明遮罩，效果范围仅限
 *     本桌面 WebView 内容，**不影响**：
 *       - 原生 chrome（顶栏的 Tauri Title Bar）
 *       - 应用窗口（独立 WebviewWindow，**单独**的 WebView）
 *       - 外部显示器
 *     用户在 Control Center 里看到的标签会**显式**说"仅桌面内容" /
 *     "Desktop content only" —— 这是设计意图，不是 bug。
 *   * 默认值 100（不降亮）—— 用户首次启动不会看到任何黑屏。
 *
 * 全部函数纯（无 I/O / 无副作用），便于单元测试与后续切换实现（比如某天 Tauri 真的
 * 暴露了 `WebviewWindow.setBrightness`，把这个 lib 换成调宿主命令即可，UI 不变）。
 */

/** 屏幕降亮设置。pct = 100 时不降亮（遮罩透明），pct = 0 时完全黑。 */
export interface BrightnessSettings {
  pct: number;
}

/** 仓内**唯一**真源；其他文件必须 import 这个常量，不允许字面 `"amos.brightness"`。
 * 被 src/lib/__tests__/brightness.test.ts 的负控钉住。 */
export const BRIGHTNESS_KEY = "amos.brightness";

/** pct 的合法上界（含）。100 = 不降亮。 */
export const MAX_BRIGHTNESS_PCT = 100;
/** pct 的合法下界（含）。0 = 完全黑遮罩。 */
export const MIN_BRIGHTNESS_PCT = 0;
/** 默认值。100 = 不降亮 —— 首次启动不能让用户看到任何黑屏。 */
export const DEFAULT_BRIGHTNESS_PCT = 100;

/**
 * 把任意 unknown（absent / corrupt / 越界）规范成合法 BrightnessSettings。
 * 全部失败路径都 fallback 到 `DEFAULT_BRIGHTNESS_PCT` —— 比"假装合法"更诚实：
 * 一个 corrupt 的 store 不该让用户的屏幕**永久黑掉**。
 */
export function normalizeBrightness(raw: unknown): BrightnessSettings {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const v = (raw as Record<string, unknown>).pct;
    if (typeof v === "number" && Number.isFinite(v)) {
      return { pct: clampPct(v) };
    }
  }
  return { pct: DEFAULT_BRIGHTNESS_PCT };
}

/** 把 pct 限制在 [MIN, MAX] 区间。NaN / Infinity 不走这条（被 normalizeBrightness 拦了）。 */
function clampPct(v: number): number {
  if (v < MIN_BRIGHTNESS_PCT) return MIN_BRIGHTNESS_PCT;
  if (v > MAX_BRIGHTNESS_PCT) return MAX_BRIGHTNESS_PCT;
  return v;
}

/**
 * pct → CSS alpha（遮罩的 `opacity` 值）。
 *   * pct=100 → alpha=0（透明，不降亮）
 *   * pct=0 → alpha=1（完全不透明，完全黑）
 *   * 线性：`alpha = (MAX - pct) / MAX = 1 - pct / 100`
 *
 * **为什么要单独抽出来**：让 UI 只调这个函数，不允许 `.svelte` 里手算
 * `1 - pct / 100`（被 brightness.test.ts 的负控钉住）。将来如果改曲线（指数 / gamma）
 * 只动这里即可。
 *
 * 同时承担**clamp** 责任（UI 写脏值时也不让 alpha 越界）：
 *   * pct > 100 → alpha < 0 钳到 0
 *   * pct < 0 → alpha > 1 钳到 1
 */
export function brightnessToAlpha(pct: number): number {
  const p = clampPct(pct);
  return (MAX_BRIGHTNESS_PCT - p) / MAX_BRIGHTNESS_PCT;
}

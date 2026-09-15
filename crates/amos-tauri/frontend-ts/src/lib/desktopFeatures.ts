/**
 * desktopFeatures.ts — desktop shell feature flags (run-time toggles).
 *
 * Why this lives here:
 *   macOS 真机上 `⌘H` 已经被系统"隐藏应用"接管,如果桌面壳的前端也消费它,
 *   就会与 OS 抢键造成"按了没反应"的错觉。开发者与 e2e 也经常需要"临时关掉
 *   某个壳能力"——比如做截图、做断言。
 *
 * 文档化的两个开关(`AMOS_DESKTOP_SHORTCUTS` / `AMOS_DOCK_CONTEXT_MENU`)在
 * `docs/ENV_VARIABLES.md` §11 媒体与系统 一节;**默认值是"开"**,这与"诚实 UI"
 * 一致——能力默认就是声明的,关掉才需要理由。
 *
 * 单元测试 / e2e 可直接写 `window.__amosDisabledFeatures = ["shortcuts"]`,
 * 不用动 env(因为 vitest 不一定加载 .env.test)。
 */

export type DesktopFeature = "shortcuts" | "dock-context-menu";

const FEATURE_TO_ENV: Record<DesktopFeature, string> = {
  shortcuts: "AMOS_DESKTOP_SHORTCUTS",
  "dock-context-menu": "AMOS_DOCK_CONTEXT_MENU",
};

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

function readDisabledFromEnv(feature: DesktopFeature): Set<string> {
  const envName = FEATURE_TO_ENV[feature];
  const raw =
    (typeof import.meta !== "undefined" &&
      (import.meta as { env?: Record<string, string | undefined> }).env?.[envName]) ??
    (typeof process !== "undefined" ? process.env?.[envName] : undefined);
  // 必须是 string,才能进 parseList。其他值(例如 vite 注入的 boolean)⇒ 不解析。
  return typeof raw === "string" ? parseList(raw) : new Set();
}

/**
 * 查询某个桌面壳能力是否启用。
 * 默认启用。任何一个开关把它列在"禁用"集合中 ⇒ 返回 false:
 *   - `window.__amosDisabledFeatures` 数组或字符串(测试钩子)
 *   - 环境变量 `AMOS_DESKTOP_SHORTCUTS` / `AMOS_DOCK_CONTEXT_MENU`(生产路径)
 * 取并集,任何一个非"enabled"的写法都视为禁用;只有显式写 "enabled" 才允许(留出口
 * 给运维反向表达,但默认仍是"启用")。
 */
export function isDesktopFeatureEnabled(feature: DesktopFeature): boolean {
  const win = readDisabledFromWindow();
  if (win.has(feature)) return false;
  // 也接受 `=disabled` 单值写法:显式写"disabled" ⇒ 禁用(且只对这一个能力禁用)
  const envRaw =
    (typeof import.meta !== "undefined" &&
      (import.meta as { env?: Record<string, string | undefined> }).env?.[FEATURE_TO_ENV[feature]]) ??
    (typeof process !== "undefined" ? process.env?.[FEATURE_TO_ENV[feature]] : undefined);
  if (typeof envRaw === "string" && envRaw.trim().toLowerCase() === "disabled") {
    return false;
  }
  const env = readDisabledFromEnv(feature);
  if (env.has(feature)) return false;
  return true;
}

/**
 * rotation.ts — device-orientation (rotation lock / forced orientation) 的前端真源。
 *
 * 平板 OS 的快速设置里有一个「旋转锁定」按钮（REQ-A677）。**决策**只有一份：
 * Rust 侧纯内核 `amos_display::orientation`（`RotationMode` 4 个 key、Android
 * `ActivityInfo` requested-orientation 码的映射、以及哪个模式会「冻结」显示）。
 * 本文件是它在 TS 侧**同一套词表**的镜像 —— UI 只持有意图，真正把显示转过去的
 * 是宿主 `rotation_set`（桌面 / CI 诚实地答 `hostOnly`，绝不假装已应用）。
 *
 * 反 drift：Rust `crates/amos-display/src/orientation.rs` 的 key 集合与这里
 * `ROTATION_MODES` 必须一致，被 `src/lib/__tests__/rotation.test.ts` 的负控钉住
 * （改了 key 却不改这里 → 测试红）。
 *
 * 诚实边界：
 *   * 这是**用户设的偏好**（`configuration`），不是设备状态的镜像 —— Android 的
 *     requestedOrientation 不跨进程存活，所以 Rust 在启动时用 `apply_persisted`
 *     重新应用；桌面 / CI 只会把意图存下来。
 *   * `auto` 是默认（未锁定）：一个损坏的 store 必须回落到 `auto`，绝不能把显示
 *     永久冻住。
 */

/** 仓内**唯一**真源；其他文件必须 import 这个常量，不允许内联这个字面量。 */
export const ROTATION_KEY = "amos.rotation";

/** 四个模式 key —— 与 Rust `RotationMode::key()` 逐字一致。 */
export const ROTATION_MODES = ["auto", "locked", "portrait", "landscape"] as const;

export type RotationMode = (typeof ROTATION_MODES)[number];

/** 默认模式：未锁定，跟随设备重力。 */
export const DEFAULT_ROTATION_MODE: RotationMode = "auto";

/** 是否是一个已知的模式 key（用于校验来自宿主 / store 的字符串）。 */
export function isRotationMode(v: unknown): v is RotationMode {
  return typeof v === "string" && (ROTATION_MODES as readonly string[]).includes(v);
}

/** 任意 unknown（absent / corrupt / 未知 key）→ 合法 RotationMode，失败回落 `auto`。 */
export function normalizeRotation(raw: unknown): RotationMode {
  if (isRotationMode(raw)) return raw;
  // 也接受宿主存下来的对象形状 `{ mode }`（与 Rust `RotationStore` 同形）。
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const m = (raw as Record<string, unknown>).mode;
    if (isRotationMode(m)) return m;
  }
  return DEFAULT_ROTATION_MODE;
}

/** 模式的 i18n 标签 key（UI 只调这个，不内联字符串）。 */
export function rotationLabelKey(mode: RotationMode): string {
  return `rotation.${mode}`;
}

/**
 * 该模式是否**冻结**显示（即「锁定」，非 auto）。与 Rust `RotationMode::freezes`
 * 同义 —— 用于把快速设置 tile 画成 on/off。与内核「哪个模式不冻结」的集合由
 * `src/__tests__/declaredMirrors.test.ts` 绑定（读 Rust 的 `key()`/`freezes()` 臂）。
 */
export function rotationFreezes(mode: RotationMode): boolean {
  return mode !== "auto";
}

/** 设备的物理朝向（由显示宽高判定）—— 与 Rust `orientation_of` 同义。 */
export type ScreenOrientation = "portrait" | "landscape";

/**
 * 宽度 > 高度 ⇒ 横屏，否则竖屏（正方形算竖屏，与 Rust 内核一致）。
 *
 * 与 Rust `amos_display::orientation::orientation_of` 的**严格性**由
 * `src/__tests__/declaredMirrors.test.ts` 绑定（读 Rust 源码断言用 `>` 而非 `>=`，
 * 否则正方形会变横屏、与本文件的 home grid 分岔）。
 */
export function orientationOf(width: number, height: number): ScreenOrientation {
  return width > height ? "landscape" : "portrait";
}

/**
 * 宿主 `rotation_set` 的应答形状（`RotationApplied`，camelCase）。字段与 `outcome`
 * 的 tagged 形状由 `src/__tests__/declaredMirrors.test.ts` 读
 * `crates/amos-tauri/src/rotation.rs` 逐序绑定（改名会让 `applied.available` 静默变
 * `undefined`）。
 * `outcome.state` 是**事实**：桌面 / CI 是 `hostOnly`，设备上未落地时是
 * `unattached`/`unavailable`/`denied`/`unknown` —— 绝不四舍五入成 `applied`。
 */
export interface RotationApplied {
  mode: string;
  available: boolean;
  outcome: { state: string; detail?: string };
}

/**
 * 宿主 `rotation_get` 的应答形状（`RotationSnapshot`，camelCase）。字段与 Rust
 * `rotation.rs` 的 `RotationSnapshot` 由 `src/__tests__/declaredMirrors.test.ts` 逐序绑定。
 */
export interface RotationSnapshot {
  mode: string;
  available: boolean;
}

/**
 * 一次 `rotation_set` 之后，UI 该说的话：`applied` 表示平台真的转了；其余都是
 * **未生效**的诚实状态。桌面 / CI 的 `hostOnly` 不能读成"失败"——意图已存，只是
 * 这个宿主没有可控制的方向。
 */
export type RotationTapResult =
  | { kind: "applied" }
  | { kind: "host_only" }
  | { kind: "unapplied"; state: string; detail: string };

/** 把宿主应答分类成 UI 的一句话。未知 state 归入 `unapplied`（诚实的兜底）。 */
export function classifyRotationOutcome(applied: RotationApplied): RotationTapResult {
  const state = applied.outcome.state;
  if (state === "applied") return { kind: "applied" };
  if (state === "host_only") return { kind: "host_only" };
  return { kind: "unapplied", state, detail: applied.outcome.detail ?? "" };
}

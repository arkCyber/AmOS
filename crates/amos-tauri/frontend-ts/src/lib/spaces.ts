/**
 * Space (虚拟桌面) type definitions and bridge layer.
 *
 * 状态：完整实现（2026-09-16）
 *
 * REQ-SPACES: virtual-desktop management.
 * Detailed plan: docs/SPACES_IMPLEMENTATION_PLAN.md.
 *
 * ## Bridge contract (REQ-A296)
 *
 * Every export here reflects the real `lib/backend.invoke` contract:
 *   * `invoke<T>` resolves to `T | null` — failures are NOT thrown, they're
 *     logged through `bridgeDiag(command)` with the structured `AmosError`.
 *     Earlier `Promise<T>` signatures here were TypeScript lies: a failed
 *     `spaces_list` would silently assign `null` to a typed `Space[]`, breaking
 *     SpacesPanel.svelte without ever firing `catch`.
 *   * Read calls return `T | null`. Mutation calls return `boolean`. Callers
 *     read `bridgeDiag("spaces_<command>").detail.code` to surface the typed
 *     `amos.spaces.*` code and translate it in the UI.
 *   * `spaces_switch` is the exception, and deliberately so (REQ-A513): it
 *     returns a [`SpaceSwitchReport`] because a command with a **unit** reply
 *     cannot be reported through `boolean` at all — `()` arrives as `null`, the
 *     same value the bridge uses for a failure, so `result !== null` was
 *     `false` on success too. The four remaining unit-reply mutations answer
 *     through the ledger instead (`unitMutationOk`).
 */

import { invoke, bridgeDiag } from "./backend";
import type { WmWindowInfo, WmWindowsSnapshot } from "./wm";

// ─── Types ────────────────────────────────────────────────────────────

/**
 * One virtual desktop (Space).
 */
export interface Space {
  /** Unique identifier (e.g. "space-0"). */
  id: string;

  /** User-visible name (editable). */
  name: string;

  /** Window labels that belong to this Space. */
  windows: string[];
}

/**
 * Transport-side mirror of `Space` — same shape, kept distinct so a future
 * wire-contract change can fork types instead of breaking every consumer.
 */
export interface SpaceInfo {
  id: string;
  name: string;
  windows: string[];
}

// ─── API ──────────────────────────────────────────────────────────────

/**
 * 列出所有虚拟桌面 — `null` when the bridge is offline or the command fails.
 *
 * Read `bridgeDiag("spaces_list")` after a `null` to surface the typed error.
 */
export async function listSpaces(): Promise<Space[] | null> {
  return await invoke<Space[] | null>("spaces_list");
}

/**
 * 当前活动桌面的索引 — `null` when offline.
 */
export async function activeSpace(): Promise<number | null> {
  return await invoke<number | null>("spaces_active");
}

/**
 * 切换到指定桌面。
 *
 * Returns the **report** on success and `null` when the command was refused. The typed error
 * lives in `bridgeDiag("spaces_switch").detail.code` and is one of
 * `amos.spaces.lock_failed` / `amos.spaces.index_out_of_bounds`.
 *
 * REQ-A513: 从前这里返回 `boolean`，判据是 `result !== null` —— 而命令返回 `()`（wire 上 `null`）
 * 且桥把失败也表达成 `null`，所以那个布尔**恒为 false**：切换成功时 `MissionControl` 不关闭浮层、
 * `SpacesPanel` 写一行"切换失败"。现在成功是**对象**、拒绝是 `null`，两者分得开；
 * `hide_failed` / `show_failed` 是"账本动了、屏幕没动"的窗口（从前只进 `tracing::warn!`）。
 */
export async function switchSpace(index: number): Promise<SpaceSwitchReport | null> {
  return await invoke<SpaceSwitchReport | null>("spaces_switch", { index });
}

/**
 * 「活动桌面换过了」的同窗口通告（REQ-A1311 / F-SH-585）。
 *
 * 拥有这条事实的属主有三个（桌面壳的 ⌃←/⌃→ 与 ⌃1…9、SpacesPanel 的卡片、MissionControl 的
 * 顶部栏），而**显示**这条事实的面还有别的（面板开着的时候按 ⌃←/⌃→，跑的是壳那一份 ——
 * 壳在 **capture** 阶段消费这条弦并 `stopPropagation()`，面板自己的监听器收不到）。
 * 于是属主换了桌面，显示的那一面还停在旧桌面上：同一个事实两种说法。
 *
 * 这里只**通告**，不带索引：索引的权威仍是宿主（`spaces_active`），消费者收到通告后去
 * **重新读一次**，而不是相信一个随事件捎来的副本 —— 与 `lib/dockConfig.ts` 的
 * `emitDockBounce` 同一个形状（同窗口 `CustomEvent`，消费面各自订阅）。
 */
export const SPACES_CHANGED_EVENT = "spaces-changed";

/** 通告：活动桌面换过了。没有窗口环境时（SSR ∕ 纯逻辑测试）静默。 */
export function announceSpacesChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SPACES_CHANGED_EVENT));
}

/**
 * 订阅"活动桌面换过了"。返回退订函数。
 *
 * 订阅方**不应该**把通告当成新索引（通告不带索引），而应当回去问宿主 —— 见
 * [`announceSpacesChanged`] 的理由。
 */
export function onSpacesChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SPACES_CHANGED_EVENT, handler);
  return () => window.removeEventListener(SPACES_CHANGED_EVENT, handler);
}

/**
 * 创建新的虚拟桌面。
 * Returns the new id, or `null` on failure.
 */
export async function createSpace(name: string): Promise<string | null> {
  return await invoke<string | null>("spaces_create", { name });
}

/**
 * 删除指定的虚拟桌面。不能删除最后一个桌面时返回 `false`,
 * 读 `bridgeDiag("spaces_delete")` 拿 `amos.spaces.delete_last` code。
 */
export async function deleteSpace(id: string): Promise<boolean> {
  await invoke<null>("spaces_delete", { id });
  return unitMutationOk("spaces_delete");
}

/**
 * 切换桌面时的**结果读数**（REQ-A513）—— 与 `spaces_commands::SpaceSwitchReport` 一一对应。
 *
 * 为什么不是 `boolean`：命令从前返回 `()`，wire 上是 `null`，而桥把"失败"也表达成 `null`
 * ⇒ `result !== null` **永远为 false**（切换成功也报失败）。现在成功返回这个对象（非 null），
 * 拒绝返回 `null`，两者终于分得开；顺带把"账本动了、屏幕没动"的窗口带给壳。
 */
export interface SwitchFailure {
  label: string;
  reason: string;
}

export interface SpaceSwitchReport {
  index: number;
  hide_failed: SwitchFailure[];
  show_failed: SwitchFailure[];
}

/**
 * 一个**返回 `()`** 的 mutation 是否成功（REQ-A513）。
 *
 * `() `在 wire 上就是 `null`，而桥的约定是"失败也返回 `null`"（`lib/backend.invoke` 把错误
 * 吞进诊断台账并返回 `null`）⇒ `result !== null` 对这类命令**恒为 false**：
 * `deleteSpace` / `renameSpace` / `moveWindowToSpace` / `unfileWindow` 四个包装器都一直答
 * "失败"，而 `SpacesPanel` 因此把成功的操作也写成一行错误。
 *
 * 唯一分得开两者的地方是台账：`invoke` 每次调用后写 `{ ok }`（`bridgeDiag(command)`）。
 * 边界（诚实）：台账是**按命令名**保留最近一次的读数，所以同一个命令被两处**并发**调用时，
 * 这里读到的是"最近一次完成"的那条 —— 与壳里 `DesktopShell` 处理 `spaces_switch` 的既有做法
 * 同一条约定（也是本仓对"返回值分不开"这类桥的既有读法）。
 */
function unitMutationOk(command: string): boolean {
  return bridgeDiag(command).ok;
}

/**
 * 将窗口移动到另一个虚拟桌面。
 * Returns `true` on success, `false` on failure.
 */
export async function moveWindowToSpace(
  windowLabel: string,
  spaceId: string,
): Promise<boolean> {
  await invoke<null>("spaces_move_window", { windowLabel, spaceId });
  return unitMutationOk("spaces_move_window");
}

/**
 * 把一个窗口从**所有**虚拟桌面移出 —— `moveWindowToSpace` 的反向操作（REQ-A450）。
 *
 * 未归档的窗口在**每个**桌面都可见：那是每个窗口的初始状态，也是这条命令唯一能到达的状态
 * （`move_window_to_space` 只能在桌面之间搬，搬不回"谁都没归档"）。
 * Returns `true` on success, `false` on failure.
 */
export async function unfileWindow(windowLabel: string): Promise<boolean> {
  await invoke<null>("spaces_unfile_window", { windowLabel });
  return unitMutationOk("spaces_unfile_window");
}

/**
 * 重命名虚拟桌面。
 * Returns `true` on success, `false` on failure.
 */
export async function renameSpace(id: string, name: string): Promise<boolean> {
  await invoke<null>("spaces_rename", { id, name });
  return unitMutationOk("spaces_rename");
}

// `bridgeDiag` is imported above for the file-top comment; callers should
// import it directly from `./backend` rather than relying on a re-export
// (keeps the API surface obvious: `spaces_*` is this file, `bridgeDiag` is
// the shared diagnostic helper).

// ─── Navigation math (pure) ───────────────────────────────────────────

/**
 * The next active-space index when the user hits `Ctrl+←` (wrap left).
 *
 * `current` is 0-based; `spaceCount` is the number of spaces returned by
 * `listSpaces()` (an empty array counts as `0`). The math is **cyclic**
 * because there is no "end" of the desktop rail a user could want to
 * fall off — it is the same invariant the host applies to its own
 * switching and is the one the shell's keyboard handler reuses verbatim
 * (REQ-A340).
 *
 * Three guarantees a unit test can lean on without a bridge:
 *   1. **Cyclic** — going left from `0` lands on the **last** index
 *      (`spaceCount - 1`), so `Ctrl+←` from the first space always does
 *      something visible;
 *   2. **Stationary when empty / single** — with 0 or 1 spaces, the
 *      result is `0` (the only valid position), so the shortcut is
 *      harmless when there is nothing to navigate to;
 *   3. **Step size 1** — every other case decrements by exactly 1, so
 *      the shell's `switchSpace()` call never has to range-check.
 *
 * Returning `null` means "the caller's preconditions do not hold"
 * (negative `current`, negative `spaceCount`); the production handler
 * does not branch on that case because it always reads from the bridge,
 * but a test / future caller may want to surface it.
 */
export function prevSpaceIndex(current: number, spaceCount: number): number | null {
  if (current < 0 || spaceCount < 0) return null;
  if (spaceCount === 0) return 0;
  if (current === 0) return spaceCount - 1;
  return current - 1;
}

/**
 * The next active-space index when the user hits `Ctrl+→` (wrap right).
 *
 * Same three guarantees as [`prevSpaceIndex`], mirrored for the right
 * direction. Single / empty arrays return `0` so the shortcut is
 * stationary when there is nothing to step through — a `1 → 2 → 1 → …`
 * loop on a single space would otherwise still call `switchSpace(0)`
 * and round-trip the bridge for nothing.
 */
export function nextSpaceIndex(current: number, spaceCount: number): number | null {
  if (current < 0 || spaceCount < 0) return null;
  if (spaceCount === 0) return 0;
  if (current === spaceCount - 1) return 0;
  return current + 1;
}

/**
 * The windows a desktop can own, out of a `wm_windows` snapshot (REQ-A449).
 *
 * Only `kind === "App"` and not `external`. Each exclusion is a decision, not a filter for
 * tidiness:
 *
 *   1. the **Launcher** *is* the surface the desktops live on — the host's `switch_plan` never
 *      hides or focuses it, so offering to file it would be a lie the UI then has to explain;
 *   2. a **System** surface (notification centre, control panel, dialogs) belongs to no desktop
 *      and follows focus instead;
 *   3. an `external` composited surface has no `WebviewWindow` of ours, so "hide it" cannot
 *      resolve to anything.
 *
 * Pure and typed against the host's own snapshot ([`WmWindowsSnapshot`]) so a caller cannot pass a
 * half-shaped object: the import is type-only, so nothing new is pulled in at runtime. Testable
 * without a bridge, the same way [`prevSpaceIndex`] is.
 */
export function fileableWindows(snapshot: WmWindowsSnapshot): WmWindowInfo[] {
  return snapshot.windows.filter((w) => w.kind === "App" && !w.external);
}

/**
 * Why a `spaces_*` command was refused, as the **one** rule that turns the typed
 * `amos.spaces.*` code into the sentence a user reads (F-SH-577).
 *
 * 这条映射从前只住在 `SpacesPanel.svelte` 的局部函数 `spacesErrorLabel` 里，于是**同一个
 * 拒绝**只有一处说得出话：Mission Control 的 Spaces 栏点下去被宿主拒掉时，浮层留着不动、
 * 屏幕上没有一个字 —— 用户看到的"点了没反应"与"坏了"完全同形（FMEA F-SH-001 那一族），
 * 而它的姊妹面（`SpacesPanel` 的 `applySwitch`）对**同一个** `spaces_switch` 拒绝是写下一行
 * 错误再留着的。两个面报同一件事，规则只能有一份 —— 这里回答"哪一条"，参数化与语言由调用点
 * 的 `t()` 负责。
 *
 * `hostMessage` 是宿主自己写下的句子，只在**没有任何已知 code** 可映射时才给 —— 与
 * `SpacesPanel` 从前的行为逐字一致（`detail?.message ?? t("spaces.errorUnknown")`），
 * 所以这条规则的搬家没有改变任何一个字符的输出。
 *
 * `bridgeDiag` 是**按命令名**保留最近一次读数的，所以调用点必须传它自己刚跑的那条命令
 * （同一个命令被并发调用时读到的是最近一次完成的那条 —— 本仓对"返回值分不开"的既有读法）。
 */
export function spacesFailure(command: string): { key: string; hostMessage?: string } {
  const diag = bridgeDiag(command);
  // 台账里没有失败记录 ⇒ 只可能是"没有任何话可说"的那一支（调用点的 `null` 判据才是权威）。
  if (diag.ok) return { key: "spaces.errorUnknown" };
  const detail =
    diag.kind === "command-failed" && diag.detail && typeof diag.detail === "object"
      ? (diag.detail as { code?: string; message?: string })
      : null;
  switch (detail?.code) {
    case "amos.spaces.lock_failed":
      return { key: "spaces.errorLockFailed" };
    case "amos.spaces.serialization_failed":
      return { key: "spaces.errorSerialization" };
    case "amos.spaces.not_found":
      return { key: "spaces.errorNotFound" };
    case "amos.spaces.index_out_of_bounds":
      return { key: "spaces.errorOutOfBounds" };
    case "amos.spaces.delete_last":
      return { key: "spaces.errorDeleteLast" };
    default:
      return { key: "spaces.errorUnknown", hostMessage: detail?.message };
  }
}

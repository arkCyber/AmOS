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
 */

import { invoke } from "./backend";

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
 * Returns `true` on success, `false` on failure. The typed error lives in
 * `bridgeDiag("spaces_switch").detail.code` and is one of
 * `amos.spaces.lock_failed` / `amos.spaces.index_out_of_bounds`.
 */
export async function switchSpace(index: number): Promise<boolean> {
  const result = await invoke<null>("spaces_switch", { index });
  return result !== null;
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
  const result = await invoke<null>("spaces_delete", { id });
  return result !== null;
}

/**
 * 将窗口移动到另一个虚拟桌面。
 * Returns `true` on success, `false` on failure.
 */
export async function moveWindowToSpace(
  windowLabel: string,
  spaceId: string,
): Promise<boolean> {
  const result = await invoke<null>("spaces_move_window", { windowLabel, spaceId });
  return result !== null;
}

/**
 * 重命名虚拟桌面。
 * Returns `true` on success, `false` on failure.
 */
export async function renameSpace(id: string, name: string): Promise<boolean> {
  const result = await invoke<null>("spaces_rename", { id, name });
  return result !== null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Returns `true` iff `listSpaces()` resolved with a non-null array.
 * The old form (`try/catch` around `await listSpaces()`) never fired because
 * `invoke` swallows failures into `null` — see the file-top comment.
 */
export async function isSpacesAvailable(): Promise<boolean> {
  const list = await listSpaces();
  return list !== null;
}

/**
 * Human-readable status string for diagnostics / the Settings screen.
 * `"Spaces 功能已启用"` (zh) / equivalent in en.
 */
export async function getSpacesStatus(): Promise<string> {
  const available = await isSpacesAvailable();
  return available
    ? "Spaces 功能已启用"
    : "Spaces 功能不可用";
}

// `bridgeDiag` is imported above for the file-top comment; callers should
// import it directly from `./backend` rather than relying on a re-export
// (keeps the API surface obvious: `spaces_*` is this file, `bridgeDiag` is
// the shared diagnostic helper).

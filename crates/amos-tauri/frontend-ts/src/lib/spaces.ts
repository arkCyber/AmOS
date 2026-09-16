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
 * The auto-name a new Space gets when the user hits `Ctrl+↑`:
 * `"Space ${spaceCount + 1}"`.
 *
 * One place for the convention; if the UI ever switches to "Desk {n}"
 * or some localised form, every test and the handler move together.
 */
export function newSpaceName(spaceCount: number): string {
  return `Space ${spaceCount + 1}`;
}

/**
 * The index of the newly-created space in a refreshed listing, or `-1`
 * if the create did not show up in the list (a host that returns the
 * old snapshot, a deleted-by-mistake race, etc.).
 *
 * The caller already guards the `-1` branch by short-circuiting before
 * `switchSpace`; we expose the helper so a test can pin both the
 * "found it" path and the "never landed" path without a bridge.
 */
export function indexOfCreatedSpace(
  refreshed: readonly { id: string }[],
  newId: string,
): number {
  return refreshed.findIndex((s) => s.id === newId);
}

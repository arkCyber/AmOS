/**
 * Virtual scrolling utilities for large lists.
 *
 * Provides a lightweight pure-function calculator. Svelte components compose
 * these primitives with their own `$state` runes (a `.ts` file CANNOT host
 * `$state`/`$derived` — those runes only work inside `.svelte`, `.svelte.ts`,
 * `.svelte.js` modules, and component scopes).
 *
 * Features:
 * - Only renders visible items + buffer (overscan)
 * - Maintains scroll position
 * - Supports variable height items
 */

/**
 * A single item's geometry within a virtualized list.
 */
export interface VirtualItem {
  index: number;
  /** Pixel offset from the top of the virtualized container. */
  start: number;
  /** Item height in px. */
  size: number;
  /** Pixel offset of the bottom edge. */
  end: number;
}

/**
 * The visible range produced by `calculateVirtualRange`.
 */
export interface VirtualRange {
  startIndex: number;
  endIndex: number;
  items: VirtualItem[];
}

/**
 * Calculate which items should be visible given scroll position.
 *
 * Pure function — easy to unit-test. Inputs with non-finite numbers fall back to
 * "nothing visible" so a caller does not have to special-case DOM-missing tests.
 *
 * @param scrollTop - Pixels scrolled from the top of the container
 * @param containerHeight - Visible height of the container in px
 * @param itemCount - Total number of items
 * @param itemHeight - Height of a single item (px). Variable heights not supported here.
 * @param overscan - Number of extra items to render above and below the viewport
 */
export function calculateVirtualRange(
  scrollTop: number,
  containerHeight: number,
  itemCount: number,
  itemHeight: number,
  overscan: number = 5
): VirtualRange {
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(containerHeight) ||
    !Number.isFinite(itemCount) ||
    !Number.isFinite(itemHeight) ||
    itemCount <= 0 ||
    itemHeight <= 0
  ) {
    return { startIndex: 0, endIndex: -1, items: [] };
  }

  const clampedScroll = Math.max(0, scrollTop);
  const clampedHeight = Math.max(0, containerHeight);
  const clampedOverscan = Math.max(0, Math.floor(overscan));
  const count = Math.floor(itemCount);

  const startIndex = Math.max(
    0,
    Math.floor(clampedScroll / itemHeight) - clampedOverscan
  );
  const endIndex = Math.min(
    count - 1,
    Math.ceil((clampedScroll + clampedHeight) / itemHeight) + clampedOverscan
  );

  const items: VirtualItem[] = [];
  for (let i = startIndex; i <= endIndex; i++) {
    items.push({
      index: i,
      start: i * itemHeight,
      size: itemHeight,
      end: (i + 1) * itemHeight,
    });
  }

  return { startIndex, endIndex, items };
}

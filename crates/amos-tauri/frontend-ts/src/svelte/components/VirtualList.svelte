<script lang="ts" generics="T">
  /**
   * VirtualList.svelte — 虚拟滚动列表组件
   * 
   * 仅渲染可见区域的项目，大幅提升长列表性能。
   * 支持动态高度和固定高度两种模式。
   * 
   * @example
   * ```svelte
   * <VirtualList
   *   items={logs}
   *   itemHeight={80}
   *   containerHeight={600}
   *   buffer={5}
   * >
   *   {#snippet renderItem(log)}
   *     <LogItem {log} />
   *   {/snippet}
   * </VirtualList>
   * ```
   */

  import type { Snippet } from "svelte";

  interface Props<T> {
    /** 列表数据 */
    items: T[];
    /** 项目高度（固定值或计算函数） */
    itemHeight: number | ((item: T, index: number) => number);
    /** 容器高度 */
    containerHeight: number;
    /** 缓冲区大小（可见区域外额外渲染的项目数） */
    buffer?: number;
    /** 渲染单个项目的插槽 */
    renderItem: Snippet<[T, number]>;
    /** 子内容 */
    children?: Snippet;
  }

  let {
    items,
    itemHeight,
    containerHeight,
    buffer = 3,
    renderItem,
    children,
  }: Props<T> = $props();

  // ============================================================================
  // 状态管理
  // ============================================================================

  let scrollTop = $state(0);
  let containerEl: HTMLDivElement | undefined = $state();

  // ============================================================================
  // 计算属性
  // ============================================================================

  /** 获取单个项目的高度 */
  function getItemHeight(item: T, index: number): number {
    return typeof itemHeight === "function"
      ? itemHeight(item, index)
      : itemHeight;
  }

  /** 计算总高度 */
  const totalHeight = $derived(
    items.reduce((sum, item, idx) => sum + getItemHeight(item, idx), 0)
  );

  /** 计算可见范围 */
  const visibleRange = $derived(() => {
    let startIndex = 0;
    let currentOffset = 0;
    
    // 找到第一个可见项
    for (let i = 0; i < items.length; i++) {
      const height = getItemHeight(items[i], i);
      if (currentOffset + height > scrollTop) {
        startIndex = Math.max(0, i - buffer);
        break;
      }
      currentOffset += height;
    }

    // 计算可见项数量
    let endIndex = startIndex;
    let visibleHeight = 0;
    for (let i = startIndex; i < items.length; i++) {
      visibleHeight += getItemHeight(items[i], i);
      endIndex = i;
      if (visibleHeight >= containerHeight + buffer * 50) {
        break;
      }
    }

    endIndex = Math.min(items.length - 1, endIndex + buffer);

    return { startIndex, endIndex };
  });

  /** 可见项目 */
  const visibleItems = $derived(
    items.slice(visibleRange().startIndex, visibleRange().endIndex + 1)
  );

  /** 计算偏移量（顶部填充） */
  const offsetY = $derived(() => {
    let offset = 0;
    for (let i = 0; i < visibleRange().startIndex; i++) {
      offset += getItemHeight(items[i], i);
    }
    return offset;
  });

  // ============================================================================
  // 事件处理
  // ============================================================================

  function handleScroll(event: Event) {
    const target = event.target as HTMLDivElement;
    scrollTop = target.scrollTop;
  }
</script>

<div
  bind:this={containerEl}
  class="virtual-list-container"
  style="height: {containerHeight}px; overflow-y: auto;"
  onscroll={handleScroll}
>
  <div class="virtual-list-spacer" style="height: {totalHeight}px; position: relative;">
    <div class="virtual-list-content" style="transform: translateY({offsetY()}px);">
      {#each visibleItems as item, idx}
        {@const actualIndex = visibleRange().startIndex + idx}
        <div
          class="virtual-list-item"
          style="height: {getItemHeight(item, actualIndex)}px;"
          data-index={actualIndex}
        >
          {@render renderItem(item, actualIndex)}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .virtual-list-container {
    position: relative;
    width: 100%;
    overflow-x: hidden;
  }

  .virtual-list-spacer {
    width: 100%;
  }

  .virtual-list-content {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
  }

  .virtual-list-item {
    width: 100%;
    overflow: hidden;
  }
</style>

<script lang="ts">
  /**
   * LazyImage.svelte — 懒加载图片组件
   * 
   * 使用 IntersectionObserver 实现图片懒加载，
   * 仅在图片进入可视区域时才加载真实图片。
   * 
   * @example
   * ```svelte
   * <LazyImage
   *   src="/path/to/image.jpg"
   *   alt="描述"
   *   placeholder="/placeholder.jpg"
   *   threshold={0.1}
   * />
   * ```
   */

  interface Props {
    /** 图片 URL */
    src: string;
    /** 替代文本 */
    alt: string;
    /** 占位图片（可选） */
    placeholder?: string;
    /** CSS 类名 */
    class?: string;
    /** 触发加载的可见比例（0-1） */
    threshold?: number;
    /** 根元素边距 */
    rootMargin?: string;
    /** 图片加载回调 */
    onload?: () => void;
    /** 图片错误回调 */
    onerror?: (error: Event) => void;
  }

  let {
    src,
    alt,
    placeholder = "",
    class: className = "",
    threshold = 0.1,
    rootMargin = "50px",
    onload,
    onerror,
  }: Props = $props();

  // ============================================================================
  // 状态管理
  // ============================================================================

  let imageLoaded = $state(false);
  let imageError = $state(false);
  let isIntersecting = $state(false);
  let imgEl: HTMLImageElement | undefined = $state();

  // 当前显示的 src
  const currentSrc = $derived(
    imageLoaded ? src : placeholder || ""
  );

  // ============================================================================
  // IntersectionObserver 设置
  // ============================================================================

  $effect(() => {
    if (!imgEl || typeof IntersectionObserver === "undefined") {
      // 降级：直接加载图片
      isIntersecting = true;
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            isIntersecting = true;
            observer.disconnect();
          }
        });
      },
      {
        threshold,
        rootMargin,
      }
    );

    observer.observe(imgEl);

    return () => observer.disconnect();
  });

  // ============================================================================
  // 图片加载逻辑
  // ============================================================================

  $effect(() => {
    if (!isIntersecting || imageLoaded || !src) return;

    const img = new Image();

    img.onload = () => {
      imageLoaded = true;
      imageError = false;
      onload?.();
    };

    img.onerror = (event) => {
      imageError = true;
      onerror?.(event);
    };

    img.src = src;
  });
</script>

<img
  bind:this={imgEl}
  src={currentSrc}
  {alt}
  class="lazy-image {className}"
  class:loaded={imageLoaded}
  class:error={imageError}
  class:loading={!imageLoaded && !imageError}
/>

<style>
  .lazy-image {
    display: block;
    width: 100%;
    height: auto;
    transition: opacity 0.3s ease;
  }

  .lazy-image.loading {
    opacity: 0.5;
    background: #f2f2f7;
  }

  .lazy-image.loaded {
    opacity: 1;
  }

  .lazy-image.error {
    opacity: 0.3;
    background: #ffe5e5;
  }
</style>

<script lang="ts">
  /**
   * LazyImage.svelte — lazy image loading (REQ-A587).
   *
   * The `<img>` only receives the real `src` once the element has been seen by an
   * `IntersectionObserver`; everything else is the *caller's* business, because what a
   * not-yet-loaded tile should look like is a layout decision, not a component's.
   *
   * Adopting this into the photo grid (the surface the backlog named: a page of 60 tiles
   * used to decode all 60 at once) exposed three defects that only a real caller sees:
   *
   *  1. an empty `src` was rendered (`src={placeholder || ""}`) — an `<img src="">` makes the
   *     browser request the *page* URL and paints a broken-image glyph. When there is no
   *     placeholder the attribute is now **omitted**;
   *  2. it preloaded through `new Image()` and only then assigned the element's `src`, so a
   *     data-URL tile was decoded **twice** (once off-DOM, once by the element) and nothing
   *     appeared until the off-DOM load finished. The element's own `load`/`error` events now
   *     drive the state — one fetch, one decode;
   *  3. its own style block forced `width: 100%; height: auto`, which fights a caller that positions
   *     the image (`absolute inset-0 h-full w-full object-cover` in the grid). The base class
   *     now carries **no layout at all**;
   *
   * and it gained the two hints that make the native path honest when the observer is absent:
   * `loading="lazy"` and `decoding="async"`. Without `IntersectionObserver` (a non-browser
   * test/build, an ancient engine) the image is shown immediately — never hidden forever.
   *
   * The visual states are deliberately thin: `loaded` and `error` are classes the caller may
   * style, and a caller that passes **no** `placeholder` gets `hidden-until-loaded` so whatever
   * it renders underneath (the grid's glyph) is what the user sees until the photo is ready.
   * A caller that *does* pass a placeholder keeps the blur-up it asked for.
   *
   * @example
   * ```svelte
   * <LazyImage src={photo.data} alt="" class="absolute inset-0 h-full w-full object-cover" />
   * ```
   */

  // `extends Record<string, unknown>` + `$props<Props>()` 是本仓既有的写法
  // （见 FileErrorBanner.svelte）：直接 `: Props = $props()` 时 svelte-check 会报
  // 「Type 'Record<string, unknown>' is missing the following properties from type 'Props'」。
  interface Props extends Record<string, unknown> {
    /** 图片 URL */
    src: string;
    /** 替代文本 */
    alt: string;
    /** 占位图片（可选）；给了它就会在真实图片就绪前显示，没给则整张图在就绪前不可见 */
    placeholder?: string;
    /** CSS 类名 */
    class?: string;
    /** 触发加载的可见比例（0-1） */
    threshold?: number;
    /** 根元素边距 */
    rootMargin?: string;
    /** 图片加载回调 */
    onload?: () => void;
    /** 图片错误回调（`HTMLImageElement.onerror` 的入参是 `Event | string`，照实转发） */
    onerror?: (error: Event | string) => void;
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
  } = $props<Props>();

  let imageLoaded = $state(false);
  let imageError = $state(false);
  let isIntersecting = $state(false);
  let imgEl: HTMLImageElement | undefined = $state();

  /**
   * The `src` the element carries right now: the real one once the tile has been seen, the
   * caller's placeholder while it has not, and **nothing** when there is neither — an omitted
   * attribute instead of `src=""` (which requests the page URL).
   */
  const shownSrc = $derived(isIntersecting ? src : placeholder === "" ? undefined : placeholder);

  $effect(() => {
    if (!imgEl || typeof IntersectionObserver === "undefined") {
      // 降级：没有观察者就直接显示（绝不让图片永远藏着）
      isIntersecting = true;
      return;
    }
    if (isIntersecting) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            isIntersecting = true;
            observer.disconnect();
            return;
          }
        }
      },
      { threshold, rootMargin },
    );

    observer.observe(imgEl);
    return () => observer.disconnect();
  });
</script>

<img
  bind:this={imgEl}
  src={shownSrc}
  {alt}
  class="lazy-image {className}"
  class:loaded={imageLoaded}
  class:error={imageError}
  class:hidden-until-loaded={placeholder === ""}
  loading="lazy"
  decoding="async"
  onload={() => {
    imageLoaded = true;
    imageError = false;
    onload?.();
  }}
  onerror={(event) => {
    imageError = true;
    onerror?.(event);
  }}
/>

<style>
  /* No layout here on purpose: the caller positions the image (see the header). Only the
     state hooks live in this file, and both are inert unless the caller styles them. */
  .lazy-image {
    display: block;
  }

  /* No placeholder was given → stay invisible until the real bytes are decoded, so the
     caller's own fallback (a glyph, a gradient) is what shows. */
  .lazy-image.hidden-until-loaded {
    opacity: 0;
  }
</style>

<script lang="ts">
  // SlideOverSurface.svelte — the tablet's floating third pane (REQ-A675).
  //
  // Where `SplitSurface` divides one screen between two cooperating apps, this paints
  // a single **narrow panel floating over** whatever the shell is showing (home, an
  // app, or an existing split). Nothing behind it is resized — the panel just covers
  // part of it, and the user can slide it off the edge to get at what is underneath.
  //
  // The geometry is **not** re-implemented here — every rect comes from the host's
  // `wm_slide_over_rect`, which delegates to `amos_wm::layout::slide_over_pane`. This
  // component holds only the intent (which app, which axis, what share, shown/hidden)
  // and paints what the host answers.
  //
  // Honest failure: when the host answers `null` (no bridge, a command failure, or a
  // screen that cannot hold a minimum panel) the component keeps the **previous** rect
  // and says so in the diagnostics log. It never invents a layout — a fabricated panel
  // would be a surface the user cannot actually use.
  import { onMount } from "svelte";
  import AppPane from "./AppPane.svelte";
  import { t } from "./locale.svelte";
  import { amosWarn } from "../lib/debugLog";
  import { wmSlideOverRect, type PaneLayout, type FormFactor } from "../lib/wm";
  import {
    closeSlideOver,
    hideSlideOver,
    setSlideOverPercent,
    showSlideOver,
    slideOver,
  } from "./shellState.svelte";

  let { form }: { form: FormFactor } = $props();

  const s = $derived(slideOver());
  const axis = $derived(s?.axis ?? "auto");
  const percent = $derived(s?.percent ?? 33);
  const hidden = $derived(s?.hidden ?? false);

  let hostEl = $state<HTMLDivElement | null>(null);
  let size = $state({ w: 0, h: 0 });
  /** The last rect the host actually gave us; `null` until the first answer. */
  let rect = $state<PaneLayout | null>(null);

  // Which way the panel went. Derived from the rect, not from the intent: `auto` is
  // resolved by the host's class rule, so the answer is the truth. A side panel is
  // taller than it is wide; a bottom panel the reverse.
  const resolvedAxis = $derived(rect && rect.width > rect.height ? "horizontal" : "vertical");

  $effect(() => {
    const a = axis;
    const p = percent;
    const { w, h } = size;
    if (w < 1 || h < 1) return;
    let alive = true;
    void wmSlideOverRect(a, p, w, h).then((r) => {
      if (!alive) return;
      if (r) rect = r;
      else
        amosWarn(
          "slide-over",
          `host refused a panel rect for ${w}x${h} @ ${p}% (${a}); keeping the last layout`,
        );
    });
    return () => {
      alive = false;
    };
  });

  onMount(() => {
    const el = hostEl;
    if (!el) return;
    const measure = () => (size = { w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // ---- Resize drag (the panel's leading edge) --------------------------------
  // Same discipline as the split divider: the pointer maps to a *share*, committed
  // through `setSlideOverPercent` (the one clamp), and the host is re-asked for the
  // rect on the next frame. The shell never resizes the panel itself.
  let dragging = $state(false);
  let rafId = 0;
  let pending = 0;

  function commitPercent(p: number): void {
    pending = p;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      setSlideOverPercent(pending);
    });
  }

  function onHandleDown(e: PointerEvent): void {
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onHandleMove(e: PointerEvent): void {
    if (!dragging || !hostEl) return;
    const r = hostEl.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    // The panel grows as the leading edge moves *away* from its hugging edge.
    const raw =
      resolvedAxis === "vertical"
        ? ((r.right - e.clientX) / r.width) * 100
        : ((r.bottom - e.clientY) / r.height) * 100;
    const next = Math.round(raw);
    if (next !== percent) commitPercent(next);
  }
  function onHandleUp(e: PointerEvent): void {
    dragging = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Already released (pointercancel); nothing to undo.
    }
  }
  /** Keyboard half of the same control: a resize handle that only answers to a finger
   * is unreachable with a keyboard or a switch device. Arrow along the axis shrinks /
   * grows the panel one point; Home/End jump to the clamped extremes. */
  function onHandleKey(e: KeyboardEvent): void {
    const grow = resolvedAxis === "vertical" ? "ArrowLeft" : "ArrowUp";
    const shrink = resolvedAxis === "vertical" ? "ArrowRight" : "ArrowDown";
    let next: number | null = null;
    if (e.key === grow) next = percent + 1;
    else if (e.key === shrink) next = percent - 1;
    else if (e.key === "Home") next = 1;
    else if (e.key === "End") next = 99;
    if (next === null) return;
    e.preventDefault();
    setSlideOverPercent(next);
  }

  // Hidden = slid fully past the screen's trailing edge. The transform is measured
  // against the host, not the panel: the panel is inset from the edge, so moving by
  // its own width would leave a margin-wide strip peeking.
  const hiddenTransform = $derived(
    !rect
      ? ""
      : resolvedAxis === "vertical"
        ? `translateX(${Math.max(0, size.w - rect.x)}px)`
        : `translateY(${Math.max(0, size.h - rect.y)}px)`,
  );
  const panelStyle = $derived(
    rect
      ? `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px` +
          (hidden ? `;transform:${hiddenTransform}` : "")
      : "",
  );
</script>

{#if s}
  <!-- The measured host is **always** mounted while a panel is intended: it is what the
       resize observer measures, so gating it on `rect` would deadlock (no host ⇒ no
       measurement ⇒ no rect). Only the painted panel waits for the host's answer. -->
  <div class="pointer-events-none absolute inset-0 z-20" bind:this={hostEl} data-testid="slide-over">
    {#if rect}
    <!-- The panel itself. Only this layer takes pointer events, so a tap on the app
         behind it still reaches the app. -->
    <div
      class="pointer-events-auto absolute overflow-hidden rounded-2xl border border-black/10 bg-white/95 shadow-2xl backdrop-blur-md transition-transform duration-200 ease-out dark:border-white/10 dark:bg-neutral-900/95"
      style={panelStyle}
      data-testid="slide-over-panel"
      data-hidden={hidden ? "true" : "false"}
    >
      <AppPane
        id={s.id}
        {form}
        variant="pane"
        paneLabel={t("slide.panel")}
        onback={closeSlideOver}
      >
        {#snippet trailing()}
          <button
            type="button"
            onclick={hideSlideOver}
            aria-label={t("a11y.slideOverHide")}
            title={t("a11y.slideOverHide")}
            data-testid="slide-over-hide"
            class="grid h-11 w-11 cursor-pointer place-items-center rounded-full text-[17px] font-semibold text-neutral-500 transition active:bg-black/5 dark:text-neutral-400 dark:active:bg-white/10"
          >»</button>
        {/snippet}
      </AppPane>
      <!-- The resize handle: a `<button>` so it carries pointer + key handlers
           without a suppression, exactly like the split divider. -->
      <button
        type="button"
        aria-label={t("a11y.slideOver")}
        data-testid="slide-over-handle"
        class={[
          "absolute touch-none border-0 bg-transparent p-0",
          resolvedAxis === "vertical" ? "cursor-col-resize" : "cursor-row-resize",
          dragging ? "bg-accent/30" : "",
        ].join(" ")}
        style={resolvedAxis === "vertical"
          ? "left:0;top:0;width:10px;height:100%"
          : "left:0;top:0;width:100%;height:10px"}
        onpointerdown={onHandleDown}
        onpointermove={onHandleMove}
        onpointerup={onHandleUp}
        onpointercancel={onHandleUp}
        onkeydown={onHandleKey}
      ></button>
    </div>

    <!-- The reveal grabber: shown only while the panel is slid off, hugging the same
         edge so the user has something to tap / swipe to bring it back. -->
    {#if hidden}
      <button
        type="button"
        onclick={showSlideOver}
        aria-label={t("a11y.slideOverShow")}
        title={t("a11y.slideOverShow")}
        data-testid="slide-over-show"
        class={[
          "pointer-events-auto absolute grid h-12 w-6 cursor-pointer place-items-center rounded-l-2xl border border-r-0 border-black/10 bg-white/90 text-neutral-500 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/90 dark:text-neutral-400",
          resolvedAxis === "vertical" ? "right-0 top-1/2 -translate-y-1/2" : "bottom-0 left-1/2 -translate-x-1/2 rotate-90",
        ].join(" ")}
      >‹</button>
    {/if}
    {/if}
  </div>
{/if}

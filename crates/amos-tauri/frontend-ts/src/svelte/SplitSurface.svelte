<script lang="ts">
  // SplitSurface.svelte — the tablet's two-pane surface (REQ-A512).
  //
  // One screen, two app panes. This is what a touch class gets instead of two native
  // windows: Tauri's mobile target hosts a **single** WebView, so `wm_open` can never
  // produce the second window `WindowPage`'s split controls expect. The geometry is
  // **not** re-implemented here — every rect comes from the host's `wm_pane_rects`,
  // which delegates to `amos_wm::layout::split_panes`, the same rule a desktop split
  // uses. This component holds only the intent (which two apps, which axis, what
  // percent) and paints what the host answers.
  //
  // Honest failure: when the host answers `null` (no bridge, a command failure, or a
  // screen that cannot host two minimum panes) the component keeps the **previous**
  // rects and says so in the diagnostics log. It never invents a layout — a
  // fabricated "split" would be a screen the user cannot actually use.
  import { onMount } from "svelte";
  import AppPane from "./AppPane.svelte";
  import { t } from "./locale.svelte";
  import { amosWarn } from "../lib/debugLog";
  import { wmPaneRects, type PaneLayout, type FormFactor } from "../lib/wm";
  import { exitSplit, setSplitPercent, surface } from "./shellState.svelte";

  let { form }: { form: FormFactor } = $props();

  const s = $derived(surface());
  const axis = $derived(s.kind === "split" ? s.axis : "auto");
  const percent = $derived(s.kind === "split" ? s.percent : 50);

  let hostEl = $state<HTMLDivElement | null>(null);
  let size = $state({ w: 0, h: 0 });
  /** The last **pair** of rects the host actually gave us; `null` until the first
   * answer. A tuple, not an array: a split with one pane is not a layout, and the
   * type says so rather than leaving every reader to re-check the length. */
  let rects = $state<[PaneLayout, PaneLayout] | null>(null);

  /** The host answered that two panes do **not** fit the current size, and we have no
   * earlier pair to keep. `rects === null` alone cannot say this: it also means "the
   * host has not answered yet" (a frame or two at mount, and every successful size
   * change), and painting the notice in *that* state would flash on every working
   * split. Without this third state the surface drew **nothing at all** for a genuine
   * refusal (REQ-A1355) — a blank frame with no message and no in-UI way out. The gate
   * that admits a split is `columns >= 2` (a *width* band); the rule that paints it
   * (`split_panes`) needs both edges — a stacked split wants
   * `2 × min_pane.height + divider_gap` = 972 px of the measured box — so the two can
   * disagree, and a portrait tablet under that height reaches this branch. */
  let refused = $state(false);

  // Which way the split actually went. Derived from the rects, not from the intent:
  // `auto` is resolved by the host's class rule, so the answer is the truth and the
  // drag below maps a pointer axis to the right percent without asking again.
  const resolvedAxis = $derived(rects && rects[0].x !== rects[1].x ? "vertical" : "horizontal");

  $effect(() => {
    const a = axis;
    const p = percent;
    const { w, h } = size;
    if (w < 1 || h < 1) return;
    let alive = true;
    void wmPaneRects(a, p, w, h).then((r) => {
      if (!alive) return;
      // `wmPaneRects` already guarantees the pair (or `null`); the destructure is
      // what makes that guarantee part of this component's types.
      if (r && r[0] && r[1]) {
        // A pair lands → `rects` is non-null for the rest of this mount, and the render's
        // first branch wins; `refused` is only ever read while `rects` is null.
        rects = [r[0], r[1]];
      } else {
        // A refusal is terminal for this size: with a pair already on screen we keep
        // it (a resize the host cannot honour must not blank a working split), and
        // with none we say so on screen instead of leaving an empty frame.
        refused = true;
        amosWarn(
          "split-surface",
          `host refused pane rects for ${w}x${h} @ ${p}% (${a}); keeping the last layout`,
        );
      }
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

  // Divider drag. The percent is committed through `setSplitPercent` (the one place
  // that clamps) and the host is asked for rects on the next frame — the shell never
  // moves a pane itself, so a drag cannot desync from the class's `min_pane` rule.
  let dragging = $state(false);
  let rafId = 0;
  let pending = 0;

  function commitPercent(p: number): void {
    pending = p;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      setSplitPercent(pending);
    });
  }

  function onDividerDown(e: PointerEvent): void {
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onDividerMove(e: PointerEvent): void {
    if (!dragging || !hostEl) return;
    const r = hostEl.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const raw =
      resolvedAxis === "vertical"
        ? ((e.clientX - r.left) / r.width) * 100
        : ((e.clientY - r.top) / r.height) * 100;
    const next = Math.round(raw);
    if (next !== percent) commitPercent(next);
  }
  function onDividerUp(e: PointerEvent): void {
    dragging = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // The capture may already be gone (pointercancel); nothing to undo.
    }
  }
  /** Keyboard half of the same control: a divider that only answers to a finger is
   * unreachable with a keyboard or a switch device. Arrow along the split axis moves
   * it one point; Home/End jump to the clamped extremes. */
  function onDividerKey(e: KeyboardEvent): void {
    const back = resolvedAxis === "vertical" ? "ArrowLeft" : "ArrowUp";
    const fwd = resolvedAxis === "vertical" ? "ArrowRight" : "ArrowDown";
    let next: number | null = null;
    if (e.key === back) next = percent - 1;
    else if (e.key === fwd) next = percent + 1;
    else if (e.key === "Home") next = 1;
    else if (e.key === "End") next = 99;
    if (next === null) return;
    e.preventDefault();
    setSplitPercent(next);
  }

  function style(p: PaneLayout): string {
    return `left:${p.x}px;top:${p.y}px;width:${p.width}px;height:${p.height}px`;
  }
</script>

<div class="relative h-full w-full overflow-hidden" bind:this={hostEl}>
  {#if rects}
    {@const a = rects[0]}
    {@const b = rects[1]}
    <!-- The divider is the **gap the host left between the panes**, not a width this
         component picked — `split_panes` reserves `policy.divider_gap` and the two
         rects are exactly that far apart. -->
    {@const dividerStyle =
      resolvedAxis === "vertical"
        ? `left:${a.x + a.width}px;top:${a.y}px;width:${b.x - (a.x + a.width)}px;height:${a.height}px`
        : `left:${a.x}px;top:${a.y + a.height}px;width:${a.width}px;height:${b.y - (a.y + a.height)}px`}
    <div class="absolute" style={style(rects[0])}>
      <AppPane
        id={s.kind === "split" ? s.primary : ""}
        {form}
        variant="pane"
        paneLabel={t("split.panePrimary")}
        onback={exitSplit}
      />
    </div>
    <div class="absolute" style={style(rects[1])}>
      <AppPane
        id={s.kind === "split" ? s.secondary : ""}
        {form}
        variant="pane"
        paneLabel={t("split.paneSecondary")}
        onback={exitSplit}
        onclosepane={exitSplit}
      />
    </div>
    <!-- A `<button>`, not a bare div: the divider is an operable control (drag, plus
         the arrow-key nudge in `onDividerKey`), and an interactive element is what
         lets it carry pointer + key handlers without a compiler suppression. -->
    <button
      type="button"
      aria-label={t("a11y.split")}
      data-testid="split-divider"
      class={[
        "absolute z-10 touch-none border-0 bg-black/10 p-0 dark:bg-white/10",
        resolvedAxis === "vertical" ? "cursor-col-resize" : "cursor-row-resize",
        dragging ? "bg-accent/40" : "",
      ].join(" ")}
      style={dividerStyle}
      onpointerdown={onDividerDown}
      onpointermove={onDividerMove}
      onpointerup={onDividerUp}
      onpointercancel={onDividerUp}
      onkeydown={onDividerKey}
    ></button>
  {:else if refused}
    <!-- The host refused the pair and there is no earlier layout to keep. This frame
         is otherwise **empty** — the shell draws only its status bar above it — so a
         silent refusal left the user on a blank screen with no message and no control
         (`exitSplit` reaches the surface only through a pane's back button, and no pane
         is drawn). Say what happened and hand them the way out. -->
    <div
      data-testid="split-unavailable"
      class="flex h-full flex-col items-center justify-center gap-3 px-8 text-center"
    >
      <span class="text-3xl" aria-hidden="true">▥</span>
      <!-- `role="status"` on the text, not on the container: the exit button below is a
           control, and a live region is for what was said, not for what can be pressed. -->
      <div role="status" class="flex flex-col gap-1">
        <p class="text-sm font-semibold">{t("split.cannotFit")}</p>
        <p class="text-xs opacity-60">{t("split.cannotFitHint")}</p>
      </div>
      <button
        type="button"
        data-testid="split-unavailable-exit"
        onclick={exitSplit}
        class="cursor-pointer rounded-full bg-accent/10 px-4 py-2 text-sm font-semibold text-accent transition active:bg-accent/20"
      >
        {t("split.exitToPrimary")}
      </button>
    </div>
  {/if}
</div>

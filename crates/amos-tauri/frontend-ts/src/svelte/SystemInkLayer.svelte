<script lang="ts">
  /**
   * SystemInkLayer.svelte — the **system-wide ink layer** (REQ-A1590): a scratch drawing surface
   * that floats over whatever the shell is showing, so the stylus means something outside Notes.
   *
   * Before this, freehand ink was a *Notes* feature. `lib/ink.ts` (REQ-A526) is a complete, pure
   * model — pressure/tilt widths, the eraser's segment hit test, the SVG outline builder — but its
   * only consumer was `InkCanvas.svelte`, which is bound to one note (a white background, a scroll
   * container, `aria-label={t("note.inkCanvas")}`). Nothing in the system could be annotated.
   *
   * The geometry is **not** re-implemented here: `classifyPointer` decides pen / palm / ignore,
   * `appendPoint` gates jitter, `simplifyStroke` trims on commit, `eraseAt` is the eraser, and
   * `strokePath` builds the path. This component is the DOM plumbing and the toolbar; the *history*
   * (what a commit does, what undo/redo mean) is `lib/systemInk.ts`, which is pure and unit-tested.
   *
   * The layer is 1:1 with the window — no `fitScale` group, because the surface never scrolls and
   * never zooms, so a stored coordinate is already a CSS pixel on screen.
   *
   * Honest boundaries (stated, not hidden):
   *
   *   * **It covers the window it is summoned in.** On desktop an app is a **separate native
   *     Tauri window** (`DesktopAppWindow`), so an overlay mounted in the launcher window cannot
   *     float above another window — there is no cross-window compositor here. The layer is
   *     genuinely system-wide in the sense that it is reachable from any *surface* the shell
   *     draws (home, an in-webview app, a split), and its entry point is the Control Center on
   *     both forms; "draw over any OS window" would be a claim this architecture cannot keep.
   *   * **The drawing is session-scoped.** It is a scratch pad, not a document: nothing is
   *     persisted, and closing the layer keeps the strokes for the rest of the run so reopening
   *     resumes where the user left off — but a restart starts blank. Persisting it would make it
   *     a file (where does it live? which window?) — a decision this round does not make.
   *   * **Palm rejection is on and not configurable here.** The system layer's reason to exist is
   *     the pen; `notePrefs.palmRejection` is a Notes setting and is deliberately not read.
   */
  import { onDestroy, onMount } from "svelte";
  import { t } from "./locale.svelte";
  import { closeSysInk, sysInkOpen } from "./shellState.svelte";
  import {
    ERASER_RADIUS,
    INK_DEFAULT_COLOR,
    INK_DEFAULT_WIDTH,
    PALM_PEN_IDLE_MS,
    appendPoint,
    classifyPointer,
    eraseAt,
    noteHasInk,
    simplifyStroke,
    strokePath,
    tiltMagnitude,
    type Ink,
    type InkPoint,
    type InkPointerSample,
    type InkTool,
  } from "../lib/ink";
  import {
    canRedoSystemInk,
    canUndoSystemInk,
    commitSystemInk,
    emptySystemInk,
    redoSystemInk,
    undoSystemInk,
    type SystemInkState,
  } from "../lib/systemInk";

  let host = $state<HTMLDivElement | null>(null);
  let svgEl = $state<SVGSVGElement | null>(null);
  /** The surface's box in CSS px; the drawing is stored in these units (see the header). */
  let viewW = $state(0);
  let viewH = $state(0);
  /** The in-progress pen stroke's samples — never committed until pointer-up. */
  let activePts = $state<InkPoint[]>([]);
  let tool = $state<InkTool>("pen");
  /**
   * The scratch history. It lives here (not in `shellState`) because it is a drawing, not shell
   * navigation — but the component stays mounted while the layer is closed, so reopening within a
   * session resumes the same sheet instead of silently discarding it.
   */
  let history = $state<SystemInkState>(emptySystemInk());

  const ink = $derived(history.ink);
  const canUndo = $derived(canUndoSystemInk(history));
  const canRedo = $derived(canRedoSystemInk(history));

  // Non-reactive bookkeeping: none of it decides what is rendered.
  let penSeenAt = 0;
  let activeId: number | null = null;
  const palms = new Set<number>();

  const measure = () => {
    viewW = host?.clientWidth ?? 0;
    viewH = host?.clientHeight ?? 0;
  };

  let ro: ResizeObserver | null = null;
  onMount(() => {
    measure();
    if (typeof ResizeObserver !== "undefined" && host) {
      ro = new ResizeObserver(measure);
      ro.observe(host);
    }
  });
  onDestroy(() => ro?.disconnect());

  /** Whether a pen has been seen inside the palm window. */
  const penActive = () => performance.now() - penSeenAt < PALM_PEN_IDLE_MS;

  const sampleOf = (e: PointerEvent): InkPointerSample => ({
    pointerType: e.pointerType,
    width: e.width,
    height: e.height,
    isPrimary: e.isPrimary,
    penActive: penActive(),
    // The system layer's whole reason is the pen, so palm rejection is on here and is not read
    // from a Notes preference (see the header's boundary).
    palmRejection: true,
  });

  /** Pen-only pressure: a mouse reports a flat 0.5 and a finger often a flat 0 (see `lib/ink`). */
  const pressureOf = (e: PointerEvent): number => (e.pointerType === "pen" ? e.pressure : NaN);

  const pointAt = (e: PointerEvent): InkPoint => {
    const rect = svgEl?.getBoundingClientRect();
    return {
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
      p: pressureOf(e),
      t: tiltMagnitude(e.tiltX, e.tiltY),
    };
  };

  /**
   * The samples the browser batched into this event. `getCoalescedEvents` is absent in happy-dom
   * and has thrown on some WebView builds; a throw would abort the move handler and silently
   * truncate every stroke, so the fallback is the whole point.
   */
  const coalesced = (e: PointerEvent): PointerEvent[] => {
    const fn = (e as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] })
      .getCoalescedEvents;
    if (typeof fn !== "function") return [e];
    try {
      const out = fn.call(e);
      return out && out.length ? out : [e];
    } catch {
      return [e];
    }
  };

  const capture = (e: PointerEvent) => {
    try {
      (e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId);
    } catch {
      /* best-effort: a failed capture degrades the gesture, it must not break the stroke */
    }
  };

  /** Erase one contact; a pass that crossed nothing keeps the same drawing (no undo step). */
  const erase = (x: number, y: number) => {
    const base = history.ink;
    if (!base) return;
    const next = eraseAt(base, x, y, ERASER_RADIUS);
    if (next === base) return;
    history = commitSystemInk(history, next);
  };

  const commit = (pts: InkPoint[]) => {
    const kept = simplifyStroke(pts);
    if (kept.length === 0) return;
    const base = history.ink ?? { w: 0, h: 0, strokes: [] };
    const next: Ink = {
      w: base.w > 0 ? base.w : Math.round(viewW),
      h: Math.max(base.h, Math.round(viewH)),
      strokes: [
        ...base.strokes,
        { tool: "pen", color: INK_DEFAULT_COLOR, width: INK_DEFAULT_WIDTH, pts: kept },
      ],
    };
    history = commitSystemInk(history, next);
  };

  const onDown = (e: PointerEvent) => {
    const decision = classifyPointer(sampleOf(e));
    if (decision === "ignore") return;
    e.preventDefault();
    capture(e);
    if (e.pointerType === "pen") penSeenAt = performance.now();
    // A palm is captured and then swallowed — an uncaptured contact would scroll the surface
    // under the user's hand (the same rule `InkCanvas` follows).
    if (decision === "palm") {
      palms.add(e.pointerId);
      return;
    }
    activeId = e.pointerId;
    if (tool === "eraser") {
      const m = pointAt(e);
      erase(m.x, m.y);
      return;
    }
    activePts = [pointAt(e)];
  };

  const onMove = (e: PointerEvent) => {
    if (palms.has(e.pointerId)) return;
    if (e.pointerType === "pen") penSeenAt = performance.now();
    if (activeId !== e.pointerId) return;
    const events = coalesced(e);
    if (tool === "eraser") {
      for (const ev of events) {
        const m = pointAt(ev);
        erase(m.x, m.y);
      }
      return;
    }
    let pts = activePts;
    for (const ev of events) pts = appendPoint(pts, pointAt(ev));
    activePts = pts;
  };

  const finish = (e: PointerEvent) => {
    palms.delete(e.pointerId);
    if (activeId !== e.pointerId) return;
    // Released on every exit path, including `pointercancel` — a stuck id would read the next
    // pen-down as a second contact and reject it as a palm.
    activeId = null;
    const pts = activePts;
    activePts = [];
    if (tool === "eraser" || pts.length === 0) return;
    commit(pts);
  };

  function clearSheet(): void {
    history = commitSystemInk(history, null);
  }
</script>

{#if sysInkOpen()}
  <div
    bind:this={host}
    class="absolute inset-0 z-[87]"
    data-testid="system-ink-layer"
    role="application"
    aria-label={t("sysInk.title")}
  >
    <!-- A faint wash so the user can tell the ink layer is up over content of any brightness. -->
    <div class="pointer-events-none absolute inset-0 bg-neutral-900/10" aria-hidden="true"></div>

    <svg
      bind:this={svgEl}
      role="img"
      aria-label={t("sysInk.canvas")}
      data-testid="system-ink-svg"
      class={"absolute inset-0 h-full w-full touch-none select-none " +
        (tool === "eraser" ? "cursor-cell" : "cursor-crosshair")}
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerup={finish}
      onpointercancel={finish}
      onlostpointercapture={finish}
    >
      {#each ink?.strokes ?? [] as stroke, i (i)}
        <path d={strokePath(stroke.pts, stroke.width)} fill={stroke.color} />
      {/each}
      {#if activePts.length > 0}
        <path
          data-testid="system-ink-live"
          d={strokePath(activePts, INK_DEFAULT_WIDTH)}
          fill={INK_DEFAULT_COLOR}
        />
      {/if}
    </svg>

    <!-- The toolbar sits above the surface as a **sibling**, so a tap here never becomes a
         stroke: it is painted over the svg and takes the pointer first. -->
    <div
      class="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-2xl bg-neutral-900/80 p-1.5 text-white shadow-lg backdrop-blur"
      data-testid="system-ink-toolbar"
    >
      <button
        type="button"
        class={"rounded-xl px-3 py-1.5 text-[12px] font-medium transition-colors " +
          (tool === "pen" ? "bg-white/25" : "enabled:active:bg-white/15")}
        aria-pressed={tool === "pen"}
        aria-label={t("sysInk.pen")}
        data-testid="system-ink-pen"
        onclick={() => (tool = "pen")}
      >{t("sysInk.pen")}</button>
      <button
        type="button"
        class={"rounded-xl px-3 py-1.5 text-[12px] font-medium transition-colors " +
          (tool === "eraser" ? "bg-white/25" : "enabled:active:bg-white/15")}
        aria-pressed={tool === "eraser"}
        aria-label={t("sysInk.eraser")}
        data-testid="system-ink-eraser"
        onclick={() => (tool = "eraser")}
      >{t("sysInk.eraser")}</button>

      <span class="mx-1 h-5 w-px bg-white/20" aria-hidden="true"></span>

      <button
        type="button"
        class="rounded-xl px-3 py-1.5 text-[12px] font-medium transition-colors enabled:active:bg-white/15 disabled:opacity-35"
        aria-label={t("sysInk.undo")}
        data-testid="system-ink-undo"
        disabled={!canUndo}
        onclick={() => (history = undoSystemInk(history))}
      >{t("sysInk.undo")}</button>
      <button
        type="button"
        class="rounded-xl px-3 py-1.5 text-[12px] font-medium transition-colors enabled:active:bg-white/15 disabled:opacity-35"
        aria-label={t("sysInk.redo")}
        data-testid="system-ink-redo"
        disabled={!canRedo}
        onclick={() => (history = redoSystemInk(history))}
      >{t("sysInk.redo")}</button>
      <button
        type="button"
        class="rounded-xl px-3 py-1.5 text-[12px] font-medium transition-colors enabled:active:bg-white/15 disabled:opacity-35"
        aria-label={t("sysInk.clear")}
        data-testid="system-ink-clear"
        disabled={!noteHasInk(history)}
        onclick={clearSheet}
      >{t("sysInk.clear")}</button>

      <span class="mx-1 h-5 w-px bg-white/20" aria-hidden="true"></span>

      <button
        type="button"
        class="rounded-xl bg-accent px-3 py-1.5 text-[12px] font-semibold transition-colors enabled:active:brightness-110"
        aria-label={t("sysInk.done")}
        data-testid="system-ink-done"
        onclick={() => closeSysInk()}
      >{t("sysInk.done")}</button>
    </div>
  </div>
{/if}

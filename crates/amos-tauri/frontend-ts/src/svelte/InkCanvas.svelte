<script lang="ts">
  // InkCanvas.svelte — the handwriting surface for ONE note (REQ-A526). Design: docs/notes-ink.md.
  //
  // It owns pointer plumbing and nothing else: every geometric decision (width from pressure and
  // tilt, sample gating, simplification, the outline path, the eraser's hit test, whether a
  // contact is a pen / a palm / ignorable) lives in `lib/ink.ts`, which is pure and unit-tested.
  // This component turns those answers into attributes.
  //
  // Why SVG rather than `<canvas>`: a variable-width stroke is a *filled outline*, and a `<path>`
  // carries it as one node that the browser re-renders without this component repainting anything.
  // A canvas would need a rasteriser here (a second, untested implementation of the same geometry)
  // and — decisively — happy-dom implements no 2D context, so a canvas renderer would be
  // unverifiable in the test suite. One `<path>` per stroke is also what keeps the committed
  // strokes and the in-progress one from being redrawn together: Svelte diffs the keyed list, so a
  // new sample touches only the live path.
  import { onDestroy, onMount } from "svelte";
  import {
    ERASER_RADIUS,
    INK_DEFAULT_COLOR,
    INK_DEFAULT_WIDTH,
    PALM_PEN_IDLE_MS,
    appendPoint,
    classifyPointer,
    eraseAt,
    fitScale,
    simplifyStroke,
    strokePath,
    tiltMagnitude,
    toModelPoint,
    type Ink,
    type InkPoint,
    type InkPointerSample,
    type InkTool,
  } from "../lib/ink";
  import { t } from "./locale.svelte";

  let {
    ink,
    palmRejection = true,
    tool,
    onChange,
  }: {
    ink: Ink | undefined;
    palmRejection?: boolean;
    tool: InkTool;
    onChange: (next: Ink) => void;
  } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let svgEl = $state<SVGSVGElement | null>(null);
  /** Measured view width in CSS px; 0 until the host has been laid out. */
  let viewW = $state(0);
  let hostH = $state(0);
  /** The in-progress stroke's samples — never committed until pointer-up. */
  let activePts = $state<InkPoint[]>([]);

  // Plain (non-reactive) bookkeeping: none of it affects what is rendered, and making it `$state`
  // would re-run the render for a timestamp nobody draws.
  let penSeenAt = 0;
  let activeId: number | null = null;
  const palms = new Set<number>();

  /** The layer being edited, standing in an empty one for a note that has no ink yet. */
  const layer = $derived<Ink>(ink ?? { w: viewW, h: 0, strokes: [] });
  const scale = $derived(fitScale(layer.w, viewW));
  /** The strip grows downward as strokes are drawn, and never shrinks below the host. */
  const viewH = $derived(Math.max(hostH, layer.h * scale, 1));

  const measure = () => {
    viewW = host?.clientWidth ?? 0;
    hostH = host?.clientHeight ?? 0;
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
    palmRejection,
  });

  /**
   * Pressure is only meaningful from a pen. A mouse reports a constant `0.5` while pressed and a
   * touch controller often reports a constant `0`; feeding either into the width curve would make
   * a finger draw hair-thin and would be a number pretending to be a measurement. `NaN` tells
   * `sampleWidth` "no reading", which draws at the chosen base width.
   */
  const pressureOf = (e: PointerEvent): number => (e.pointerType === "pen" ? e.pressure : NaN);

  /** The event's position in the strip's own coordinate space (scroll accounted for by the rect). */
  const localOf = (e: PointerEvent): { x: number; y: number } => {
    const rect = svgEl?.getBoundingClientRect();
    return toModelPoint(
      e.clientX - (rect?.left ?? 0),
      e.clientY - (rect?.top ?? 0),
      scale,
    );
  };

  const pointAt = (e: PointerEvent): InkPoint => {
    const m = localOf(e);
    return { x: m.x, y: m.y, p: pressureOf(e), t: tiltMagnitude(e.tiltX, e.tiltY) };
  };

  /**
   * The samples the browser batched into this event. `getCoalescedEvents` is a Chromium/WebKit
   * extension that is **absent** in happy-dom and has been missing or throwing on some WebView
   * builds; a throw here would abort the move handler and silently truncate every stroke on that
   * device, so the fallback is the whole point of this function.
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

  /** Commit an eraser pass; a pass that crossed nothing keeps the same layer and saves nothing. */
  const erase = (x: number, y: number) => {
    const base = ink;
    if (!base) return;
    const next = eraseAt(base, x, y, ERASER_RADIUS);
    if (next !== base) onChange(next);
  };

  const commit = (pts: InkPoint[]) => {
    const kept = simplifyStroke(pts);
    if (kept.length === 0) return;
    let maxY = 0;
    for (const p of kept) if (p.y > maxY) maxY = p.y;
    const base = ink ?? { w: 0, h: 0, strokes: [] };
    onChange({
      w: base.w > 0 ? base.w : Math.round(viewW),
      h: Math.max(base.h, Math.round(maxY)),
      strokes: [
        ...base.strokes,
        { tool: "pen", color: INK_DEFAULT_COLOR, width: INK_DEFAULT_WIDTH, pts: kept },
      ],
    });
  };

  const onDown = (e: PointerEvent) => {
    const decision = classifyPointer(sampleOf(e));
    if (decision === "ignore") return;
    e.preventDefault();
    capture(e);
    if (e.pointerType === "pen") penSeenAt = performance.now();
    // A palm is captured and then swallowed — **not** left uncaptured. An uncaptured contact keeps
    // delivering moves to the scroll container, so the page would scroll under the user's hand.
    if (decision === "palm") {
      palms.add(e.pointerId);
      return;
    }
    activeId = e.pointerId;
    const m = localOf(e);
    if (tool === "eraser") {
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
        const m = localOf(ev);
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
    // Released on *every* exit path, including `pointercancel`: a system gesture that steals the
    // pointer would otherwise leave the id stuck, and the next pen-down would read as a second
    // contact and be rejected as a palm.
    activeId = null;
    const pts = activePts;
    activePts = [];
    if (tool === "eraser" || pts.length === 0) return;
    commit(pts);
  };
</script>

<div bind:this={host} class="h-full w-full overflow-y-auto overscroll-contain bg-white dark:bg-neutral-900">
  <svg
    bind:this={svgEl}
    role="img"
    aria-label={t("note.inkCanvas")}
    data-testid="note-ink-canvas"
    class={"block touch-none select-none " + (tool === "eraser" ? "cursor-cell" : "cursor-crosshair")}
    width={viewW || 1}
    height={viewH}
    viewBox={`0 0 ${viewW || 1} ${viewH}`}
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={finish}
    onpointercancel={finish}
    onlostpointercapture={finish}
  >
    <!-- Strokes are stored in capture-space px; the group carries them into view-space. -->
    <g transform={`scale(${scale})`}>
      {#each layer.strokes as stroke, i (i)}
        <path d={strokePath(stroke.pts, stroke.width)} fill={stroke.color} />
      {/each}
      {#if activePts.length > 0}
        <path
          data-testid="note-ink-live"
          d={strokePath(activePts, INK_DEFAULT_WIDTH)}
          fill={INK_DEFAULT_COLOR}
        />
      {/if}
    </g>
  </svg>
</div>

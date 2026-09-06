<script lang="ts">
  // MagnifierApp.svelte — Svelte 5 (runes) port of the React MagnifierApp
  // (src/components/MagnifierApp.tsx). iPhone-style accessibility magnifier:
  // a circular lens re-renders the content under it at higher magnification.
  //
  // This ports the CONTROL surface (zoom/brightness/contrast + reset + persisted
  // settings) and the lens/viewfinder canvas structure faithfully. Camera
  // acquisition (getUserMedia) + the actual 2D paint are guarded: where Canvas 2D
  // is unavailable (SSR / happy-dom) drawing no-ops so the UI still renders — the
  // control surface is mock-testable; real magnified view is device acceptance.
  import {
    LENS_R,
    MIN_ZOOM,
    MAX_ZOOM,
    DEFAULT_ZOOM,
    DEFAULT_TONE,
    MAGNIFIER_SETTINGS_KEY,
    clampCenter,
    centredLens,
    lensSourceRadius,
    normalizeMagnifierSettings,
    toneFilter,
  } from "../lib/magnifier";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { capSet, grantCap, loadLedger, saveLedger } from "../lib/permissions";
  import { t } from "./locale.svelte";

  const LENS_SIZE = LENS_R * 2;
  type SceneMode = "live" | "demo";

  // ---- settings (persisted) ----
  const init = normalizeMagnifierSettings(readStoreValue<unknown>(MAGNIFIER_SETTINGS_KEY, {}));
  let zoom = $state(init.zoom);
  let bright = $state(init.brightness);
  let contrast = $state(init.contrast);
  $effect(() => {
    writeStoreValue(MAGNIFIER_SETTINGS_KEY, normalizeMagnifierSettings({ zoom, brightness: bright, contrast }));
  });
  const reset = () => {
    zoom = DEFAULT_ZOOM;
    bright = DEFAULT_TONE;
    contrast = DEFAULT_TONE;
  };

  // ---- camera permission gate (OS ledger, like the Camera app) ----
  let granted = $state(capSet(loadLedger(), "magnifier", "camera"));
  const allowCamera = () => {
    saveLedger(grantCap(loadLedger(), "magnifier", "camera"));
    granted = true;
  };

  // ---- scene / lens state ----
  let mode = $state<SceneMode>("demo");
  let hint = $state(t("magnifier.starting"));
  let center = $state({ x: 0, y: 0 });
  const pct = (v: number) => `${v}%`;

  // DOM refs + drag flag (state so bind:this/assignments stay reactive).
  let containerEl = $state<HTMLDivElement | null>(null);
  let baseCanvas = $state<HTMLCanvasElement | null>(null);
  let lensCanvas = $state<HTMLCanvasElement | null>(null);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let stream = $state<MediaStream | null>(null);
  let dragging = $state(false);

  const sizeOf = () => ({ w: containerEl?.clientWidth ?? 0, h: containerEl?.clientHeight ?? 0 });

  const mark = (live: boolean) => {
    mode = live ? "live" : "demo";
    hint = live ? t("magnifier.live") : t("magnifier.demo");
  };

  // Attempt live camera; otherwise fall back to demo scene.
  $effect(() => {
    if (!granted) return;
    const supported =
      typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
    let cancelled = false;
    const v = videoEl;
    const checkReady = () => {
      if (v && typeof v.videoWidth === "number" && v.videoWidth > 0) mark(true);
    };
    if (!supported) {
      mark(false);
      return;
    }
    hint = t("magnifier.starting");
    navigator.mediaDevices!
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        stream = s;
        if (v) {
          try {
            v.srcObject = s;
          } catch {
            /* ignore */
          }
          ["loadeddata", "canplay", "playing"].forEach((ev) =>
            v.addEventListener(ev, checkReady),
          );
        }
        checkReady();
      })
      .catch(() => mark(false));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((tr) => tr.stop());
      stream = null;
    };
  });
  // ---- lens painting (guarded: no-op where Canvas 2D is unavailable) ----
  function paint() {
    const base = baseCanvas;
    const lens = lensCanvas;
    const c = containerEl;
    if (!base || !lens || !c) return;
    const { w, h } = sizeOf();
    if (w <= 0 || h <= 0) return;
    if (base.width !== w) base.width = w;
    if (base.height !== h) base.height = h;
    const bctx = base.getContext("2d");
    if (!bctx) return;
    bctx.clearRect(0, 0, w, h);
    bctx.save();
    bctx.filter = toneFilter(bright, contrast);
    if (mode === "live" && videoEl && videoEl.videoWidth > 0) {
      drawCover(bctx, videoEl, w, h);
    } else {
      drawDemoScene(bctx, w, h);
    }
    bctx.restore();

    const lctx = lens.getContext("2d");
    if (!lctx) return;
    lctx.clearRect(0, 0, LENS_SIZE, LENS_SIZE);
    const R = LENS_R;
    const srcR = lensSourceRadius(zoom);
    lctx.save();
    lctx.beginPath();
    lctx.arc(R, R, R - 2, 0, Math.PI * 2);
    lctx.clip();
    lctx.imageSmoothingEnabled = true;
    lctx.imageSmoothingQuality = "high";
    lctx.drawImage(base, center.x - srcR, center.y - srcR, srcR * 2, srcR * 2, 0, 0, LENS_SIZE, LENS_SIZE);
    lctx.restore();
    lctx.lineWidth = 3;
    lctx.strokeStyle = "rgba(255,255,255,0.92)";
    lctx.beginPath();
    lctx.arc(R, R, R - 2, 0, Math.PI * 2);
    lctx.stroke();
  }
  const safePaint = () => {
    try {
      paint();
    } catch {
      /* structure still renders */
    }
  };

  // Demo / cold start: static scene → repaint when the scene/inputs change so the
  // lens reflects slider moves (mirrors React's demo-effect deps).
  const sceneKey = $derived([mode, zoom, bright, contrast, center.x, center.y] as const);
  $effect(() => {
    const [m] = sceneKey;
    if (m === "live") return;
    safePaint();
  });
  // Live: repaint every frame (only meaningful where requestAnimationFrame exists).
  $effect(() => {
    if (mode !== "live") return;
    if (typeof requestAnimationFrame !== "function") {
      safePaint();
      return;
    }
    let raf = 0;
    const tick = () => {
      safePaint();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  // Centre the lens once the viewfinder has a size.
  $effect(() => {
    const c = containerEl;
    if (!c) return;
    const p = centredLens(c.clientWidth, c.clientHeight);
    center = { x: p.x, y: p.y };
  });

  // ---- drag the lens ----
  const localXY = (e: PointerEvent) => {
    const r = containerEl?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const moveLensTo = (x: number, y: number) => {
    const { w, h } = sizeOf();
    const p = clampCenter(x, y, w, h);
    center = { x: p.x, y: p.y };
  };
  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    e.preventDefault();
    const { x, y } = localXY(e);
    moveLensTo(x, y);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    e.preventDefault();
    const { x, y } = localXY(e);
    moveLensTo(x, y);
  };
  const endDrag = () => {
    dragging = false;
  };

  /** Object-cover draw of `video` into a `w×h` canvas. */
  function drawCover(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, w: number, h: number) {
    const sw = v.videoWidth;
    const sh = v.videoHeight;
    if (!sw || !sh) return;
    const scale = Math.max(w / sw, h / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  /** Synthetic "document" scene so the lens visibly magnifies without a camera. */
  function drawDemoScene(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#111827");
    g.addColorStop(1, "#1f2937");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const words = ["Amos", "放大镜", "MAGNIFIER", "iOS·对齐", "iPhone", "readable", "放大", "label", "🔍"];
    ctx.font = "11px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "middle";
    const lineH = 15;
    let color = 0;
    for (let y = 8; y < h - 4; y += lineH) {
      let x = 6;
      let i = 0;
      while (x < w - 10 && i < 200) {
        const word = words[(y + i) % words.length] ?? "Amos";
        color = (color + 1) % 3;
        ctx.fillStyle =
          color === 0
            ? "rgba(255,255,255,0.85)"
            : color === 1
              ? "rgba(147,197,253,0.9)"
              : "rgba(253,224,71,0.9)";
        const tw = ctx.measureText(word).width;
        ctx.fillText(word, x, y);
        x += tw + 16;
        i += 1;
      }
    }
    ctx.textBaseline = "alphabetic";
  }
</script>

<div class="flex h-full flex-col bg-neutral-950 text-white">
  {#if !granted}
    <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div class="text-3xl">🔐</div>
      <p class="text-sm text-white/90">{t("perm.askAllow", { app: t("app.magnifier"), cap: t("perm.cap.camera") })}</p>
      <button onclick={allowCamera} class="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95">
        {t("perm.allow")}
      </button>
    </div>
  {:else}
    <div class="flex h-full flex-col">
      <div
        bind:this={containerEl}
        role="img"
        aria-label={t("magnifier.dragHint")}
        class="relative min-h-0 flex-1 touch-none overflow-hidden bg-black select-none"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={endDrag}
        onpointerleave={endDrag}
        onpointercancel={endDrag}
      >
        <canvas bind:this={baseCanvas} class="absolute inset-0 h-full w-full" data-testid="magnifier-base"></canvas>
        <video bind:this={videoEl} autoplay muted playsinline class="hidden"></video>
        {#if mode === "live"}
          <span class="absolute left-2 top-2 rounded-full bg-white/20 px-2 py-0.5 text-[10px]">{t("magnifier.live")}</span>
        {:else}
          <span class="absolute left-2 top-2 rounded-full bg-white/20 px-2 py-0.5 text-[10px]">{t("magnifier.demo")}</span>
        {/if}
        <div
          class="pointer-events-none absolute"
          style="left: {center.x - LENS_R}px; top: {center.y - LENS_R}px; width: {LENS_SIZE}px; height: {LENS_SIZE}px; border-radius: 9999px;"
        >
          <canvas bind:this={lensCanvas} width={LENS_SIZE} height={LENS_SIZE} class="h-full w-full" data-testid="magnifier-lens"></canvas>
        </div>
        {#if hint}
          <p class="absolute bottom-1 left-0 right-0 text-center text-[11px] text-white/40">{hint}</p>
        {/if}
      </div>

      <div class="shrink-0 space-y-3 px-4 py-3">
        <div class="flex items-center gap-3">
          <label for="magnifier-brightness" class="w-12 shrink-0 text-xs text-white/70">{t("magnifier.brightness")}</label>
          <input
            id="magnifier-brightness"
            type="range"
            min={0}
            max={200}
            step={1}
            value={bright}
            oninput={(e) => (bright = Number((e.target as HTMLInputElement).value))}
            aria-label={t("magnifier.brightness")}
            class="h-1 flex-1 appearance-none rounded-full bg-white/30 accent-white"
          />
          <span class="w-11 shrink-0 text-right text-xs tabular-nums text-white/70">{pct(bright)}</span>
        </div>
        <div class="flex items-center gap-3">
          <label for="magnifier-contrast" class="w-12 shrink-0 text-xs text-white/70">{t("magnifier.contrast")}</label>
          <input
            id="magnifier-contrast"
            type="range"
            min={0}
            max={200}
            step={1}
            value={contrast}
            oninput={(e) => (contrast = Number((e.target as HTMLInputElement).value))}
            aria-label={t("magnifier.contrast")}
            class="h-1 flex-1 appearance-none rounded-full bg-white/30 accent-white"
          />
          <span class="w-11 shrink-0 text-right text-xs tabular-nums text-white/70">{pct(contrast)}</span>
        </div>
        <div class="flex items-center gap-3">
          <label for="magnifier-zoom" class="w-12 shrink-0 text-xs text-white/70">{t("magnifier.zoom")}</label>
          <input
            id="magnifier-zoom"
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.5}
            value={zoom}
            oninput={(e) => (zoom = Number((e.target as HTMLInputElement).value))}
            aria-label={t("magnifier.zoom")}
            class="h-1 flex-1 appearance-none rounded-full bg-white/30 accent-white"
          />
          <span class="w-11 shrink-0 text-right text-xs tabular-nums text-white/70">{zoom.toFixed(1)}×</span>
        </div>
        <div class="flex items-center justify-end">
          <button
            onclick={reset}
            class="rounded-full bg-white/15 px-4 py-1.5 text-xs text-white ring-1 ring-white/20 transition active:scale-95"
          >
            {t("magnifier.reset")}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>



import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "../i18n";
import CapabilityGate from "./CapabilityGate";
import type { Capability } from "../lib/permissions";
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

/**
 * AmOS "放大镜" (Magnifier) — iPhone-style accessibility magnifier.
 *
 * It shows the live camera as the viewfinder and floats a *circular lens* that
 * the user can drag around; the lens re-renders the content under its centre at
 * a higher magnification so fine detail (labels, small print, objects) becomes
 * readable. Brightness / Contrast adjust the (canvas-filtered) view, and a zoom
 * slider sets how strongly the lens magnifies — mirroring Apple's Magnifier.
 *
 * Camera access is gated behind the OS capability ledger via CapabilityGate
 * (same permission UX as the Camera app). When no camera is available the app
 * gracefully falls back to a synthetic "document" demo scene so the lens and
 * controls still work for demo / offline / headless-test purposes.
 */

const APP_ID = "magnifier";
const CAMERA_CAP: Capability = "camera";

/** Lens canvas is 2R×2R device px so the circle is crisp. */
const LENS_SIZE = LENS_R * 2;

type SceneMode = "live" | "demo";

export default function MagnifierApp() {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col bg-neutral-950 text-white">
      <CapabilityGate
        appId={APP_ID}
        cap={CAMERA_CAP}
        appLabel={t("app.magnifier")}
        capLabel={t("perm.cap.camera")}
      >
        <MagnifierViewer />
      </CapabilityGate>
    </div>
  );
}

function MagnifierViewer() {
  const { t } = useI18n();

  // ---- live UI state ----
  // Restore last-used adjustments (iOS-like persistence); SSR/absent → defaults.
  const initial = normalizeMagnifierSettings(
    typeof window === "undefined" ? {} : readStoreValue<unknown>(MAGNIFIER_SETTINGS_KEY, {}),
  );
  const [zoom, setZoom] = useState(initial.zoom);
  const [bright, setBright] = useState(initial.brightness);
  const [contrast, setContrast] = useState(initial.contrast);
  const [mode, setMode] = useState<SceneMode>("demo");
  const [hint, setHint] = useState(t("magnifier.starting"));
  const [center, setCenter] = useState({ x: 0, y: 0 });

  // Persist adjustments back to the shared store whenever they change, so the
  // next open (or another window) starts where the user left off.
  useEffect(() => {
    writeStoreValue(MAGNIFIER_SETTINGS_KEY, normalizeMagnifierSettings({ zoom, brightness: bright, contrast }));
  }, [zoom, bright, contrast]);

  // Refs mirrored from state so the animation-frame loop always reads the
  // latest values without restarting (60 fps lens redraws).
  const zoomRef = useRef(DEFAULT_ZOOM);
  const brightRef = useRef(DEFAULT_TONE / 100);
  const contrastRef = useRef(DEFAULT_TONE / 100);
  const centerRef = useRef(center);
  const modeRef = useRef<SceneMode>("demo");

  // DOM / media refs.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const lensRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const draggingRef = useRef(false);


  const setZoomAll = useCallback((v: number) => {
    setZoom(v);
    zoomRef.current = v;
  }, []);
  const setBrightAll = useCallback((v: number) => {
    setBright(v);
    brightRef.current = v / 100;
  }, []);
  const setContrastAll = useCallback((v: number) => {
    setContrast(v);
    contrastRef.current = v / 100;
  }, []);

  const setCenterAll = useCallback((x: number, y: number) => {
    setCenter((prev) => {
      const next = { x, y };
      centerRef.current = next;
      return prev.x === next.x && prev.y === next.y ? prev : next;
    });
  }, []);

  const reset = useCallback(() => {
    setZoomAll(DEFAULT_ZOOM);
    setBrightAll(DEFAULT_TONE);
    setContrastAll(DEFAULT_TONE);
    const c = containerRef.current;
    if (c) {
      const p = centredLens(c.clientWidth, c.clientHeight);
      setCenterAll(p.x, p.y);
    }
  }, [setZoomAll, setBrightAll, setContrastAll, setCenterAll]);

  // Camera acquisition. Any failure (no device / webview denies it) leaves us
  // in demo mode so the lens still demonstrably works.
  const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  useEffect(() => {
    const v = videoRef.current;
    let cancelled = false;
    const mark = (live: boolean) => {
      if (cancelled) return;
      setMode(live ? "live" : "demo");
      modeRef.current = live ? "live" : "demo";
      setHint(live ? t("magnifier.live") : t("magnifier.demo"));
    };
    // Frames arrive asynchronously after getUserMedia resolves; a real <video>
    // only reports videoWidth > 0 once a frame is actually decodable. Waiting
    // for that keeps a working camera from being misclassified as "demo".
    const readyEvents = ["loadeddata", "canplay", "playing"] as const;
    const checkReady = () => {
      if (v && typeof v.videoWidth === "number" && v.videoWidth > 0) mark(true);
    };
    if (!supported) {
      mark(false);
      return;
    }
    setHint(t("magnifier.starting"));
    navigator.mediaDevices!
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        streamRef.current = s;
        if (v) {
          try {
            v.srcObject = s;
          } catch {
            /* ignore */
          }
          readyEvents.forEach((ev) => v.addEventListener(ev, checkReady));
        }
        checkReady();
      })
      .catch(() => mark(false));
    return () => {
      cancelled = true;
      if (v) readyEvents.forEach((ev) => v.removeEventListener(ev, checkReady));
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, t]);

  const sizeOf = useCallback((): { w: number; h: number } => {
    const c = containerRef.current;
    return { w: c?.clientWidth ?? 0, h: c?.clientHeight ?? 0 };
  }, []);


  // Render a full-frame base scene (live video or a synthetic document) and
  // then the magnified circular lens sampled from that base.
  const paintFrame = useCallback(() => {
    const base = baseRef.current;
    const c = containerRef.current;
    if (!base || !c) return;
    const { w, h } = sizeOf();
    if (w <= 0 || h <= 0) return;
    // Keep the base canvas at CSS-pixel resolution for 1:1 drag mapping.
    if (base.width !== w) base.width = w;
    if (base.height !== h) base.height = h;
    const bctx = base.getContext("2d");
    if (!bctx) return;

    bctx.clearRect(0, 0, w, h);
    const tone = toneFilter(brightRef.current, contrastRef.current);
    bctx.save();
    bctx.filter = tone;
    if (modeRef.current === "live" && videoRef.current && videoRef.current.videoWidth > 0) {
      drawCover(bctx, videoRef.current, w, h);
    } else {
      drawDemoScene(bctx, w, h);
    }
    bctx.restore();

    // ---- lens ----
    const lens = lensRef.current;
    if (!lens) return;
    const lctx = lens.getContext("2d");
    if (!lctx) return;
    lctx.clearRect(0, 0, LENS_SIZE, LENS_SIZE);
    const { x: cx, y: cy } = centerRef.current;
    const R = LENS_R;
    // Source sub-rect radius: the lens samples a 1/zoom slice of the base so
    // content underneath appears `zoom`× in the circle.
    const srcR = lensSourceRadius(zoomRef.current);
    lctx.save();
    lctx.beginPath();
    lctx.arc(R, R, R - 2, 0, Math.PI * 2);
    lctx.clip();
    lctx.imageSmoothingEnabled = true;
    lctx.imageSmoothingQuality = "high";
    lctx.drawImage(base, cx - srcR, cy - srcR, srcR * 2, srcR * 2, 0, 0, LENS_SIZE, LENS_SIZE);
    lctx.restore();
    // Lens chrome: outer ring + hairline centre cross.
    lctx.lineWidth = 3;
    lctx.strokeStyle = "rgba(255,255,255,0.92)";
    lctx.beginPath();
    lctx.arc(R, R, R - 2, 0, Math.PI * 2);
    lctx.stroke();
    lctx.lineWidth = 1;
    lctx.strokeStyle = "rgba(0,0,0,0.55)";
    lctx.beginPath();
    lctx.arc(R, R, R - 2, 0, Math.PI * 2);
    lctx.stroke();
    lctx.strokeStyle = "rgba(255,255,255,0.85)";
    lctx.beginPath();
    lctx.moveTo(R - 8, R);
    lctx.lineTo(R + 8, R);
    lctx.moveTo(R, R - 8);
    lctx.lineTo(R, R + 8);
    lctx.stroke();
  }, [sizeOf]);

  // Non-canvas environments (SSR / happy-dom) must never throw on a paint.
  const safePaint = useCallback(() => {
    try {
      paintFrame();
    } catch {
      /* structure still renders */
    }
  }, [paintFrame]);

  // Live view: repaint every frame so the video + lens stay fluid.
  useEffect(() => {
    if (mode !== "live") return;
    if (typeof requestAnimationFrame !== "function") {
      safePaint(); // no clock (e.g. happy-dom) → single paint
      return;
    }
    let raf = 0;
    const tick = () => {
      safePaint();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, safePaint]);

  // Demo / cold start (no camera): the scene is static, so repaint only when an
  // input or the lens actually moves instead of burning a 60 fps clock.
  useEffect(() => {
    if (mode === "live") return; // handled by the live loop above
    safePaint();
  }, [mode, zoom, bright, contrast, center, safePaint]);

  // Centre the lens on first layout once the container has a size.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const p = centredLens(c.clientWidth, c.clientHeight);
    setCenterAll(p.x, p.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  const localXY = (e: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const c = containerRef.current;
    const r = c?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const moveLensTo = (x: number, y: number) => {
    const { w, h } = sizeOf();
    const p = clampCenter(x, y, w, h);
    setCenterAll(p.x, p.y);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    e.preventDefault();
    const { x, y } = localXY(e);
    moveLensTo(x, y);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    e.preventDefault();
    const { x, y } = localXY(e);
    moveLensTo(x, y);
  };
  const endDrag = () => {
    draggingRef.current = false;
  };

  const pct = (v: number) => `${v}%`;
  const sliderCls = "h-1 flex-1 appearance-none rounded-full bg-white/30 accent-white";
  const valueCls = "w-11 shrink-0 text-right text-xs tabular-nums text-white/70";


  return (
    <div className="flex h-full flex-col">
      {/* Viewfinder area (canvas layer + draggable lens overlay). */}
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 touch-none overflow-hidden bg-black select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onPointerCancel={endDrag}
      >
        <canvas ref={baseRef} className="absolute inset-0 h-full w-full" data-testid="magnifier-base" />
        {/* Real video source (hidden: we draw it onto the canvas ourselves). */}
        <video ref={videoRef} autoPlay muted playsInline className="hidden" />
        {mode === "live" && (
          <div aria-hidden className="absolute left-2 top-2 rounded-full bg-black/40 px-2 py-0.5 text-[10px] tracking-widest text-white/70">
            ● {t("magnifier.live")}
          </div>
        )}
        {mode === "demo" && (
          <div aria-hidden className="absolute inset-x-0 top-2 text-center text-[10px] tracking-widest text-white/60">
            {t("magnifier.demo")}
          </div>
        )}
        <div
          className="pointer-events-none absolute"
          style={{
            left: center.x - LENS_R,
            top: center.y - LENS_R,
            width: LENS_SIZE,
            height: LENS_SIZE,
            filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.45))",
          }}
          aria-hidden="true"
        >
          <canvas ref={lensRef} width={LENS_SIZE} height={LENS_SIZE} data-testid="magnifier-lens" />
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-[11px] text-white/70">
          {t("magnifier.dragHint")}
        </div>
      </div>

      {/* Control deck (brightness / contrast / zoom + reset). */}
      <div className="space-y-3 border-t border-white/10 bg-neutral-900 px-4 py-3">
        <div className="flex items-center gap-3">
          <label htmlFor="magnifier-brightness" className="w-12 shrink-0 text-xs text-white/70">
            {t("magnifier.brightness")}
          </label>
          <input
            id="magnifier-brightness"
            type="range"
            min={0}
            max={200}
            step={1}
            value={bright}
            onChange={(e) => setBrightAll(Number(e.target.value))}
            aria-label={t("magnifier.brightness")}
            className={sliderCls}
          />
          <span className={valueCls}>{pct(bright)}</span>
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="magnifier-contrast" className="w-12 shrink-0 text-xs text-white/70">
            {t("magnifier.contrast")}
          </label>
          <input
            id="magnifier-contrast"
            type="range"
            min={0}
            max={200}
            step={1}
            value={contrast}
            onChange={(e) => setContrastAll(Number(e.target.value))}
            aria-label={t("magnifier.contrast")}
            className={sliderCls}
          />
          <span className={valueCls}>{pct(contrast)}</span>
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="magnifier-zoom" className="w-12 shrink-0 text-xs text-white/70">
            {t("magnifier.zoom")}
          </label>
          <input
            id="magnifier-zoom"
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.5}
            value={zoom}
            onChange={(e) => setZoomAll(Number(e.target.value))}
            aria-label={t("magnifier.zoom")}
            className={sliderCls}
          />
          <span className={valueCls}>{zoom.toFixed(1)}×</span>
        </div>
        <div className="flex items-center justify-end">
          <button
            onClick={reset}
            className="rounded-full bg-white/15 px-4 py-1.5 text-xs text-white ring-1 ring-white/20 transition active:scale-95"
          >
            {t("magnifier.reset")}
          </button>
        </div>
        {hint ? <p className="text-center text-[11px] text-white/40">{hint}</p> : null}
      </div>
    </div>
  );
}


/** Draw `video` into a `w×h` CSS-pixel canvas with object-cover semantics. */
function drawCover(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, w: number, h: number) {
  const sw = v.videoWidth;
  const sh = v.videoHeight;
  if (!sw || !sh) return;
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const dx = (w - dw) / 2;
  const dy = (h - dh) / 2;
  ctx.drawImage(v, dx, dy, dw, dh);
}

/** Synthetic "document" scene so the lens visibly magnifies without a camera. */
function drawDemoScene(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#111827");
  g.addColorStop(1, "#1f2937");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // A faint "page" of tiny print — precisely the content a magnifier enlarges.
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
        color === 0 ? "rgba(255,255,255,0.85)" : color === 1 ? "rgba(147,197,253,0.9)" : "rgba(253,224,71,0.9)";
      const tw = ctx.measureText(word).width;
      ctx.fillText(word, x, y);
      x += tw + 16;
      i += 1;
    }
  }
  ctx.textBaseline = "alphabetic";
}



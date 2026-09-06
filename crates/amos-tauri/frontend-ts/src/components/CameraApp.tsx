import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import {
  startVideoRecording,
  persistVideoCapture,
  removeVideoCapture,
  captureBlob,
  listCaptures,
  newCaptureId,
  RecordingUnavailableError,
  type ActiveVideoRecording,
  type VideoCapture,
} from "../lib/cameraCapture";
import { grantCap, loadLedger, saveLedger, type Capability } from "../lib/permissions";
import { PHOTOS_KEY, newPhoto, newCapturePhoto, type Photo } from "../lib/photos";
import {
  ZOOM_STEPS,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_SLIDER_STEP,
  resOf,
  nextRes,
  facingMode,
  mirrorPreview,
  clampZoom,
  nextZoom,
  fitCrop,
  zoomCrop,
  captureDims,
  type CamFacing,
  type CamFlash,
  type CamRatio,
  type CamResId,
} from "../lib/camera";

// Module-level monotonic counter: burst / rapid captures get unique ids even if
// two frames land in the same millisecond (photo ids are timestamp-based).
let shotSeq = 0;

/** Read the most recent real captured photo (thumbnail chip). */
function latestPhoto(list: Photo[]): Photo | undefined {
  for (const p of list) if (p.data) return p;
  return undefined;
}

/** A small iOS-style round control overlaid on the viewfinder. */
function Control({
  label,
  title,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={
        "grid h-9 min-w-9 place-items-center rounded-full px-1.5 text-[13px] leading-none transition active:scale-90 disabled:opacity-25 " +
        (active ? "bg-white text-neutral-900 shadow" : "bg-black/30 text-white ring-1 ring-white/30")
      }
    >
      {children}
    </button>
  );
}

export default function CameraApp() {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [live, setLive] = useState(false);
  const [hint, setHint] = useState("");
  const [retriable, setRetriable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);

  // iPhone-style controls (state/math lives in lib/camera).
  const [facing, setFacing] = useState<CamFacing>("back");
  const [flash, setFlash] = useState<CamFlash>("auto");
  const [ratio, setRatio] = useState<CamRatio>("4:3");
  const [zoom, setZoom] = useState<number>(ZOOM_STEPS[0]!);
  const [grid, setGrid] = useState(false);
  const [timer, setTimer] = useState<number>(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [flashFx, setFlashFx] = useState(false);
  const [last, setLast] = useState<Photo | null>(() =>
    latestPhoto(readStoreValue<Photo[]>(PHOTOS_KEY, [])) ?? null,
  );
  const timerIdRef = useRef<number | null>(null);

  // Video recording + capture library.
  const [mode, setMode] = useState<"photo" | "video">("photo");
  const [recState, setRecState] = useState<"idle" | "recording">("idle");
  const [recErr, setRecErr] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [captures, setCaptures] = useState<VideoCapture[]>(() => listCaptures());
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [viewUrl, setViewUrl] = useState("");
  const recRef = useRef<ActiveVideoRecording | null>(null);
  const elapsedRef = useRef<number | null>(null);
  const recTickRef = useRef<number | null>(null);

  // Capture resolution tier + honest HDR preference.
  const [res, setRes] = useState<CamResId>("hd");
  const [hdr, setHdr] = useState(false);
  // Long-press burst support (photo mode).
  const heldRef = useRef(false);
  const burstDelayRef = useRef<number | null>(null);
  const burstIvRef = useRef<number | null>(null);
  const burstSuppressClickRef = useRef(false);
  // Selectable burst mode (tap → N frames with a live counter); N is adjustable.
  const BURST_OPTS = [6, 12] as const;
  const [burst, setBurst] = useState<number>(0);
  const [burstSeq, setBurstSeq] = useState<{ taken: number; total: number } | null>(null);
  const burstSeqRef = useRef<number | null>(null);


  // Default-allowed camera: there is no in-app permission gate or confirmation
  // screen. The camera is always granted so the app opens straight into the live
  // viewfinder (the OS/WebView may still prompt on the very first real
  // getUserMedia — that layer is outside the UI and can't be bypassed here). We
  // also record the grant in the shared ledger so other capability gates treat
  // camera as allowed.
  const APP_ID = "camera";
  const CAMERA_CAP: Capability = "camera";

  useEffect(() => {
    saveLedger(grantCap(loadLedger(), APP_ID, CAMERA_CAP));
  }, []);

  const supported =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  // (Re)acquire the feed when a lens flips, resolution/HDR changes, or retry.
  useEffect(() => {
    if (!supported) {
      setHint(t("camera.noCamera"));
      setRetriable(false);
      return;
    }
    let cancelled = false;
    setLive(false);
    setHint(t("camera.starting"));
    setRetriable(false);
    navigator.mediaDevices!
      .getUserMedia({
        video: {
          facingMode: facingMode(facing),
          width: { ideal: resOf(res).w },
          height: { ideal: resOf(res).h },
        },
      })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        streamRef.current = s;
        try {
          if (videoRef.current) videoRef.current.srcObject = s;
        } catch {
          /* non-MediaStream runtimes: still allow demo capture */
        }
        // Best-effort torch when flash is On (unsupported → UI-only state).
        if (flash === "on") {
          try {
            const track = s.getVideoTracks()[0];
            if (track?.applyConstraints)
              void track.applyConstraints({
                advanced: [{ torch: true }],
              } as unknown as MediaTrackConstraints);
          } catch {
            /* torch unsupported — the flash chip still reflects the choice */
          }
        }
        setLive(true);
        setHint("");
        setRetriable(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const name: unknown = (err as { name?: unknown })?.name;
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setHint(t("camera.denied"));
        } else {
          setHint(t("camera.noCamera"));
        }
        setRetriable(true);
      });
    return () => {
      cancelled = true;
      if (timerIdRef.current != null) window.clearInterval(timerIdRef.current);
      timerIdRef.current = null;
      setCountdown(null);
      // If a video is mid-recording when the stream re-acquires / unmounts, stop it.
      try {
        if (recRef.current) cancelRecording();
      } catch {
        /* ignore */
      }
      // Drop any in-flight burst / long-press capture too.
      try {
        stopBurstSeq();
        clearBurst();
      } catch {
        /* ignore */
      }
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, supported, t, facing, res]);

  const retry = useCallback(() => {
    if (supported) setAttempt((n) => n + 1);
  }, [supported]);

  // Apply torch on the live track when Flash turns On (best-effort; some
  // devices/browsers don't expose it — the chip still reflects the choice).
  const setFlashState = (next: CamFlash) => {
    setFlash(next);
    const track = streamRef.current?.getVideoTracks()[0];
    if (next === "on") {
      try {
        if (track?.applyConstraints)
          void track.applyConstraints({
            advanced: [{ torch: true }],
          } as unknown as MediaTrackConstraints);
      } catch {
        /* torch unsupported */
      }
    }
  };

  // Capture: real frame → canvas (aspect + zoom applied); else demo placeholder.
  const doCapture = useCallback(() => {
    const list = readStoreValue<Photo[]>(PHOTOS_KEY, []);
    const now = Date.now();
    const cid = `c${now}-${shotSeq++}`; // unique even for same-ms burst frames
    const video = videoRef.current;
    let photo: Photo;
    if (live && video && typeof document !== "undefined" && video.videoWidth > 0) {
      try {
        const { w, h } = captureDims(ratio);
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext && cv.getContext("2d");
        if (ctx) {
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const out = { w, h };
          const crop = zoom > ZOOM_MIN ? zoomCrop(vw, vh, zoom, out) : fitCrop(vw, vh, out);
          if (mirrorPreview(facing)) {
            ctx.save();
            ctx.translate(w, 0);
            ctx.scale(-1, 1); // selfie captures read naturally (not mirrored text)
          }
          if (crop) ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
          else ctx.drawImage(video, 0, 0, w, h);
          if (mirrorPreview(facing)) ctx.restore();
          photo = newCapturePhoto(cid, now, cv.toDataURL("image/jpeg", 0.82));
        } else {
          photo = newPhoto(cid, now);
        }
      } catch {
        photo = newPhoto(cid, now);
      }
    } else {
      photo = newPhoto(cid, now);
    }
    writeStoreValue(PHOTOS_KEY, [photo, ...list]);
    if (photo.data) setLast(photo);
    setHint(t("camera.saved"));
    setFlashFx(true);
    window.setTimeout(() => setFlashFx(false), 120);
  }, [live, ratio, zoom, facing, t]);

  const captureRef = useRef(doCapture);
  captureRef.current = doCapture;

  const cancelCountdown = () => {
    if (timerIdRef.current != null) {
      window.clearInterval(timerIdRef.current);
      timerIdRef.current = null;
    }
    setCountdown(null);
  };

  const startCountdown = (sec: number) => {
    cancelCountdown();
    setCountdown(sec);
    timerIdRef.current = window.setInterval(() => {
      setCountdown((c) => {
        if (c == null || c <= 1) {
          if (timerIdRef.current != null) window.clearInterval(timerIdRef.current);
          timerIdRef.current = null;
          captureRef.current();
          return null;
        }
        return c - 1;
      });
    }, 1000);
  };

  const pressShutter = () => {
    if (!live) return;
    if (mode === "video") {
      if (recState === "recording") void endRecord();
      else void beginRecord();
      return;
    }
    if (countdown != null) {
      cancelCountdown(); // iPhone-style: a second tap cancels the timer
      return;
    }
    if (timer > 0) startCountdown(timer);
    else doCapture();
  };

  // ---- long-press burst (photo mode) ----
  const clearBurst = () => {
    if (burstDelayRef.current != null) {
      window.clearTimeout(burstDelayRef.current);
      burstDelayRef.current = null;
    }
    if (burstIvRef.current != null) {
      window.clearInterval(burstIvRef.current);
      burstIvRef.current = null;
    }
    heldRef.current = false;
  };
  const onShutterDown = () => {
    if (!live || mode !== "photo" || recState === "recording" || burst > 0) return;
    heldRef.current = true;
    burstDelayRef.current = window.setTimeout(() => {
      if (heldRef.current) {
        burstSuppressClickRef.current = true; // long press = burst, skip the single shot
        if (burstIvRef.current == null)
          burstIvRef.current = window.setInterval(() => captureRef.current(), 150);
      }
    }, 350);
  };
  const onShutterUp = () => clearBurst(); // short tap → the click fires a single shot
  const stopBurstSeq = () => {
    if (burstSeqRef.current != null) {
      window.clearInterval(burstSeqRef.current);
      burstSeqRef.current = null;
    }
    setBurstSeq(null);
  };
  const runBurstSeq = (total: number) => {
    if (!live || burstSeqRef.current != null) return;
    let taken = 0;
    setBurstSeq({ taken: 0, total });
    burstSeqRef.current = window.setInterval(() => {
      taken += 1;
      captureRef.current();
      setBurstSeq({ taken, total });
      if (taken >= total) stopBurstSeq();
    }, 150);
  };
  const onShutterClick = () => {
    if (burstSuppressClickRef.current) {
      burstSuppressClickRef.current = false;
      return; // a long-press burst already ran for this hold
    }
    if (mode === "photo" && burst > 0) {
      runBurstSeq(burst); // selectable burst: tap → `burst` quick frames
      return;
    }
    pressShutter();
  };
  useEffect(
    () => () => {
      clearBurst();
      stopBurstSeq();
    },
    [],
  );
  const toggleHdr = () => {
    setHdr((h) => {
      const next = !h;
      setHint(next ? t("camera.hdrNote") : "");
      return next;
    });
  };

  const flipCam = () => {
    if (!live) return;
    if (recState === "recording") return; // flipping re-acquires the stream → would cancel the take
    setFacing((f) => (f === "back" ? "front" : "back"));
    setFlash("auto"); // iOS resets flash when flipping lenses
  };

  const flashLabel: Record<CamFlash, string> = { auto: "⚡A", on: "⚡", off: "⚡" };
  const ratioLabel: Record<CamRatio, string> = {
    "4:3": "4:3",
    square: "□",
    "16:9": "16:9",
  };
  const mirror = mirrorPreview(facing);

  // ---- dynamic / pinch zoom ----
  const zoomText = (z: number) => (Math.round(z * 100) % 100 === 0 ? `${z}×` : `${z.toFixed(1)}×`);
  const pinch = useRef({
    ids: new Map<number, { x: number; y: number }>(),
    d0: 0,
    z0: 1,
  });
  const pinchDistance = () => {
    const pts = [...pinch.current.ids.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
  };
  const onPinchDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest?.("button")) return; // don't hijack controls
    pinch.current.ids.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current.ids.size === 2) {
      pinch.current.d0 = pinchDistance();
      pinch.current.z0 = zoom;
    }
  };
  const onPinchMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pinch.current.ids.get(e.pointerId);
    if (p) p.x = e.clientX, p.y = e.clientY;
    if (pinch.current.ids.size >= 2 && pinch.current.d0 > 0) {
      const d = pinchDistance();
      setZoom((z) => clampZoom((pinch.current.z0 * d) / pinch.current.d0 || z));
    }
  };
  const onPinchEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    pinch.current.ids.delete(e.pointerId);
    if (pinch.current.ids.size < 2) pinch.current.d0 = 0;
  };
  const onZoomDoubleTap = () => setZoom((z) => (z > ZOOM_MIN ? ZOOM_MIN : 2));

  // ---- video recording + capture library ----
  const fmtClockSec = (s: number) => {
    const m = Math.floor(Math.max(0, s) / 60);
    const ss = Math.floor(Math.max(0, s) % 60);
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  };
  const stopTicking = () => {
    if (recTickRef.current != null) {
      window.clearInterval(recTickRef.current);
      recTickRef.current = null;
    }
  };
  const beginRecord = async () => {
    if (!live || !streamRef.current) return;
    setRecErr("");
    try {
      const r = await startVideoRecording(streamRef.current, newCaptureId());
      recRef.current = r;
      elapsedRef.current = Date.now();
      setElapsed(0);
      setRecState("recording");
      recTickRef.current = window.setInterval(() => {
        setElapsed(elapsedRef.current ? (Date.now() - elapsedRef.current) / 1000 : 0);
      }, 250);
    } catch (e) {
      setRecErr(e instanceof RecordingUnavailableError ? t("camera.recUnavailable") : t("camera.recUnavailable"));
    }
  };
  const endRecord = async () => {
    const r = recRef.current;
    stopTicking();
    recRef.current = null;
    setRecState("idle");
    if (!r) return;
    try {
      const { capture, blob } = await r.stop();
      // Record the source resolution so the Photos library can show it.
      const track = streamRef.current?.getVideoTracks()[0];
      const settings = (track as { getSettings?: () => MediaTrackSettings } | undefined)?.getSettings?.();
      const meta: VideoCapture = {
        ...capture,
        w: settings?.width || videoRef.current?.videoWidth || undefined,
        h: settings?.height || videoRef.current?.videoHeight || undefined,
      };
      await persistVideoCapture(meta, blob);
      setCaptures(listCaptures());
      setRecErr("");
      setHint(t("camera.recSaved"));
    } catch {
      setRecErr(t("camera.recUnavailable"));
    }
  };
  const cancelRecording = () => {
    stopTicking();
    recRef.current?.cancel();
    recRef.current = null;
    setRecState("idle");
  };
  const toggleMode = (m: "photo" | "video") => {
    if (m === mode) return;
    if (recState === "recording") cancelRecording();
    stopBurstSeq();
    setMode(m);
    cancelCountdown();
  };
  const openViewer = async (id: string) => {
    setViewerId(id);
    const blob = await captureBlob(id);
    if (blob) {
      try {
        if (typeof URL !== "undefined" && URL.createObjectURL) setViewUrl(URL.createObjectURL(blob));
      } catch {
        /* object URLs unavailable (headless) — the overlay shows a spinner */
      }
    }
  };
  const closeViewer = () => {
    if (viewUrl) URL.revokeObjectURL(viewUrl);
    setViewUrl("");
    setViewerId(null);
  };
  const delCapture = async (id: string) => {
    await removeVideoCapture(id);
    setCaptures(listCaptures());
    closeViewer();
  };




  return (
    <div className="flex h-full flex-col bg-black text-white">
      <div
        className="relative min-h-0 flex-1 touch-none overflow-hidden bg-neutral-950"
        onPointerDown={live ? onPinchDown : undefined}
        onPointerMove={live ? onPinchMove : undefined}
        onPointerUp={live ? onPinchEnd : undefined}
        onPointerCancel={live ? onPinchEnd : undefined}
        onDoubleClick={live ? onZoomDoubleTap : undefined}
      >
        {/* live feed: object-cover, zoomed; mirrored on the front (selfie) lens */}
        {live && (
          <div
            className="absolute inset-0"
            style={{ transform: `scale(${clampZoom(zoom)})`, transformOrigin: "center" }}
          >
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className={"h-full w-full object-cover " + (mirror ? "-scale-x-100" : "")}
            />
          </div>
        )}
        {/* demo viewfinder fallback (no camera / headless) */}
        {!live && <div className="grid h-full place-items-center text-6xl">🏔️</div>}

        {/* rule-of-thirds grid */}
        {live && grid && (
          <div aria-hidden className="pointer-events-none absolute inset-0">
            <div className="absolute inset-y-0 left-1/3 w-px bg-white/35" />
            <div className="absolute inset-y-0 left-2/3 w-px bg-white/35" />
            <div className="absolute inset-x-0 top-1/3 h-px bg-white/35" />
            <div className="absolute inset-x-0 top-2/3 h-px bg-white/35" />
          </div>
        )}

        {/* countdown + shutter-flash overlays */}
        {countdown != null && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="grid h-20 w-20 place-items-center rounded-full bg-black/40 text-4xl font-thin text-white ring-2 ring-white">
              {countdown}
            </div>
          </div>
        )}
        {flashFx && <div className="pointer-events-none absolute inset-0 bg-white" />}

        {/* recording indicator (video mode) */}
        {recState === "recording" && (
          <div className="pointer-events-none absolute inset-x-0 top-14 flex justify-center">
            <div className="flex items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-xs ring-1 ring-white/30">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
              {fmtClockSec(elapsed)} · {t("camera.recording")}
            </div>
          </div>
        )}

        {/* burst-in-progress counter */}
        {burstSeq && (
          <div className="pointer-events-none absolute inset-x-0 top-16 flex justify-center">
            <div className="rounded-full bg-black/50 px-3 py-1 text-xs text-white ring-1 ring-white/30">
              🎞 {t("camera.burst")} {burstSeq.taken}/{burstSeq.total}
            </div>
          </div>
        )}

        {/* top toolbar (hidden while recording a video — those options don't apply
            to the recorded stream and would only mislead) */}
        {live && recState !== "recording" && burstSeq == null && (
          <div className="absolute inset-x-0 top-0 flex items-center justify-between p-3">
            <Control
              label={t("camera.grid")}
              title={t("camera.grid")}
              onClick={() => setGrid((g) => !g)}
              active={grid}
            >
              ▦
            </Control>
            <div className="flex items-center gap-2">
              <Control
                label={t("camera.flash")}
                title={t("camera.flash")}
                onClick={() => setFlashState(flash === "auto" ? "on" : flash === "on" ? "off" : "auto")}
                active={flash === "on"}
              >
                {flashLabel[flash]}
              </Control>
              <Control
                label={t("camera.timer")}
                title={t("camera.timer")}
                onClick={() => setTimer((s) => (s === 0 ? 3 : s === 3 ? 10 : 0))}
                active={timer > 0}
              >
                ⏱{timer > 0 ? timer : ""}
              </Control>
              <Control
                label={t("camera.aspect")}
                title={t("camera.aspect")}
                onClick={() => setRatio((r) => (r === "4:3" ? "square" : r === "square" ? "16:9" : "4:3"))}
              >
                {ratioLabel[ratio]}
              </Control>
              <Control
                label={t("camera.zoom")}
                title={t("camera.zoom")}
                onClick={() => setZoom((z) => nextZoom(z))}
                active={zoom > 1}
              >
                {zoomText(zoom)}
              </Control>
              <Control
                label={t("camera.res")}
                title={t("camera.res")}
                onClick={() => setRes((r) => nextRes(r))}
              >
                {resOf(res).label}
              </Control>
              <Control
                label={t("camera.hdr")}
                title={t("camera.hdr")}
                onClick={toggleHdr}
                active={hdr}
              >
                HDR
              </Control>
            </div>
          </div>
        )}
        </div>



        {/* bottom toolbar (always shown: camera is default-allowed) */}
        {(
        <div className="flex flex-col items-center gap-1.5 bg-gradient-to-t from-black to-transparent px-3 pt-1 pb-2">
          {hint ? (
            <p className="text-xs text-white/70">{hint}</p>
          ) : (
            <p className="text-[11px] text-white/30">{live ? ratioLabel[ratio] : "· · ·"}</p>
          )}
          {retriable && (
            <button
              onClick={retry}
              className="rounded-full bg-white/15 px-4 py-1 text-xs text-white ring-1 ring-white/25 transition active:scale-95"
            >
              {t("camera.retry")}
            </button>
          )}
          {recErr && <p role="status" className="text-[11px] text-amber-300">{recErr}</p>}
          {/* Photo / Video mode switch */}
          <div className="flex items-center rounded-full bg-white/15 p-0.5 ring-1 ring-white/25">
            {(["photo", "video"] as const).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                aria-label={m === "photo" ? t("camera.photo") : t("camera.video")}
                onClick={() => toggleMode(m)}
                disabled={recState === "recording"}
                className={
                  "rounded-full px-5 py-1 text-[13px] font-medium transition " +
                  (mode === m ? "bg-white text-neutral-900 shadow" : "text-white/75")
                }
              >
                {m === "photo" ? t("camera.photo") : t("camera.video")}
              </button>
            ))}
          </div>

          {/* selectable burst mode (photo) */}
          {mode === "photo" && live && (
            <button
              aria-label={t("camera.burst")}
              aria-pressed={burst > 0}
              onClick={() => {
                setBurst((b) => (b === 0 ? BURST_OPTS[0] : b === BURST_OPTS[0] ? BURST_OPTS[1] : 0));
                stopBurstSeq();
              }}
              className={
                "rounded-full px-4 py-1 text-[11px] transition " +
                (burst > 0 ? "bg-white text-neutral-900 shadow" : "bg-white/15 text-white/80 ring-1 ring-white/25")
              }
            >
              🎞 {t("camera.burst")} {burst > 0 ? `×${burst}` : "○"}
            </button>
          )}

          {/* continuous zoom slider (also controllable by pinch / double-tap) */}
          {live && mode === "photo" && (
            <div className="flex w-full max-w-xs items-center gap-3 px-2">
              <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-white/70">
                {zoomText(zoom)}
              </span>
              <input
                type="range"
                aria-label="zoom slider"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={ZOOM_SLIDER_STEP}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="flex-1 accent-white"
              />
            </div>
          )}
          {/* iPhone-style bottom bar: thumbnail · shutter · flip */}
          <div className="flex w-full items-center justify-between px-6 pt-0.5">
            <button
              aria-label="last photo"
              disabled={!last}
              className="grid h-12 w-12 place-items-center overflow-hidden rounded-[11px] bg-white/15 ring-1 ring-white/40 disabled:opacity-30"
            >
              {last?.data ? (
                <img src={last.data} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="opacity-60">🖼️</span>
              )}
            </button>
            <button
              onClick={onShutterClick}
              onPointerDown={onShutterDown}
              onPointerUp={onShutterUp}
              onPointerCancel={onShutterUp}
              onPointerLeave={onShutterUp}
              aria-label="shutter"
              disabled={!live}
              className="relative my-1 grid h-[78px] w-[78px] place-items-center rounded-full ring-[5px] ring-white transition active:scale-90 disabled:opacity-40"
            >
              <span className="h-[62px] w-[62px] rounded-full bg-white" />
            </button>
            <button
              onClick={flipCam}
              disabled={!live || recState === "recording"}
              aria-label={t("camera.flip")}
              className="grid h-12 w-12 place-items-center rounded-full bg-white/15 text-xl ring-1 ring-white/40 transition active:scale-90 disabled:opacity-40"
            >
              ⇄
            </button>
          </div>
          {/* video capture library (filmstrip, plays in the viewer overlay) */}
          {mode === "video" && captures.length > 0 && (
            <div className="flex w-full gap-2 overflow-x-auto px-4 pt-1">
              {captures.map((c) => (
                <button
                  key={c.id}
                  aria-label={t("camera.library")}
                  onClick={() => void openViewer(c.id)}
                  className="relative grid h-14 w-[76px] shrink-0 place-items-center overflow-hidden rounded-lg bg-white/12 text-xl ring-1 ring-white/25 transition active:scale-95"
                >
                  🎬
                  <span className="absolute bottom-0.5 right-1 rounded bg-black/60 px-0.5 text-[9px] tabular-nums">
                    {fmtClockSec(c.durationMs / 1000)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* video player overlay (open a capture from the library) */}
      {viewerId && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/90 px-4">
          <div className="relative w-full max-w-lg">
            {viewUrl ? (
              <video src={viewUrl} controls autoPlay playsInline className="max-h-[70vh] w-full rounded-xl" />
            ) : (
              <div className="grid h-40 w-full place-items-center text-white/50">…</div>
            )}
            <div className="mt-3 flex items-center justify-between">
              <button
                onClick={closeViewer}
                aria-label={t("camera.library")}
                className="rounded-full bg-white/15 px-5 py-1.5 text-sm text-white ring-1 ring-white/25"
              >
                ✕
              </button>
              <button
                onClick={() => void delCapture(viewerId)}
                className="rounded-full bg-danger/90 px-4 py-1.5 text-sm text-white"
              >
                {t("camera.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


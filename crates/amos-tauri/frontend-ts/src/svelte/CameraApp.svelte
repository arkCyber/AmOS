<script lang="ts">
  // CameraApp.svelte — Svelte 5 (runes) single-source implementation of the camera
  // screen. Pure control/capture math reuses
  // lib/camera.ts + lib/cameraCapture.ts; photos land in lib/photos store; the
  // camera is default-allowed (no in-app gate) and granted to the shared ledger
  // on mount. The live feed path is gated on navigator.mediaDevices?.getUserMedia
  // exactly like React, so headless runs take the demo viewfinder (🏔️) path.
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import {
    startVideoRecording,
    persistVideoCapture,
    removeVideoCapture,
    captureBlob,
    listCaptures,
    newCaptureId,
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
    focusFromRect,
    afInit,
    afTap,
    afCaption,
    type AfState,
    type CamFacing,
    type CamFlash,
    type CamRatio,
    type CamResId,
  } from "../lib/camera";
  import { t } from "./locale.svelte";

  // Monotonic counter: burst / rapid captures get unique ids even if two frames
  // land in the same millisecond (photo ids are timestamp-based).
  let shotSeq = 0;

  /** Read the most recent real captured photo (thumbnail chip). */
  function latestPhoto(list: Photo[]): Photo | undefined {
    for (const p of list) if (p.data) return p;
    return undefined;
  }

  // Default-allowed camera: there is no in-app permission gate or confirmation
  // screen — always granted so the app opens straight into the live viewfinder.
  const APP_ID = "camera";
  const CAMERA_CAP: Capability = "camera";
  saveLedger(grantCap(loadLedger(), APP_ID, CAMERA_CAP));

  // DOM / stream refs (non-reactive mutable locals).
  let videoEl = $state<HTMLVideoElement | null>(null);
  let stream: MediaStream | null = null;
  let timerId: number | null = null;
  let recTickId: number | null = null;
  let recStart = 0;
  let rec: ActiveVideoRecording | null = null;
  let gen = 0; // acquisition generation token (ignore stale getUserMedia resolves)

  // ---- iPhone-style controls (state/math lives in lib/camera) ----
  let live = $state(false);
  let hint = $state("");
  let retriable = $state(false);
  let facing = $state<CamFacing>("back");
  let flash = $state<CamFlash>("auto");
  let ratio = $state<CamRatio>("4:3");
  let zoom = $state<number>(ZOOM_STEPS[0] ?? 1);
  let grid = $state(false);
  let timer = $state<number>(0);
  let countdown = $state<number | null>(null);
  // Tap-to-focus / AE-AF lock state (pure model in lib/camera).
  let af = $state<AfState>(afInit());
  let flashFx = $state(false);
  let last = $state<Photo | null>(
    latestPhoto(readStoreValue<Photo[]>(PHOTOS_KEY, [])) ?? null,
  );

  // Video recording + capture library.
  let mode = $state<"photo" | "video">("photo");
  let recState = $state<"idle" | "recording">("idle");
  let recErr = $state("");
  let elapsed = $state(0);
  let captures = $state<VideoCapture[]>(listCaptures());
  let viewerId = $state<string | null>(null);
  let viewUrl = $state("");

  // Capture resolution tier + honest HDR preference.
  let res = $state<CamResId>("hd");
  let hdr = $state(false);

  // Long-press burst (photo mode).
  let held = false;
  let burstDelay: number | null = null;
  let burstIv: number | null = null;
  let burstSuppressClick = false;
  // Selectable burst mode (tap → N frames with a live counter); N is adjustable.
  const BURST_OPTS = [6, 12] as const;
  let burst = $state<number>(0);
  let burstSeq = $state<{ taken: number; total: number } | null>(null);
  let burstSeqId: number | null = null;

  // ---- dynamic / pinch zoom + tap-to-focus ----
  let pinch: {
    ids: Map<number, { x: number; y: number }>;
    d0: number;
    z0: number;
    tap: { id: number; x: number; y: number; t: number } | null;
  } = {
    ids: new Map(),
    d0: 0,
    z0: 1,
    tap: null,
  };

  const supported =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const mirror = $derived(mirrorPreview(facing));
  // ---- (re)acquire the live feed ----
  function stopStream() {
    const old = stream;
    stream = null;
    old?.getTracks().forEach((tr) => tr.stop());
  }
  async function acquire(): Promise<void> {
    const my = ++gen;
    if (!supported) {
      if (my === gen) {
        hint = t("camera.noCamera");
        retriable = false;
        live = false;
      }
      return;
    }
    // Drop any in-flight burst / long-press capture and mid-recording take.
    try {
      if (rec) cancelRecording();
    } catch {
      /* ignore */
    }
    stopBurstSeq();
    clearBurst();
    if (timerId != null) {
      window.clearInterval(timerId);
      timerId = null;
    }
    countdown = null;
    stopStream();
    live = false;
    hint = t("camera.starting");
    retriable = false;
    try {
      const s = await navigator.mediaDevices!.getUserMedia({
        video: {
          facingMode: facingMode(facing),
          width: { ideal: resOf(res).w },
          height: { ideal: resOf(res).h },
        },
      });
      if (my !== gen) {
        s.getTracks().forEach((tr) => tr.stop());
        return;
      }
      stream = s;
      try {
        if (videoEl) videoEl.srcObject = s;
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
      if (my === gen) {
        live = true;
        hint = "";
        retriable = false;
      }
    } catch (err) {
      if (my !== gen) return;
      const name: unknown = (err as { name?: unknown })?.name;
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        hint = t("camera.denied");
      } else {
        hint = t("camera.noCamera");
      }
      retriable = true;
    }
  }

  // Acquire once after mount; teardown everything when the component unmounts.
  let inited = false;
  $effect(() => {
    if (inited) return;
    inited = true;
    void acquire();
    return () => {
      stopBurstSeq();
      clearBurst();
      try {
        if (rec) cancelRecording();
      } catch {
        /* ignore */
      }
      if (timerId != null) {
        window.clearInterval(timerId);
        timerId = null;
      }
      countdown = null;
      stopStream();
      if (viewUrl) {
        try {
          URL.revokeObjectURL(viewUrl);
        } catch {
          /* ignore */
        }
        viewUrl = "";
      }
    };
  });

  // Attach the acquired stream to the <video> once it mounts. On first open the
  // feed resolves before live=true renders the element, so `acquire` can't wire
  // srcObject synchronously — this effect does it as soon as videoEl binds.
  $effect(() => {
    const el = videoEl;
    if (el && stream) {
      try {
        el.srcObject = stream;
      } catch {
        /* non-MediaStream runtimes: still allow demo capture */
      }
    }
  });

  const retry = () => {
    if (supported) void acquire();
  };

  // Apply torch on the live track when Flash turns On (best-effort).
  const setFlashState = (next: CamFlash) => {
    flash = next;
    const track = stream?.getVideoTracks()[0];
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
  // ---- Capture: real frame → canvas (aspect + zoom applied); else demo ----
  function doCapture(): void {
    const list = readStoreValue<Photo[]>(PHOTOS_KEY, []);
    const now = Date.now();
    const cid = `c${now}-${shotSeq++}`; // unique even for same-ms burst frames
    const video = videoEl;
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
            ctx.scale(-1, 1); // selfie captures read naturally (not mirrored)
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
    if (photo.data) last = photo;
    hint = t("camera.saved");
    flashFx = true;
    window.setTimeout(() => {
      flashFx = false;
    }, 120);
  }

  // ---- countdown timer (iPhone-style: second tap cancels) ----
  function cancelCountdown(): void {
    if (timerId != null) {
      window.clearInterval(timerId);
      timerId = null;
    }
    countdown = null;
  }
  function startCountdown(sec: number): void {
    cancelCountdown();
    countdown = sec;
    timerId = window.setInterval(() => {
      if (countdown == null || countdown <= 1) {
        if (timerId != null) {
          window.clearInterval(timerId);
          timerId = null;
        }
        countdown = null;
        doCapture();
      } else {
        countdown = countdown - 1;
      }
    }, 1000);
  }

  function pressShutter(): void {
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
  }

  // ---- long-press burst (photo mode) ----
  function clearBurst(): void {
    if (burstDelay != null) {
      window.clearTimeout(burstDelay);
      burstDelay = null;
    }
    if (burstIv != null) {
      window.clearInterval(burstIv);
      burstIv = null;
    }
    held = false;
  }
  function onShutterDown(): void {
    if (!live || mode !== "photo" || recState === "recording" || burst > 0) return;
    held = true;
    burstDelay = window.setTimeout(() => {
      if (held) {
        burstSuppressClick = true; // long press = burst, skip the single shot
        if (burstIv == null) burstIv = window.setInterval(() => doCapture(), 150);
      }
    }, 350);
  }
  const onShutterUp = () => clearBurst(); // short tap → click fires a single shot
  function stopBurstSeq(): void {
    if (burstSeqId != null) {
      window.clearInterval(burstSeqId);
      burstSeqId = null;
    }
    burstSeq = null;
  }
  function runBurstSeq(total: number): void {
    if (!live || burstSeqId != null) return;
    let taken = 0;
    burstSeq = { taken: 0, total };
    burstSeqId = window.setInterval(() => {
      taken += 1;
      doCapture();
      burstSeq = { taken, total };
      if (taken >= total) stopBurstSeq();
    }, 150);
  }
  function onShutterClick(): void {
    if (burstSuppressClick) {
      burstSuppressClick = false;
      return; // a long-press burst already ran for this hold
    }
    if (mode === "photo" && burst > 0) {
      runBurstSeq(burst); // selectable burst: tap → `burst` quick frames
      return;
    }
    pressShutter();
  }
  // ---- pinch / dynamic zoom handlers (Svelte native PointerEvent) ----
  const fmtClockSec = (s: number) => {
    const m = Math.floor(Math.max(0, s) / 60);
    const ss = Math.floor(Math.max(0, s) % 60);
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  };
  function pinchDistance(): number {
    const pts = [...pinch.ids.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
  }
  function onPinchDown(e: PointerEvent): void {
    if ((e.target as HTMLElement).closest?.("button")) return; // don't hijack controls
    pinch.ids.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.ids.size === 2) {
      pinch.d0 = pinchDistance();
      pinch.z0 = zoom;
      pinch.tap = null; // a second finger means zoom, not a tap
    } else if (pinch.ids.size === 1) {
      pinch.tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    }
  }
  function onPinchMove(e: PointerEvent): void {
    const p = pinch.ids.get(e.pointerId);
    if (p) {
      p.x = e.clientX;
      p.y = e.clientY;
    }
    // a real drag (not a tap) invalidates the tap candidate
    const t = pinch.tap;
    if (t && t.id === e.pointerId) {
      if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > 12) pinch.tap = null;
    }
    if (pinch.ids.size >= 2 && pinch.d0 > 0) {
      const d = pinchDistance();
      zoom = clampZoom((pinch.z0 * d) / pinch.d0 || zoom);
    }
  }
  function onPinchEnd(e: PointerEvent): void {
    pinch.ids.delete(e.pointerId);
    // a quick, still single tap = tap-to-focus (first tap aims; again locks)
    const t = pinch.tap;
    if (t && t.id === e.pointerId) {
      pinch.tap = null;
      if (performance.now() - t.t < 500) {
        tapToFocus(t.x, t.y, e.currentTarget as HTMLElement);
      }
    }
    if (pinch.ids.size < 2) pinch.d0 = 0;
  }
  const onZoomDoubleTap = () => {
    zoom = zoom > ZOOM_MIN ? ZOOM_MIN : 2;
  };

  // ---- video recording + capture library ----
  function stopTicking(): void {
    if (recTickId != null) {
      window.clearInterval(recTickId);
      recTickId = null;
    }
  }
  async function beginRecord(): Promise<void> {
    if (!live || !stream) return;
    recErr = "";
    try {
      const r = await startVideoRecording(stream, newCaptureId());
      rec = r;
      recStart = Date.now();
      elapsed = 0;
      recState = "recording";
      recTickId = window.setInterval(() => {
        elapsed = recStart ? (Date.now() - recStart) / 1000 : 0;
      }, 250);
    } catch {
      recErr = t("camera.recUnavailable");
    }
  }
  async function endRecord(): Promise<void> {
    const r = rec;
    stopTicking();
    rec = null;
    recState = "idle";
    if (!r) return;
    try {
      const { capture, blob } = await r.stop();
      // Record the source resolution so the Photos library can show it.
      const track = stream?.getVideoTracks()[0];
      const settings = (track as { getSettings?: () => MediaTrackSettings } | undefined)?.getSettings?.();
      const meta: VideoCapture = {
        ...capture,
        w: settings?.width || videoEl?.videoWidth || undefined,
        h: settings?.height || videoEl?.videoHeight || undefined,
      };
      await persistVideoCapture(meta, blob);
      captures = listCaptures();
      recErr = "";
      hint = t("camera.recSaved");
    } catch {
      recErr = t("camera.recUnavailable");
    }
  }
  function cancelRecording(): void {
    stopTicking();
    try {
      rec?.cancel();
    } catch {
      /* ignore */
    }
    rec = null;
    recState = "idle";
  }
  const toggleMode = (m: "photo" | "video") => {
    if (m === mode) return;
    if (recState === "recording") cancelRecording();
    stopBurstSeq();
    mode = m;
    cancelCountdown();
  };
  async function openViewer(id: string): Promise<void> {
    viewerId = id;
    const blob = await captureBlob(id);
    if (blob) {
      try {
        if (typeof URL !== "undefined" && URL.createObjectURL)
          viewUrl = URL.createObjectURL(blob);
      } catch {
        /* object URLs unavailable (headless) — the overlay shows a spinner */
      }
    }
  }
  function closeViewer(): void {
    if (viewUrl) URL.revokeObjectURL(viewUrl);
    viewUrl = "";
    viewerId = null;
  }
  async function delCapture(id: string): Promise<void> {
    await removeVideoCapture(id);
    captures = listCaptures();
    closeViewer();
  }

  // ---- control cycles (state/math lives in lib/camera) ----
  const flipCam = () => {
    if (!live) return;
    if (recState === "recording") return; // re-acquiring would cancel the take
    facing = facing === "back" ? "front" : "back";
    flash = "auto"; // iOS resets flash when flipping lenses
    af = afInit(); // focus/point no longer applies to the other lens
    void acquire();
  };
  // iOS tap-to-focus: a quick single tap aims the AF point; tapping the same
  // point again locks AE/AF; tapping elsewhere (or while locked) unlocks +
  // re-aims. Hardware focus is best-effort via track pointsOfInterest;
  // unsupported → the on-screen AF/AE-AF indicator still reflects the model.
  const tapToFocus = (x: number, y: number, el: HTMLElement) => {
    if (!live) return;
    const rect = el.getBoundingClientRect();
    const p = focusFromRect(x, y, rect);
    if (!p) return;
    aimAt(p);
  };
  const aimAt = (p: { x: number; y: number }) => {
    af = afTap(af, p);
    const track = stream?.getVideoTracks()[0];
    try {
      if (track?.applyConstraints)
        void track.applyConstraints({
          advanced: [{ pointsOfInterest: [{ x: p.x, y: p.y }] }],
        } as unknown as MediaTrackConstraints);
    } catch {
      /* focus point unsupported — the UI indicator still reflects the model */
    }
  };
  const toggleHdr = () => {
    hdr = !hdr;
    hint = hdr ? t("camera.hdrNote") : "";
  };
  const resCycle = () => {
    res = nextRes(res);
    void acquire(); // resolution tier needs a fresh stream
  };
  const flashLabel: Record<CamFlash, string> = { auto: "⚡A", on: "⚡", off: "⚡" };
  const ratioLabel: Record<CamRatio, string> = {
    "4:3": "4:3",
    square: "□",
    "16:9": "16:9",
  };
  const zoomText = (z: number) =>
    Math.round(z * 100) % 100 === 0 ? `${z}×` : `${z.toFixed(1)}×`;

  // Reusable round-control style (matches React `Control`).
  const controlCls = (active: boolean) =>
    "grid h-9 min-w-9 place-items-center rounded-full px-1.5 text-[13px] leading-none transition active:scale-90 disabled:opacity-25 " +
    (active ? "bg-white text-neutral-900 shadow" : "bg-black/30 text-white ring-1 ring-white/30");
</script>

<div class="flex h-full flex-col bg-black text-white">
  <!-- The viewfinder handles gestures (tap-to-focus + pinch zoom) via pointer
       events; live feed, AF/AE-AF overlay etc. follow. -->
  <div
    class="relative min-h-0 flex-1 touch-none overflow-hidden bg-neutral-950"
    role="application"
    onpointerdown={live ? onPinchDown : undefined}
    onpointermove={live ? onPinchMove : undefined}
    onpointerup={live ? onPinchEnd : undefined}
    onpointercancel={live ? onPinchEnd : undefined}
    ondblclick={live ? onZoomDoubleTap : undefined}
  >
    <!-- live feed: object-cover, zoomed; mirrored on the front (selfie) lens -->
    {#if live}
      <div
        class="absolute inset-0"
        style="transform: scale({clampZoom(zoom)}); transform-origin: center;"
      >
        <video
          bind:this={videoEl}
          autoplay
          muted
          playsinline
          class={"h-full w-full object-cover " + (mirror ? "-scale-x-100" : "")}
        ></video>
      </div>
    {/if}
    <!-- demo viewfinder fallback (no camera / headless) -->
    {#if !live}
      <div class="grid h-full place-items-center text-6xl">🏔️</div>
    {/if}

    <!-- tap-to-focus AF / AE-AF-lock indicator (iOS-style yellow square) -->
    {#if live && af.x != null && af.y != null}
      <div
        aria-hidden="true"
        class="pointer-events-none absolute z-10"
        style="left: {af.x * 100}%; top: {af.y * 100}%; transform: translate(-50%, -50%);"
      >
        <div class="relative grid h-16 w-16 place-items-center rounded-[3px] border-2 {af.locked ? 'border-amber-300' : 'border-yellow-400'}">
          {#if af.locked}
            <span class="absolute top-0 translate-y-[-110%] rounded bg-black/55 px-1 text-[9px] font-semibold tracking-wide text-amber-200">{afCaption(af)}</span>
          {/if}
        </div>
      </div>
    {/if}

    <!-- rule-of-thirds grid -->
    {#if live && grid}
      <div aria-hidden="true" class="pointer-events-none absolute inset-0">
        <div class="absolute inset-y-0 left-1/3 w-px bg-white/35"></div>
        <div class="absolute inset-y-0 left-2/3 w-px bg-white/35"></div>
        <div class="absolute inset-x-0 top-1/3 h-px bg-white/35"></div>
        <div class="absolute inset-x-0 top-2/3 h-px bg-white/35"></div>
      </div>
    {/if}

    <!-- countdown + shutter-flash overlays -->
    {#if countdown != null}
      <div class="absolute inset-0 grid place-items-center">
        <div class="grid h-20 w-20 place-items-center rounded-full bg-black/40 text-4xl font-medium text-white ring-2 ring-white">
          {countdown}
        </div>
      </div>
    {/if}
    {#if flashFx}
      <div class="pointer-events-none absolute inset-0 bg-white"></div>
    {/if}

    <!-- recording indicator (video mode) -->
    {#if recState === "recording"}
      <div class="pointer-events-none absolute inset-x-0 top-14 flex justify-center">
        <div class="flex items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-xs ring-1 ring-white/30">
          <span class="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500"></span>
          {fmtClockSec(elapsed)} · {t("camera.recording")}
        </div>
      </div>
    {/if}

    <!-- burst-in-progress counter -->
    {#if burstSeq}
      <div class="pointer-events-none absolute inset-x-0 top-16 flex justify-center">
        <div class="rounded-full bg-black/50 px-3 py-1 text-xs text-white ring-1 ring-white/30">
          🎞 {t("camera.burst")} {burstSeq.taken}/{burstSeq.total}
        </div>
      </div>
    {/if}

    <!-- top toolbar (hidden while recording a video) -->
    {#if live && recState !== "recording" && burstSeq == null}
      <div class="absolute inset-x-0 top-0 flex items-center justify-between p-3">
        <button
          aria-label={t("camera.grid")}
          title={t("camera.grid")}
          onclick={() => (grid = !grid)}
          class={controlCls(grid)}
        >▦</button>
        <div class="flex items-center gap-2">
          <button
            aria-label={t("camera.flash")}
            title={t("camera.flash")}
            onclick={() => setFlashState(flash === "auto" ? "on" : flash === "on" ? "off" : "auto")}
            class={controlCls(flash === "on")}
          >{flashLabel[flash]}</button>
          <button
            aria-label={t("camera.timer")}
            title={t("camera.timer")}
            onclick={() => (timer = timer === 0 ? 3 : timer === 3 ? 10 : 0)}
            class={controlCls(timer > 0)}
          >⏱{timer > 0 ? timer : ""}</button>
          <button
            aria-label={t("camera.aspect")}
            title={t("camera.aspect")}
            onclick={() => (ratio = ratio === "4:3" ? "square" : ratio === "square" ? "16:9" : "4:3")}
            class={controlCls(false)}
          >{ratioLabel[ratio]}</button>
          <button
            aria-label={t("camera.zoom")}
            title={t("camera.zoom")}
            onclick={() => (zoom = nextZoom(zoom))}
            class={controlCls(zoom > 1)}
          >{zoomText(zoom)}</button>
          <button
            aria-label={t("camera.res")}
            title={t("camera.res")}
            onclick={resCycle}
            class={controlCls(false)}
          >{resOf(res).label}</button>
          <button
            aria-label={t("camera.hdr")}
            title={t("camera.hdr")}
            onclick={toggleHdr}
            class={controlCls(hdr)}
          >HDR</button>
        </div>
      </div>
    {/if}
  </div>

  <!-- bottom toolbar (always shown: camera is default-allowed) -->
    <div class="flex flex-col items-center gap-1.5 bg-gradient-to-t from-black to-transparent px-3 pt-1 pb-2">
      {#if hint}
        <p class="text-xs text-white/70">{hint}</p>
      {:else}
        <p class="text-[11px] text-white/30">{live ? ratioLabel[ratio] : "· · ·"}</p>
      {/if}
      {#if retriable}
        <button
          onclick={retry}
          class="rounded-full bg-white/15 px-4 py-1 text-xs text-white ring-1 ring-white/25 transition active:scale-95"
        >{t("camera.retry")}</button>
      {/if}
      {#if recErr}
        <p role="status" class="text-[11px] text-amber-300">{recErr}</p>
      {/if}
      <!-- Photo / Video mode switch -->
      <div class="flex items-center rounded-full bg-white/15 p-0.5 ring-1 ring-white/25">
        {#each (["photo", "video"] as const) as m}
          <button
            role="tab"
            aria-selected={mode === m}
            aria-label={m === "photo" ? t("camera.photo") : t("camera.video")}
            onclick={() => toggleMode(m)}
            disabled={recState === "recording"}
            class={"rounded-full px-5 py-1 text-[13px] font-medium transition " +
              (mode === m ? "bg-white text-neutral-900 shadow" : "text-white/75")}
          >{m === "photo" ? t("camera.photo") : t("camera.video")}</button>
        {/each}
      </div>

      <!-- selectable burst mode (photo) -->
      {#if mode === "photo" && live}
        <button
          aria-label={t("camera.burst")}
          aria-pressed={burst > 0}
          onclick={() => {
            burst = burst === 0 ? BURST_OPTS[0] : burst === BURST_OPTS[0] ? BURST_OPTS[1] : 0;
            stopBurstSeq();
          }}
          class={"rounded-full px-4 py-1 text-[11px] transition " +
            (burst > 0 ? "bg-white text-neutral-900 shadow" : "bg-white/15 text-white/80 ring-1 ring-white/25")}
        >🎞 {t("camera.burst")} {burst > 0 ? `×${burst}` : "○"}</button>
      {/if}

      <!-- continuous zoom slider (also pinch / double-tap) -->
      {#if live && mode === "photo"}
        <div class="flex w-full max-w-xs items-center gap-3 px-2">
          <span class="w-9 shrink-0 text-right text-[11px] tabular-nums text-white/70">{zoomText(zoom)}</span>
          <input
            type="range"
            aria-label="zoom slider"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_SLIDER_STEP}
            bind:value={zoom}
            class="flex-1 accent-white"
          />
        </div>
      {/if}

      <!-- iPhone-style bottom bar: thumbnail · shutter · flip -->
      <div class="flex w-full items-center justify-between px-6 pt-0.5">
        <button
          aria-label="last photo"
          disabled={!last}
          class="grid h-12 w-12 place-items-center overflow-hidden rounded-[11px] bg-white/15 ring-1 ring-white/40 disabled:opacity-30"
        >
          {#if last?.data}
            <img src={last.data} alt="" class="h-full w-full object-cover" />
          {:else}
            <span class="opacity-60">🖼️</span>
          {/if}
        </button>
        <button
          onclick={onShutterClick}
          onpointerdown={onShutterDown}
          onpointerup={onShutterUp}
          onpointercancel={onShutterUp}
          onpointerleave={onShutterUp}
          aria-label="shutter"
          disabled={!live}
          class="relative my-1 grid h-[78px] w-[78px] place-items-center rounded-full ring-[5px] ring-white transition active:scale-90 disabled:opacity-40"
        >
          <span class="h-[62px] w-[62px] rounded-full bg-white"></span>
        </button>
        <button
          onclick={flipCam}
          disabled={!live || recState === "recording"}
          aria-label={t("camera.flip")}
          class="grid h-12 w-12 place-items-center rounded-full bg-white/15 text-xl ring-1 ring-white/40 transition active:scale-90 disabled:opacity-40"
        >⇄</button>
      </div>

      <!-- video capture library (filmstrip, plays in the viewer overlay) -->
      {#if mode === "video" && captures.length > 0}
        <div class="flex w-full gap-2 overflow-x-auto px-4 pt-1">
          {#each captures as c (c.id)}
            <button
              aria-label={t("camera.library")}
              onclick={() => void openViewer(c.id)}
              class="relative grid h-14 w-[76px] shrink-0 place-items-center overflow-hidden rounded-lg bg-white/12 text-xl ring-1 ring-white/25 transition active:scale-95"
            >
              🎬
              <span class="absolute bottom-0.5 right-1 rounded bg-black/60 px-0.5 text-[9px] tabular-nums">
                {fmtClockSec(c.durationMs / 1000)}
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- video player overlay (open a capture from the library) -->
    {#if viewerId}
      <div class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/90 px-4">
        <div class="relative w-full max-w-lg">
          {#if viewUrl}
            <video src={viewUrl} controls autoplay playsinline class="max-h-[70vh] w-full rounded-xl"><track kind="captions" /></video>
          {:else}
            <div class="grid h-40 w-full place-items-center text-white/50">…</div>
          {/if}
          <div class="mt-3 flex items-center justify-between">
            <button
              onclick={closeViewer}
              aria-label={t("camera.library")}
              class="rounded-full bg-white/15 px-5 py-1.5 text-sm text-white ring-1 ring-white/25"
            >✕</button>
            <button
              onclick={() => viewerId && void delCapture(viewerId)}
              class="rounded-full bg-danger/90 px-4 py-1.5 text-sm text-white"
            >{t("camera.delete")}</button>
          </div>
        </div>
      </div>
    {/if}
</div>


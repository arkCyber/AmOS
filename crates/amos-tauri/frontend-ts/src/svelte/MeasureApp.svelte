<script lang="ts">
  // MeasureApp.svelte — Svelte 5 (runes) implementation of the Measure app.
  // Features: AR-style distance measurement using camera, calibration,
  // unit conversion (metric/imperial), and measurement history.

  import { onMount, onDestroy, tick } from "svelte";
  import { t, locale } from "./locale.svelte";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import {
    MEASURE_SETTINGS_KEY,
    MEASURE_HISTORY_KEY,
    normalizeMeasureSettings,
    normalizeMeasureHistory,
    defaultMeasureSettings,
    createMeasurement,
    formatDistance,
    calibrateReference,
    getReferenceObject,
    REFERENCE_OBJECTS,
    type MeasureSettings,
    type MeasurePoint,
    type Measurement,
    type CalibrationResult,
  } from "../lib/measure";

  // Constants
  const MAX_HISTORY = 50;
  const MAX_VISIBLE_MEASUREMENTS = 10;

  // --- State ---
  let settings = $state<MeasureSettings>(defaultMeasureSettings());
  let history = $state<Measurement[]>([]);
  
  // Camera state
  let videoEl = $state<HTMLVideoElement | null>(null);
  let stream: MediaStream | null = null;
  let cameraActive = $state(false);
  let cameraError = $state<string>("");
  
  // Measurement state
  let measuring = $state(false);
  let startPoint = $state<MeasurePoint | null>(null);
  let currentPoint = $state<MeasurePoint | null>(null);
  let measurements = $state<Measurement[]>([]);
  
  // UI state
  let tab = $state<"measure" | "calibrate" | "history">("measure");
  let calibrateStep = $state<"select" | "measure">("select");
  let selectedReference = $state<keyof typeof REFERENCE_OBJECTS | null>(null);
  let calibrateStart = $state<MeasurePoint | null>(null);
  let calibrateEnd = $state<MeasurePoint | null>(null);
  let calibrationMessage = $state<{ type: "success" | "error"; text: string } | null>(null);
  
  // Container dimensions
  let containerWidth = $state(0);
  let containerHeight = $state(0);

  // Load persisted settings and history
  onMount(async () => {
    try {
      settings = normalizeMeasureSettings(await readStoreValue(MEASURE_SETTINGS_KEY, {}));
      history = normalizeMeasureHistory(await readStoreValue(MEASURE_HISTORY_KEY, []));
      
      // Wait for DOM to be ready
      await tick();
      await startCamera();
    } catch (err) {
      console.error("初始化失败:", err);
    }
  });

  // Persist settings
  $effect(() => {
    writeStoreValue(MEASURE_SETTINGS_KEY, settings);
  });

  // Persist history
  $effect(() => {
    writeStoreValue(MEASURE_HISTORY_KEY, history);
  });

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (videoEl) {
        videoEl.srcObject = stream;
        cameraActive = true;
        cameraError = "";
      } else {
        // If videoEl is not ready, release stream
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
        cameraError = "Video element not ready";
      }
    } catch (err) {
      // Better error handling for different camera errors
      if (err instanceof DOMException) {
        if (err.name === "NotAllowedError") {
          cameraError = t("measure.cameraPermissionDenied");
        } else if (err.name === "NotFoundError") {
          cameraError = t("measure.cameraNotFound");
        } else {
          cameraError = err.message;
        }
      } else {
        cameraError = err instanceof Error ? err.message : String(err);
      }
      cameraActive = false;
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    cameraActive = false;
  }

  onDestroy(() => {
    stopCamera();
  });

  function handleVideoClick(e: MouseEvent) {
    if (!cameraActive || tab !== "measure") return;
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const point: MeasurePoint = { x, y };

    if (!measuring) {
      // Start measurement
      startPoint = point;
      currentPoint = point;
      measuring = true;
    } else {
      // Complete measurement
      if (startPoint) {
        const measurement = createMeasurement(
          startPoint,
          point,
          containerWidth,
          containerHeight,
          settings.referenceDistance,
        );
        measurements = [measurement, ...measurements].slice(0, MAX_VISIBLE_MEASUREMENTS);
        history = [measurement, ...history].slice(0, MAX_HISTORY);
      }
      startPoint = null;
      currentPoint = null;
      measuring = false;
    }
  }

  // Throttled mouse move handler for better performance
  let lastMoveTime = 0;
  const MOVE_THROTTLE_MS = 16; // ~60fps

  function handleVideoMove(e: MouseEvent) {
    if (!measuring || !startPoint) return;
    
    const now = Date.now();
    if (now - lastMoveTime < MOVE_THROTTLE_MS) return;
    lastMoveTime = now;
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    currentPoint = { x, y };
  }

  function clearMeasurements() {
    measurements = [];
    startPoint = null;
    currentPoint = null;
    measuring = false;
  }

  function deleteMeasurement(id: string) {
    measurements = measurements.filter((m) => m.id !== id);
    history = history.filter((m) => m.id !== id);
  }

  function toggleUnit() {
    settings.unit = settings.unit === "metric" ? "imperial" : "metric";
  }

  // Calibration
  function startCalibration(refKey: keyof typeof REFERENCE_OBJECTS) {
    selectedReference = refKey;
    calibrateStep = "measure";
    calibrateStart = null;
    calibrateEnd = null;
  }

  function handleCalibrateClick(e: MouseEvent) {
    if (tab !== "calibrate" || calibrateStep !== "measure") return;
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const point: MeasurePoint = { x, y };

    if (!calibrateStart) {
      calibrateStart = point;
    } else {
      calibrateEnd = point;
      applyCalibration();
    }
  }

  function applyCalibration() {
    if (!calibrateStart || !calibrateEnd || !selectedReference) return;
    
    const refObj = getReferenceObject(selectedReference);
    if (!refObj) return;

    // Calculate pixel distance
    const dx = (calibrateEnd.x - calibrateStart.x) * containerWidth;
    const dy = (calibrateEnd.y - calibrateStart.y) * containerHeight;
    const pixelDist = Math.sqrt(dx * dx + dy * dy);

    // Calibrate
    const result: CalibrationResult = calibrateReference(
      refObj.size,
      pixelDist,
      containerWidth,
      settings.referenceDistance,
    );
    
    if (result.success) {
      settings.referenceDistance = result.value;
      calibrationMessage = { type: "success", text: t("measure.calibrateSuccess") };
      calibrateStep = "select";
      calibrateStart = null;
      calibrateEnd = null;
      selectedReference = null;
      
      // Clear success message after 3 seconds
      setTimeout(() => {
        calibrationMessage = null;
      }, 3000);
    } else {
      calibrationMessage = { type: "error", text: t("measure.calibrateFailed") };
      
      // Clear error message after 5 seconds
      setTimeout(() => {
        calibrationMessage = null;
      }, 5000);
    }
  }

  function cancelCalibration() {
    calibrateStep = "select";
    calibrateStart = null;
    calibrateEnd = null;
    selectedReference = null;
    calibrationMessage = null;
  }

  // Container resize observer
  let resizeObserver: ResizeObserver | null = null;
  $effect(() => {
    const container = document.querySelector(".measure-container");
    if (container) {
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          containerWidth = entry.contentRect.width;
          containerHeight = entry.contentRect.height;
        }
      });
      resizeObserver.observe(container);
      
      return () => {
        resizeObserver?.disconnect();
      };
    }
  });

  // Calculate current measurement distance
  const currentDistance = $derived.by(() => {
    if (!measuring || !startPoint || !currentPoint) return null;
    const dx = (currentPoint.x - startPoint.x) * containerWidth;
    const dy = (currentPoint.y - startPoint.y) * containerHeight;
    const pixelDist = Math.sqrt(dx * dx + dy * dy);
    
    // Simple pinhole model
    const fovRadians = (60 * Math.PI) / 180;
    const referenceWidth = 2 * settings.referenceDistance * Math.tan(fovRadians / 2);
    return (pixelDist / containerWidth) * referenceWidth;
  });
</script>

<div class="flex h-full flex-col bg-slate-900">
  <!-- Tab Bar -->
  <div class="flex border-b border-slate-700 bg-slate-800">
    <button
      class="flex-1 px-4 py-3 text-sm font-medium transition-colors"
      class:bg-slate-700={tab === "measure"}
      class:text-sky-400={tab === "measure"}
      class:text-slate-300={tab !== "measure"}
      onclick={() => (tab = "measure")}
    >
      {t("measure.measure")}
    </button>
    <button
      class="flex-1 px-4 py-3 text-sm font-medium transition-colors"
      class:bg-slate-700={tab === "calibrate"}
      class:text-sky-400={tab === "calibrate"}
      class:text-slate-300={tab !== "calibrate"}
      onclick={() => (tab = "calibrate")}
    >
      {t("measure.calibrate")}
    </button>
    <button
      class="flex-1 px-4 py-3 text-sm font-medium transition-colors"
      class:bg-slate-700={tab === "history"}
      class:text-sky-400={tab === "history"}
      class:text-slate-300={tab !== "history"}
      onclick={() => (tab = "history")}
    >
      {t("measure.history")}
    </button>
  </div>

  <!-- Measure Tab -->
  {#if tab === "measure"}
    <div class="measure-container relative flex-1 overflow-hidden">
      {#if cameraActive}
        <!-- Video feed -->
        <video
          bind:this={videoEl}
          autoplay
          playsinline
          class="h-full w-full object-cover"
          onclick={handleVideoClick}
          onmousemove={handleVideoMove}
        ></video>

        <!-- Crosshair overlay -->
        {#if settings.showGuides}
          <svg class="pointer-events-none absolute inset-0 h-full w-full">
            <line x1="50%" y1="0" x2="50%" y2="100%" stroke="rgba(56,189,248,0.3)" stroke-width="1" />
            <line x1="0" y1="50%" x2="100%" y2="50%" stroke="rgba(56,189,248,0.3)" stroke-width="1" />
            <circle cx="50%" cy="50%" r="4" fill="none" stroke="rgba(56,189,248,0.6)" stroke-width="2" />
          </svg>
        {/if}

        <!-- Measurement overlay -->
        {#if measuring && startPoint && currentPoint}
          <svg class="pointer-events-none absolute inset-0 h-full w-full">
            <line
              x1="{startPoint.x * 100}%"
              y1="{startPoint.y * 100}%"
              x2="{currentPoint.x * 100}%"
              y2="{currentPoint.y * 100}%"
              stroke="#F59E0B"
              stroke-width="3"
              stroke-linecap="round"
            />
            <circle cx="{startPoint.x * 100}%" cy="{startPoint.y * 100}%" r="6" fill="#F59E0B" />
            <circle cx="{currentPoint.x * 100}%" cy="{currentPoint.y * 100}%" r="6" fill="#F59E0B" />
          </svg>
          
          <!-- Distance label -->
          {#if currentDistance !== null}
            <div
              class="pointer-events-none absolute rounded-lg bg-slate-900/90 px-3 py-2 text-lg font-bold text-amber-400"
              style="left: {((startPoint.x + currentPoint.x) / 2) * 100}%; top: {((startPoint.y + currentPoint.y) / 2) * 100}%; transform: translate(-50%, -50%);"
            >
              {formatDistance(currentDistance, settings.unit)}
            </div>
          {/if}
        {/if}

        <!-- Saved measurements -->
        {#each measurements as m}
          <svg class="pointer-events-none absolute inset-0 h-full w-full">
            <line
              x1="{m.start.x * 100}%"
              y1="{m.start.y * 100}%"
              x2="{m.end.x * 100}%"
              y2="{m.end.y * 100}%"
              stroke="rgba(34,211,238,0.6)"
              stroke-width="2"
              stroke-linecap="round"
            />
            <circle cx="{m.start.x * 100}%" cy="{m.start.y * 100}%" r="4" fill="rgba(34,211,238,0.8)" />
            <circle cx="{m.end.x * 100}%" cy="{m.end.y * 100}%" r="4" fill="rgba(34,211,238,0.8)" />
          </svg>
        {/each}

        <!-- Controls overlay -->
        <div class="absolute bottom-4 left-0 right-0 flex justify-center gap-3 px-4">
          <button
            class="rounded-full bg-slate-800/90 px-6 py-3 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700"
            onclick={toggleUnit}
          >
            {settings.unit === "metric" ? t("measure.metric") : t("measure.imperial")}
          </button>
          {#if measurements.length > 0}
            <button
              class="rounded-full bg-slate-800/90 px-6 py-3 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700"
              onclick={clearMeasurements}
            >
              {t("measure.clear")}
            </button>
          {/if}
        </div>

        <!-- Instruction -->
        <div class="pointer-events-none absolute left-0 right-0 top-4 flex justify-center px-4">
          <div class="rounded-lg bg-slate-900/80 px-4 py-2 text-sm text-slate-200">
            {measuring ? t("measure.tapToFinish") : t("measure.tapToStart")}
          </div>
        </div>
      {:else if cameraError}
        <div class="flex h-full flex-col items-center justify-center p-6 text-center">
          <div class="mb-4 text-6xl">📹</div>
          <p class="mb-2 text-lg font-medium text-slate-200">{t("measure.cameraError")}</p>
          <p class="text-sm text-slate-400">{cameraError}</p>
          <button
            class="mt-6 rounded-lg bg-sky-600 px-6 py-3 text-sm font-medium text-white hover:bg-sky-500"
            onclick={startCamera}
          >
            {t("measure.retryCamera")}
          </button>
        </div>
      {:else}
        <div class="flex h-full items-center justify-center">
          <div class="text-lg text-slate-400">{t("measure.loadingCamera")}</div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Calibrate Tab -->
  {#if tab === "calibrate"}
    <div class="flex-1 overflow-auto">
      {#if calibrateStep === "select"}
        <div class="p-6">
          <h2 class="mb-2 text-xl font-semibold text-slate-100">{t("measure.calibrateTitle")}</h2>
          <p class="mb-6 text-sm text-slate-400">{t("measure.calibrateDesc")}</p>

          {#if calibrationMessage}
            <div
              class="mb-4 rounded-lg border p-4 transition-all"
              class:bg-green-900={calibrationMessage.type === "success"}
              class:bg-opacity-20={calibrationMessage.type === "success"}
              class:border-green-600={calibrationMessage.type === "success"}
              class:text-green-400={calibrationMessage.type === "success"}
              class:bg-red-900={calibrationMessage.type === "error"}
              class:border-red-600={calibrationMessage.type === "error"}
              class:text-red-400={calibrationMessage.type === "error"}
            >
              {calibrationMessage.text}
            </div>
          {/if}

          <div class="space-y-3">
            {#each Object.entries(REFERENCE_OBJECTS) as [key, obj]}
              <button
                class="flex w-full items-center justify-between rounded-lg border border-slate-700 bg-slate-800 p-4 text-left transition-colors hover:border-sky-600 hover:bg-slate-750"
                onclick={() => startCalibration(key as keyof typeof REFERENCE_OBJECTS)}
              >
                <div>
                  <div class="font-medium text-slate-100">{t(`measure.ref.${obj.name}`)}</div>
                  <div class="text-sm text-slate-400">{obj.size} {obj.unit}</div>
                </div>
                <div class="text-sky-400">→</div>
              </button>
            {/each}
          </div>

          <div class="mt-6 rounded-lg border border-slate-700 bg-slate-800 p-4">
            <div class="text-sm font-medium text-slate-300">{t("measure.currentCalibration")}</div>
            <div class="mt-1 text-lg text-slate-100">{settings.referenceDistance.toFixed(0)} mm</div>
          </div>
        </div>
      {:else}
        <div class="measure-container relative h-full">
          {#if cameraActive}
            <video
              bind:this={videoEl}
              autoplay
              playsinline
              class="h-full w-full object-cover"
              onclick={handleCalibrateClick}
            ></video>

            {#if calibrateStart}
              <svg class="pointer-events-none absolute inset-0 h-full w-full">
                <circle cx="{calibrateStart.x * 100}%" cy="{calibrateStart.y * 100}%" r="8" fill="#F59E0B" />
                {#if calibrateEnd}
                  <line
                    x1="{calibrateStart.x * 100}%"
                    y1="{calibrateStart.y * 100}%"
                    x2="{calibrateEnd.x * 100}%"
                    y2="{calibrateEnd.y * 100}%"
                    stroke="#F59E0B"
                    stroke-width="3"
                  />
                  <circle cx="{calibrateEnd.x * 100}%" cy="{calibrateEnd.y * 100}%" r="8" fill="#F59E0B" />
                {/if}
              </svg>
            {/if}

            <div class="pointer-events-none absolute left-0 right-0 top-4 flex justify-center px-4">
              <div class="rounded-lg bg-slate-900/80 px-4 py-2 text-center text-sm text-slate-200">
                {selectedReference && t(`measure.ref.${getReferenceObject(selectedReference)?.name || ""}`)}
                <br />
                {calibrateStart ? t("measure.tapEndPoint") : t("measure.tapStartPoint")}
              </div>
            </div>

            <div class="absolute bottom-4 left-0 right-0 flex justify-center px-4">
              <button
                class="rounded-full bg-slate-800/90 px-6 py-3 text-sm font-medium text-slate-100 hover:bg-slate-700"
                onclick={cancelCalibration}
              >
                {t("measure.cancel")}
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <!-- History Tab -->
  {#if tab === "history"}
    <div class="flex-1 overflow-auto p-4">
      {#if history.length === 0}
        <div class="flex h-full flex-col items-center justify-center text-center">
          <div class="mb-3 text-6xl">📏</div>
          <p class="text-slate-400">{t("measure.noHistory")}</p>
        </div>
      {:else}
        <div class="space-y-2">
          {#each history as m}
            <div class="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800 p-4">
              <div class="flex-1">
                <div class="text-lg font-semibold text-slate-100">
                  {formatDistance(m.distance, settings.unit)}
                </div>
                {#if m.label}
                  <div class="mt-1 text-sm text-slate-400">{m.label}</div>
                {/if}
                <div class="mt-1 text-xs text-slate-500">
                  {new Date(m.timestamp).toLocaleString(locale() === "zh" ? "zh-CN" : "en-US")}
                </div>
              </div>
              <button
                class="ml-4 rounded-lg p-2 text-slate-400 hover:bg-slate-700 hover:text-red-400"
                onclick={() => deleteMeasurement(m.id)}
              >
                🗑️
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

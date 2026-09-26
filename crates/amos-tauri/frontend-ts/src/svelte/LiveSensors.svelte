<script lang="ts">
  // LiveSensors.svelte — a small live card for the System UI's *host* sensor
  // stream. It listens to the real-time `sensor-data` events broadcast by
  // `SensorHost` (see lib/sensorLive + lib/sensorEvents) and refreshes on every
  // accepted IMU sample / camera-frame / energy-mode change — event-driven, no
  // polling. This is distinct from the daemon-backed SensorPanel (pull snapshot);
  // it proves the host bus is flowing. Hidden nothing: it renders a waiting hint
  // until a producer (device glue or a WebView `sensor_host_record_*`) pushes.
  import { onDestroy, onMount } from "svelte";
  import { createSensorLive, type SensorLiveState } from "../lib/sensorLive";
  import {
    accuracyLabel,
    describeLocation,
    isAndroidBackend,
    readGnss,
    type GnssRead,
  } from "../lib/gps";
  import {
    locationPermissionRequest,
    locationPermissionState,
    type LocationPermissionState,
  } from "../lib/backend";
  import { t } from "./locale.svelte";

  const live = createSensorLive();
  let view = $state<SensorLiveState>(live.snapshot());
  let unsubView: (() => void) | undefined;
  let stopFeed: (() => void) | undefined;
  // start() resolves asynchronously; if the card unmounts first, onDestroy runs
  // before stopFeed is set and the opened feed would leak. This flag lets the
  // late-resolved start() close the feed immediately instead of losing it.
  let disposed = false;

  const GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const ROW = "flex items-center justify-between gap-3 px-4 py-3";
  const LABEL = "text-[15px] text-neutral-800 dark:text-neutral-100";

  function modeKey(m: string): string {
    return m === "balanced"
      ? "settings.sensorBalanced"
      : m === "performance"
        ? "settings.sensorPerformance"
        : m === "power_save"
          ? "settings.sensorPowerSave"
          : "settings.sensorLiveUnknown";
  }

  onMount(() => {
    unsubView = live.subscribe((s) => (view = s));
    void live
      .start()
      .then((stop) => {
        if (disposed) {
          // The card unmounted before the feed opened — close it right away so
          // no sensor-data listener outlives the component.
          stop();
        } else {
          stopFeed = stop;
        }
      })
      .catch(() => {});
  });
  onDestroy(() => {
    disposed = true;
    unsubView?.();
    stopFeed?.();
  });

  const hasLive = $derived(view.totalEvents > 0);
  /** One sample axis: a formatted number, or `—` when the daemon did not report it.
   *  An unknown reading must never be printed as `0.00` (REQ-A294 / AEROSPACE P0-3). */
  const liveSample = (v: number | null, digits = 2): string =>
    v === null ? "—" : v.toFixed(digits);
  const dotClass = $derived(
    hasLive
      ? "h-2 w-2 animate-pulse rounded-full bg-emerald-500"
      : view.listening
        ? "h-2 w-2 rounded-full bg-amber-400"
        : "h-2 w-2 rounded-full bg-neutral-400",
  );
  const modeLabel = $derived(
    view.mode && view.mode !== "unknown" ? t(modeKey(view.mode)) : t("settings.sensorLiveModeNone"),
  );
  const backendLine = $derived(
    view.backend ? t("settings.sensorLiveBackend", { name: view.backend }) : "",
  );
  const countLine = $derived(
    t("settings.sensorLiveCount", {
      imu: view.imuCount,
      frames: view.frameCount,
      clears: view.clearCount,
    }),
  );
  const imuLine = $derived(
    view.lastImu
      ? t("settings.sensorLiveLastImu", {
          ax: liveSample(view.lastImu.accel_x),
          ay: liveSample(view.lastImu.accel_y),
          az: liveSample(view.lastImu.accel_z),
          temp: liveSample(view.lastImu.temperature_c, 1),
        })
      : "",
  );
  const frameLine = $derived(
    view.lastFrame
      ? t("settings.sensorLiveLastFrame", {
          id: view.lastFrame.id,
          w: view.lastFrame.width,
          h: view.lastFrame.height,
          format: view.lastFrame.format,
          seq: view.lastFrame.seq,
        })
      : "",
  );

  // ── 定位 (REQ-A582) ─────────────────────────────────────────────────────────
  //
  // `lib/gps.ts` was a whole unreachable module: the honest GNSS view layer whose *screen* had
  // never been built, so this card only showed the raw sensor stream. It is the natural home —
  // the same disposition REQ-A528 gave the biometric row (put it on the page that already
  // existed rather than inventing one).
  //
  // Reading is a **pull** (`sensor_host_snapshot`) and the fix is a device sideband, so it is
  // read on mount, on an energy-mode change (rare, and the mode gates the receiver), and when the
  // user asks — never per IMU sample: a snapshot per 100 Hz event would be a hot loop, and the
  // reading does not move that fast anyway.
  let gnss = $state<GnssRead | null>(null);
  let gnssReads = $state(0);
  let lastMode = "";

  // The OS grant is read alongside the fix (same pattern as `DeviceMicButton`): the reading says
  // whether the receiver could be reached, and the grant says what standing the OS gives this app
  // — two different facts, and the second is the one the user changes.
  let grant = $state<LocationPermissionState | null>(null);

  const readLocation = async () => {
    gnssReads += 1;
    gnss = await readGnss();
    grant = await locationPermissionState();
  };

  // Post the OS location dialog for the **native** read, then read again. The card shows the
  // read, never the dialog's answer: what matters is whether the next snapshot could reach the
  // receiver (REQ-A772). On a host build this is an immediate no-op that changes nothing.
  const requestLocationGrant = async () => {
    await locationPermissionRequest();
    await readLocation();
  };

  // "no OS-grant concept here" is its own sentence: on a host build or a browser preview no
  // dialog can appear, and saying "not granted" would blame a user who was never asked.
  const grantKey = $derived(
    grant === null
      ? ""
      : !grant.native
        ? "settings.gnssGrantNoOs"
        : grant.grant === "fine"
          ? "settings.gnssGrantFine"
          : grant.grant === "coarse"
            ? "settings.gnssGrantCoarse"
            : "settings.gnssGrantNone",
  );

  $effect(() => {
    const mode = view.mode;
    if (mode === lastMode) return;
    lastMode = mode;
    void readLocation();
  });

  const gnssKey = $derived(
    gnss === null
      ? "settings.gnssReading"
      : gnss.kind === "fix"
        ? "settings.gnssLocked"
        : gnss.kind === "no-fix"
          ? gnss.enabled
            ? "settings.gnssSearching"
            : "settings.gnssOff"
          : gnss.kind === "permission-required"
            ? "settings.gnssPermissionRequired"
            : gnss.kind === "read-failed"
              ? "settings.gnssReadFailed"
              : gnss.kind === "absent"
                ? "settings.gnssAbsent"
                : "settings.gnssOffline",
  );
  const coordinateLine = $derived(
    gnss?.kind === "fix"
      ? describeLocation(gnss.location.latitude, gnss.location.longitude)
      : "",
  );
  const accuracyLine = $derived(
    gnss?.kind === "fix"
      ? t("settings.gnssAccuracy", { label: accuracyLabel(gnss.location.accuracy) })
      : "",
  );
  // The module documents this badge as its reason for existing ("Drives a 'DEMO / DEVICE' badge"):
  // the same reading means different things on the real Android provider and on the dev simulator,
  // and only the host knows which one it bound.
  const backendBadge = $derived(
    gnss === null || gnss.kind === "unavailable"
      ? ""
      : t(isAndroidBackend(gnss.snap) ? "settings.gnssDevice" : "settings.gnssSimulated"),
  );
</script>

<section class={GROUP}>
  <div class={ROW}>
    <span class={LABEL}>{t("settings.sensorLive")}</span>
    <span class="flex items-center gap-1.5 text-xs opacity-80">
      <span class={dotClass}></span>
      <span>
        {t("settings.sensorLiveMode")}: {modeLabel}
      </span>
    </span>
  </div>
  <div class="grid grid-cols-1 gap-1 border-t border-black/5 px-4 py-3 text-xs opacity-80 dark:border-white/10">
    {#if backendLine}
      <p>{backendLine}</p>
    {/if}
    <p>{countLine}</p>
    {#if imuLine}
      <p>{imuLine}</p>
    {/if}
    {#if frameLine}
      <p>{frameLine}</p>
    {/if}
    {#if !hasLive}
      <p class="italic opacity-60">{t("settings.sensorLiveWait")}</p>
    {/if}
  </div>
  <div class="flex justify-end border-t border-black/5 px-4 py-2 dark:border-white/10">
    <button
      onclick={() => live.reset()}
      disabled={!hasLive}
      class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-30 dark:bg-white/10"
    >
      {t("settings.sensorLiveReset")}
    </button>
  </div>
</section>

<!-- 定位 (REQ-A582, extended by REQ-A772): the screen `lib/gps.ts` never had. Every state the
     host can be in gets its own sentence — no bridge, no GNSS hardware, receiver switched off,
     receiver on but not locked, **read failed for want of an OS grant**, **read failed outright**,
     and the last fix with its accuracy. Before REQ-A772 the two failure states were reported as
     "searching", which is a sentence about progress and was simply false on a phone that had
     never been asked for location. -->
<section class={GROUP} data-testid="sensor-live-gnss">
  <div class={ROW}>
    <span class={LABEL}>{t("settings.gnssTitle")}</span>
    <span class="text-xs opacity-80" data-testid="gnss-state">{t(gnssKey)}</span>
  </div>
  <div
    class="grid grid-cols-1 gap-1 border-t border-black/5 px-4 py-3 text-xs opacity-80 dark:border-white/10"
  >
    {#if backendBadge}
      <p class="text-[10px] uppercase tracking-wide opacity-60" data-testid="gnss-backend">
        {backendBadge}
      </p>
    {/if}
    {#if grantKey}
      <p data-testid="gnss-grant-state">{t(grantKey)}</p>
    {/if}
    {#if coordinateLine}
      <p class="font-mono" data-testid="gnss-coords">{coordinateLine}</p>
      <p data-testid="gnss-accuracy">{accuracyLine}</p>
      <p class="italic opacity-60">{t("settings.gnssLastFix")}</p>
    {:else if gnss?.kind === "no-fix"}
      <p data-testid="gnss-hint">{t("settings.gnssNoFixHint")}</p>
    {:else if gnss?.kind === "permission-required"}
      <p data-testid="gnss-hint">{t("settings.gnssPermissionRequiredHint")}</p>
      <!-- The one state here the user can leave. Until this button existed the card could say
           "location was never granted" and then offer nothing: the OS dialog for the *native*
           read is not the WebView's, so nothing else on this screen would ever post it. -->
      <div class="flex justify-start pt-1">
        <button
          onclick={() => void requestLocationGrant()}
          class="rounded-full bg-accent px-3 py-1 text-xs text-white active:scale-95"
          data-testid="gnss-grant">{t("settings.gnssGrant")}</button
        >
      </div>
    {:else if gnss?.kind === "read-failed"}
      <p data-testid="gnss-hint">{t("settings.gnssReadFailedHint")}</p>
    {:else if gnss?.kind === "absent"}
      <p data-testid="gnss-hint">{t("settings.gnssAbsentHint")}</p>
    {:else if gnss?.kind === "unavailable"}
      <p data-testid="gnss-hint">{t("settings.gnssOfflineHint")}</p>
    {/if}
  </div>
  <div class="flex justify-end border-t border-black/5 px-4 py-2 dark:border-white/10">
    <button
      onclick={() => void readLocation()}
      class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 dark:bg-white/10"
      data-testid="gnss-refresh">{t("settings.gnssRefresh")}</button
    >
  </div>
</section>

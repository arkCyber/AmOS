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
          ax: view.lastImu.accel_x.toFixed(2),
          ay: view.lastImu.accel_y.toFixed(2),
          az: view.lastImu.accel_z.toFixed(2),
          temp: view.lastImu.temperature_c.toFixed(1),
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

<script lang="ts">
  // SensorPanel.svelte — Svelte 5 (runes) port of the React SensorPanel shown in
  // Settings. Reads the daemon's mounted SensorService via lib/sensors (same pure
  // normalizer + bridge as React) and shows energy mode + cameras + GNSS + IMU.
  // Hidden entirely when there is no data (not bridged / daemon offline), so the
  // Settings page never renders a broken card.
  import {
    normalizeSnapshot,
    sensorCameraCount,
    sensorSetMode,
    sensorSnapshot,
    type SensorMode,
  } from "../lib/sensors";
  import { t } from "./locale.svelte";

  const SENSOR_MODES: SensorMode[] = ["balanced", "performance", "power_save"];
  function modeKey(m: SensorMode): string {
    return m === "balanced"
      ? "settings.sensorBalanced"
      : m === "performance"
        ? "settings.sensorPerformance"
        : "settings.sensorPowerSave";
  }

  const GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const ROW = "flex items-center justify-between gap-3 px-4 py-3";
  const LABEL = "text-[15px] text-neutral-800 dark:text-neutral-100";

  let snap = $state(normalizeSnapshot(null));
  let busy = $state(false);

  const refresh = () => {
    busy = true;
    sensorSnapshot()
      .then((s) => {
        if (s) snap = normalizeSnapshot(s);
      })
      .catch(() => {
        /* daemon offline → keep previous / nothing */
      })
      .finally(() => (busy = false));
  };
  $effect(() => {
    refresh();
  });

  const setMode = (mode: SensorMode) => {
    if (mode === snap.mode || busy) return;
    busy = true;
    sensorSetMode(mode)
      .then(() => refresh())
      .catch(() => (busy = false));
  };

  const cameraCount = $derived(sensorCameraCount(snap));
  const visible = $derived(
    cameraCount > 0 || !!snap.gnss || !!snap.imu || snap.mode !== "unknown",
  );
  const firstCam = $derived(snap.cameras[0]);
  const camLabel = $derived(
    cameraCount === 0
      ? "—"
      : `${cameraCount}${firstCam ? ` · ${firstCam.width}×${firstCam.height}` : ""}`,
  );
  const gnssLabel = $derived(
    !snap.gnss
      ? "—"
      : !snap.gnss.enabled
        ? t("settings.sensorGnssDisabled")
        : snap.gnss.has_fix
          ? `${snap.gnss.latitude_deg.toFixed(5)}, ${snap.gnss.longitude_deg.toFixed(5)} · ±${snap.gnss.accuracy_m.toFixed(0)}m · ${snap.gnss.sats}sats`
          : t("settings.sensorGnssNone"),
  );
</script>

{#if visible}
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.sensor")}</span>
      <button
        onclick={refresh}
        disabled={busy}
        class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-40 dark:bg-white/10"
      >
        {t("settings.sensorRefresh")}
      </button>
    </div>
    <div class="flex gap-1.5 px-4 pb-2" role="group" aria-label={t("settings.sensorMode")}>
      {#each SENSOR_MODES as m (m)}
        <button
          onclick={() => setMode(m)}
          disabled={busy}
          aria-pressed={snap.mode === m}
          class={"rounded-full px-3 py-1 text-xs transition disabled:opacity-40 " +
            (snap.mode === m
              ? "bg-accent text-white"
              : "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300")}
        >
          {t(modeKey(m))}
        </button>
      {/each}
    </div>
    <div class="grid grid-cols-1 gap-1 border-t border-black/5 px-4 py-3 text-xs opacity-80 dark:border-white/10">
      <p>{t("settings.sensorCameras", { n: camLabel })}</p>
      <p>{t("settings.sensorGnss", { n: gnssLabel })}</p>
      {#if snap.imu}
        <p>{t("settings.sensorImu", { hz: String(snap.imu.rate_hz), t: snap.imu.temp_c.toFixed(1) })}</p>
      {/if}
    </div>
  </section>
{/if}

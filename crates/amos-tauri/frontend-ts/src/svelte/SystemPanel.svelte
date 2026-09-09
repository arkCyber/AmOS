<script lang="ts">
  // SystemPanel.svelte — Svelte 5 (runes) port of the React SystemPanel in
  // Settings. Reads the daemon's amos-monitor via lib/system (system_health
  // bridge) and shows CPU / memory / battery / process tiers + governor. Hidden
  // when there is no data (offline), never a broken card. Auto-refreshes (~2.5s)
  // only while live data is present.
  import {
    systemStatusWithHostBattery,
    normalizeSystemHealth,
    fmtBytes,
    liveProcesses,
    memUsedBytes,
    memUsedPct,
    type SystemStatus,
  } from "../lib/system";
  import { t } from "./locale.svelte";

  const REFRESH_MS = 2500;
  const GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const ROW = "flex items-center justify-between gap-3 px-4 py-3";
  const LABEL = "text-[15px] text-neutral-800 dark:text-neutral-100";

  let sys = $state<SystemStatus>(normalizeSystemHealth(null));
  let busy = $state(false);
  let inflight = false;

  const refresh = () => {
    if (inflight) return;
    inflight = true;
    busy = true;
    systemStatusWithHostBattery()
      .then((raw) => {
        if (raw) sys = raw;
      })
      .catch(() => {
        /* daemon offline → keep previous / nothing */
      })
      .finally(() => {
        inflight = false;
        busy = false;
      });
  };

  const hasAny = $derived(
    sys.cpu_busy_pct !== null ||
      sys.mem_total_bytes !== null ||
      sys.battery_level_pct !== null ||
      sys.live_power_mw !== null ||
      liveProcesses(sys) > 0 ||
      sys.apps.length > 0 ||
      (sys.governor !== null && sys.governor.ticks > 0),
  );

  $effect(() => {
    refresh();
  });
  $effect(() => {
    if (!hasAny) return;
    const id = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(id);
  });

  const memPct = $derived(memUsedPct(sys));
  const cpuLabel = $derived(sys.cpu_busy_pct === null ? "—" : `${Math.round(sys.cpu_busy_pct)}%`);
  const memLabel = $derived(
    memPct === null || sys.mem_total_bytes === null
      ? "—"
      : `${memPct.toFixed(0)}% · ${fmtBytes(memUsedBytes(sys))} / ${fmtBytes(sys.mem_total_bytes)}`,
  );
  const batteryLabel = $derived.by(() => {
    const parts: string[] = [];
    if (sys.battery_level_pct !== null) parts.push(`${Math.round(sys.battery_level_pct)}%`);
    if (sys.battery_charging === true) parts.push(t("settings.systemCharging"));
    if (sys.live_power_mw !== null) parts.push(`${Math.round(sys.live_power_mw)} mW`);
    return parts.length > 0 ? parts.join(" · ") : "—";
  });
  const processesLabel = $derived(`${sys.running} running · ${sys.cached} cached · ${sys.stopped} stopped`);

  const govModeLabel = (mode: string): string =>
    mode === "balanced"
      ? t("settings.sensorBalanced")
      : mode === "performance"
        ? t("settings.sensorPerformance")
        : mode === "power_save"
          ? t("settings.sensorPowerSave")
          : mode;
</script>

{#if hasAny}
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.system")}</span>
      <button
        onclick={refresh}
        disabled={busy}
        class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-40 dark:bg-white/10"
      >
        {t("settings.systemRefresh")}
      </button>
    </div>
    <div class="grid grid-cols-1 gap-1 border-t border-black/5 px-4 py-3 text-xs opacity-80 dark:border-white/10">
      <p>{t("settings.systemCpu", { v: cpuLabel })}</p>
      <p>{t("settings.systemMem", { v: memLabel })}</p>
      <p>{t("settings.systemBattery", { v: batteryLabel })}</p>
      <p>{t("settings.systemProcesses", { v: processesLabel })}</p>
      {#if sys.governor && sys.governor.ticks > 0}
        <div class="mt-1 border-t border-black/5 pt-1 dark:border-white/10">
          <p class="mb-0.5">{t("settings.systemGovernor")}</p>
          <p>{t("settings.systemGovernorMode", { mode: govModeLabel(sys.governor.mode), reason: sys.governor.reason })}</p>
          <p>{t("settings.systemGovernorFlags", { cap: sys.governor.cap_inference ? t("common.on") : t("common.off"), throttle: sys.governor.throttle_background ? t("common.on") : t("common.off") })}</p>
          <p>
            {t("settings.systemGovernorDvfs", { applied: String(sys.governor.dvfs_applied), failed: String(sys.governor.dvfs_failed), dropped: String(sys.governor.dropped) })}
            {sys.governor.dvfs_failed > 0 ? " ⚠" : ""}
          </p>
        </div>
      {/if}
      {#if sys.apps.length > 0}
        <div class="mt-1 border-t border-black/5 pt-1 dark:border-white/10">
          <p class="mb-0.5">{t("settings.systemApps")}</p>
          <ul class="space-y-0.5">
            {#each sys.apps as a (a.id)}
              <li class="flex items-center justify-between gap-2">
                <span class="truncate">{a.id}</span>
                <span class="opacity-60">{a.state}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  </section>
{/if}

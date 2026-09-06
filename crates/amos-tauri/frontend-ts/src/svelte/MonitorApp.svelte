<script lang="ts">
  // MonitorApp.svelte — Svelte 5 (runes) dock app「系统监控」.
  //
  // A standalone dashboard into the system-health + resource-governor data that
  // lives as Settings tiles. Top: a live overview strip with big CPU / memory /
  // battery readouts (own poll of the daemon's amos-monitor system_health bridge,
  // adaptive cadence — 2.5 s while online, 5 s reconnect probe while offline).
  // Below: the same two self-contained panels the Settings screen renders
  // (SystemPanel = CPU/mem/battery/process detail; TaskManager = the daemon's
  // resource-governor registry/decision). Each panel still hides itself when the
  // daemon has nothing for it (no broken card); the host supplies the app chrome
  // (‹ back / title「系统监控」/ home) so this screen is only the content area.
  //
  // Empty-state handling (the page is never a blank wall):
  //  • not bridged → "系统服务未连接" + Retry (auto-recovers on the reconnect probe);
  //  • bridged but no readings → "暂无系统数据" (host without /proc reports honestly).
  import SystemPanel from "./SystemPanel.svelte";
  import TaskManager from "./TaskManager.svelte";
  import {
    fmtBytes,
    liveProcesses,
    memUsedBytes,
    memUsedPct,
    normalizeSystemHealth,
    systemHealth,
    type SystemStatus,
  } from "../lib/system";
  import { bridged } from "../lib/backend";
  import { amosLog, amosWarn } from "../lib/debugLog";
  import { t } from "./locale.svelte";
  import { onDestroy, onMount } from "svelte";

  const REFRESH_MS = 2500; // live poll while the daemon is reachable
  const RECONNECT_MS = 5000; // lighter probe cadence while it is not
  const CARD =
    "overflow-hidden rounded-[14px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const TILE =
    "flex flex-col items-center justify-center gap-1 rounded-xl bg-black/[0.04] px-2 py-3 dark:bg-white/[0.06]";
  const LABEL = "text-[10px] uppercase tracking-wider opacity-50";
  const BIG = "text-[24px] font-semibold leading-none tabular-nums text-neutral-900 dark:text-white";

  let sys = $state<SystemStatus>(normalizeSystemHealth(null));
  let online = $state(bridged());
  let busy = $state(false);
  let inflight = false;
  // Drop in-flight writes after the screen unmounts (keeps the async path clean).
  let disposed = false;
  onMount(() => amosLog("monitor", "mounted", { bridged: online }));
  onDestroy(() => {
    disposed = true;
  });

  const refresh = () => {
    if (inflight || disposed) return;
    const on = bridged();
    online = on;
    if (!on) return; // offline: cheap probe; the reconnect cadence wakes us later
    inflight = true;
    busy = true;
    systemHealth()
      .then((raw) => {
        if (raw && !disposed) sys = normalizeSystemHealth(raw);
      })
      .catch(() => {
        /* daemon went away mid-flight → keep the previous reading */
        amosWarn("monitor", "health read failed", { online });
      })
      .finally(() => {
        if (disposed) return;
        inflight = false;
        busy = false;
      });
  };

  // Same "has real data" test as SystemPanel, so overview & panels stay in step.
  const overviewAny = $derived(
    sys.cpu_busy_pct !== null ||
      sys.mem_total_bytes !== null ||
      sys.battery_level_pct !== null ||
      sys.live_power_mw !== null ||
      liveProcesses(sys) > 0 ||
      sys.apps.length > 0 ||
      (sys.governor !== null && sys.governor.ticks > 0),
  );

  // Immediate first read…
  $effect(() => {
    refresh();
  });
  // …then adaptive cadence: while online poll every 2.5 s; while the daemon is
  // absent, probe far less often (5 s) and auto-recover once it comes back —
  // cheap and battery-friendly for a monitoring screen. Re-armed whenever the
  // online flag flips (the effect re-runs and swaps the interval period).
  $effect(() => {
    const ms = online ? REFRESH_MS : RECONNECT_MS;
    const id = window.setInterval(refresh, ms);
    return () => window.clearInterval(id);
  });

  // On-device diagnosis ([amos][monitor] → adb logcat): report which surface the
  // screen resolved to (offline / noData / overview) each time it transitions,
  // plus the live readings behind it — mirrors the Shell/Dock markers so "the
  // monitor shows no numbers on device" is greppable straight from the log.
  let lastSurface: "offline" | "noData" | "overview" | null = null;
  $effect(() => {
    const label: "offline" | "noData" | "overview" = online
      ? overviewAny
        ? "overview"
        : "noData"
      : "offline";
    if (label === lastSurface) return;
    lastSurface = label;
    amosLog("monitor", `surface=${label}`, {
      online,
      cpu: sys.cpu_busy_pct,
      memTotal: sys.mem_total_bytes,
      battery: sys.battery_level_pct,
    });
  });

  const pctLabel = (v: number | null): string => (v === null ? "—" : `${Math.round(v)}%`);
  const pctNow = (v: number): number => Math.min(100, Math.max(0, Math.round(v)));

  const cpuNow = $derived(pctNow(sys.cpu_busy_pct ?? 0));
  const mem = $derived.by(() => {
    const pct = memUsedPct(sys);
    const used = memUsedBytes(sys);
    const total = sys.mem_total_bytes;
    return {
      big: pct === null ? "—" : `${Math.round(pct)}%`,
      now: pct === null ? 0 : pctNow(pct),
      sub: used === null || total === null ? "n/a" : `${fmtBytes(used)} / ${fmtBytes(total)}`,
    };
  });
  const batteryNow = $derived(pctNow(sys.battery_level_pct ?? 0));
  const batteryBig = $derived(pctLabel(sys.battery_level_pct));
  const batterySub = $derived.by(() => {
    const parts: string[] = [];
    if (sys.battery_charging === true) parts.push(t("settings.systemCharging"));
    if (sys.live_power_mw !== null) parts.push(`${Math.round(sys.live_power_mw)} mW`);
    return parts.join(" · ");
  });
</script>

<div class="h-full overflow-y-auto px-3 py-4" data-testid="monitor-app">
  <div class="space-y-3">
    {#if online && overviewAny}
      <!-- Dashboard overview: three big live readouts + refresh -->
      <section data-testid="monitor-overview" class={CARD}>
        <div class="flex items-center justify-between px-3 pt-2">
          <span class="text-[11px] font-semibold opacity-60">{t("monitor.overview")}</span>
          <button
            onclick={refresh}
            disabled={busy}
            aria-label={t("monitor.retry")}
            class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-40 dark:bg-white/10"
          >
            {t("settings.systemRefresh")}
          </button>
        </div>
        <div class="grid grid-cols-3 gap-2 p-3 pt-2">
          <div class={TILE}>
            <span class={LABEL}>{t("monitor.cpu")}</span>
            <span class={BIG}>{pctLabel(sys.cpu_busy_pct)}</span>
            <span
              role="progressbar"
              aria-label={t("monitor.cpu")}
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={cpuNow}
              class="block h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
            >
              <span class="block h-full rounded-full bg-accent" style={`width:${cpuNow}%`}></span>
            </span>
          </div>
          <div class={TILE}>
            <span class={LABEL}>{t("monitor.memory")}</span>
            <span class={BIG}>{mem.big}</span>
            <span
              role="progressbar"
              aria-label={t("monitor.memory")}
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={mem.now}
              class="block h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
            >
              <span class="block h-full rounded-full bg-accent" style={`width:${mem.now}%`}></span>
            </span>
          </div>
          <div class={TILE}>
            <span class={LABEL}>{t("monitor.battery")}</span>
            <span class={BIG}>{batteryBig}</span>
            <span
              role="progressbar"
              aria-label={t("monitor.battery")}
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={batteryNow}
              class="block h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
            >
              <span
                class="block h-full rounded-full bg-accent"
                style={`width:${batteryNow}%`}
              ></span>
            </span>
          </div>
        </div>
        <div class="flex items-center justify-between gap-2 border-t border-black/5 px-3 py-2 text-[10px] opacity-70 dark:border-white/10">
          <span class="truncate">{t("monitor.memory")} · {mem.sub}</span>
          <span class="shrink-0 truncate pl-2">{batterySub}</span>
        </div>
      </section>
    {:else}
      <!-- Empty states: never a blank page -->
      <section
        data-testid={online ? "monitor-empty-nodata" : "monitor-empty-offline"}
        class="flex flex-col items-center gap-2 px-6 py-10 text-center"
      >
        <div class="text-3xl">{online ? "📡" : "🔌"}</div>
        <p class="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
          {online ? t("monitor.noData") : t("monitor.unavailable")}
        </p>
        <p class="max-w-[260px] text-xs leading-relaxed opacity-60">
          {online ? t("monitor.noDataHint") : t("monitor.unavailableHint")}
        </p>
        <button
          onclick={refresh}
          disabled={busy}
          class="mt-1 rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95 disabled:opacity-50"
        >
          {t("monitor.retry")}
        </button>
      </section>
    {/if}

    <!-- Detail panels (Settings-shared); each self-hides when it has no data. -->
    <SystemPanel />
    <TaskManager />
  </div>
</div>


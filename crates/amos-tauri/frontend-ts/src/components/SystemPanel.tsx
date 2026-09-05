import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  fmtBytes,
  liveProcesses,
  memUsedBytes,
  memUsedPct,
  normalizeSystemHealth,
  systemHealth,
  type SystemStatus,
} from "../lib/system";
import { GROUP, ROW, LABEL } from "./ui";

/** Auto-refresh cadence while live data is present (CPU busy% is a window delta). */
const REFRESH_MS = 2500;

/**
 * System working-status readout tile (desktop/device): reads the daemon's
 * `get_status.system` (amos-monitor) through the `system_health` Tauri bridge and
 * shows CPU / memory / battery / process tiers. Hidden when not bridged or there
 * is no data at all (e.g. no daemon), so Settings never shows a broken card.
 * Absent values render as "—" (never a fabricated number).
 */
export default function SystemPanel() {
  const { t } = useI18n();
  const [sys, setSys] = useState<SystemStatus>(() => normalizeSystemHealth(null));
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const refresh = () => {
    if (busyRef.current) return; // never overlap an in-flight read
    busyRef.current = true;
    setBusy(true);
    systemHealth()
      .then((raw) => {
        if (raw) setSys(normalizeSystemHealth(raw));
      })
      .catch(() => {
        /* daemon offline → keep previous / nothing */
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };

  const hasAny =
    sys.cpu_busy_pct !== null ||
    sys.mem_total_bytes !== null ||
    sys.battery_level_pct !== null ||
    sys.live_power_mw !== null ||
    liveProcesses(sys) > 0 ||
    sys.apps.length > 0 ||
    (sys.governor !== null && sys.governor.ticks > 0);

  // Initial read on mount.
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live auto-refresh while there is data to show (keeps the CPU busy% window +
  // battery current). Only starts once data arrives, so offline tests never spin
  // up a timer; it is cleared on unmount / when data disappears.
  useEffect(() => {
    if (!hasAny) return undefined;
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAny]);

  if (!hasAny) return null;

  const memPct = memUsedPct(sys);
  const cpuLabel =
    sys.cpu_busy_pct === null ? "—" : `${Math.round(sys.cpu_busy_pct)}%`;
  const memLabel =
    memPct === null || sys.mem_total_bytes === null
      ? "—"
      : `${memPct.toFixed(0)}% · ${fmtBytes(memUsedBytes(sys))} / ${fmtBytes(sys.mem_total_bytes)}`;

  const batteryParts: string[] = [];
  if (sys.battery_level_pct !== null) batteryParts.push(`${Math.round(sys.battery_level_pct)}%`);
  if (sys.battery_charging === true) batteryParts.push(t("settings.systemCharging"));
  if (sys.live_power_mw !== null) batteryParts.push(`${Math.round(sys.live_power_mw)} mW`);
  const batteryLabel = batteryParts.length > 0 ? batteryParts.join(" · ") : "—";

  const processesLabel = `${sys.running} running · ${sys.cached} cached · ${sys.stopped} stopped`;

  // Localize the governor mode via the same keys the energy-mode buttons use
  // (SensorPanel), so "power_save" renders as "Power save"; unknown modes stay raw.
  const govModeLabel = (mode: string): string =>
    mode === "balanced"
      ? t("settings.sensorBalanced")
      : mode === "performance"
        ? t("settings.sensorPerformance")
        : mode === "power_save"
          ? t("settings.sensorPowerSave")
          : mode;

  return (
    <section className={GROUP}>
      <div className={ROW}>
        <span className={LABEL}>{t("settings.system")}</span>
        <button
          onClick={refresh}
          disabled={busy}
          className="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-40 dark:bg-white/10"
        >
          {t("settings.systemRefresh")}
        </button>
      </div>
      <div className="grid grid-cols-1 gap-1 border-t border-black/5 px-4 py-3 text-xs opacity-80 dark:border-white/10">
        <p>{t("settings.systemCpu", { v: cpuLabel })}</p>
        <p>{t("settings.systemMem", { v: memLabel })}</p>
        <p>{t("settings.systemBattery", { v: batteryLabel })}</p>
        <p>{t("settings.systemProcesses", { v: processesLabel })}</p>
        {sys.governor && sys.governor.ticks > 0 && (
          <div className="mt-1 border-t border-black/5 pt-1 dark:border-white/10">
            <p className="mb-0.5">{t("settings.systemGovernor")}</p>
            <p>
              {t("settings.systemGovernorMode", {
                mode: govModeLabel(sys.governor.mode),
                reason: sys.governor.reason,
              })}
            </p>
            <p>
              {t("settings.systemGovernorFlags", {
                cap: sys.governor.cap_inference ? t("common.on") : t("common.off"),
                throttle: sys.governor.throttle_background ? t("common.on") : t("common.off"),
              })}
            </p>
            <p>
              {t("settings.systemGovernorDvfs", {
                applied: String(sys.governor.dvfs_applied),
                failed: String(sys.governor.dvfs_failed),
                dropped: String(sys.governor.dropped),
              })}
              {sys.governor.dvfs_failed > 0 ? " ⚠" : ""}
            </p>
          </div>
        )}
        {sys.apps.length > 0 && (
          <div className="mt-1 border-t border-black/5 pt-1 dark:border-white/10">
            <p className="mb-0.5">{t("settings.systemApps")}</p>
            <ul className="space-y-0.5">
              {sys.apps.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{a.id}</span>
                  <span className="opacity-60">{a.state}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

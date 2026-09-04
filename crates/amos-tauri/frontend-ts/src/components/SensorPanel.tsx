import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import {
  normalizeSnapshot,
  sensorSetMode,
  sensorSnapshot,
  type SensorMode,
} from "../lib/sensors";
import { GROUP, ROW, LABEL } from "./ui";

const SENSOR_MODES: SensorMode[] = ["balanced", "performance", "power_save"];

function modeKey(m: SensorMode): string {
  return m === "balanced"
    ? "settings.sensorBalanced"
    : m === "performance"
      ? "settings.sensorPerformance"
      : "settings.sensorPowerSave";
}

/**
 * Device-sensor readout tile (desktop): calls the daemon's mounted `SensorService`
 * through the `sensor_*` Tauri bridge and shows energy mode + cameras + GNSS + IMU.
 * Hidden when not bridged / no data (e.g. no daemon), so it never shows a broken card.
 */
export default function SensorPanel() {
  const { t } = useI18n();
  const [snap, setSnap] = useState(() => normalizeSnapshot(null));
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setBusy(true);
    sensorSnapshot()
      .then((s) => {
        // Coerce through the pure normalizer so a partial/odd payload can never
        // crash the tile or show a bogus active mode.
        if (s) setSnap(normalizeSnapshot(s));
      })
      .catch(() => {
        /* daemon offline → keep previous / nothing */
      })
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setMode = (mode: SensorMode) => {
    if (mode === snap.mode || busy) return;
    setBusy(true);
    sensorSetMode(mode)
      .then(() => refresh())
      .catch(() => setBusy(false));
  };

  // Hidden entirely when there is nothing to show (not bridged / daemon offline),
  // so Settings never displays a broken/empty card.
  if (snap.cameras.length === 0 && !snap.gnss && !snap.imu && snap.mode === "unknown") {
    return null;
  }

  const firstCam = snap.cameras[0];
  const camLabel =
    snap.cameras.length === 0
      ? "—"
      : `${snap.cameras.length}${firstCam ? ` · ${firstCam.width}×${firstCam.height}` : ""}`;
  const gnssLabel = !snap.gnss
    ? "—"
    : !snap.gnss.enabled
      ? t("settings.sensorGnssDisabled")
      : snap.gnss.has_fix
        ? `${snap.gnss.latitude_deg.toFixed(5)}, ${snap.gnss.longitude_deg.toFixed(5)} · ±${snap.gnss.accuracy_m.toFixed(0)}m · ${snap.gnss.sats}sats`
        : t("settings.sensorGnssNone");

  return (
    <section className={GROUP}>
      <div className={ROW}>
        <span className={LABEL}>{t("settings.sensor")}</span>
        <button
          onClick={refresh}
          disabled={busy}
          className="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-40 dark:bg-white/10"
        >
          {t("settings.sensorRefresh")}
        </button>
      </div>
      <div className="flex gap-1.5 px-4 pb-2" role="group" aria-label={t("settings.sensorMode")}>
        {SENSOR_MODES.map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            disabled={busy}
            aria-pressed={snap.mode === m}
            className={
              "rounded-full px-3 py-1 text-xs transition disabled:opacity-40 " +
              (snap.mode === m
                ? "bg-accent text-white"
                : "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300")
            }
          >
            {t(modeKey(m))}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-1 border-t border-black/5 px-4 py-3 text-xs opacity-80 dark:border-white/10">
        <p>{t("settings.sensorCameras", { n: camLabel })}</p>
        <p>{t("settings.sensorGnss", { n: gnssLabel })}</p>
        {snap.imu && (
          <p>
            {t("settings.sensorImu", {
              hz: String(snap.imu.rate_hz),
              t: snap.imu.temp_c.toFixed(1),
            })}
          </p>
        )}
      </div>
    </section>
  );
}

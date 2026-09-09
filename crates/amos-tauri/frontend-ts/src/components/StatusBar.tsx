import { useEffect, useState } from "react";
import { fmtClock } from "../lib/time";
import {
  SETTINGS_KEY,
  FLASHLIGHT_KEY,
  normalizeFlashlight,
  normalizeQuick,
  torchOn,
} from "../lib/settings";
import { WIFI_KEY, normalizeWifi } from "../lib/wifi";
import { useStoreValue } from "../lib/useStoreValue";
import { useOnline } from "../lib/useOnline";
import { useAlertPolicy } from "../lib/sound";
import { batterySvg, iconSvg, radioIcon, type SysIconName } from "../lib/sysIcons";
import {
  firstBattery,
  batteryTone,
  watchHostBattery,
  type BatterySample,
} from "../lib/batteryStatus";
import { statusIcons } from "../lib/netStatus";
import { systemHealth, hostBattery } from "../lib/system";
import { bridged } from "../lib/backend";

/**
 * React StatusBar — the DEV/non-PROD fallback of the top chrome (the Svelte
 * `StatusBar.svelte` is the production bar; `svelteEnabled()` is true in the Vite
 * build). To keep the two bars from drifting, this fallback reads the SAME real
 * battery & connectivity that the Svelte bar does: daemon `system_health` first,
 * host OS Battery API second, else an honest "—" (never a fabricated countdown);
 * Wi‑Fi reflects the SSID we actually joined, not just the toggle.
 */
export default function StatusBar() {
  const [now, setNow] = useState(() => new Date());
  const settings = useStoreValue<unknown>(SETTINGS_KEY, {});
  const flashStore = useStoreValue<unknown>(FLASHLIGHT_KEY, {});
  const wifiStore = useStoreValue<unknown>(WIFI_KEY, {});
  const online = useOnline();
  const quick = normalizeQuick(settings);
  const flashOn = torchOn(normalizeFlashlight(flashStore));
  const wifi = normalizeWifi(wifiStore);
  // Wi‑Fi reads as "connected" only when enabled AND genuinely joined to a network.
  const icons = statusIcons(quick, online, wifi.current);
  const { dnd, effective } = useAlertPolicy();
  // Persistent alert indicators: moon while Do-Not-Disturb; otherwise a muted
  // bell when the ring/vibrate policy mutes alerts. Nothing extra by default.
  const alertIcon: SysIconName | null = dnd
    ? "moon"
    : effective.ring || effective.vibrate
      ? null
      : "mutedBell";

  // Real battery: authoritative daemon reading, else host OS battery, else unknown.
  const [systemBatt, setSystemBatt] = useState<BatterySample>({
    levelPct: null,
    charging: null,
  });
  const [tauriBatt, setTauriBatt] = useState<BatterySample>({
    levelPct: null,
    charging: null,
  });
  const [hostBatt, setHostBatt] = useState<BatterySample>({
    levelPct: null,
    charging: null,
  });
  useEffect(() => {
    const stopHost = watchHostBattery(setHostBatt);
    const poll = async () => {
      if (!bridged()) return;
      const raw = await systemHealth();
      if (raw) {
        setSystemBatt({
          levelPct: raw.battery_level_pct,
          charging: raw.battery_charging,
        });
      }
      // The host OS battery (desktop dev / any host the daemon can't see).
      const host = await hostBattery();
      if (host) {
        setTauriBatt({ levelPct: host.level_pct, charging: host.charging });
      }
    };
    void poll();
    const id = window.setInterval(poll, 5000);
    return () => {
      if (stopHost) stopHost();
      window.clearInterval(id);
    };
  }, []);
  const batt = firstBattery([systemBatt, tauriBatt, hostBatt]);
  const battTone = batteryTone(batt);
  const battText =
    batt.levelPct === null ? "—" : `${Math.round(batt.levelPct)}%`;
  const battTitle =
    batt.levelPct === null
      ? undefined
      : batt.charging === true
        ? `battery: charging ${battText}`
        : `battery: ${battText}`;

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="relative flex items-center justify-between px-4 pb-1 pt-3 text-xs font-semibold">
      <span className="tabular-nums">{fmtClock(now)}</span>
      {/* Dynamic Island */}
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[9px] h-[22px] w-[112px] -translate-x-1/2 rounded-full bg-black shadow-sm"
      />
      <span className="flex items-center gap-1 text-[10px] opacity-80" aria-label="network status">
        {alertIcon && (
          <span
            data-icon={alertIcon}
            aria-label={dnd ? "do not disturb" : "alerts muted"}
            title={dnd ? "Do Not Disturb" : "alerts muted"}
            dangerouslySetInnerHTML={{ __html: iconSvg(alertIcon) }}
          />
        )}
        {flashOn && (
          <span
            data-icon="flashlight"
            aria-label="flashlight on"
            title="Flashlight"
            dangerouslySetInnerHTML={{ __html: iconSvg("flashlight") }}
          />
        )}
        {icons.map((ic) => (
          <span
            key={ic.kind}
            data-icon={ic.kind}
            className={ic.on ? "" : "opacity-40"}
            title={ic.title}
            dangerouslySetInnerHTML={{ __html: iconSvg(radioIcon(ic.kind)) }}
          />
        ))}
        <span
          className="flex items-center gap-1 tabular-nums"
          aria-label="battery level"
          title={battTitle}
        >
          <span
            aria-hidden
            dangerouslySetInnerHTML={{
              __html: batterySvg(
                batt.levelPct === null ? 0 : batt.levelPct,
                "h-3 w-3",
                battTone,
              ),
            }}
          />
          <span aria-hidden>{battText}</span>
        </span>
      </span>
    </div>
  );
}



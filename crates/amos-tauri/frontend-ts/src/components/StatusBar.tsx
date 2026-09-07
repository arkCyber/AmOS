import { useEffect, useState } from "react";
import { batteryPercent, fmtClock } from "../lib/time";
import { SETTINGS_KEY, FLASHLIGHT_KEY, applyConnectivity, normalizeFlashlight, normalizeQuick, radioIcons, torchOn } from "../lib/settings";
import { useStoreValue } from "../lib/useStoreValue";
import { useOnline } from "../lib/useOnline";
import { useAlertPolicy } from "../lib/sound";
import { batterySvg, iconSvg, radioIcon, type SysIconName } from "../lib/sysIcons";

export default function StatusBar() {
  const [now, setNow] = useState(() => new Date());
  const settings = useStoreValue<unknown>(SETTINGS_KEY, {});
  const flashStore = useStoreValue<unknown>(FLASHLIGHT_KEY, {});
  const online = useOnline();
  const quick = normalizeQuick(settings);
  const flashOn = torchOn(normalizeFlashlight(flashStore));
  // Wi-Fi reads as "on" only when enabled AND the host is actually online.
  const icons = applyConnectivity(radioIcons(quick), online);
  const { dnd, effective } = useAlertPolicy();
  // Persistent alert indicators: moon while Do-Not-Disturb; otherwise a muted
  // bell when the ring/vibrate policy mutes alerts. Nothing extra by default.
  const alertIcon: SysIconName | null = dnd
    ? "moon"
    : effective.ring || effective.vibrate
      ? null
      : "mutedBell";
  const battery = batteryPercent(now);

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
            title={ic.kind === "wifi" && !online ? "wifi: no connection" : undefined}
            dangerouslySetInnerHTML={{ __html: iconSvg(radioIcon(ic.kind)) }}
          />
        ))}
        <span className="flex items-center gap-1 tabular-nums" aria-label="battery level">
          <span aria-hidden dangerouslySetInnerHTML={{ __html: batterySvg(battery) }} />
          <span aria-hidden>{battery}%</span>
        </span>
      </span>
    </div>
  );
}


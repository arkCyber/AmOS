import { useEffect, useState } from "react";
import { batteryPercent, fmtClock } from "../lib/time";
import { SETTINGS_KEY, applyConnectivity, normalizeQuick, radioIcons } from "../lib/settings";
import { useStoreValue } from "../lib/useStoreValue";
import { useOnline } from "../lib/useOnline";
import { useAlertPolicy } from "../lib/sound";

/** Glyph per radio kind — keep consistent with the NotificationCenter quick tiles. */
const GLYPH: Record<string, string> = {
  airplane: "✈️",
  wifi: "📶",
  bluetooth: "🅱",
};

export default function StatusBar() {
  const [now, setNow] = useState(() => new Date());
  const settings = useStoreValue<unknown>(SETTINGS_KEY, {});
  const online = useOnline();
  const quick = normalizeQuick(settings);
  // Wi-Fi reads as "on" only when enabled AND the host is actually online.
  const icons = applyConnectivity(radioIcons(quick), online);
  const { dnd, effective } = useAlertPolicy();
  // Persistent alert indicators: 🌒 while Do-Not-Disturb; otherwise 🔕 when the
  // ring/vibrate policy mutes alerts. Nothing extra in the default state.
  const alertGlyph = dnd ? "🌒" : effective.ring || effective.vibrate ? null : "🔕";

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
        {alertGlyph && (
          <span
            aria-label={dnd ? "do not disturb" : "alerts muted"}
            title={dnd ? "Do Not Disturb" : "alerts muted"}
          >
            {alertGlyph}
          </span>
        )}
        {icons.map((ic) => (
          <span
            key={ic.kind}
            className={ic.on ? "" : "opacity-40"}
            title={ic.kind === "wifi" && !online ? "wifi: no connection" : undefined}
          >
            {GLYPH[ic.kind] ?? ic.kind}
          </span>
        ))}
        <span className="tabular-nums" aria-hidden>
          ▮▮▮ {batteryPercent(now)}%
        </span>
      </span>
    </div>
  );
}


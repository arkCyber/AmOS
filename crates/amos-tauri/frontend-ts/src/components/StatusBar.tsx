import { useEffect, useState } from "react";
import { batteryPercent, fmtClock } from "../lib/time";

export default function StatusBar() {
  const [now, setNow] = useState(() => new Date());
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
      <span className="flex items-center gap-1 text-[10px] opacity-80">
        ▮▮▮ <span className="tabular-nums">{batteryPercent(now)}%</span>
      </span>
    </div>
  );
}

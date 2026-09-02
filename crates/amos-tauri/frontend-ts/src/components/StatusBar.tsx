import { useEffect, useState } from "react";
import { batteryPercent, fmtClock } from "../lib/time";

export default function StatusBar() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center justify-between px-4 pt-2 text-xs font-semibold">
      <span className="tabular-nums">{fmtClock(now)}</span>
      <span className="flex items-center gap-1 text-[10px] opacity-80">
        ▮▮▮ <span className="tabular-nums">{batteryPercent(now)}%</span>
      </span>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { fmtClock } from "../lib/time";
import { forecast } from "../lib/weather";

/** iOS-like home widgets: a live clock card + today's weather card. Tapping
 * either opens its app. */
export function HomeWidgets({ onOpen }: { onOpen?: (id: string) => void }) {
  const { t, locale } = useI18n();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const date = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
  const day = forecast()[0];

  const card =
    "flex flex-col justify-center rounded-3xl bg-white/40 p-4 text-left shadow-sm ring-1 ring-black/5 backdrop-blur-md transition active:scale-95 dark:bg-white/10 dark:ring-white/10";

  return (
    <div className="grid grid-cols-[1fr_auto] gap-3">
      <button className={card} onClick={() => onOpen?.("clock")}>
        <div className="text-4xl font-thin leading-none tabular-nums">{fmtClock(now)}</div>
        <div className="mt-2 text-xs opacity-70">{date}</div>
      </button>
      {day && (
        <button
          className={card + " items-center px-5"}
          onClick={() => onOpen?.("weather")}
          aria-label={t("app.weather")}
        >
          <div className="text-2xl">{day.icon}</div>
          <div className="text-xl font-thin tabular-nums">{day.temp}°</div>
          <div className="text-[10px] opacity-70">{t("weather.today")}</div>
        </button>
      )}
    </div>
  );
}

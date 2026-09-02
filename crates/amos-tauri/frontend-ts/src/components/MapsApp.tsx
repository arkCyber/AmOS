import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import {
  PLACES,
  clampZoom,
  latLonToTile,
  tileUrl,
  type LatLon,
} from "../lib/maps";

const PX = 256;
const SPAN = 3;

export default function MapsApp() {
  const { t } = useI18n();
  const online = useMemo(() => typeof navigator !== "undefined" && navigator.onLine !== false, []);
  const [center, setCenter] = useState<LatLon>([39.9042, 116.4074]);
  const [zoom, setZoom] = useState(12);
  const [label, setLabel] = useState("北京");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("");

  const { x, y } = latLonToTile(center[0], center[1], zoom);
  const tx = Math.floor(x);
  const ty = Math.floor(y);

  const search = () => {
    const hit = PLACES[query.trim()];
    if (hit) {
      setCenter(hit);
      setLabel(query.trim());
      setStatus("");
    } else {
      setStatus(t("maps.notFound"));
    }
  };

  return (
    <div className="p-3">
      <div className="flex items-center justify-between text-xs opacity-70">
        <span>{label}</span>
        <span>{status}</span>
      </div>

      <div className="relative mt-2 h-64 overflow-hidden rounded-2xl bg-neutral-200 dark:bg-neutral-800">
        {!online ? (
          <div className="grid h-full w-full place-items-center text-4xl">{t("maps.offline")}</div>
        ) : (
          <div
            className="absolute"
            style={{ width: `${SPAN * PX}px`, height: `${SPAN * PX}px` }}
          >
            {Array.from({ length: SPAN * SPAN }, (_, i) => {
              const dx = i % SPAN;
              const dy = Math.floor(i / SPAN);
              const ox = tx + dx - 1;
              const oy = ty + dy - 1;
              return (
                <img
                  key={i}
                  alt=""
                  src={tileUrl(zoom, ox, oy)}
                  className="absolute"
                  style={{ left: `${dx * PX}px`, top: `${dy * PX}px`, width: PX, height: PX }}
                />
              );
            })}
          </div>
        )}
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full text-2xl">
          📍
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => {
            if (typeof navigator !== "undefined" && navigator.geolocation) {
              navigator.geolocation.getCurrentPosition(
                (pos) => {
                  setCenter([pos.coords.latitude, pos.coords.longitude]);
                  setZoom(13);
                  setStatus("");
                },
                () => setStatus(t("maps.notFound")),
              );
            } else {
              setStatus(t("maps.offline"));
            }
          }}
          className="rounded-full bg-neutral-300 px-3 py-1 text-sm dark:bg-neutral-700"
        >
          {t("maps.locate")}
        </button>
        <button
          onClick={() => setZoom(clampZoom(zoom - 1))}
          className="h-8 w-8 rounded-full bg-neutral-300 dark:bg-neutral-700"
          aria-label="zoom out"
        >
          −
        </button>
        <button
          onClick={() => setZoom(clampZoom(zoom + 1))}
          className="h-8 w-8 rounded-full bg-neutral-300 dark:bg-neutral-700"
          aria-label="zoom in"
        >
          +
        </button>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder={t("maps.search")}
          className="min-w-0 flex-1 rounded-full bg-neutral-200 px-3 py-1.5 text-sm outline-none dark:bg-neutral-800"
        />
      </div>
    </div>
  );
}

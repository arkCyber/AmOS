import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "../i18n";
import { chip } from "./ui";
import { useCapability } from "./CapabilityGate";
import { useOnline } from "../lib/useOnline";
import { SETTINGS_KEY, locationEnabled, normalizeQuick } from "../lib/settings";
import { useStoreValue } from "../lib/useStoreValue";
import {
  PLACES,
  clampZoom,
  latLonToTile,
  tileUrl,
  panTiles,
  shiftCenter,
  cityLabel,
  cityKey,
  type LatLon,
} from "../lib/maps";

const PX = 256;
const SPAN = 3;

export default function MapsApp() {
  const { t, locale } = useI18n();
  // Live connectivity: flips as the user goes online/offline, not a mount snapshot.
  const online = useOnline();
  const [center, setCenter] = useState<LatLon>([39.9042, 116.4074]);
  const [zoom, setZoom] = useState(12);
  const [label, setLabel] = useState("北京");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("");

  // OS location permission gate (see lib/permissions.ts): geolocation is only
  // called after the "location" capability is granted to the maps app.
  const loc = useCapability("maps", "location");
  const [askLoc, setAskLoc] = useState(false);

  // System location master switch (the Notification Center "location" quick
  // toggle). When it is OFF, geolocation is blocked for every app regardless of
  // its grant — a granted app still needs the master ON to actually locate.
  const quickSettings = useStoreValue<unknown>(SETTINGS_KEY, {});
  // Location services default to ON; only an explicit OFF (the NC quick toggle)
  // disables them system-wide (regardless of per-app grants).
  const locationMaster = locationEnabled(normalizeQuick(quickSettings));

  // Drag-to-pan: remember where the drag began so each move is relative to the
  // start (no drift), and pan by screen-pixel delta.
  const dragRef = useRef<{ sx: number; sy: number; center: LatLon } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!online) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, center };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (dx || dy) {
      setCenter(shiftCenter(d.center, zoom, dx, dy));
      setLabel("");
    }
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const nudge = (dxTiles: number, dyTiles: number) => {
    setCenter((c) => panTiles(c, zoom, dxTiles, dyTiles));
    setLabel("");
  };

  const { x, y } = latLonToTile(center[0], center[1], zoom);
  const tx = Math.floor(x);
  const ty = Math.floor(y);

  const search = () => {
    const key = cityKey(query, locale);
    const c = key ? PLACES[key] : undefined;
    if (c && key) {
      setCenter(c);
      setLabel(key);
      setStatus("");
    } else {
      setStatus(t("maps.notFound"));
    }
  };

  const locate = () => {
    if (!locationMaster) {
      setStatus(t("maps.locOff"));
      return;
    }
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
  };

  return (
    <div className="p-3">
      <div className="flex items-center justify-between text-xs opacity-70">
        <span>{cityLabel(label, locale)}</span>
        <span>{status}</span>
      </div>

      <div
        className="relative mt-2 h-64 touch-none overflow-hidden rounded-2xl bg-neutral-200 dark:bg-neutral-800"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
        title={online ? t("maps.dragHint") : undefined}
      >
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
        {askLoc && (
          <div className="flex w-full flex-wrap items-center gap-2 rounded-2xl bg-white/70 px-3 py-2 text-xs ring-1 ring-black/10 dark:bg-white/[0.06] dark:ring-white/10">
            <span className="opacity-80">
              {t("perm.askAllow", { app: t("app.maps"), cap: t("perm.cap.location") })}
            </span>
            <button
              onClick={() => {
                loc.allow();
                setAskLoc(false);
                locate();
              }}
              className="rounded-full bg-accent px-3 py-1 text-white"
            >
              {t("perm.allow")}
            </button>
            <button
              onClick={() => {
                loc.deny();
                setAskLoc(false);
              }}
              className="rounded-full bg-neutral-300 px-3 py-1 dark:bg-neutral-700"
            >
              {t("perm.deny")}
            </button>
          </div>
        )}
        <button
          onClick={() => {
            if (!locationMaster) setStatus(t("maps.locOff"));
            else if (!loc.granted) setAskLoc(true);
            else locate();
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
        <div className="flex items-center gap-1">
          <button onClick={() => nudge(0, -1)} className="h-7 w-7 rounded-full bg-neutral-300 text-xs dark:bg-neutral-700" aria-label={t("maps.panUp")}>
            ▲
          </button>
          <button onClick={() => nudge(-1, 0)} className="h-7 w-7 rounded-full bg-neutral-300 text-xs dark:bg-neutral-700" aria-label={t("maps.panLeft")}>
            ◀
          </button>
          <button onClick={() => nudge(1, 0)} className="h-7 w-7 rounded-full bg-neutral-300 text-xs dark:bg-neutral-700" aria-label={t("maps.panRight")}>
            ▶
          </button>
          <button onClick={() => nudge(0, 1)} className="h-7 w-7 rounded-full bg-neutral-300 text-xs dark:bg-neutral-700" aria-label={t("maps.panDown")}>
            ▼
          </button>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder={t("maps.search")}
          className="min-w-0 flex-1 rounded-full bg-black/5 px-3.5 py-1.5 text-sm text-neutral-900 outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:text-white dark:ring-white/10 dark:placeholder:text-white/30"
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {Object.keys(PLACES).map((name) => (
          <button
            key={name}
            onClick={() => {
              const c = PLACES[name];
              if (!c) return;
              setCenter(c);
              setLabel(name);
              setQuery("");
              setStatus("");
            }}
            className={chip(label === name)}
          >
            {cityLabel(name, locale)}
          </button>
        ))}
      </div>
    </div>
  );
}

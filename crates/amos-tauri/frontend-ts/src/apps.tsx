import { Fragment, useEffect, useReducer, useRef, useState, type FC } from "react";
import FilesApp from "./components/FilesApp";
import AndroidApp from "./components/AndroidApp";
import { MessagesApp, PhoneApp, MusicApp } from "./components/CommsApps";
import MapsApp from "./components/MapsApp";
import CameraApp from "./components/CameraApp";
import { AiApp, InterpApp } from "./components/BackendApps";
import MailApp from "./components/MailApp";
import StoreApp from "./components/StoreApp";
import PermissionsApp from "./components/PermissionsApp";
import ContactsApp from "./components/ContactsApp";
import ExtApp from "./components/ExtApp";
import { isExtId } from "./lib/storeApps";
import type { MessageKey } from "./i18n/locales/zh";
import { useI18n } from "./i18n";
import { useTheme, type ThemeMode } from "./theme";
import Segmented from "./components/Segmented";
import { GROUP, ROW, LABEL, SUB, FIELD, Switch, chip, btn } from "./components/ui";
import { WallpaperCard } from "./components/Wallpaper";
import LockSettings from "./components/LockSettings";
import { SETTINGS_KEY, BACKUP_KEY, SYNC_STORES, readCloud, setCloudPrefs, snapshotStores, type CloudPrefs } from "./lib/cloud";
import { readAiConfig, setAiConfig, DEEPSEEK_MODEL, DEEPSEEK_ENDPOINT, type AiProviderId } from "./lib/providers";
import type { Locale } from "./i18n/types";
import { addHistory, calcDisplay, calcEntry, calcFromKey, calcInit, calcPress, ERR } from "./lib/calculator";
import { zoneClock, stopwatchInit, stopwatchReducer, fmtStopwatch, timerInit, timerReducer, fmtCountdown, alarmsReducer, alarmInit, ringingAlarms, normalizeAlarms, normalizeWorldCities, removeWorldCity, addWorldCity, WORLD_CITY_PRESETS, defaultWorldCities, lapDeltas, fastestLap, type WorldCity } from "./lib/time";
import { readStoreValue, writeStoreValue } from "./lib/amosStore";
import { bridged, getAiStatus, switchAiBackend } from "./lib/backend";
import { NOTES_KEY, prependNote, removeNote, editNote, togglePin, orderPinned, setNoteState, notesOf, searchNotes, fmtTime, normalizeNotes, noteStats, tasksOf, toggleTaskInText, toggleTaskInNote, taskSummary, completeAllTasks, noteListProgress, fmtInline, type Note } from "./lib/notes";
import { forecast, dayLabel, displayTemp, convertRange, adjustForecast, WEATHER_CITIES, normalizeWeatherCities, removeWeatherCity, addWeatherCity, type TempUnit, type WCity } from "./lib/weather";
import {
  PHOTOS_KEY,
  seedPhotos,
  newPhoto,
  removePhoto,
  removePhotos,
  neighborOf,
  isRealPhoto,
  toggleFav,
  favsOf,
  shareCaption,
  normalizePhotos,
  type Photo,
} from "./lib/photos";

export interface AppMeta {
  id: string;
  /** i18n key for the app's display name (also used as its title bar). */
  titleKey: MessageKey;
  icon: string;
}

/** The set of apps currently ported to React/TS. Grows as each app migrates. */
export const APPS: AppMeta[] = [
  { id: "clock", titleKey: "app.clock", icon: "🕐" },
  { id: "settings", titleKey: "app.settings", icon: "⚙️" },
  { id: "calculator", titleKey: "app.calculator", icon: "🧮" },
  { id: "weather", titleKey: "app.weather", icon: "🌤️" },
  { id: "notes", titleKey: "app.notes", icon: "📝" },
  { id: "photos", titleKey: "app.photos", icon: "🖼️" },
  { id: "files", titleKey: "app.files", icon: "📁" },
  { id: "android", titleKey: "app.android", icon: "🤖" },
  { id: "messages", titleKey: "app.messages", icon: "💬" },
  { id: "phone", titleKey: "app.phone", icon: "📞" },
  { id: "music", titleKey: "app.music", icon: "🎵" },
  { id: "maps", titleKey: "app.maps", icon: "🗺️" },
  { id: "camera", titleKey: "app.camera", icon: "📷" },
  { id: "ai", titleKey: "app.ai", icon: "🤖" },
  { id: "interpreter", titleKey: "app.interpreter", icon: "🌐" },
  { id: "mail", titleKey: "app.mail", icon: "✉️" },
  { id: "store", titleKey: "app.store", icon: "🛍️" },
  { id: "privacy", titleKey: "app.privacy", icon: "🛡️" },
  { id: "contacts", titleKey: "app.contacts", icon: "👥" },
];

export function appTitleKey(id: string): MessageKey | null {
  return APPS.find((a) => a.id === id)?.titleKey ?? null;
}

/** Single source of truth for an app's tile icon (emoji). */
export function appIcon(id: string): string {
  return APPS.find((a) => a.id === id)?.icon ?? "🧩";
}

/* ---- Clock (world clock + live now) ---- */
const StopwatchCard: FC = () => {
  const { t } = useI18n();
  const [sw, swDispatch] = useReducer(stopwatchReducer, undefined, stopwatchInit);
  const [laps, setLaps] = useState<number[]>([]);
  useEffect(() => {
    if (!sw.running) return;
    const id = setInterval(() => swDispatch({ type: "tick", now: Date.now() }), 50);
    return () => clearInterval(id);
  }, [sw.running]);
  const doLap = () => setLaps((prev) => (prev.length >= 50 ? prev : [...prev, sw.elapsedMs]));
  const deltas = lapDeltas(laps);
  const fastest = fastestLap(laps);
  const resetAll = () => {
    setLaps([]);
    swDispatch({ type: "reset" });
  };
  return (
    <div className="mt-6 rounded-xl bg-neutral-200/50 p-4 text-center dark:bg-neutral-800/50">
      <div className="text-xs uppercase tracking-wide opacity-50">{t("clock.stopwatch")}</div>
      <div className="mt-1 text-4xl font-thin tabular-nums">{fmtStopwatch(sw.elapsedMs)}</div>
      <div className="mt-3 flex items-center justify-center gap-4">
        <button
          onClick={() =>
            swDispatch({ type: sw.running ? "pause" : "start", now: Date.now() })
          }
          className={
            "h-12 w-12 rounded-full text-lg text-white " +
            (sw.running ? "bg-danger" : "bg-green-500")
          }
          aria-label={t("clock.stopwatch")}
        >
          {sw.running ? "⏸" : "▶"}
        </button>
        <button
          onClick={doLap}
          disabled={!sw.running}
          aria-label="lap"
          className="h-10 rounded-full bg-neutral-300 px-3 text-sm disabled:opacity-30 dark:bg-neutral-700"
        >
          {t("clock.lap")}
        </button>
        <button
          onClick={resetAll}
          disabled={sw.elapsedMs === 0 && !sw.running}
          className="h-12 w-12 rounded-full bg-neutral-300 text-lg disabled:opacity-30 dark:bg-neutral-700"
          aria-label="reset"
        >
          ↺
        </button>
      </div>
      {laps.length > 0 && (
        <div className="mt-3 space-y-1 border-t pt-2 text-sm tabular-nums">
          {laps.map((l, i) => (
            <div
              key={i}
              className={"flex justify-between " + (i === fastest ? "font-semibold text-accent" : "opacity-70")}
            >
              <span>
                {t("clock.lapCount", { n: String(i + 1) })}
                {i === fastest ? " ★" : ""}
              </span>
              <span className="tabular-nums">
                {fmtStopwatch(l)} <span className="opacity-50">(+{fmtStopwatch(deltas[i] ?? 0)})</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const Clock: FC = () => {
  const { t, locale } = useI18n();
  const fmt = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const fmtDate = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  // Editable world clock: persisted list, defaulted to the base four cities.
  const [wc, setWc] = useState<WorldCity[]>(() =>
    normalizeWorldCities(readStoreValue<unknown>("amos.worldclock", undefined), defaultWorldCities()),
  );
  useEffect(() => {
    writeStoreValue("amos.worldclock", wc);
  }, [wc]);
  const [wcEdit, setWcEdit] = useState(false);
  const world = wc;
  const wcMissing = WORLD_CITY_PRESETS.find((c) => !wc.some((x) => x.zone === c.zone));
  const [tm, tmDispatch] = useReducer(timerReducer, undefined, timerInit);
  // The clock already ticks every second via `now` — drive the countdown from it.
  useEffect(() => {
    if (tm.running) tmDispatch({ type: "tick", now: Date.now() });
  }, [now, tm.running]);
  const timerDone = tm.totalMs > 0 && tm.remainingMs === 0 && !tm.running;
  // Alarms: kept in a pure reducer; loaded/persisted, and re-evaluated each
  // second (the Clock already re-renders at 1 Hz via `now`).
  const [al, alDispatch] = useReducer(
    alarmsReducer,
    undefined,
    () => alarmInit(normalizeAlarms(readStoreValue<unknown>("amos.alarms", []))),
  );
  useEffect(() => {
    writeStoreValue("amos.alarms", al.list);
  }, [al.list]);
  useEffect(() => {
    alDispatch({ type: "tick", now });
  }, [now]);
  const ringAlarms = ringingAlarms(al);
  const [alH, setAlH] = useState("8");
  const [alM, setAlM] = useState("0");
  const [alLabel, setAlLabel] = useState("");
  const [alRepeat, setAlRepeat] = useState<number[]>([]);
  const [tab, setTab] = useState<"world" | "stopwatch" | "timer" | "alarm">("world");
  const TABS: { value: typeof tab; label: string }[] = [
    { value: "world", label: t("clock.world") },
    { value: "stopwatch", label: t("clock.stopwatch") },
    { value: "timer", label: t("clock.timer") },
    { value: "alarm", label: t("clock.alarm") },
  ];
  const DOW = locale === "zh" ? ["日", "一", "二", "三", "四", "五", "六"] : ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const toggleDay = (day: number) =>
    setAlRepeat((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );
  const fmtHm = (h: number, m: number) =>
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const addAlarm = () => {
    const h = Number.parseInt(alH, 10);
    const m = Number.parseInt(alM, 10);
    alDispatch({
      type: "add",
      hour: Number.isNaN(h) ? 0 : h,
      min: Number.isNaN(m) ? 0 : m,
      label: alLabel,
      repeat: alRepeat,
    });
    setAlH("8");
    setAlM("0");
    setAlLabel("");
    setAlRepeat([]);
  };
  return (
    <div className="p-6">
      <div className="flex justify-center pt-1 pb-3">
        <Segmented value={tab} options={TABS} onChange={setTab} ariaLabel="clock-tabs" />
      </div>
      <div className={tab === "world" ? "" : "hidden"}>
      <div className="text-center">
        <div className="text-5xl font-thin tabular-nums">{fmt(now)}</div>
        <div className="mt-1 text-sm opacity-60">{fmtDate(now)}</div>
        <div className="mt-1 text-xs uppercase tracking-wide opacity-50">{t("clock.now")}</div>
      </div>
      <div className="mt-6 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide opacity-50">{t("clock.world")}</span>
        <div className="flex items-center gap-2">
          {wcMissing && (
            <button
              onClick={() => setWc(addWorldCity(wc, wcMissing))}
              className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
            >
              + {t("clock.addCity")}
            </button>
          )}
          <button
            onClick={() => setWcEdit((e) => !e)}
            className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
          >
            {wcEdit ? t("common.done") : t("clock.edit")}
          </button>
        </div>
      </div>
      <div className="mt-2 space-y-2">
        {world.map((c) => (
          <div
            key={c.labelKey}
            className="flex items-center justify-between rounded-xl bg-neutral-200/50 px-3 py-2 text-sm dark:bg-neutral-800/50"
          >
            <span className="opacity-70">{t(c.labelKey)}</span>
            <div className="flex items-center gap-2">
              {wcEdit && (
                <button
                  onClick={() => setWc(removeWorldCity(wc, c.zone))}
                  className="rounded-full bg-neutral-300 px-2 text-xs text-danger dark:bg-neutral-700"
                >
                  ✕
                </button>
              )}
              <span className="tabular-nums">{zoneClock(now, c.zone)}</span>
            </div>
          </div>
        ))}
      </div>
      </div>
      <div className={tab === "timer" ? "" : "hidden"}>
      <div className="mt-6 rounded-xl bg-neutral-200/50 p-4 text-center dark:bg-neutral-800/50">
        <div className="text-xs uppercase tracking-wide opacity-50">{t("clock.timer")}</div>
        <div
          className={
            "mt-1 text-4xl font-thin tabular-nums " + (timerDone ? "text-danger" : "")
          }
        >
          {fmtCountdown(tm.remainingMs)}
        </div>
        {timerDone && <div className="mt-1 text-xs text-danger">{t("clock.timerDone")}</div>}
        <div className="mt-2 flex items-center justify-center gap-2">
          {[1, 3, 5].map((m) => (
            <button
              key={m}
              onClick={() => tmDispatch({ type: "set", totalMs: m * 60000 })}
              disabled={tm.running}
              className={btn("neutral", "sm")}
            >
              {m} {t("clock.min")}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-center gap-4">
          <button
            onClick={() => tmDispatch({ type: tm.running ? "pause" : "start", now: Date.now() })}
            disabled={tm.totalMs === 0 && !tm.running}
            className={
              "h-12 w-12 rounded-full text-lg text-white " +
              (tm.running ? "bg-danger" : "bg-green-500")
            }
            aria-label={t("clock.timer")}
          >
            {tm.running ? "⏸" : "▶"}
          </button>
          <button
            onClick={() => tmDispatch({ type: "reset" })}
            disabled={tm.totalMs === 0}
            className="h-12 w-12 rounded-full bg-neutral-300 text-lg disabled:opacity-30 dark:bg-neutral-700"
            aria-label="reset"
          >
            ↺
          </button>
        </div>
      </div>
      </div>
      <div className={tab === "alarm" ? "" : "hidden"}>
      {ringAlarms.length > 0 && (
        <div className="mt-4 space-y-2">
          {ringAlarms.map((ra) => (
            <div
              key={ra.id}
              className="flex items-center justify-between gap-2 rounded-xl bg-danger/15 px-3 py-2 text-sm"
            >
              <span>
                {(ra.tone ?? "🔔")} {fmtHm(ra.hour, ra.min)}
                {ra.label ? ` · ${ra.label}` : ""}
              </span>
              <div className="flex shrink-0 gap-1.5">
                <button
                  onClick={() => alDispatch({ type: "snooze", id: ra.id, now })}
                  className={btn("neutral", "sm")}
                >
                  {t("clock.snooze")}
                </button>
                <button
                  onClick={() => alDispatch({ type: "dismiss", id: ra.id })}
                  className={btn("danger", "sm")}
                >
                  {t("clock.dismissAlarm")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-6 rounded-xl bg-neutral-200/50 p-4 dark:bg-neutral-800/50">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide opacity-50">{t("clock.alarm")}</span>
          <span className="text-[11px] opacity-50">{t("clock.alarmCount", { n: al.list.length })}</span>
        </div>
        {al.list.length === 0 ? (
          <p className="py-2 text-center text-xs opacity-50">{t("clock.alarmEmpty")}</p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {al.list.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <span className={"tabular-nums font-semibold " + (!a.enabled ? "opacity-40" : "")}>
                    {fmtHm(a.hour, a.min)}
                  </span>
                  {a.label && (
                    <span className={"ml-2 text-xs " + (!a.enabled ? "opacity-40" : "opacity-60")}>
                      {a.label}
                    </span>
                  )}
                  {a.repeat && a.repeat.length > 0 && (
                    <span className={"block text-[10px] " + (!a.enabled ? "opacity-40" : "opacity-50")}>
                      {t("clock.repeat")}: {a.repeat.map((d) => DOW[d] ?? "").join(" · ")}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => alDispatch({ type: "tone", id: a.id })}
                    aria-label={t("clock.tone")}
                    title={t("clock.tone")}
                    className="rounded-full px-1 text-base leading-none"
                  >
                    {a.tone ?? "🔔"}
                  </button>
                  <Switch
                    on={a.enabled}
                    onToggle={() => alDispatch({ type: "toggle", id: a.id })}
                    label={t("clock.alarmToggle")}
                  />
                  <button
                    onClick={() => alDispatch({ type: "remove", id: a.id })}
                    aria-label={t("clock.alarmRemove")}
                    className="text-danger"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex items-center gap-1">
          <span className="mr-1 text-[10px] opacity-50">{t("clock.repeat")}</span>
          {DOW.map((d, day) => (
            <button
              key={day}
              onClick={() => toggleDay(day)}
              aria-pressed={alRepeat.includes(day)}
              className={
                "h-6 w-6 rounded-full text-[10px] " +
                (alRepeat.includes(day)
                  ? "bg-accent text-white"
                  : "bg-neutral-300 dark:bg-neutral-700")
              }
            >
              {d}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-end gap-1.5">
          <input
            value={alH}
            onChange={(e) => setAlH(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
            inputMode="numeric"
            aria-label={t("clock.hour")}
            className="w-12 rounded-lg bg-white/70 px-2 py-1 text-center text-sm outline-none dark:bg-neutral-900/70"
          />
          <span className="pb-1 text-sm">:</span>
          <input
            value={alM}
            onChange={(e) => setAlM(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
            inputMode="numeric"
            aria-label={t("clock.minute")}
            className="w-12 rounded-lg bg-white/70 px-2 py-1 text-center text-sm outline-none dark:bg-neutral-900/70"
          />
          <input
            value={alLabel}
            onChange={(e) => setAlLabel(e.target.value)}
            placeholder={t("clock.alarmLabel")}
            className="min-w-0 flex-1 rounded-lg bg-white/70 px-2 py-1 text-sm outline-none dark:bg-neutral-900/70"
          />
          <button
            onClick={addAlarm}
            className="shrink-0 rounded-full bg-accent px-3 py-1.5 text-sm text-white active:scale-95"
          >
            {t("clock.addAlarm")}
          </button>
        </div>
      </div>
      </div>
      <div className={tab === "stopwatch" ? "" : "hidden"}>
        <StopwatchCard />
      </div>
    </div>
  );
};

/* ---- Settings: first-class light/dark + language ---- */
const Settings: FC = () => {
  const { t, locale, setLocale } = useI18n();
  const { mode, dark, setMode } = useTheme();

  const themeOpts: { value: ThemeMode; label: string }[] = [
    { value: "light", label: t("theme.light") },
    { value: "dark", label: t("theme.dark") },
    { value: "auto", label: t("theme.auto") },
  ];
  const langOpts: { value: Locale; label: string }[] = [
    { value: "zh", label: "中文" },
    { value: "en", label: "English" },
  ];
  // iCloud-style sync toggle + manual local backup snapshot.
  const [cloud, setCloudState] = useState<CloudPrefs>(() =>
    readCloud(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {})),
  );
  const persistCloud = (partial: Partial<CloudPrefs>) => {
    const cur = readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {});
    writeStoreValue(SETTINGS_KEY, setCloudPrefs(cur, partial));
    setCloudState((c) => ({ ...c, ...partial }));
  };
  const syncNow = () => {
    const stores: Record<string, unknown> = {};
    for (const k of SYNC_STORES) stores[k] = readStoreValue<unknown>(k, []);
    writeStoreValue(BACKUP_KEY, snapshotStores(stores));
    persistCloud({ enabled: cloud.enabled, lastSync: Date.now() });
  };
  // AI inference backend: local vs cloud (DeepSeek). Applies on daemon restart.
  const [aiCfg, setAiCfgState] = useState(() =>
    readAiConfig(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {})),
  );
  const [aiEdits, setAiEdits] = useState(() => ({
    provider: aiCfg.provider,
    model: aiCfg.model ?? DEEPSEEK_MODEL,
    endpoint: aiCfg.endpoint ?? DEEPSEEK_ENDPOINT,
    apiKey: aiCfg.apiKey ?? "",
  }));
  const [aiMsg, setAiMsg] = useState("");
  const [aiLive, setAiLive] = useState<string | null>(null);
  // Show the *actual* model the daemon is serving right now (real get_status).
  useEffect(() => {
    if (!bridged()) return;
    getAiStatus().then((s) => {
      const m = s?.model && s.model.trim() ? s.model : "offline";
      setAiLive(m);
    });
  }, []);
  const pickProvider = (provider: AiProviderId) =>
    setAiEdits((e) => ({ ...e, provider }));
  const saveAi = () => {
    const cur = readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {});
    writeStoreValue(SETTINGS_KEY, setAiConfig(cur, aiEdits));
    setAiCfgState(aiEdits);
    // Inside Tauri, apply immediately via the one-click backend switcher.
    if (bridged()) {
      const provider = aiEdits.provider === "deepseek" ? "deepseek" : "local";
      void switchAiBackend(provider, aiEdits.apiKey).then((report) => {
        setAiMsg(report ? `${t("settings.aiApplied")}: ${report}` : t("settings.aiSaved"));
        void getAiStatus().then((s) => {
          const m = s?.model && s.model.trim() ? s.model : "offline";
          setAiLive(m);
        });
      });
    } else {
      setAiMsg(t("settings.aiSaved"));
    }
  };
  return (
    <div className="space-y-5 p-4">
      {/* General */}
      <section className={GROUP}>
        <div className={ROW}>
          <span className={LABEL}>{t("settings.appearance")}</span>
          <Segmented value={mode} options={themeOpts} onChange={setMode} ariaLabel="appearance" />
        </div>
        <div className={SUB} />
        <div className={ROW}>
          <span className={LABEL}>{t("settings.language")}</span>
          <Segmented value={locale} options={langOpts} onChange={setLocale} ariaLabel="language" />
        </div>
      </section>

      {/* iCloud-style sync */}
      <section className={GROUP}>
        <div className={ROW}>
          <span className={LABEL}>{t("settings.icloud")}</span>
          <Switch on={cloud.enabled} onToggle={() => persistCloud({ enabled: !cloud.enabled })} label={t("settings.icloud")} />
        </div>
        {cloud.enabled && (
          <>
            <div className={SUB} />
            <div className="px-4 py-3">
              <p className="text-xs opacity-70">{t("settings.icloudHint")}</p>
              {cloud.lastSync > 0 && (
                <p className="mt-1 text-xs opacity-60">
                  {t("settings.syncedAt", { time: new Date(cloud.lastSync).toLocaleTimeString() })}
                </p>
              )}
              <button
                onClick={syncNow}
                className="mt-2 rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95"
              >
                {t("settings.syncNow")}
              </button>
            </div>
          </>
        )}
      </section>

      {/* AI inference backend */}
      <section className={"p-4 " + GROUP}>
        <div className="flex items-center justify-between gap-2">
          <span className={LABEL}>{t("settings.aiBackend")}</span>
          <div className="flex gap-1.5" role="group" aria-label={t("settings.aiBackend")}>
            <button
              onClick={() => pickProvider("local")}
              aria-pressed={aiEdits.provider === "local"}
              className={
                "rounded-full px-3 py-1.5 text-xs transition " +
                (aiEdits.provider === "local"
                  ? "bg-accent text-white"
                  : "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300")
              }
            >
              {t("settings.aiLocal")}
            </button>
            <button
              onClick={() => pickProvider("deepseek")}
              aria-pressed={aiEdits.provider === "deepseek"}
              className={
                "rounded-full px-3 py-1.5 text-xs transition " +
                (aiEdits.provider === "deepseek"
                  ? "bg-accent text-white"
                  : "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300")
              }
            >
              {t("settings.aiCloud")}
            </button>
          </div>
        </div>
        {aiEdits.provider === "deepseek" && (
          <div className="mt-3 space-y-2">
            <label className="block text-[11px] opacity-60">{t("settings.aiModel")}</label>
            <input value={aiEdits.model} onChange={(e) => setAiEdits((s) => ({ ...s, model: e.target.value }))} className={FIELD} />
            <label className="block text-[11px] opacity-60">{t("settings.aiEndpoint")}</label>
            <input value={aiEdits.endpoint} onChange={(e) => setAiEdits((s) => ({ ...s, endpoint: e.target.value }))} className={FIELD} />
            <label className="block text-[11px] opacity-60">{t("settings.aiKey")}</label>
            <input
              value={aiEdits.apiKey}
              onChange={(e) => setAiEdits((s) => ({ ...s, apiKey: e.target.value }))}
              type="password"
              placeholder={aiEdits.apiKey ? "••••••••" : ""}
              className={FIELD}
            />
            <p className="text-[11px] opacity-50">{t("settings.aiKeyHint")}</p>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] opacity-50">{t("settings.aiNote")}</span>
          <button onClick={saveAi} className="rounded-full bg-accent px-3 py-1.5 text-xs text-white active:scale-95">
            {t("settings.aiSave")}
          </button>
        </div>
        {aiMsg && (
          <p role="status" className="mt-2 text-[11px] text-accent">
            {aiMsg}
          </p>
        )}
        <p className="mt-1 text-[11px] opacity-60">{t("settings.aiCurrent", { model: aiLive ?? "—" })}</p>
      </section>

      <WallpaperCard />
      <LockSettings />
      <p className="px-1 text-xs opacity-50">mode={mode} · dark={String(dark)} · locale={locale}</p>
    </div>
  );
};

/* ---- Calculator (pure logic in lib/calculator.ts, UI here) ---- */
const Calculator: FC = () => {
  const { t } = useI18n();
  const [st, setSt] = useState(() => calcInit());
  const [history, setHistory] = useState<{ expr: string; result: string }[]>([]);
  const [showHist, setShowHist] = useState(false);
  const press = (k: string) => {
    if (k === "=") {
      // Record the completed computation (before the reducer consumes it).
      const entry = calcEntry(st);
      setSt((s) => calcPress(s, k));
      if (entry) setHistory((h) => addHistory(h, entry));
    } else {
      setSt((s) => calcPress(s, k));
    }
  };
  const shown = calcDisplay(st).split(ERR).join(t("calc.error"));
  const ROWS: string[][] = [
    ["C", "⌫", "%", "÷"],
    ["7", "8", "9", "×"],
    ["4", "5", "6", "−"],
    ["1", "2", "3", "+"],
    ["0", ".", "=", ""],
  ];
  // iOS-style key roles: the right operator column (incl. =) is orange,
  // the top function row (C / ⌫ / %) is a light grey, everything else a digit key.
  const OPER = new Set(["÷", "×", "−", "+", "="]);
  const FN = new Set(["C", "⌫", "%"]);
  // Physical keyboard support: Enter/Backspace/Delete/Escape, digits, +−×÷% …
  // Keep the latest `press` in a ref so the window listener is registered only
  // once (no unbind/rebind churn on every keystroke).
  const pressRef = useRef(press);
  pressRef.current = press;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const label = calcFromKey(e.key, e.ctrlKey || e.metaKey || e.altKey);
      if (label == null) return;
      e.preventDefault();
      pressRef.current(label);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="flex h-full flex-col px-2 pb-2 pt-1">
      <div className="flex items-start justify-between px-2">
        <button
          onClick={() => setShowHist((v) => !v)}
          className={
            "rounded-full px-3 py-1 text-xs transition active:scale-90 " +
            (showHist ? "bg-accent text-white" : "opacity-60")
          }
        >
          {t("calc.history")}
          {history.length > 0 ? ` (${history.length})` : ""}
        </button>
        <div
          role="status"
          className="flex-1 truncate px-1 pb-1 text-right text-[52px] font-thin leading-none tabular-nums"
          style={{ color: st.cur === ERR ? "var(--color-danger, #ef4444)" : undefined }}
        >
          {shown}
        </div>
      </div>
      {showHist &&
        (history.length > 0 ? (
          <div className="mx-2 mb-1 max-h-24 overflow-auto rounded-xl bg-neutral-100/80 p-2 text-sm dark:bg-neutral-800/80">
            {history.map((h, i) => (
              <div
                key={`${i}-${h.expr}`}
                className="flex items-baseline justify-end gap-2 py-0.5"
              >
                <span className="opacity-50">{h.expr} =</span>
                <span className="tabular-nums font-medium">{h.result}</span>
              </div>
            ))}
            <button
              onClick={() => setHistory([])}
              className="mt-1 w-full rounded-md py-0.5 text-xs opacity-50 hover:opacity-100"
            >
              {t("calc.clear")}
            </button>
          </div>
        ) : (
          <p className="mb-1 text-center text-xs opacity-40">{t("calc.empty")}</p>
        ))}
      <div className="flex min-h-0 flex-1 flex-col justify-end">
        <div className="grid grid-cols-4 gap-x-[11px] gap-y-[11px]">
          {ROWS.map((row) =>
            row
              .filter(Boolean)
              .map((k) => {
                const isOp = OPER.has(k);
                const isFn = FN.has(k);
                const wide = k === "0";
                return (
                  <button
                    key={k}
                    onClick={() => press(k)}
                    aria-label={k}
                    className={
                      "flex select-none items-center justify-center rounded-full text-[26px] leading-none transition active:scale-95 " +
                      (isOp
                        ? "bg-orange-500 text-white"
                        : isFn
                          ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-300 dark:text-neutral-900"
                          : "bg-neutral-300 text-neutral-900 dark:bg-neutral-600 dark:text-white") +
                      (wide ? " col-span-2 justify-start pl-7" : " aspect-square")
                    }
                  >
                    {k}
                  </button>
                );
              }),
          )}
        </div>
      </div>
    </div>
  );
};

/* ---- Weather (localized 5-day forecast; data in lib/weather.ts) ---- */
const Weather: FC = () => {
  const { t, locale } = useI18n();
  const base = new Date();
  const baseDays = forecast();
  // Editable city subset (persisted) + remembered selection.
  const [cities, setCities] = useState<WCity[]>(() =>
    normalizeWeatherCities(readStoreValue<unknown>("amos.weather.cities", undefined)),
  );
  useEffect(() => {
    writeStoreValue("amos.weather.cities", cities);
  }, [cities]);
  const [selId, setSelId] = useState<string>(() => {
    const saved = readStoreValue<string>("amos.weather.city", "");
    return normalizeWeatherCities(undefined).some((c) => c.id === saved) ? saved : "";
  });
  useEffect(() => {
    writeStoreValue("amos.weather.city", selId);
  }, [selId]);
  const active = cities.find((c) => c.id === selId) ?? cities[0];
  const days = adjustForecast(baseDays, active?.offset ?? 0);
  const [unit, setUnit] = useState<TempUnit>("c");
  const missingCity = WEATHER_CITIES.find((c) => !cities.some((x) => x.id === c.id));
  const [edit, setEdit] = useState(false);
  const select = (id: string) => setSelId(id);
  const unitBtn = (u: TempUnit, label: string) => (
    <button onClick={() => setUnit(u)} className={chip(unit === u)}>
      {label}
    </button>
  );
  return (
    <div className="p-4">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {cities.map((c) => (
          <button
            key={c.id}
            onClick={() => select(c.id)}
            aria-pressed={active?.id === c.id}
            className={chip(active?.id === c.id)}
          >
            {t(`weather.city.${c.id}` as MessageKey)}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          {missingCity && (
            <button
              onClick={() => setCities(addWeatherCity(cities, missingCity))}
              className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
            >
              + {t("weather.addCity")}
            </button>
          )}
          <button
            onClick={() => setEdit((e) => !e)}
            className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-700"
          >
            {edit ? t("common.done") : t("weather.edit")}
          </button>
          {unitBtn("c", "℃")}
          {unitBtn("f", "℉")}
        </div>
      </div>
      {edit && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {cities.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                const next = removeWeatherCity(cities, c.id);
                setCities(next);
                if (active?.id === c.id) setSelId(next[0]?.id ?? "");
              }}
              className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] text-danger dark:bg-neutral-700"
            >
              {t(`weather.city.${c.id}` as MessageKey)} ✕
            </button>
          ))}
        </div>
      )}
      <div className="py-4 text-center">
        <div className="text-6xl">{days[0]?.icon ?? ""}</div>
        <div className="text-5xl font-thin">{days[0] ? displayTemp(days[0].temp, unit) : ""}</div>
        <div className="text-sm opacity-60">{days[0] ? convertRange(days[0].range, unit) : ""}</div>
        <div className="mt-1 text-xs opacity-60">
          {t("weather.humidity")} {days[0]?.humidity ?? "—"}% · {t("weather.wind")}{" "}
          {days[0]?.wind ?? "—"}
        </div>
      </div>
      <div className={"divide-y divide-black/5 dark:divide-white/10 " + GROUP}>
        {days.map((d) => {
          const label = d.daysFromNow === 0 ? t("weather.today") : dayLabel(locale, base, d.daysFromNow);
          return (
            <div key={d.daysFromNow} className="flex items-center justify-between gap-2 px-3.5 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
              <span className="text-xl">{d.icon}</span>
              <span className="flex w-16 flex-col items-end">
                <span className="text-sm font-semibold tabular-nums">{convertRange(d.range, unit)}</span>
                <span className="text-[10px] opacity-60">💧{d.humidity}%</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ---- Notes (persisted via the shared amos.notes store) ---- */
const Notes: FC = () => {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [notes, setNotes] = useState<Note[]>(() =>
    normalizeNotes(readStoreValue<unknown>(NOTES_KEY, [])),
  );
  const persist = (list: Note[]) => {
    writeStoreValue(NOTES_KEY, list);
    setNotes(list);
  };
  const add = () => {
    const v = text.trim();
    if (!v) return;
    persist(prependNote(notes, v, Date.now()));
    setText("");
  };
  // Edit existing note: one note at a time, saves bump ts; blank/cancel reverts.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const beginEdit = (n: Note) => {
    setEditingId(n.id);
    setEditVal(n.text);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditVal("");
  };
  const saveEdit = () => {
    if (!editingId) return;
    persist(editNote(notes, editingId, editVal, Date.now()));
    cancelEdit();
  };
  const editingThis = (id: string) => editingId === id;
  const editTasks = tasksOf(editVal);
  const [mode, setMode] = useState<"all" | "archived" | "trash">("all");
  const [searchQ, setSearchQ] = useState("");
  const active = orderPinned(searchNotes(notesOf(notes, undefined), mode === "all" ? searchQ : ""));
  const archived = notesOf(notes, "archived");
  const trashed = notesOf(notes, "trash");
  const agg = noteListProgress(notesOf(notes, undefined));
  const view = mode === "all" ? active : mode === "archived" ? archived : trashed;
  const setState = (id: string, st: "archived" | "trash" | undefined) =>
    persist(setNoteState(notes, id, st));
  const composeStats = noteStats(text);
  const statsOf = (n: Note) => noteStats(n.text);
  const chip = (m: "all" | "archived" | "trash", label: string, count: number) => (
    <button
      key={m}
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      className={
        "rounded-full px-3 py-1 text-xs " +
        (mode === m ? "bg-accent text-white" : "bg-neutral-300 dark:bg-neutral-700")
      }
    >
      {label} ({count})
    </button>
  );
  return (
    <div className="p-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder={t("note.placeholder")}
        className="mb-2 w-full resize-none rounded-2xl bg-black/5 p-3 text-sm text-neutral-900 outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:text-neutral-100 dark:ring-white/10 dark:placeholder:text-white/30"
      />
      <div className="flex items-center justify-between">
        <button onClick={add} className="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95">
          {t("note.add")}
        </button>
        <span className="text-[11px] opacity-50">
          {t("note.stats", { chars: String(composeStats.chars), lines: String(composeStats.lines) })}
        </span>
      </div>
      {mode === "all" && (
        <input
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          placeholder={t("note.search")}
          className="mt-2 w-full rounded-full bg-black/5 px-3.5 py-1.5 text-sm text-neutral-900 outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:text-neutral-100 dark:ring-white/10 dark:placeholder:text-white/30"
        />
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {chip("all", t("note.tabNotes"), notesOf(notes, undefined).length)}
        {chip("archived", t("note.tabArchived"), archived.length)}
        {chip("trash", t("note.tabTrash"), trashed.length)}
      </div>
      {mode === "all" && agg.notes > 0 && (
        <p className="mt-2 text-[11px] text-accent">
          {t("note.progressAgg", {
            done: String(agg.done),
            total: String(agg.total),
            notes: String(agg.notes),
          })}
        </p>
      )}
      <div className="mt-3 space-y-2">
        {view.length === 0 ? (
          <p className="py-6 text-center text-sm opacity-60">{t("note.empty")}</p>
        ) : (
          view.map((n) => (
            <div key={n.id} className="rounded-2xl bg-white/60 p-3 shadow-sm ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10">
              {editingThis(n.id) ? (
                <>
                  <textarea
                    value={editVal}
                    onChange={(e) => setEditVal(e.target.value)}
                    rows={3}
                    autoFocus
                    className="w-full resize-none rounded-xl bg-white/70 p-2 text-sm outline-none dark:bg-neutral-900/70"
                  />
                  {editTasks.length > 0 && (
                    <div className="mt-2 rounded-xl bg-white/50 p-2 dark:bg-neutral-900/50">
                      <div className="text-[11px] opacity-50">
                        {t("note.tasks")} · {editTasks.filter((tk) => tk.done).length}/
                        {editTasks.length}
                      </div>
                      {editTasks.map((tk, i) => (
                        <button
                          key={`${i}-${tk.label}`}
                          onClick={() => setEditVal(toggleTaskInText(editVal, i))}
                          className="flex w-full items-start gap-2 py-0.5 text-left text-sm"
                        >
                          <span className="mt-0.5">{tk.done ? "☑" : "☐"}</span>
                          <span className={tk.done ? "opacity-50 line-through" : ""}>
                            {tk.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 flex items-center justify-between text-[11px]">
                    <span className="opacity-60">{fmtTime(n.ts)}</span>
                    <div className="flex gap-2">
                      <button onClick={cancelEdit} className="opacity-70 hover:underline">
                        {t("note.cancel")}
                      </button>
                      <button onClick={saveEdit} className="text-accent font-semibold hover:underline">
                        {t("note.save")}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <p className="whitespace-pre-wrap text-sm">
                    {fmtInline(n.text).map((seg, i) =>
                      seg.bold ? (
                        <strong key={i} className="font-semibold">
                          {seg.text}
                        </strong>
                      ) : seg.hl ? (
                        <mark
                          key={i}
                          className="rounded bg-amber-200 px-0.5 dark:bg-amber-500/40"
                        >
                          {seg.text}
                        </mark>
                      ) : seg.link && seg.url ? (
                        <a
                          key={i}
                          href={seg.url}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all text-accent underline"
                        >
                          {seg.text}
                        </a>
                      ) : seg.strike ? (
                        <s key={i} className="opacity-60">
                          {seg.text}
                        </s>
                      ) : (
                        <Fragment key={i}>{seg.text}</Fragment>
                      ),
                    )}
                  </p>
                  {(() => {
                    const nt = tasksOf(n.text);
                    if (nt.length === 0) return null;
                    const sum = taskSummary(n.text);
                    return (
                      <div className="mt-1.5 rounded-xl bg-neutral-200/50 p-1.5 dark:bg-neutral-800/40">
                        <div className="flex flex-col">
                          {nt.map((tk, i) => (
                            <button
                              key={`${i}-${tk.label}`}
                              onClick={() => persist(toggleTaskInNote(notes, n.id, i))}
                              className="flex items-start gap-1.5 py-0.5 text-left text-sm"
                            >
                              <span className={tk.done ? "text-accent" : "opacity-50"}>{tk.done ? "☑" : "☐"}</span>
                              <span className={tk.done ? "text-neutral-400 line-through" : ""}>{tk.label}</span>
                            </button>
                          ))}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-accent">
                          <span>
                            {sum.done}/{sum.total} ✓
                          </span>
                          {sum.done < sum.total && (
                            <button
                              onClick={() => persist(completeAllTasks(notes, n.id))}
                              className="underline hover:text-neutral-900 dark:hover:text-white"
                            >
                              {t("note.completeAll")}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  <div className="mt-2 flex items-center justify-between text-[11px] opacity-60">
                    <span className="flex gap-1.5">
                      <span>{fmtTime(n.ts)}</span>
                      <span>
                        · {statsOf(n).chars} {t("note.chars")}
                      </span>
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {mode === "all" && (
                        <button
                          onClick={() => persist(togglePin(notes, n.id))}
                          title={t("note.pin")}
                          className={"hover:underline " + (n.pinned ? "text-amber-500" : "opacity-70")}
                        >
                          {n.pinned ? "★" : "☆"}
                        </button>
                      )}
                      {mode === "all" && (
                        <button onClick={() => setState(n.id, "archived")} className="hover:underline">
                          {t("note.archive")}
                        </button>
                      )}
                      {mode === "all" && (
                        <button onClick={() => beginEdit(n)} className="text-accent hover:underline">
                          {t("note.edit")}
                        </button>
                      )}
                      {(mode === "all" || mode === "archived") && (
                        <button onClick={() => setState(n.id, "trash")} className="text-danger hover:underline">
                          {t("note.delete")}
                        </button>
                      )}
                      {mode === "archived" && (
                        <button onClick={() => setState(n.id, undefined)} className="text-accent hover:underline">
                          {t("note.restore")}
                        </button>
                      )}
                      {mode === "trash" && (
                        <>
                          <button onClick={() => setState(n.id, undefined)} className="text-accent hover:underline">
                            {t("note.restore")}
                          </button>
                          <button onClick={() => persist(removeNote(notes, n.id))} className="text-danger hover:underline">
                            {t("note.deleteForever")}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

/* ---- Photos (grid album persisted via amos.photos + simple viewer) ---- */
const Photos: FC = () => {
  const { t } = useI18n();
  const [list, setList] = useState<Photo[]>(() => {
    const existing = normalizePhotos(readStoreValue<unknown>(PHOTOS_KEY, []));
    if (existing.length) return existing;
    const seed = seedPhotos(8, Date.now());
    writeStoreValue(PHOTOS_KEY, seed);
    return seed;
  });
  const [sel, setSel] = useState<Photo | null>(null);
  const [wallMsg, setWallMsg] = useState("");
  const [slide, setSlide] = useState(false);
  const [favOnly, setFavOnly] = useState(false);
  const persist = (l: Photo[]) => {
    writeStoreValue(PHOTOS_KEY, l);
    setList(l);
  };
  const shown = favOnly ? favsOf(list) : list;
  const add = () => persist([newPhoto(`p${Date.now()}`, Date.now()), ...list]);
  // Multi-select batch delete.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleSelectMode = () => {
    setSelected(new Set());
    setSelecting((s) => !s);
  };
  const deleteSelected = () => {
    if (selected.size === 0) return;
    persist(removePhotos(list, selected));
    setSelected(new Set());
    setSelecting(false);
  };
  // Arrow-key navigation inside the single-photo viewer (‹ / › shortcut).
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        const p = neighborOf(list, sel.id, -1);
        if (p) setSel(p);
      } else if (e.key === "ArrowRight") {
        const n = neighborOf(list, sel.id, 1);
        if (n) setSel(n);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, list]);

  const grad = (p: Photo): string | undefined =>
    p.a && p.b ? `linear-gradient(135deg, ${p.a}, ${p.b})` : undefined;

  // Slideshow: advance to the next photo on a timer while active.
  useEffect(() => {
    if (!slide || !sel) return;
    const id = setInterval(() => {
      setSel((cur) => neighborOf(list, cur?.id ?? "", 1) ?? cur);
    }, 2500);
    return () => clearInterval(id);
  }, [slide, sel, list]);

  if (sel) {
    const prev = neighborOf(list, sel.id, -1);
    const next = neighborOf(list, sel.id, 1);
    const idx = list.findIndex((p) => p.id === sel.id) + 1;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <div
          className="grid h-40 w-40 place-items-center overflow-hidden rounded-3xl text-7xl"
          style={{ background: grad(sel) ?? "#14161d" }}
        >
          {sel.data ? (
            <img src={sel.data} alt="" className="h-full w-full object-cover" />
          ) : (
            (sel.emoji ?? "")
          )}
        </div>
        <p className="text-xs opacity-60">{fmtTime(sel.ts)}</p>
        <div className="flex items-center gap-4">
          <button
            onClick={() => prev && setSel(prev)}
            disabled={!prev}
            aria-label={t("photo.prev")}
            className="h-9 w-9 rounded-full bg-neutral-300 text-lg dark:bg-neutral-700 disabled:opacity-30"
          >
            ‹
          </button>
          <span className="min-w-[3rem] text-center text-xs tabular-nums opacity-60">
            {idx} / {list.length}
          </span>
          <button
            onClick={() => next && setSel(next)}
            disabled={!next}
            aria-label={t("photo.next")}
            className="h-9 w-9 rounded-full bg-neutral-300 text-lg dark:bg-neutral-700 disabled:opacity-30"
          >
            ›
          </button>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => {
              const toggled = toggleFav(list, sel.id);
              persist(toggled);
              setSel(toggled.find((x) => x.id === sel.id) ?? sel);
            }}
            aria-label={t("photo.fav")}
            title={t("photo.fav")}
            className={chip(!!sel.fav, "lg")}
          >
            {sel.fav ? "♥" : "♡"}
          </button>
          {list.length > 1 && (
            <button
              onClick={() => setSlide((s) => !s)}
              className={chip(slide, "lg")}
            >
              {slide ? t("photo.slideStop") : t("photo.slidePlay")}
            </button>
          )}
          <button
            onClick={async () => {
              const txt = shareCaption(sel, fmtTime(sel.ts));
              try {
                await navigator.clipboard?.writeText(txt);
              } catch {
                /* clipboard unavailable → still show the confirmation */
              }
              setWallMsg(t("photo.shared"));
            }}
            className={btn("neutral", "lg")}
          >
            {t("photo.share")}
          </button>
          <button
            onClick={() => {
              setSlide(false);
              setSel(null);
            }}
            className={btn("neutral", "lg")}
          >
            {t("photo.close")}
          </button>
          {isRealPhoto(sel) && (
            <button
              onClick={() => {
                const cur = readStoreValue<Record<string, unknown>>("amos.settings", {});
                writeStoreValue("amos.settings", { ...cur, wallpaper: sel.data ?? "" });
                setWallMsg(t("photo.setWallpaperDone"));
              }}
              className={btn("neutral", "lg")}
            >
              {t("photo.setWallpaper")}
            </button>
          )}
          <button
            onClick={() => {
              persist(removePhoto(list, sel.id));
              setSel(null);
            }}
            className={btn("danger", "lg")}
          >
            {t("photo.delete")}
          </button>
        </div>
        {wallMsg && (
          <p role="status" className="text-xs opacity-70">
            {wallMsg}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="p-2">
      <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
        <button onClick={add} className={btn("accent", "lg")}>
          {t("photo.add")}
        </button>
        {list.length > 0 && (
          <button
            onClick={toggleSelectMode}
            className={chip(selecting, "lg")}
          >
            {selecting ? t("photo.cancel") : t("photo.select")}
          </button>
        )}
        {favsOf(list).length > 0 && (
          <div className="ml-auto flex gap-1">
            <button
              onClick={() => setFavOnly(false)}
              aria-pressed={!favOnly}
              className={chip(!favOnly, "md")}
            >
              {t("photo.all")} ({list.length})
            </button>
            <button
              onClick={() => setFavOnly(true)}
              aria-pressed={favOnly}
              className={chip(favOnly, "md")}
            >
              ♥ ({favsOf(list).length})
            </button>
          </div>
        )}
        {selecting && selected.size > 0 && (
          <button onClick={deleteSelected} className={btn("danger", "lg")}>
            {t("photo.deleteSelected", { n: selected.size })}
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <p className="py-10 text-center text-sm opacity-60">{t("photo.empty")}</p>
      ) : shown.length === 0 ? (
        <p className="py-10 text-center text-sm opacity-60">{t("photo.favEmpty")}</p>
      ) : (
        <div className="grid grid-cols-3 gap-1">
          {shown.map((p) => {
            const isSel = selecting && selected.has(p.id);
            return (
              <button
                key={p.id}
                onClick={() => (selecting ? toggleSelect(p.id) : setSel(p))}
                aria-label={p.emoji ?? p.id}
                className={
                  "relative grid aspect-square place-items-center overflow-hidden text-3xl " +
                  (isSel ? "ring-2 ring-accent ring-inset" : "")
                }
                style={{ background: grad(p) ?? "#1c1c1e" }}
              >
                {p.data ? (
                  <img src={p.data} alt="" className="absolute inset-0 h-full w-full object-cover" />
                ) : (
                  (p.emoji ?? "")
                )}
                {p.fav && !selecting && (
                  <span className="absolute left-1 top-1 text-xs drop-shadow">♥</span>
                )}
                {selecting && (
                  <span
                    className={
                      "absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold " +
                      (isSel ? "bg-accent text-white" : "bg-black/40 text-white/90")
                    }
                  >
                    {isSel ? "✓" : ""}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** Map of ported app id → React component. Unported ids fall back to a stub. */
const COMPONENTS: Record<string, FC> = {
  clock: Clock,
  settings: Settings,
  calculator: Calculator,
  weather: Weather,
  notes: Notes,
  photos: Photos,
  files: FilesApp,
  android: AndroidApp,
  messages: MessagesApp,
  phone: PhoneApp,
  music: MusicApp,
  maps: MapsApp,
  camera: CameraApp,
  ai: AiApp,
  interpreter: InterpApp,
  mail: MailApp,
  store: StoreApp,
  privacy: PermissionsApp,
  contacts: ContactsApp,
};

/** Get the component for an app id, or a "not ported yet" placeholder. */
export function AppComponent({ id }: { id: string }): ReturnType<FC> {
  if (isExtId(id)) return <ExtApp id={id} />;
  const Comp = COMPONENTS[id] ?? NotFound;
  return <Comp />;
}

const NotFound: FC = () => {
  const { t } = useI18n();
  return <div className="p-8 text-center text-sm opacity-60">{t("app.notFound")}</div>;
};

import { Fragment, useEffect, useReducer, useState, type FC } from "react";
import AndroidApp from "./components/AndroidApp";
import { MessagesApp, PhoneApp, MusicApp } from "./components/CommsApps";
import MapsApp from "./components/MapsApp";
import CameraApp from "./components/CameraApp";
import MagnifierApp from "./components/MagnifierApp";
import { AiApp, InterpApp } from "./components/BackendApps";
import MailApp from "./components/MailApp";
import StoreApp from "./components/StoreApp";
import RemindersApp from "./components/RemindersApp";
import ContactsApp from "./components/ContactsApp";
import VoiceMemosApp from "./components/VoiceMemosApp";
import ExtApp from "./components/ExtApp";
import { isExtId } from "./lib/storeApps";
import { useI18n } from "./i18n";
import { useTheme, type ThemeMode } from "./theme";
import Segmented from "./components/Segmented";
import { ClipboardTray } from "./components/ClipboardTray";
import { GROUP, ROW, LABEL, SUB, FIELD, Switch, chip, btn } from "./components/ui";
import { LockWallpaperCard, WallpaperCard } from "./components/Wallpaper";
import LockSettings from "./components/LockSettings";
import SensorPanel from "./components/SensorPanel";
import SystemPanel from "./components/SystemPanel";
import TaskManager from "./components/TaskManager";
import LmkDebugPanel from "./components/LmkDebugPanel";
import { SETTINGS_KEY, BACKUP_KEY, SYNC_STORES, readCloud, setCloudPrefs, snapshotStores, type CloudPrefs } from "./lib/cloud";
import { readAiConfig, setAiConfig, DEEPSEEK_MODEL, DEEPSEEK_ENDPOINT, type AiProviderId } from "./lib/providers";
import { describeEngine, type EngineView } from "./lib/aiEngine";
import type { Locale } from "./i18n/types";
import { zoneClock, stopwatchInit, stopwatchReducer, fmtStopwatch, timerInit, timerReducer, fmtCountdown, alarmsReducer, alarmInit, ringingAlarms, normalizeAlarms, normalizeWorldCities, removeWorldCity, addWorldCity, WORLD_CITY_PRESETS, defaultWorldCities, lapDeltas, fastestLap, type WorldCity } from "./lib/time";
import { readStoreValue, writeStoreValue } from "./lib/amosStore";
import { AUTOOFF_STORE_KEY, clampAutoOffSec, WAKE_HOME_KEY, wakeHomeEnabled } from "./lib/display";
import { bridged, getAiStatus, switchAiBackend, exportTxtFile } from "./lib/backend";
import { clipboardRead, clipboardWrite, entryText } from "./lib/clipboard";
import { NOTES_KEY, prependNote, removeNote, editNote, togglePin, orderPinned, setNoteState, notesOf, searchNotes, fmtTime, normalizeNotes, noteStats, tasksOf, toggleTaskInText, toggleTaskInNote, taskSummary, completeAllTasks, noteListProgress, fmtInline, hasTag, tagsOf, setManyState, setPinned, removeMany, exportBaseName, noteExportText, type Note } from "./lib/notes";
import { noteTitle, notePreview, noteDayOf } from "./lib/notes";
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
import {
  listCaptures,
  captureBlob,
  removeVideoCapture,
  toggleCaptureFav,
  resLabelOf,
  type VideoCapture,
} from "./lib/cameraCapture";
import VideoThumb from "./components/VideoThumb";
import SvelteAppHost from "./components/SvelteAppHost";

export { APP_META as APPS, appIcon, appTitleKey } from "./lib/appMeta";
export type { AppMeta } from "./lib/appMeta";

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
  // Auto screen-off timeout (seconds as a string for the segmented control;
  // "0" = off). Written to the shared store so the Shell's reactive watcher
  // re-arms immediately.
  const [autoOffStr, setAutoOffStr] = useState(() =>
    String(clampAutoOffSec(readStoreValue<unknown>(AUTOOFF_STORE_KEY, 0))),
  );
  const pickAutoOff = (v: string) => {
    writeStoreValue(AUTOOFF_STORE_KEY, Number(v));
    setAutoOffStr(v);
  };
  // Return to the dock home page when the display wakes (default ON). Reactive-ish:
  // written to the shared store so the Shell's wake policy picks it up live.
  const [wakeHome, setWakeHome] = useState(() =>
    wakeHomeEnabled(readStoreValue<unknown>(WAKE_HOME_KEY, true)),
  );
  const toggleWakeHome = () => {
    const next = !wakeHome;
    setWakeHome(next);
    writeStoreValue(WAKE_HOME_KEY, next);
  };
  // Truthful engine/ASR snapshot from get_status (engine + degraded + asr).
  const [aiView, setAiView] = useState<EngineView>({
    engine: "",
    engine_model: "",
    degraded: false,
    asr: "",
    accelerator: "",
    profile: null,
  });
  // Show the *actual* model the daemon is serving right now (real get_status).
  useEffect(() => {
    if (!bridged()) return;
    getAiStatus().then((s) => {
      const m = s?.model && s.model.trim() ? s.model : "offline";
      setAiLive(m);
      setAiView(describeEngine(s));
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
          setAiView(describeEngine(s));
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
        <div className={SUB} />
        <div className={ROW}>
          <span className={LABEL}>{t("settings.autoOff")}</span>
          <Segmented
            value={autoOffStr}
            options={[
              { value: "0", label: t("settings.autoOffOff") },
              { value: "15", label: t("settings.autoOff15") },
              { value: "30", label: t("settings.autoOff30") },
              { value: "60", label: t("settings.autoOff60") },
            ]}
            onChange={pickAutoOff}
            ariaLabel="auto-screen-off"
          />
        </div>
        <div className={SUB} />
        <div className={ROW}>
          <span className={LABEL}>{t("settings.wakeHome")}</span>
          <Switch on={wakeHome} onToggle={toggleWakeHome} label={t("settings.wakeHome")} />
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
        {aiView.engine && (
          <p className="mt-0.5 text-[11px] opacity-70">
            {aiView.engine === "mock"
              ? t("settings.aiMockEngine")
              : t("settings.aiRealEngine", {
                  engine: aiView.engine,
                  model: aiView.engine_model || aiView.engine,
                })}
          </p>
        )}
        {aiView.asr && (
          <p className="text-[11px] opacity-60">{t("settings.aiAsr", { asr: aiView.asr })}</p>
        )}
        {aiView.accelerator && (
          <p className="text-[11px] opacity-60">{t("settings.aiAccel", { accel: aiView.accelerator })}</p>
        )}
        {aiView.degraded && (
          <p
            role="alert"
            className="mt-2 rounded-md bg-red-500/15 px-2 py-1 text-[11px] font-medium text-red-700 dark:text-red-300"
          >
            {t("settings.aiDegraded")}
          </p>
        )}
        {aiView.profile && aiView.profile.decode_runs > 0 && (
          <div className="mt-2 rounded-md bg-black/5 px-2 py-1.5 text-[11px] opacity-80 dark:bg-white/10">
            <span className="font-medium opacity-70">{t("settings.aiProfile")}</span>
            <span className="ml-2">
              {t("settings.aiProfileTps", { v: aiView.profile.decode_tokens_per_sec.toFixed(1) })}
            </span>
            <span className="ml-2">
              {t("settings.aiProfileTtft", { v: aiView.profile.ttft_ms.toFixed(0) })}
            </span>
            <span className="ml-2">
              {t("settings.aiProfileTokens", { v: String(aiView.profile.decode_tokens_total) })}
            </span>
          </div>
        )}
      </section>

      <SensorPanel />
      <SystemPanel />
      <TaskManager />
      <LmkDebugPanel />
      <WallpaperCard />
      <LockWallpaperCard />
      <LockSettings />
      <p className="px-1 text-xs opacity-50">mode={mode} · dark={String(dark)} · locale={locale}</p>
    </div>
  );
};

/* ---- Svelte migration seam (React → Svelte) ----
 * Each migrated screen keeps its long-standing React implementation as the
 * reference + bun-test path (the happy-dom suite has no .svelte loader) and is
 * A/B-validated on-device through `SvelteAppHost`, which mounts the .svelte app
 * inside the React shell. Routing:
 *   • production build (`vite build`, what Tauri ships to a device) → Svelte;
 *   • `vite dev` + the bun test suite → React, unless opted in below, so CI and
 *     fast local iteration stay on the loader-free path.
 * This lets each Svelte port be validated before the React body is deleted. */
export function svelteEnabled(): boolean {
  try {
    // `import.meta.env.PROD` is only defined by Vite; absent under bun (→ React).
    const env = (import.meta as { env?: { PROD?: boolean } }).env;
    if (env?.PROD) return true;
  } catch {
    /* non-Vite runtime */
  }
  try {
    // dev opt-in: localStorage.setItem("amos.ui.svelteCalc", "1")
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("amos.ui.svelteCalc") === "1"
    );
  } catch {
    return false;
  }
}

// Stable module-level loaders (identity must not change per render — the host
// mounts once per loader identity).
const loadCalculator = () => import("./svelte/CalculatorApp.svelte");
const loadWeather = () => import("./svelte/WeatherApp.svelte");
const loadContacts = () => import("./svelte/ContactsApp.svelte");
const loadPermissions = () => import("./svelte/PermissionsApp.svelte");
const loadClock = () => import("./svelte/ClockApp.svelte");
const loadMessages = () => import("./svelte/MessagesApp.svelte");
const loadMusic = () => import("./svelte/MusicApp.svelte");
const loadNotes = () => import("./svelte/NotesApp.svelte");
const loadFiles = () => import("./svelte/FilesApp.svelte");
const loadPhotos = () => import("./svelte/PhotosApp.svelte");
const loadPhone = () => import("./svelte/PhoneApp.svelte");
const loadReminders = () => import("./svelte/RemindersApp.svelte");
const loadMail = () => import("./svelte/MailApp.svelte");
const loadSettings = () => import("./svelte/SettingsApp.svelte");
const loadMaps = () => import("./svelte/MapsApp.svelte");
const loadVmem = () => import("./svelte/VoiceMemosApp.svelte");
const loadMagnifier = () => import("./svelte/MagnifierApp.svelte");
const loadAndroid = () => import("./svelte/AndroidApp.svelte");
const loadStore = () => import("./svelte/StoreApp.svelte");
const loadCamera = () => import("./svelte/CameraApp.svelte");
const loadInterp = () => import("./svelte/InterpApp.svelte");
const loadAi = () => import("./svelte/AiApp.svelte");
const loadMonitor = () => import("./svelte/MonitorApp.svelte");

const CalculatorEntry: FC = () => <SvelteAppHost load={loadCalculator} />;

const WeatherEntry: FC = () => <SvelteAppHost load={loadWeather} />;

const ContactsEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadContacts} /> : <ContactsApp />;

const PermissionsEntry: FC = () => <SvelteAppHost load={loadPermissions} />;

const ClockEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadClock} /> : <Clock />;

const MessagesEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadMessages} /> : <MessagesApp />;

const MusicEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadMusic} /> : <MusicApp />;

const NotesEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadNotes} /> : <Notes />;

const FilesEntry: FC = () => <SvelteAppHost load={loadFiles} />;

const PhotosEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadPhotos} /> : <Photos />;

const PhoneEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadPhone} /> : <PhoneApp />;

const RemindersEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadReminders} /> : <RemindersApp />;

const MailEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadMail} /> : <MailApp />;

const SettingsEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadSettings} /> : <Settings />;

const MapsEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadMaps} /> : <MapsApp />;

const VmemosEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadVmem} /> : <VoiceMemosApp />;

const MagnifierEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadMagnifier} /> : <MagnifierApp />;

const AndroidEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadAndroid} /> : <AndroidApp />;

const StoreEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadStore} /> : <StoreApp />;

const CameraEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadCamera} /> : <CameraApp />;

const InterpEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadInterp} /> : <InterpApp />;

const AiEntry: FC = () =>
  svelteEnabled() ? <SvelteAppHost load={loadAi} /> : <AiApp />;

const MonitorEntry: FC = () => <SvelteAppHost load={loadMonitor} />;

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
    const now = Date.now();
    const next = prependNote(notes, v, now);
    persist(next);
    setOpenId(next[0]?.id ?? null); // reveal the freshly added note (iOS list → detail)
    setText("");
  };
  // Edit existing note: one note at a time, saves bump ts; blank/cancel reverts.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [trayOpen, setTrayOpen] = useState(false);
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
  // Copy the note body onto the AmOS global clipboard (works from any window).
  const copyEditing = async () => {
    if (!editingId) return;
    await clipboardWrite({ kind: "text", text: editVal });
  };
  // Paste the newest AmOS-clipboard text into the note editor (foreground-gated on
  // the Rust side: only works when this window is focused). Non-text payloads no-op.
  const pasteEditing = async () => {
    const e = await clipboardRead();
    const text = e ? entryText(e) : "";
    if (!text) return;
    setEditVal((v) => (v && v.trim() ? `${v}\n${text}` : text));
  };
  const editingThis = (id: string) => editingId === id;
  const editTasks = tasksOf(editVal);
  const [mode, setMode] = useState<"all" | "archived" | "trash">("all");
  const [searchQ, setSearchQ] = useState("");
  const [exportMsg, setExportMsg] = useState("");
  const doExportOne = async (n: Note) => {
    const name = exportBaseName(new Date());
    const text = noteExportText([n]);
    const res = await exportTxtFile(name, text);
    if (res?.path) {
      setExportMsg(`${t("note.exportedTo")} ${res.name}`);
    } else {
      try {
        await clipboardWrite({ kind: "text", text });
      } catch {
        /* clipboard unavailable — message still informs */
      }
      setExportMsg(t("note.exportCopied"));
    }
  };
  // Which note is expanded (its full body/editor is shown). Task lists & the
  // note being edited stay expanded so checklists are always actionable.
  const [openId, setOpenId] = useState<string | null>(null);
  // Active #tag filter (lowercased name, no '#') — chips below the list filters.
  const [selTag, setSelTag] = useState<string | null>(null);
  const activeAll = orderPinned(searchNotes(notesOf(notes, undefined), mode === "all" ? searchQ : ""));
  // Tags present in the current "all" list, with counts + first-written display name.
  const tagRow = (() => {
    const map = new Map<string, { name: string; count: number }>();
    for (const n of activeAll)
      for (const tg of tagsOf(n.text)) {
        const k = tg.toLowerCase();
        const e = map.get(k);
        if (e) e.count += 1;
        else map.set(k, { name: tg, count: 1 });
      }
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  })();
  const active = selTag ? activeAll.filter((n) => hasTag(n.text, selTag)) : activeAll;
  const archived = notesOf(notes, "archived");
  const trashed = notesOf(notes, "trash");
  const agg = noteListProgress(notesOf(notes, undefined));
  const view = mode === "all" ? active : mode === "archived" ? archived : trashed;
  const setState = (id: string, st: "archived" | "trash" | undefined) =>
    persist(setNoteState(notes, id, st));
  // Multi-select batch mode (archive / trash / restore / delete / pin).
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectedInView = new Set([...selected].filter((id) => view.some((n) => n.id === id)));
  const toggleSel = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const exitSelect = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const selectAllInView = () => {
    const ids = view.map((n) => n.id);
    setSelected((prev) =>
      ids.length > 0 && ids.every((id) => prev.has(id)) ? new Set() : new Set(ids),
    );
  };
  const runBatch = (next: Note[]) => {
    persist(next);
    exitSelect();
  };
  const selIds = [...selectedInView];
  const batchArch = () => runBatch(setManyState(notes, selIds, "archived"));
  const batchTrash = () => runBatch(setManyState(notes, selIds, "trash"));
  const batchRestore = () => runBatch(setManyState(notes, selIds, undefined));
  const batchDelete = () => runBatch(removeMany(notes, selIds));
  const batchPin = () => runBatch(setPinned(notes, selIds, true));
  const selectRow = (n: Note) => {
    const on = selected.has(n.id);
    return (
      <button
        key={n.id}
        onClick={() => toggleSel(n.id)}
        aria-pressed={on}
        className={
          "block w-full rounded-2xl p-3 text-left shadow-sm ring-1 transition active:scale-[0.99] " +
          (on
            ? "bg-accent/15 ring-accent dark:bg-accent/20"
            : "bg-white/60 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10")
        }
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={
              "grid h-5 w-5 shrink-0 place-items-center rounded-full text-[12px] " +
              (on ? "bg-accent text-white" : "border border-black/20 text-transparent dark:border-white/40")
            }
          >
            ✓
          </span>
          <span className="truncate text-[15px] font-medium">{noteTitle(n.text) || t("note.untitled")}</span>
        </div>
      </button>
    );
  };
  const composeStats = noteStats(text);
  const statsOf = (n: Note) => noteStats(n.text);
  const chip = (m: "all" | "archived" | "trash", label: string, count: number) => (
    <button
      key={m}
      onClick={() => {
        setMode(m);
        if (m !== "all") setSelTag(null);
        // Multi-select is scoped to one tab: leave select mode when switching views.
        setSelecting(false);
        setSelected(new Set());
      }}
      aria-pressed={mode === m}
      className={
        "rounded-full px-3 py-1 text-xs " +
        (mode === m ? "bg-accent text-white" : "bg-neutral-300 dark:bg-neutral-700")
      }
    >
      {label} ({count})
    </button>
  );
  /** True when a note should render as a compact (collapsed) iOS-style row:
   *  plain notes that aren't open or being edited. Checklist notes stay open so
   *  their boxes are actionable. */
  const collapsed = (n: Note) => !editingThis(n.id) && openId !== n.id && tasksOf(n.text).length === 0;
  /** iOS-style collapsed list row: bold title, preview snippet, relative time,
   *  plus pin / checklist markers. Tapping expands the full body. */
  const noteRow = (n: Note) => {
    const dd = noteDayOf(n.ts, Date.now());
    const dt = new Date(n.ts);
    const stamp =
      dd === 0
        ? fmtTime(n.ts)
        : dd === -1
          ? t("note.yesterday")
          : dt.getFullYear() === new Date().getFullYear()
            ? `${dt.getMonth() + 1}/${dt.getDate()}`
            : `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
    const title = noteTitle(n.text);
    const prev = notePreview(n.text);
    const sum = taskSummary(n.text);
    return (
      <button
        key={n.id}
        onClick={() => setOpenId(n.id)}
        className="block w-full rounded-2xl bg-white/60 p-3 text-left shadow-sm ring-1 ring-black/5 transition active:bg-white/80 dark:bg-white/[0.06] dark:ring-white/10"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="truncate text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
            {title || t("note.untitled")}
          </span>
          <span className="shrink-0 pt-0.5 text-[10px] text-neutral-500">{stamp}</span>
        </div>
        {prev && (
          <p className="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{prev}</p>
        )}
        <div className="mt-1 flex items-center gap-2 text-[10px] text-neutral-500">
          {mode === "all" && n.pinned && <span className="text-amber-500">📌</span>}
          {sum.total > 0 && (
            <span className="text-accent">
              ☑ {sum.done}/{sum.total}
            </span>
          )}
          <span className="ml-auto text-accent">{t("note.open")}</span>
        </div>
      </button>
    );
  };
  return (
    <div className="p-4">
      {exportMsg && (
        <p role="status" className="mb-2 rounded-lg bg-black/5 px-3 py-1.5 text-xs text-accent dark:bg-white/10">
          {exportMsg}
        </p>
      )}
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
      {mode === "all" && (tagRow.length > 0 || selTag) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {selTag && (
            <button
              onClick={() => setSelTag(null)}
              className="rounded-full px-2.5 py-0.5 text-[11px] text-accent ring-1 ring-accent/50"
              aria-pressed
              title={t("note.clearTag")}
            >
              #{selTag} ✕
            </button>
          )}
          {tagRow.map((tg) => {
            const activeChip = selTag === tg.name.toLowerCase();
            return (
              <button
                key={tg.name.toLowerCase()}
                onClick={() => setSelTag(activeChip ? null : tg.name.toLowerCase())}
                aria-pressed={activeChip}
                className={
                  "rounded-full px-2.5 py-0.5 text-[11px] " +
                  (activeChip
                    ? "bg-accent text-white"
                    : "bg-black/5 text-accent ring-1 ring-accent/40 dark:bg-white/10")
                }
              >
                #{tg.name} ({tg.count})
              </button>
            );
          })}
        </div>
      )}
      {mode === "all" && agg.notes > 0 && (
        <p className="mt-2 text-[11px] text-accent">
          {t("note.progressAgg", {
            done: String(agg.done),
            total: String(agg.total),
            notes: String(agg.notes),
          })}
        </p>
      )}
      {(selecting || view.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {selecting ? (
            <>
              <span className="mr-1 text-xs opacity-70">已选 {selectedInView.size}</span>
              <button
                onClick={selectAllInView}
                className="rounded-full bg-black/5 px-3 py-1 text-xs dark:bg-white/10"
              >
                {t("note.selectAll")}
              </button>
              {mode === "all" && (
                <>
                  <button
                    disabled={selectedInView.size === 0}
                    onClick={batchPin}
                    className="rounded-full bg-black/5 px-3 py-1 text-xs disabled:opacity-30 dark:bg-white/10"
                  >
                    ★ {t("note.pin")}
                  </button>
                  <button
                    disabled={selectedInView.size === 0}
                    onClick={batchArch}
                    className="rounded-full bg-black/5 px-3 py-1 text-xs disabled:opacity-30 dark:bg-white/10"
                  >
                    {t("note.archive")}
                  </button>
                  <button
                    disabled={selectedInView.size === 0}
                    onClick={batchTrash}
                    className="rounded-full bg-black/5 px-3 py-1 text-xs disabled:opacity-30 dark:bg-white/10"
                  >
                    {t("note.delete")}
                  </button>
                </>
              )}
              {mode === "archived" && (
                <>
                  <button
                    disabled={selectedInView.size === 0}
                    onClick={batchRestore}
                    className="rounded-full bg-black/5 px-3 py-1 text-xs disabled:opacity-30 dark:bg-white/10"
                  >
                    {t("note.restore")}
                  </button>
                  <button
                    disabled={selectedInView.size === 0}
                    onClick={batchTrash}
                    className="rounded-full bg-black/5 px-3 py-1 text-xs disabled:opacity-30 dark:bg-white/10"
                  >
                    {t("note.delete")}
                  </button>
                </>
              )}
              {mode === "trash" && (
                <>
                  <button
                    disabled={selectedInView.size === 0}
                    onClick={batchRestore}
                    className="rounded-full bg-black/5 px-3 py-1 text-xs disabled:opacity-30 dark:bg-white/10"
                  >
                    {t("note.restore")}
                  </button>
                  <button
                    disabled={selectedInView.size === 0}
                    onClick={batchDelete}
                    className="rounded-full bg-red-500/15 px-3 py-1 text-xs text-danger disabled:opacity-30"
                  >
                    {t("note.deleteForever")}
                  </button>
                </>
              )}
              <button onClick={exitSelect} className="ml-auto text-xs text-accent">
                {t("note.done")}
              </button>
            </>
          ) : (
            <button
              onClick={() => setSelecting(true)}
              className="ml-auto rounded-full bg-black/5 px-3 py-1 text-xs dark:bg-white/10"
            >
              {t("note.select")}
            </button>
          )}
        </div>
      )}
      <div className="mt-3 space-y-2">
        {view.length === 0 ? (
          <p className="py-6 text-center text-sm opacity-60">{t("note.empty")}</p>
        ) : (
          view.map((n) => {
            if (selecting) return selectRow(n);
            if (collapsed(n)) return noteRow(n);
            return (
            <div key={n.id} className="rounded-2xl bg-white/60 p-3 shadow-sm ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10">
              {!editingThis(n.id) && !collapsed(n) && tasksOf(n.text).length === 0 && (
                <div className="mb-1 flex justify-end">
                  <button
                    onClick={() => setOpenId(null)}
                    className="text-[11px] text-accent"
                    aria-label={t("note.collapse")}
                  >
                    ⌃ {t("note.collapse")}
                  </button>
                </div>
              )}
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
                      <button
                        onClick={() => void copyEditing()}
                        aria-label="Copy to AmOS clipboard"
                        title="复制到系统剪贴板"
                        className="opacity-70 hover:opacity-100"
                      >
                        ⧉
                      </button>
                      <button
                        onClick={() => void pasteEditing()}
                        aria-label="Paste from AmOS clipboard"
                        title="从系统剪贴板粘贴（需前台窗口）"
                        className="opacity-70 hover:opacity-100"
                      >
                        📋
                      </button>
                      <button
                        onClick={() => setTrayOpen((o) => !o)}
                        aria-label="Clipboard history"
                        aria-pressed={trayOpen}
                        title="剪贴板历史"
                        className="opacity-70 hover:opacity-100"
                      >
                        🕘
                      </button>
                      <button onClick={cancelEdit} className="opacity-70 hover:underline">
                        {t("note.cancel")}
                      </button>
                      <button onClick={saveEdit} className="text-accent font-semibold hover:underline">
                        {t("note.save")}
                      </button>
                    </div>
                  </div>
                  {trayOpen && (
                    <div className="relative mt-2">
                      <ClipboardTray
                        open
                        onClose={() => setTrayOpen(false)}
                        onPick={(e) => {
                          const pasted = entryText(e);
                          if (!pasted) return;
                          setEditVal((v) => (v && v.trim() ? `${v}\n${pasted}` : pasted));
                          setTrayOpen(false);
                        }}
                      />
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="whitespace-pre-wrap text-sm">
                    {fmtInline(n.text).map((seg, i) =>
                      seg.tag ? (
                        <button
                          type="button"
                          key={i}
                          onClick={() => {
                            setMode("all");
                            setSelTag(seg.text.slice(1).toLowerCase());
                          }}
                          className="text-accent font-medium underline decoration-accent/40 underline-offset-2"
                        >
                          {seg.text}
                        </button>
                      ) : seg.bold ? (
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
                      <button
                        onClick={() => void doExportOne(n)}
                        title={t("note.export")}
                        className="hover:underline"
                      >
                        ↧ {t("note.export")}
                      </button>
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
            );
          })
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
  // Video captures (from the camera) live in amos.captures + the binary MediaStore;
  // they join this gallery as playable tiles alongside stills.
  const [vids, setVids] = useState<VideoCapture[]>(() => listCaptures());
  const [playId, setPlayId] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState("");
  const fmtLen = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
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

  const openVideo = async (id: string) => {
    setPlayId(id);
    const blob = await captureBlob(id);
    if (blob) {
      try {
        if (typeof URL !== "undefined" && URL.createObjectURL) setPlayUrl(URL.createObjectURL(blob));
      } catch {
        /* object URLs unavailable (headless) — show a spinner */
      }
    }
  };
  const closeVideo = () => {
    if (playUrl) URL.revokeObjectURL(playUrl);
    setPlayUrl("");
    setPlayId(null);
  };
  const deleteVideo = async (id: string) => {
    await removeVideoCapture(id);
    setVids(listCaptures());
    closeVideo();
  };
  // Videos appear in the gallery only outside multi-select and the favourites filter.
  const showVideos = vids.length > 0 && !selecting && !favOnly;
  // Interleave stills + camera videos newest-first.
  const gallery: ({ kind: "photo"; p: Photo } | { kind: "video"; v: VideoCapture })[] = [];
  for (const p of shown) gallery.push({ kind: "photo", p });
  if (showVideos) for (const v of vids) gallery.push({ kind: "video", v });
  gallery.sort((a, b) => (b.kind === "photo" ? b.p.ts : b.v.ts) - (a.kind === "photo" ? a.p.ts : a.v.ts));

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
          {gallery.map((it) => {
            if (it.kind === "video") {
              const v = it.v;
              return (
                <div key={`v-${v.id}`} className="relative aspect-square overflow-hidden bg-black text-4xl">
                  <button
                    aria-label="video"
                    onClick={() => void openVideo(v.id)}
                    className="absolute inset-0 grid h-full w-full place-items-center"
                  >
                    <span className="opacity-90">🎬</span>
                    <VideoThumb id={v.id} />
                    <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] tabular-nums text-white">
                      {fmtLen(v.durationMs)}
                    </span>
                    {resLabelOf(v) && (
                      <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[9px] font-medium text-white">
                        {resLabelOf(v)}
                      </span>
                    )}
                  </button>
                  <button
                    aria-label="favourite video"
                    onClick={() => setVids(toggleCaptureFav(v.id))}
                    className="absolute right-1 top-1 z-10 grid h-6 w-6 place-items-center rounded-full bg-black/45 text-xs text-white"
                  >
                    {v.fav ? "♥" : "♡"}
                  </button>
                </div>
              );
            }
            const p = it.p;
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
      {/* video playback overlay (camera captures shown in the gallery) */}
      {playId && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/85 px-4">
          <div className="w-full max-w-lg">
            {playUrl ? (
              <video src={playUrl} controls autoPlay playsInline className="max-h-[70vh] w-full rounded-xl" />
            ) : (
              <div className="grid h-40 w-full place-items-center text-white/50">…</div>
            )}
            <div className="mt-2 text-center text-xs text-white/80">
              {(() => {
                const cap = vids.find((x) => x.id === playId);
                if (!cap) return null;
                const res = resLabelOf(cap);
                return `${fmtLen(cap.durationMs)}${res ? ` · ${res}` : ""}`;
              })()}
            </div>
            <div className="mt-3 flex flex-col items-center gap-2">
              {wallMsg && <p role="status" className="text-xs text-white/80">{wallMsg}</p>}
              <div className="flex items-center justify-between gap-3 self-stretch">
                <button
                  onClick={closeVideo}
                  className="rounded-full bg-white/15 px-5 py-1.5 text-sm text-white ring-1 ring-white/25"
                >
                  ✕
                </button>
                <button
                  onClick={() => {
                    const cap = vids.find((x) => x.id === playId);
                    if (!cap) return;
                    try {
                      navigator.clipboard?.writeText(
                        `🎬 ${fmtLen(cap.durationMs)} · ${new Date(cap.ts).toLocaleString()}`,
                      );
                    } catch {
                      /* clipboard unavailable */
                    }
                    setWallMsg(t("photo.shared"));
                  }}
                  className="rounded-full bg-white/15 px-4 py-1.5 text-sm text-white ring-1 ring-white/25"
                >
                  {t("photo.share")}
                </button>
                <button
                  onClick={() => void deleteVideo(playId!)}
                  className="rounded-full bg-danger/90 px-4 py-1.5 text-sm text-white"
                >
                  {t("photo.delete")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/** Map of ported app id → React component. Unported ids fall back to a stub. */
const COMPONENTS: Record<string, FC> = {
  clock: ClockEntry,
  settings: SettingsEntry,
  calculator: CalculatorEntry,
  weather: WeatherEntry,
  notes: NotesEntry,
  reminders: RemindersEntry,
  vmemos: VmemosEntry,
  photos: PhotosEntry,
  files: FilesEntry,
  android: AndroidEntry,
  messages: MessagesEntry,
  phone: PhoneEntry,
  music: MusicEntry,
  maps: MapsEntry,
  camera: CameraEntry,
  ai: AiEntry,
  interpreter: InterpEntry,
  mail: MailEntry,
  store: StoreEntry,
  privacy: PermissionsEntry,
  contacts: ContactsEntry,
  magnifier: MagnifierEntry,
  monitor: MonitorEntry,
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

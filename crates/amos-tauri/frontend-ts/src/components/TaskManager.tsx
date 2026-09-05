import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  appIsRunning,
  normalizeTaskSnapshot,
  taskmgrAppAction,
  taskmgrJobAction,
  taskmgrSnapshot,
  type AppAction,
  type TaskApp,
  type TaskSnapshot,
} from "../lib/taskmgr";
import { GROUP, ROW, LABEL } from "./ui";

/** Actions offered for an app given its current lifecycle state. */
function actionsFor(a: TaskApp): [AppAction, string][] {
  const acts: [AppAction, string][] = [];
  if (a.state !== "foreground" && a.state !== "unknown") {
    acts.push(["foreground", "settings.taskForeground"]);
  }
  if (a.state === "foreground") acts.push(["background", "settings.taskBackground"]);
  if (a.state === "background") acts.push(["freeze", "settings.taskFreeze"]);
  if (appIsRunning(a)) acts.push(["stop", "settings.taskStop"]);
  acts.push(["kill", "settings.taskKill"]);
  return acts;
}

/**
 * Task Manager tile (desktop): drives the daemon's shared resource-governor
 * (Register/Move/Unregister over the GovernorService) — lists its apps with
 * freeze/background/stop/kill/resume actions and its scheduled jobs (which can be
 * cancelled). Hidden when the governor has nothing registered or the daemon is
 * absent (no broken card). Honest boundary: run-now is not exposed — the governor
 * has no force-run RPC yet.
 */
/** Live auto-refresh cadence while there is registry content to show. */
const REFRESH_MS = 3000;

export default function TaskManager() {
  const { t } = useI18n();
  const [snap, setSnap] = useState<TaskSnapshot>(() => normalizeTaskSnapshot(null));
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const refresh = () => {
    if (busyRef.current) return; // never overlap an in-flight read/action
    busyRef.current = true;
    setBusy(true);
    taskmgrSnapshot()
      .then((s) => {
        if (s) setSnap(normalizeTaskSnapshot(s));
      })
      .catch(() => {
        /* daemon offline → keep previous / nothing */
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };

  const act = (id: string, action: AppAction) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    taskmgrAppAction(id, action)
      .then((s) => {
        if (s) setSnap(normalizeTaskSnapshot(s));
      })
      .catch(() => {
        /* daemon offline */
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };

  const actJob = (id: string, action: "cancel") => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    taskmgrJobAction(id, action)
      .then((s) => {
        if (s) setSnap(normalizeTaskSnapshot(s));
      })
      .catch(() => {
        /* daemon offline */
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };

  const hasAny = snap.apps.length > 0 || snap.jobs.length > 0 || snap.decision !== null;

  // Localize the governor mode via the same keys as SystemPanel / the energy-mode
  // buttons; unknown modes stay raw.
  const modeLabel = (m: string): string =>
    m === "balanced"
      ? t("settings.sensorBalanced")
      : m === "performance"
        ? t("settings.sensorPerformance")
        : m === "power_save"
          ? t("settings.sensorPowerSave")
          : m;

  // Initial read on mount.
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live auto-refresh while there is content (the daemon beat can freeze/thaw/expire
  // apps over time). Only starts once content appears, so offline tests never spin
  // up a timer; cleared on unmount / when content disappears.
  useEffect(() => {
    if (!hasAny) return undefined;
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAny]);

  if (!hasAny) return null;

  return (
    <section className={GROUP}>
      <div className={ROW}>
        <span className={LABEL}>{t("settings.task")}</span>
        <button
          onClick={refresh}
          disabled={busy}
          className="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-40 dark:bg-white/10"
        >
          {t("settings.taskRefresh")}
        </button>
      </div>

      {snap.decision && (
        <p className="px-4 py-1 text-xs opacity-70">
          {t("settings.taskDecision", {
            mode: modeLabel(snap.decision.mode),
            reason: snap.decision.reason,
          })}
        </p>
      )}

      <div className="grid grid-cols-1 gap-1 border-t border-black/5 px-4 py-3 text-xs dark:border-white/10">
        <p className="font-semibold opacity-80">{t("settings.taskApps")}</p>
        {snap.apps.length === 0 ? (
          <p className="opacity-50">{t("settings.taskEmpty")}</p>
        ) : (
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {snap.apps.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="truncate">{a.id}</span>
                  <span className="ml-2 opacity-50">{a.state}</span>
                </span>
                <span className="flex flex-wrap gap-1">
                  {actionsFor(a).map(([action, key]) => (
                    <button
                      key={action}
                      onClick={() => act(a.id, action)}
                      disabled={busy}
                      className="rounded-full bg-black/5 px-2 py-0.5 active:scale-95 disabled:opacity-40 dark:bg-white/10"
                    >
                      {t(key as "settings.taskKill")}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-2 font-semibold opacity-80">{t("settings.taskJobs")}</p>
        {snap.jobs.length === 0 ? (
          <p className="opacity-50">{t("settings.taskEmpty")}</p>
        ) : (
          <ul className="max-h-32 space-y-0.5 overflow-y-auto">
            {snap.jobs.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{j.id}</span>
                <span className="flex items-center gap-2">
                  <span className="opacity-60">
                    {j.kind} [{j.earliest}→{j.latest}]
                  </span>
                  <button
                    onClick={() => actJob(j.id, "cancel")}
                    disabled={busy}
                    className="rounded-full bg-black/5 px-2 py-0.5 active:scale-95 disabled:opacity-40 dark:bg-white/10"
                  >
                    {t("settings.taskCancel")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

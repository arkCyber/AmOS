import { useEffect, useRef, useState } from "react";
import { androidLmkDebug, androidLmkTasks, type AndroidLmkTask, type LmkVictim } from "../lib/lmk";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n/locales/zh";
import { GROUP, ROW, LABEL } from "./ui";

/** One LMK trigger round that actually returned victims (for history echo). */
interface VictimRound {
  at: string;
  victims: LmkVictim[];
}

/** A per-task host-decision action offered for a given lifecycle state. */
interface TaskAct {
  action: "apply_freeze" | "apply_thaw" | "apply_reclaim";
  /** i18n key used for both the button label and its accessible name. */
  key: MessageKey;
}

/** Only offer actions that make sense for the task's current importance state. */
function actionsForTask(state: string): TaskAct[] {
  switch (state) {
    case "cached": // frozen (tombstone) → thaw it back, or reclaim for good
      return [
        { action: "apply_thaw", key: "lmk.thaw" },
        { action: "apply_reclaim", key: "lmk.reclaim" },
      ];
    case "background":
      return [
        { action: "apply_freeze", key: "settings.taskFreeze" },
        { action: "apply_reclaim", key: "lmk.reclaim" },
      ];
    case "stopped":
      return [{ action: "apply_reclaim", key: "lmk.reclaim" }];
    default:
      return []; // foreground/visible/unknown → no host action to offer
  }
}

/**
 * Resident LMK dev panel (bring-up `docs/android-lmk-e2e.md` G3). Unlike the
 * governor-driven TaskManager (which only shows while the governor has content),
 * this always renders so the trigger + per-surface freeze/thaw/reclaim controls are
 * reachable even when nothing is registered. Offline/absent daemon shows a graceful
 * "not connected" line instead of a broken card.
 */
export default function LmkDebugPanel() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [tasks, setTasks] = useState<AndroidLmkTask[]>([]);
  const [offline, setOffline] = useState(false);
  const [rounds, setRounds] = useState<VictimRound[]>([]);
  const [budget, setBudget] = useState(1);
  const noteTimer = useRef<number | null>(null);

  const dismissNote = () => {
    if (noteTimer.current !== null) {
      window.clearTimeout(noteTimer.current);
      noteTimer.current = null;
    }
    setNote(null);
  };
  const showNote = (n: string) => {
    dismissNote();
    setNote(n);
    noteTimer.current = window.setTimeout(() => setNote(null), 4000);
  };

  useEffect(() => () => dismissNote(), []);

  // Reload the live container-task snapshot (and offline flag).
  const refresh = () => {
    androidLmkTasks()
      .then((l) => {
        setTasks(l ?? []);
        setOffline(l === null);
      })
      .catch(() => setOffline(true));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = (
    pkg: string | undefined,
    action: "trigger" | "apply_freeze" | "apply_thaw" | "apply_reclaim",
    budget?: number,
  ) => {
    if (busy) return;
    setBusy(true);
    dismissNote();
    androidLmkDebug(action, pkg, budget)
      .then((o) => {
        if (o) {
          showNote(o.note);
          if (o.victims.length > 0) {
            setRounds((r) =>
              [{ at: new Date().toLocaleTimeString(), victims: o.victims }, ...r].slice(0, 5),
            );
          }
          refresh();
        }
      })
      .catch(() => {
        showNote(t("lmk.fail"));
      })
      .finally(() => setBusy(false));
  };

  const trigger = () => run(undefined, "trigger", budget);
  const actTask = (pkg: string, action: "apply_freeze" | "apply_thaw" | "apply_reclaim") =>
    run(pkg, action);

  return (
    <section className={GROUP}>
      <div className={ROW}>
        <span className={LABEL}>{t("lmk.title")}</span>
        <label className="flex items-center gap-1 text-[11px] opacity-70">
          {t("lmk.budget")}
          <input
            type="number"
            min={1}
            max={8}
            value={budget}
            aria-label={t("lmk.ariaBudget")}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              setBudget(Number.isFinite(v) ? Math.min(8, Math.max(1, v)) : 1);
            }}
            className="w-12 rounded bg-black/5 px-1 py-0.5 text-right outline-none dark:bg-white/10"
          />
        </label>
        <button
          onClick={trigger}
          disabled={busy}
          aria-label={t("lmk.ariaTrigger")}
          className="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-40 dark:bg-white/10"
        >
          {t("lmk.trigger")}
        </button>
        <button
          onClick={refresh}
          disabled={busy}
          aria-label={t("lmk.ariaRefresh")}
          className="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-40 dark:bg-white/10"
        >
          {t("lmk.refresh")}
        </button>
      </div>
      {note && (
        <div
          role="status"
          className="mx-4 mb-1 flex items-center justify-between gap-2 rounded-lg bg-black/5 px-3 py-1 text-[11px] dark:bg-white/10"
        >
          <span className="min-w-0 truncate">{note}</span>
          <button onClick={dismissNote} aria-label={t("lmk.ariaDismiss")} className="opacity-70 hover:opacity-100">
            ✕
          </button>
        </div>
      )}

      {rounds.length > 0 && (
        <div className="border-t border-black/5 px-4 py-3 text-xs dark:border-white/10">
          <div className="mb-1 flex items-center justify-between">
            <p className="font-semibold opacity-80">{t("lmk.recentVictims")}</p>
            <button
              onClick={() => setRounds([])}
              aria-label={t("lmk.ariaClear")}
              className="rounded-full bg-black/5 px-2 py-0.5 opacity-70 active:scale-95 dark:bg-white/10"
            >
              {t("lmk.clearHistory")}
            </button>
          </div>
          <ul className="max-h-28 space-y-0.5 overflow-y-auto">
            {rounds.map((r, i) => (
              <li key={`${r.at}-${i}`} className="opacity-80">
                <span className="mr-1 opacity-50">{r.at}</span>
                {r.victims.map((v, j) => (
                  <span key={j} className="mr-2">
                    {v.package_name}
                    <span className={v.killed ? "text-red-500" : "opacity-60"}>
                      {t(v.killed ? "lmk.killed" : "lmk.frozen")}
                    </span>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-t border-black/5 px-4 py-3 text-xs dark:border-white/10">
        <p className="mb-1 font-semibold opacity-80">{t("lmk.containerTasks")}</p>
        {offline ? (
          <p className="opacity-50">{t("lmk.offline")}</p>
        ) : tasks.length === 0 ? (
          <p className="opacity-50">{t("lmk.noTasks")}</p>
        ) : (
          <ul className="max-h-32 space-y-1 overflow-y-auto">
            {tasks.map((tk) => (
              <li
                key={tk.window_id || tk.package_name}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span className="min-w-0">
                  <span className="truncate">{tk.package_name}</span>
                  <span className="ml-2 opacity-50">
                    {tk.window_id} · {tk.state}
                  </span>
                </span>
                <span className="flex flex-wrap gap-1">
                  {actionsForTask(tk.state).map((a) => (
                    <button
                      key={a.action}
                      onClick={() => actTask(tk.package_name, a.action)}
                      disabled={busy}
                      aria-label={`${t(a.key)} ${tk.package_name}`}
                      className="rounded-full bg-black/5 px-2 py-0.5 active:scale-95 disabled:opacity-40 dark:bg-white/10"
                    >
                      {t(a.key)}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

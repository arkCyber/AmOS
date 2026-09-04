import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue } from "../lib/amosStore";
import { getRecents } from "../lib/amosStore";
import { telephonyDial } from "../lib/backend";
import { useFocusTrap } from "../lib/useFocusTrap";
import { APPS, appIcon, appTitleKey } from "../apps";
import { AppIconTile } from "./AppIcon";
import { fmtClock } from "../lib/time";

/* ---- Lock screen ---- */
export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const { t, locale } = useI18n();
  const cfg = readStoreValue<{ enabled?: boolean; pin?: string }>("amos.lock", {});
  const needPin = !!cfg.enabled && !!cfg.pin;
  const [pin, setPin] = useState("");
  const [bad, setBad] = useState(false);
  const [emergency, setEmergency] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(true, rootRef);

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

  const tap = (d: string) => {
    setPin((p) => (p.length < 6 ? p + d : p));
    setBad(false);
  };
  const submit = () => {
    if (pin === cfg.pin) {
      setPin("");
      onUnlock();
    } else {
      setBad(true);
      setPin("");
    }
  };

  // Emergency quick-dial (legal hard path): always reachable from the lock screen,
  // goes straight to the privileged emergency provider (110). One-shot guard so a
  // locked UI can't spam duplicate dials while one is in flight.
  const dialEmergency = () => {
    if (emergency) return;
    setEmergency(true);
    void telephonyDial("110", true);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("shell.lockTitle")}
      ref={rootRef}
      className="fade-in absolute inset-0 z-50 flex flex-col items-center justify-center bg-neutral-900/75 px-6 text-neutral-50 backdrop-blur-2xl"
    >
      <div className="text-center leading-none">
        <div className="text-7xl font-thin tabular-nums tracking-tight">{fmtClock(now)}</div>
        <div className="mt-2.5 text-lg text-neutral-200">{date}</div>
        <div className="mt-7 flex items-center justify-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-400">
          <span aria-hidden>🔒</span> {t("shell.lockTitle")}
        </div>
      </div>
      {needPin ? (
        <>
          <div className="my-7 text-2xl tabular-nums tracking-[0.35em] text-neutral-100">
            {bad ? (
              <span className="text-3xl text-red-400">✗</span>
            ) : (
              <span className="text-3xl">{pin.length ? "●".repeat(pin.length) : "○○○○○○"}</span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-x-6 gap-y-4">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"].map((k) => {
              const confirm = k === "✓";
              const back = k === "⌫";
              return (
                <button
                  key={k}
                  onClick={() => (confirm ? submit() : back ? setPin((p) => p.slice(0, -1)) : tap(k))}
                  aria-label={k}
                  className={
                    "grid h-[72px] w-[72px] place-items-center rounded-full text-2xl ring-1 transition active:scale-90 " +
                    (confirm
                      ? "bg-green-500 text-white ring-green-400 active:bg-green-400"
                      : "bg-white/10 text-white ring-white/25 backdrop-blur active:bg-white/25")
                  }
                >
                  {k}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <button
          onClick={onUnlock}
          className="mt-10 rounded-full bg-white/15 px-9 py-3 text-base font-medium ring-1 ring-white/25 backdrop-blur transition active:bg-white/25"
        >
          {t("shell.unlock")}
        </button>
      )}
      <button
        onClick={dialEmergency}
        disabled={emergency}
        className="mt-10 rounded-full bg-danger/20 px-8 py-3 text-base font-medium text-red-200 ring-1 ring-red-400/40 transition active:bg-danger/30 disabled:opacity-60"
        aria-label={t("shell.emergency")}
      >
        {emergency ? t("shell.emergencyCalling") : t("shell.emergency")}
      </button>
    </div>
  );
}

/* ---- Recents (recently opened apps) ---- */
export function RecentsPanel({ open, onClose, onOpen }: { open: boolean; onClose: () => void; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(open, rootRef, onClose);
  if (!open) return null;
  const ids = getRecents().filter((id) => appTitleKey(id) !== null);
  return (
    <div
      ref={rootRef}
      className="sheet-in absolute inset-0 z-40 flex flex-col bg-white/45 p-4 backdrop-blur-2xl backdrop-saturate-150 dark:bg-neutral-950/60"
    >
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xl font-semibold tracking-tight">{t("shell.recents")}</h2>
        <button
          onClick={onClose}
          className="rounded-full bg-neutral-200/80 px-4 py-1.5 text-sm font-medium text-accent transition active:scale-95 dark:bg-white/10"
        >
          {t("common.done")}
        </button>
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-auto">
        {ids.length === 0 ? (
          <p className="py-16 text-center text-sm opacity-50">{t("shell.noRecent")}</p>
        ) : (
          <div className="divide-y divide-black/5 overflow-hidden rounded-2xl bg-white/55 shadow-sm ring-1 ring-black/5 dark:divide-white/5 dark:bg-white/5 dark:ring-white/10">
            {ids.map((id) => {
              const key = appTitleKey(id);
              const label = key ? t(key) : id;
              return (
                <button
                  key={id}
                  onClick={() => {
                    onOpen(id);
                    onClose();
                  }}
                  aria-label={label}
                  className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm transition active:bg-accent/10"
                >
                  <AppIconTile id={id} icon={appIcon(id)} tileClassName="h-11 w-11 rounded-[12px]" glyphClassName="text-[26px]" />
                  <span className="min-w-0 truncate font-medium">{label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- Spotlight (search + launch apps) ---- */
export function SpotlightPanel({ open, onClose, onOpen }: { open: boolean; onClose: () => void; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(open, rootRef, onClose);
  if (!open) return null;
  const needle = q.trim().toLowerCase();
  const hits = needle
    ? APPS.filter((a) => t(a.titleKey).toLowerCase().includes(needle) || a.id.includes(needle)).slice(0, 12)
    : APPS.slice(0, 12);
  return (
    <div
      ref={rootRef}
      className="sheet-in absolute inset-0 z-40 flex flex-col bg-white/45 p-4 backdrop-blur-2xl backdrop-saturate-150 dark:bg-neutral-950/60"
    >
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xl font-semibold tracking-tight">{t("shell.search")}</h2>
        <button
          onClick={onClose}
          className="rounded-full bg-neutral-200/80 px-4 py-1.5 text-sm font-medium text-accent transition active:scale-95 dark:bg-white/10"
        >
          {t("common.done")}
        </button>
      </div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("shell.searchPh")}
        className="mt-3 w-full rounded-full bg-white/70 px-4 py-2.5 text-sm text-neutral-900 shadow-sm ring-1 ring-black/5 outline-none placeholder:text-black/30 dark:bg-white/10 dark:text-white dark:ring-white/10 dark:placeholder:text-white/30"
      />
      <div className="mt-3 min-h-0 flex-1 overflow-auto">
        {hits.length === 0 ? (
          <p className="py-16 text-center text-sm opacity-50">{t("shell.noMatch")}</p>
        ) : (
          <div className="divide-y divide-black/5 overflow-hidden rounded-2xl bg-white/55 shadow-sm ring-1 ring-black/5 dark:divide-white/5 dark:bg-white/5 dark:ring-white/10">
            {hits.map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  onOpen(a.id);
                  onClose();
                }}
                aria-label={t(a.titleKey)}
                className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm transition active:bg-accent/10"
              >
                <AppIconTile id={a.id} icon={appIcon(a.id)} tileClassName="h-11 w-11 rounded-[12px]" glyphClassName="text-[26px]" />
                <span className="min-w-0 flex-1 truncate font-medium">{t(a.titleKey)}</span>
                <span className="text-xs text-accent">⌘↵</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

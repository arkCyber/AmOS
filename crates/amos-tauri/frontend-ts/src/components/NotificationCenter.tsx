import { useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { useFocusTrap } from "../lib/useFocusTrap";
import {
  NOTIF_KEY,
  SETTINGS_KEY,
  flipQuick,
  normalizeNotifs,
  normalizeQuick,
  removeNotif,
  seedNotifs,
  type Notif,
  type QuickKey,
  type QuickSettings,
} from "../lib/settings";

const QUICK: { key: QuickKey; label: "q.wifi" | "q.bluetooth" | "q.airplane" | "q.dark" | "q.dnd" | "q.location"; icon: string }[] = [
  { key: "wifi", label: "q.wifi", icon: "📶" },
  { key: "bluetooth", label: "q.bluetooth", icon: "🅱" },
  { key: "airplane", label: "q.airplane", icon: "✈️" },
  { key: "darkmode", label: "q.dark", icon: "🌙" },
  { key: "dnd", label: "q.dnd", icon: "🌒" },
  { key: "location", label: "q.location", icon: "📍" },
];

export default function NotificationCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  // The "dark mode" quick tile drives the real theme (not just a cosmetic bit).
  const { dark, toggle: themeToggle } = useTheme();
  const [settings, setSettings] = useState<QuickSettings>(() =>
    normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {})),
  );
  const [notifs, setNotifs] = useState<Notif[]>(() => {
    const l = normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, []));
    if (l.length) return l;
    const s = seedNotifs(Date.now());
    writeStoreValue(NOTIF_KEY, s);
    return s;
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(open, rootRef, onClose);
  if (!open) return null;

  const toggle = (key: QuickKey) => {
    if (key === "darkmode") {
      // Flip the *actual* theme and keep the quick-setting mirror in sync.
      const nextDark = !dark;
      const next = { ...settings, darkmode: nextDark };
      setSettings(next);
      writeStoreValue(SETTINGS_KEY, next);
      themeToggle();
      return;
    }
    const next = flipQuick(settings, key);
    setSettings(next);
    writeStoreValue(SETTINGS_KEY, next);
  };
  const clear = () => {
    setNotifs([]);
    writeStoreValue(NOTIF_KEY, []);
  };
  const dismiss = (id: string) => {
    const next = removeNotif(notifs, id);
    setNotifs(next);
    writeStoreValue(NOTIF_KEY, next);
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("nc.title")}
      className="drop-in absolute inset-0 z-40 flex flex-col bg-white/45 p-4 backdrop-blur-2xl backdrop-saturate-150 dark:bg-neutral-950/60"
    >
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xl font-semibold tracking-tight">{t("nc.title")}</h2>
        <button
          onClick={onClose}
          className="rounded-full bg-neutral-200/80 px-4 py-1.5 text-sm font-medium text-accent transition active:scale-95 dark:bg-white/10"
        >
          {t("common.done")}
        </button>
      </div>

      {/* Quick settings — iOS Control-Center style translucent tiles */}
      <div className="mt-4 grid grid-cols-3 gap-2.5">
        {QUICK.map((q) => {
          const on = q.key === "darkmode" ? dark : !!settings[q.key];
          return (
            <button
              key={q.key}
              onClick={() => toggle(q.key)}
              aria-pressed={on}
              className={
                "flex flex-col items-center justify-center gap-1.5 rounded-3xl py-4 text-[11px] font-medium backdrop-blur transition active:scale-95 " +
                (on
                  ? "bg-accent text-white shadow-[0_6px_16px_rgba(10,132,255,0.35)]"
                  : "bg-white/55 text-neutral-800 ring-1 ring-white/50 shadow-sm dark:bg-white/10 dark:text-neutral-200 dark:ring-white/10")
              }
            >
              <span className="text-xl leading-none">{q.icon}</span>
              {t(q.label)}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between px-1">
        <span className="text-xs font-semibold uppercase tracking-widest opacity-50">{notifs.length} ·</span>
        <button onClick={clear} className="text-xs font-medium text-accent hover:underline">
          {t("nc.clear")}
        </button>
      </div>

      <div className="mt-2 flex-1 space-y-2.5 overflow-auto pr-0.5">
        {notifs.length === 0 ? (
          <p className="py-12 text-center text-sm opacity-50">{t("nc.empty")}</p>
        ) : (
          notifs.map((n) => (
            <div
              key={n.id}
              className="rounded-3xl bg-white/60 p-3.5 shadow-sm ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold">
                  {n.icon} {n.app ?? n.title}
                </span>
                <button
                  onClick={() => dismiss(n.id)}
                  aria-label="dismiss"
                  className="grid h-6 w-6 place-items-center rounded-full opacity-60 transition hover:opacity-100"
                >
                  ✕
                </button>
              </div>
              {n.title && <div className="mt-1 text-sm font-medium">{n.title}</div>}
              {n.body && <div className="text-xs opacity-70">{n.body}</div>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

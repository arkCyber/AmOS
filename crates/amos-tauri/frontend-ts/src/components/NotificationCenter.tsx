import { useRef, useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { useFocusTrap } from "../lib/useFocusTrap";
import {
  NOTIF_KEY,
  SETTINGS_KEY,
  flipQuick,
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
  const [settings, setSettings] = useState<QuickSettings>(() => readStoreValue<QuickSettings>(SETTINGS_KEY, {}));
  const [notifs, setNotifs] = useState<Notif[]>(() => {
    const l = readStoreValue<Notif[]>(NOTIF_KEY, []);
    if (l.length) return l;
    const s = seedNotifs(Date.now());
    writeStoreValue(NOTIF_KEY, s);
    return s;
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(open, rootRef, onClose);
  if (!open) return null;

  const toggle = (key: QuickKey) => {
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
      className="fixed inset-0 z-40 flex flex-col bg-neutral-100/95 p-4 dark:bg-neutral-950/95"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{t("nc.title")}</h2>
        <button onClick={onClose} className="rounded-full bg-neutral-300 px-3 py-1 text-sm dark:bg-neutral-700">
          {t("common.done")}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {QUICK.map((q) => {
          const on = !!settings[q.key];
          return (
            <button
              key={q.key}
              onClick={() => toggle(q.key)}
              className={
                "flex flex-col items-center gap-1 rounded-2xl py-3 text-xs " +
                (on ? "bg-accent text-white" : "bg-neutral-200/80 dark:bg-neutral-800/80")
              }
            >
              <span className="text-lg">{q.icon}</span>
              {t(q.label)}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs opacity-60">{notifs.length} ·</span>
        <button onClick={clear} className="text-xs text-accent hover:underline">
          {t("nc.clear")}
        </button>
      </div>
      <div className="mt-1 flex-1 space-y-2 overflow-auto">
        {notifs.length === 0 ? (
          <p className="py-10 text-center text-sm opacity-60">{t("nc.empty")}</p>
        ) : (
          notifs.map((n) => (
            <div key={n.id} className="rounded-2xl bg-neutral-200/60 p-3 dark:bg-neutral-800/60">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold">
                  {n.icon} {n.app ?? n.title}
                </span>
                <button onClick={() => dismiss(n.id)} aria-label="dismiss" className="opacity-60 hover:opacity-100">
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

import { useRef, useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue } from "../lib/amosStore";
import { getRecents } from "../lib/amosStore";
import { useFocusTrap } from "../lib/useFocusTrap";
import { APPS, appTitleKey } from "../apps";

/* ---- Lock screen ---- */
export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const { t } = useI18n();
  const cfg = readStoreValue<{ enabled?: boolean; pin?: string }>("amos.lock", {});
  const needPin = !!cfg.enabled && !!cfg.pin;
  const [pin, setPin] = useState("");
  const [bad, setBad] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(true, rootRef);

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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("shell.lockTitle")}
      ref={rootRef}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-neutral-900 text-neutral-100"
    >
      <div className="text-6xl">🔒</div>
      <p className="mt-3 text-2xl font-light">{t("shell.lockTitle")}</p>
      {needPin ? (
        <div className="mt-6 flex flex-col items-center gap-3">
          <div className={"text-2xl tabular-nums tracking-[0.4em] " + (bad ? "text-danger" : "")}>
            {bad ? "✗" : "•".repeat(pin.length) || "····"}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"].map((k) => (
              <button
                key={k}
                onClick={() => (k === "✓" ? submit() : k === "⌫" ? setPin(pin.slice(0, -1)) : tap(k))}
                className="grid h-14 w-14 place-items-center rounded-full bg-neutral-800 text-lg text-white active:scale-95"
              >
                {k}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <button onClick={onUnlock} className="mt-8 rounded-full bg-accent px-6 py-2 text-white active:scale-95">
          {t("shell.unlock")}
        </button>
      )}
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
    <div ref={rootRef} className="fixed inset-0 z-40 flex flex-col bg-neutral-100/95 p-4 dark:bg-neutral-950/95">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{t("shell.recents")}</h2>
        <button onClick={onClose} className="rounded-full bg-neutral-300 px-3 py-1 text-sm dark:bg-neutral-700">
          {t("common.done")}
        </button>
      </div>
      <div className="mt-3 flex flex-1 flex-col gap-2 overflow-auto">
        {ids.length === 0 ? (
          <p className="py-10 text-center text-sm opacity-60">{t("shell.noRecent")}</p>
        ) : (
          ids.map((id) => {
            const key = appTitleKey(id);
            return (
              <button
                key={id}
                onClick={() => {
                  onOpen(id);
                  onClose();
                }}
                className="rounded-2xl bg-neutral-200/70 px-4 py-3 text-left text-sm dark:bg-neutral-800/70"
              >
                {key ? t(key) : id}
              </button>
            );
          })
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
    <div ref={rootRef} className="fixed inset-0 z-40 flex flex-col bg-neutral-100/95 p-4 dark:bg-neutral-950/95">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{t("shell.search")}</h2>
        <button onClick={onClose} className="rounded-full bg-neutral-300 px-3 py-1 text-sm dark:bg-neutral-700">
          {t("common.done")}
        </button>
      </div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("shell.searchPh")}
        className="mt-3 w-full rounded-full bg-neutral-200 px-4 py-2 text-sm outline-none dark:bg-neutral-800"
      />
      <div className="mt-3 flex flex-1 flex-col gap-2 overflow-auto">
        {hits.map((a) => (
          <button
            key={a.id}
            onClick={() => {
              onOpen(a.id);
              onClose();
            }}
            className="flex items-center gap-3 rounded-2xl bg-neutral-200/70 px-4 py-2 text-left text-sm dark:bg-neutral-800/70"
          >
            <span>{a.icon}</span>
            <span>{t(a.titleKey)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

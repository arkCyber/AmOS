import { useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { LOCK_KEY, makeLock, type LockCfg } from "../lib/lock";

export default function LockSettings() {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<LockCfg>(() => readStoreValue<LockCfg>(LOCK_KEY, { enabled: false }));
  const [on, setOn] = useState(cfg.enabled);
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState("");

  const save = () => {
    const next = makeLock(on, pin, cfg);
    setCfg(next);
    setOn(next.enabled); // never leave the UI showing enabled if the save was refused
    writeStoreValue(LOCK_KEY, next);
    setMsg(on && !next.enabled ? t("lock.pin") : t("lock.saved"));
  };

  return (
    <section className="rounded-2xl bg-neutral-200/60 p-3 dark:bg-neutral-800/60">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{t("lock.enable")}</span>
        <button
          role="switch"
          aria-checked={on}
          onClick={() => setOn((v) => !v)}
          className={"h-7 w-12 rounded-full transition " + (on ? "bg-accent" : "bg-neutral-400 dark:bg-neutral-600")}
        >
          <span className={"block h-6 w-6 translate-x-0 rounded-full bg-white transition " + (on ? "translate-x-5" : "")} />
        </button>
      </div>
      <p className="mt-2 text-xs opacity-60">
        {cfg.enabled ? t("lock.stateOn") : t("lock.stateOff")}
        {cfg.pin ? ` ${t("lock.pinSet")}` : ""}
        {(on !== cfg.enabled || (on && pin.trim().length > 0)) ? ` · ${t("lock.pin")}` : ""}
      </p>
      {on && (
        <div className="mt-3 flex gap-2">
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder={t("lock.pin")}
            inputMode="numeric"
            className="min-w-0 flex-1 rounded-lg bg-white px-3 py-1 text-sm outline-none dark:bg-neutral-900"
          />
          <button onClick={save} className="rounded-full bg-accent px-3 py-1 text-sm text-white">
            {t("lock.save")}
          </button>
        </div>
      )}
      {msg && <p className="mt-2 text-xs opacity-60">{msg}</p>}
    </section>
  );
}

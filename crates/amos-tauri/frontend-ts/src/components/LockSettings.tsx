import { useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { LOCK_KEY, makeLock, type LockCfg } from "../lib/lock";
import { GROUP, ROW, LABEL, FIELD, Switch } from "./ui";

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
    <section className={GROUP}>
      <div className={ROW}>
        <span className={LABEL}>{t("lock.enable")}</span>
        <Switch on={on} onToggle={() => setOn((v) => !v)} label={t("lock.enable")} />
      </div>
      <p className="px-4 pb-3 text-xs opacity-60">
        {cfg.enabled ? t("lock.stateOn") : t("lock.stateOff")}
        {cfg.pin ? ` ${t("lock.pinSet")}` : ""}
        {(on !== cfg.enabled || (on && pin.trim().length > 0)) ? ` · ${t("lock.pin")}` : ""}
      </p>
      {on && (
        <div className="flex items-center gap-2 border-t border-black/5 px-4 py-3 dark:border-white/10">
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder={t("lock.pin")}
            inputMode="numeric"
            className={FIELD}
          />
          <button onClick={save} className="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95">
            {t("lock.save")}
          </button>
        </div>
      )}
      {msg && <p className="px-4 pb-3 text-xs opacity-60">{msg}</p>}
    </section>
  );
}

import { useState } from "react";
import { useI18n } from "../i18n";
import {
  CAPABILITIES,
  capSet,
  grantCap,
  grantedApps,
  loadLedger,
  revokeCap,
  saveLedger,
  type Capability,
  type PermissionLedger,
} from "../lib/permissions";
import { isExtId, tileById } from "../lib/storeApps";

/** Built-in apps that actually request each sensitive capability (a showcase; a
 * future third-party/web host lists its own). */
const CANDIDATES: Record<Capability, string[]> = {
  camera: ["camera"],
  microphone: ["ai", "interpreter", "phone"],
  location: ["maps", "weather"],
  notifications: ["messages", "mail"],
};

const CAP_ICON: Record<Capability, string> = {
  camera: "📷",
  microphone: "🎙️",
  location: "📍",
  notifications: "🔔",
};

/**
 * Privacy & permissions dashboard: lists which apps may access sensitive
 * capabilities and lets the user grant/revoke each. The ledger is persisted in
 * the durable shared store (`amos.permissions`). Enforcement (gating real
 * camera/mic/location calls behind `capSet`) is wired separately at call sites.
 */
export default function PermissionsApp() {
  const { t } = useI18n();
  const [ledger, setLedger] = useState<PermissionLedger>(() => loadLedger());

  const capLabel: Record<Capability, string> = {
    camera: t("perm.cap.camera"),
    microphone: t("perm.cap.microphone"),
    location: t("perm.cap.location"),
    notifications: t("perm.cap.notifications"),
  };
  // Localized built-in app names used as grant targets / chips.
  const appName: Record<string, string> = {
    camera: t("app.camera"),
    ai: t("app.ai"),
    interpreter: t("app.interpreter"),
    phone: t("app.phone"),
    maps: t("app.maps"),
    weather: t("app.weather"),
    messages: t("app.messages"),
    mail: t("app.mail"),
  };
  const labelOf = (id: string): string =>
    isExtId(id) ? tileById(id)?.name ?? id : (appName[id] ?? id);

  const commit = (next: PermissionLedger) => {
    saveLedger(next);
    setLedger(next);
  };
  const toggle = (app: string, cap: Capability) => {
    const on = capSet(ledger, app, cap);
    commit(on ? revokeCap(ledger, app, cap) : grantCap(ledger, app, cap));
  };

  return (
    <div className="space-y-3 p-4">
      <p className="rounded-2xl bg-white/50 px-3 py-2 text-[11px] leading-relaxed opacity-60 ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10">
        {t("perm.hint")}
      </p>

      {CAPABILITIES.map((cap) => {
        const holders = grantedApps(ledger, cap);
        return (
          <section
            key={cap}
            className="rounded-2xl bg-white/60 p-3 shadow-sm ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10"
          >
            <header className="flex items-center justify-between">
              <h3 className="text-sm font-medium">
                {CAP_ICON[cap]} {capLabel[cap]}
              </h3>
              <span className="text-[11px] opacity-50">
                {t("perm.granted")}: {holders.length}
              </span>
            </header>

            {holders.length === 0 ? (
              <p className="mt-1 text-[11px] opacity-50">{t("perm.none")}</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {holders.map((app) => (
                  <button
                    key={app}
                    onClick={() => toggle(app, cap)}
                    title={t("perm.revoke")}
                    className="rounded-full bg-green-500/15 px-2.5 py-1 text-xs text-green-600 dark:text-green-400"
                  >
                    {labelOf(app)} ✕
                  </button>
                ))}
              </div>
            )}

            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-black/5 pt-2 dark:border-white/10">
              {CANDIDATES[cap].map((app) => {
                const on = capSet(ledger, app, cap);
                return (
                  <button
                    key={app}
                    onClick={() => toggle(app, cap)}
                    aria-pressed={on}
                    className={
                      "rounded-full px-3 py-1 text-xs ring-1 " +
                      (on
                        ? "bg-accent text-white ring-accent"
                        : "bg-neutral-200/60 ring-black/5 dark:bg-neutral-700/60 dark:ring-white/10")
                    }
                  >
                    {labelOf(app)} · {on ? t("perm.on") : t("perm.off")}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

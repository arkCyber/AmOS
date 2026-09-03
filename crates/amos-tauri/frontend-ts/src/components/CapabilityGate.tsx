import { useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { capSet, grantCap, loadLedger, revokeCap, saveLedger, type Capability } from "../lib/permissions";

export interface CapabilityControl {
  granted: boolean;
  /** Denied-by-user this session (not persisted); shows a hint next to the prompt. */
  refused: boolean;
  /** Grant + persist the capability, then mark granted. */
  allow: () => void;
  /** Mark refused (keeps it ungranted). */
  deny: () => void;
}

/**
 * Reusable OS permission gate for a built-in app. Returns whether the app holds
 * `cap` and the actions to grant/refuse it — call it wherever a sensitive
 * capability is used (camera/mic/location) so the ledger is actually enforced.
 */
export function useCapability(appId: string, cap: Capability): CapabilityControl {
  const [granted, setGranted] = useState(() => capSet(loadLedger(), appId, cap));
  const [refused, setRefused] = useState(false);

  const allow = () => {
    saveLedger(grantCap(loadLedger(), appId, cap));
    setGranted(true);
    setRefused(false);
  };
  const deny = () => setRefused(true);
  return { granted, refused, allow, deny };
}

/**
 * A full-view permission overlay: renders `children` when `cap` is granted for
 * `appId`; otherwise a localized allow/deny prompt. `appLabel`/`capLabel` should
 * be user-facing names (e.g. `t("app.camera")`, `t("perm.cap.camera")`).
 */
export default function CapabilityGate({
  appId,
  cap,
  appLabel,
  capLabel,
  children,
  onAllowed,
}: {
  appId: string;
  cap: Capability;
  appLabel: string;
  capLabel: string;
  children: ReactNode;
  /** Called right after the user taps "Allow" (e.g. to start the stream). */
  onAllowed?: () => void;
}) {
  const { t } = useI18n();
  const { granted, refused, allow, deny } = useCapability(appId, cap);

  if (granted) return <>{children}</>;

  const allowAnd = () => {
    allow();
    onAllowed?.();
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-neutral-950/90 px-6 text-center">
      <div className="text-3xl">🔐</div>
      <p className="text-sm text-white/90">{t("perm.askAllow", { app: appLabel, cap: capLabel })}</p>
      {refused && <p className="text-xs text-white/50">{t("perm.denied")}</p>}
      <div className="flex gap-3">
        <button
          onClick={allowAnd}
          className="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95"
        >
          {t("perm.allow")}
        </button>
        <button
          onClick={deny}
          className="rounded-full bg-white/15 px-4 py-1.5 text-sm text-white ring-1 ring-white/25 active:scale-95"
        >
          {t("perm.deny")}
        </button>
      </div>
    </div>
  );
}

/** Revoke a capability (utility for "later revoke this" flows). */
export function revokeCapability(appId: string, cap: Capability): void {
  saveLedger(revokeCap(loadLedger(), appId, cap));
}

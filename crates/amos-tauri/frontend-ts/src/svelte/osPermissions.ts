/**
 * Host-side **capability-ledger seam** for the System UI.
 *
 * Every capability grant/revoke must do two things: (a) persist to the local
 * ledger so the UI gate is immediate, and (b) mirror to the daemon, whose store is
 * **authoritative and audited** (`lib/privacyBackend`, `perm_grant`/`perm_revoke`).
 *
 * The in-app permission prompts (Camera auto-grant, Maps location, Magnifier
 * camera, VoiceMemos/new-memo mic, Interp mic, the voice-mic buttons) used to write
 * **only** the local ledger. A grant made there therefore never reached the daemon:
 * its authoritative store — and the "recent access" audit trail the Privacy
 * dashboard renders — silently disagreed with what the UI had just shown the user.
 * Meanwhile the dashboard/settings toggles *did* mirror, so the same user action
 * had two different effects depending on where it was made.
 *
 * The mirror is best-effort and offline-safe (`privacyBackend` returns `null`
 * without a bridge); local-only capabilities (`notifications`) have no daemon
 * resource and are a documented no-op.
 */
import {
  grantCap,
  loadLedger,
  revokeCap,
  saveLedger,
  type Capability,
  type PermissionLedger,
} from "../lib/permissions";
import { daemonAuthorize, daemonGrant, daemonRevoke } from "../lib/privacyBackend";

/** Grant `cap` to `appId`: persist locally, then mirror to the daemon. */
export function grantCapability(appId: string, cap: Capability): PermissionLedger {
  const next = grantCap(loadLedger(), appId, cap);
  saveLedger(next);
  void daemonGrant(appId, cap);
  return next;
}

/** Revoke `cap` from `appId`: persist locally, then mirror to the daemon. */
export function revokeCapability(appId: string, cap: Capability): PermissionLedger {
  const next = revokeCap(loadLedger(), appId, cap);
  saveLedger(next);
  void daemonRevoke(appId, cap);
  return next;
}

/**
 * The daemon's verdict for one `(app, cap)`, or `null` when it cannot answer
 * (offline / local-only capability). Callers use it to surface **drift** between
 * the local ledger and the daemon's authoritative store rather than assuming the
 * two agree.
 */
export function daemonVerdict(appId: string, cap: Capability): Promise<boolean | null> {
  return daemonAuthorize(appId, cap);
}

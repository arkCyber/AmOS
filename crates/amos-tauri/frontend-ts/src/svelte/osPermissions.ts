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
 *
 * "Best-effort" is not "unobserved": a mirror the daemon **refused** is kept
 * ({@link mirrorRefused}) so the review view can say that the local grant never
 * reached the authoritative, audited store.
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

/**
 * `app|cap` pairs whose **last** mirror write the daemon refused (this session).
 *
 * Why this exists: the local ledger is written first on purpose (the UI gate must stay
 * immediate, and it works offline), and the mirror is best-effort. That leaves exactly
 * one failure the app can prove *locally* — "my write to the authoritative store did not
 * land" — and it is the one failure the daemon's own answer can never report: when the
 * write fails because the socket is not there, the read (`perm_authorize`) fails too and
 * answers `null`, which the drift mark treats as "no claim". So a grant that never
 * reached the audited store used to be shown as a clean green grant, with no surface
 * anywhere able to say otherwise.
 *
 * It is a statement about the last write, not a session scar: a later accepted write for
 * the same pair clears it. Offline / local-only capabilities answer `null` and are *not*
 * recorded — no claim is not a refusal.
 */
const refusedMirrors = new Set<string>();
type MirrorWatcher = (appId: string, cap: Capability, accepted: boolean) => void;
const mirrorWatchers = new Set<MirrorWatcher>();

const mirrorKey = (appId: string, cap: Capability): string => `${appId}|${cap}`;

function recordMirror(appId: string, cap: Capability, accepted: boolean): void {
  const key = mirrorKey(appId, cap);
  if (accepted) refusedMirrors.delete(key);
  else refusedMirrors.add(key);
  // Notified in both directions so a view can retract a mark it already showed.
  for (const fn of mirrorWatchers) fn(appId, cap, accepted);
}

/** True when the daemon refused the last mirror write for this `(app, cap)`. */
export function mirrorRefused(appId: string, cap: Capability): boolean {
  return refusedMirrors.has(mirrorKey(appId, cap));
}

/** Watch mirror verdicts (returns an unsubscribe). */
export function onMirrorVerdict(fn: MirrorWatcher): () => void {
  mirrorWatchers.add(fn);
  return () => {
    mirrorWatchers.delete(fn);
  };
}

/**
 * Mirror one write and keep its verdict. `null` (offline / local-only capability) is
 * deliberately *not* recorded: the daemon was never asked, so there is nothing to mark.
 */
function mirrorWrite(
  appId: string,
  cap: Capability,
  write: (appId: string, cap: Capability) => Promise<boolean | null>,
): void {
  void write(appId, cap).then((verdict) => {
    if (verdict === null) return;
    recordMirror(appId, cap, verdict);
  });
}

/**
 * The outcome of one capability write: **which ledger the caller may show**, and whether
 * the local write behind it landed.
 *
 * `ledger` is deliberately not "the value we tried to write": on a refused write it is the
 * ledger the store still holds, because that is the one every gate in the OS reads back
 * (`loadLedger`) — a surface that adopted the attempted value instead would draw a revoke
 * that never took effect. The daemon mirror's own verdict is a *separate* fact and is kept
 * separately ({@link mirrorRefused}); the two can disagree, and the privacy page shows both.
 */
export interface CapabilityWrite {
  ledger: PermissionLedger;
  /** Did the local (`amos.permissions`) write land? `true` also for an idempotent no-op. */
  landed: boolean;
}

/**
 * Grant `cap` to `appId`: persist locally, then mirror to the daemon.
 *
 * Idempotent — a cap that is already held returns the unchanged ledger and
 * **does not** call the daemon. Repeated default-on seeds during a single boot
 * therefore fire exactly one mirror per newly-added pair, and a re-boot of an
 * already-default-on install fires none.
 */
export function grantCapability(appId: string, cap: Capability): CapabilityWrite {
  const prev = loadLedger();
  const next = grantCap(prev, appId, cap);
  // Same reference ⇒ no work done (idempotent grantCap). Skip both write and
  // daemon mirror so the audit log stays honest about which boot wrote what. The store
  // already holds this ledger, so the write is satisfied without one.
  if (next === prev) return { ledger: next, landed: true };
  const landed = saveLedger(next);
  mirrorWrite(appId, cap, daemonGrant);
  return { ledger: landed ? next : prev, landed };
}

/** Revoke `cap` from `appId`: persist locally, then mirror to the daemon. */
export function revokeCapability(appId: string, cap: Capability): CapabilityWrite {
  const prev = loadLedger();
  const next = revokeCap(prev, appId, cap);
  const landed = saveLedger(next);
  mirrorWrite(appId, cap, daemonRevoke);
  return { ledger: landed ? next : prev, landed };
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

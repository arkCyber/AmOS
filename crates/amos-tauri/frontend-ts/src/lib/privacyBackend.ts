/**
 * Typed client for the daemon's authoritative OS-permission store
 * (`amos-ai::privacy` behind `PrivacyService`, see `crates/amos-tauri/src/
 * privacy_client.rs`). This is the seam the OS gates will call *instead of*
 * trusting the local ledger alone: `daemonAuthorize` is the single chokepoint
 * the daemon audits, and a grant/revoke here is authoritative (persisted by the
 * daemon when it has a state file).
 *
 * Capability ↔ daemon resource alignment: `camera`/`microphone`/`location`/
 * `contacts`/`storage` map 1:1 to the daemon's stable wire keys; `notifications`
 * is **local-only** (no daemon resource) and maps to `null`.
 *
 * Offline contract (mirrors `lib/backend.ts`): outside Tauri — or when the
 * daemon command fails — every call returns `null`, so the UI can show a
 * localized "daemon not connected" state and fall back to the local ledger cache
 * rather than silently granting or crashing.
 */
import { bridged, invoke } from "./backend";
import type { Capability } from "./permissions";

/** The subset of capabilities backed by a daemon `Resource` wire key. */
export type WireResource =
  | "camera"
  | "microphone"
  | "contacts"
  | "location"
  | "storage";

/** Map a UI capability to its daemon resource wire key (null = local-only). */
export function daemonResource(cap: Capability): WireResource | null {
  switch (cap) {
    case "camera":
      return "camera";
    case "microphone":
      return "microphone";
    case "location":
      return "location";
    case "contacts":
      return "contacts";
    case "storage":
      return "storage";
    case "notifications":
      return null;
  }
}

/** True when the app holds the capability per the daemon. Null offline. */
export async function daemonAuthorize(
  appId: string,
  cap: Capability,
): Promise<boolean | null> {
  const resource = daemonResource(cap);
  if (!resource) return null; // local-only (notifications): no daemon gate
  return invoke<boolean>("perm_authorize", { appId, resource });
}

/**
 * Submit an authoritative grant to the daemon. The Rust command returns unit
 * (JSON `null`), so we can't distinguish "confirmed" from "resolved to null":
 * return `true` when we're bridged and the request was submitted (the daemon
 * persists best-effort), `null` when offline / local-only capability.
 */
export async function daemonGrant(
  appId: string,
  cap: Capability,
): Promise<boolean | null> {
  const resource = daemonResource(cap);
  if (!resource) return null;
  if (!bridged()) return null;
  await invoke<null>("perm_grant", { appId, resource });
  return true;
}

/** Submit an authoritative revoke to the daemon (same semantics as grant). */
export async function daemonRevoke(
  appId: string,
  cap: Capability,
): Promise<boolean | null> {
  const resource = daemonResource(cap);
  if (!resource) return null;
  if (!bridged()) return null;
  await invoke<null>("perm_revoke", { appId, resource });
  return true;
}

/** One normalized daemon audit record (mirrors `permission_client::PermissionAudit`). */
export interface DaemonAuditRecord {
  ts: number;
  principal: string;
  op: string;
  resource: string;
  outcome: string; // "granted" | "denied" | "success" | "rejected" | "error"
  details: string;
}

/**
 * Fetch the daemon's recent audited decisions (newest first) for the Privacy
 * dashboard's "recent access" view. Optional app/resource filter; `limit`
 * defaults to 20. Returns `null` offline / when the daemon command fails.
 */
export async function daemonRecentAudit(
  limit = 20,
  opts?: { appId?: string; resource?: WireResource | "" },
): Promise<DaemonAuditRecord[] | null> {
  if (!bridged()) return null;
  return invoke<DaemonAuditRecord[]>("perm_recent_audit", {
    appId: opts?.appId ?? "",
    resource: opts?.resource ?? "",
    limit,
  });
}

/** A display-ready view of one audit record (pure: no i18n / clock). */
export interface AuditView {
  appId: string;
  resource: string;
  granted: boolean;
  outcome: string;
  ts: number;
}

/** Map raw daemon audit records to display views (pure, newest-first preserved). */
export function toAuditViews(records: DaemonAuditRecord[]): AuditView[] {
  return records.map((r) => ({
    appId: r.principal,
    resource: r.resource,
    granted: r.outcome === "granted",
    outcome: r.outcome,
    ts: r.ts,
  }));
}


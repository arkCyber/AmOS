/**
 * Durable OS permission ledger.
 *
 * A third-party (store) or built-in app can hold a set of sensitive
 * *capabilities* it has been granted (camera / microphone / location /
 * notifications). This module is the single source of truth for those grants,
 * persisted under `amos.permissions` in the shared store — which, since the
 * durable-store work, writes through to disk (`~/.amos/state.json`) so grants
 * survive restarts and are readable by Rust.
 *
 * The core operations are pure & immutable (easy to test / reason about); the
 * `load/save` helpers read & write the durable ledger. Enforcement (gating
 * actual camera/mic/location calls behind `capSet`) is the caller's job and
 * will be wired to a permission request/deny flow + a privacy dashboard next.
 */
import { readStoreValue, writeStoreValue } from "./amosStore";

/** A sensitive capability an app may request. */
export type Capability = "camera" | "microphone" | "location" | "notifications";

/** Every capability the OS knows about (drives dashboards / prompts). */
export const CAPABILITIES: readonly Capability[] = [
  "camera",
  "microphone",
  "location",
  "notifications",
];

/** An app's display name key — a stable app id (built-in id or `store:<mid>`). */
export type AppId = string;

/** Ledger shape: app id → the capabilities it has been granted. */
export type PermissionLedger = Record<AppId, Capability[]>;

/** Shared-store key under which the ledger is persisted (now durable on disk). */
export const PERMISSIONS_KEY = "amos.permissions";

function isCapability(v: unknown): v is Capability {
  return typeof v === "string" && (CAPABILITIES as readonly string[]).includes(v);
}

/** Keep only well-formed entries (known caps, deduped). Unknown keys are dropped. */
export function normalizeLedger(raw: unknown): PermissionLedger {
  if (!raw || typeof raw !== "object") return {};
  const out: PermissionLedger = {};
  for (const [app, caps] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(caps)) continue;
    const clean = caps.filter(isCapability);
    const unique = [...new Set(clean)];
    if (app.trim() !== "" && unique.length > 0) out[app] = unique;
  }
  return out;
}

/** Whether `app` holds `cap`. */
export function capSet(ledger: PermissionLedger, app: AppId, cap: Capability): boolean {
  return (ledger[app] ?? []).includes(cap);
}

/** The capabilities `app` holds (copy). */
export function grantedCaps(ledger: PermissionLedger, app: AppId): Capability[] {
  return [...(ledger[app] ?? [])];
}

/** Apps currently holding `cap` (sorted, stable). */
export function grantedApps(ledger: PermissionLedger, cap: Capability): AppId[] {
  return Object.entries(ledger)
    .filter(([, caps]) => caps.includes(cap))
    .map(([app]) => app)
    .sort();
}

/** Grant `cap` to `app` (immutable; no-op if already granted). */
export function grantCap(ledger: PermissionLedger, app: AppId, cap: Capability): PermissionLedger {
  if (capSet(ledger, app, cap)) return ledger;
  const next: PermissionLedger = { ...ledger };
  next[app] = [...(ledger[app] ?? []), cap];
  return next;
}

/** Revoke `cap` from `app` (immutable; removes the entry when empty). */
export function revokeCap(ledger: PermissionLedger, app: AppId, cap: Capability): PermissionLedger {
  const next: PermissionLedger = { ...ledger };
  const remaining = (ledger[app] ?? []).filter((c) => c !== cap);
  if (remaining.length === 0) {
    delete next[app];
  } else {
    next[app] = remaining;
  }
  return next;
}

/** Load the ledger from the (durable) shared store. */
export function loadLedger(): PermissionLedger {
  return normalizeLedger(readStoreValue<PermissionLedger>(PERMISSIONS_KEY, {}));
}

/** Persist the ledger to the (durable) shared store. */
export function saveLedger(ledger: PermissionLedger): void {
  writeStoreValue(PERMISSIONS_KEY, normalizeLedger(ledger));
}

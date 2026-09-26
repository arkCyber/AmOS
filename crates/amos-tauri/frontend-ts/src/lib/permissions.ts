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
import { readStoreValue, writeStoreValueChecked } from "./amosStore";

/**
 * Every capability the OS knows about (drives dashboards / prompts).
 *
 * **This array is the one declaration.** {@link Capability} is *derived* from it
 * (`(typeof CAPABILITIES)[number]`), so the vocabulary cannot be spelled twice and
 * drift. It used to be two hand-written spellings of the same six strings — a union
 * type plus this array — joined only by an `as readonly string[]` membership test
 * that hid the split from the checker (a string in one but not the other still
 * compiled). `permissions.test.ts` now freezes the values and cross-checks the five
 * daemon-mirrored keys against `amos-ai::privacy::Resource` in Rust.
 *
 * The vocabulary mirrors the daemon's `amos-ai::privacy::Resource` wire keys for
 * the OS resources that the daemon gate-keeps (`camera` / `microphone` /
 * `location` / `contacts` / `storage`). `notifications` is a **local-only**
 * capability — it has no daemon resource and is not part of the OS permission
 * store (see `lib/privacyBackend.ts`).
 */
export const CAPABILITIES = [
  "camera",
  "microphone",
  "location",
  "contacts",
  "storage",
  "notifications",
] as const;

/**
 * A sensitive capability an app may request — an element of {@link CAPABILITIES}.
 *
 * Derived, not hand-written: an add/rename is one edit, and the membership check
 * in {@link normalizeLedger} can no longer silently disagree with the type.
 */
export type Capability = (typeof CAPABILITIES)[number];

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

/**
 * Persist the ledger to the (durable) shared store, and report whether it **landed**.
 *
 * The answer is not optional bookkeeping: `amos.permissions` is what every gate in the OS
 * reads back (`loadLedger`), so a refused write means the change the user just made is not
 * the change the next boot will enforce — a revoke that did not land leaves the capability
 * granted. Callers that *show* the ledger must therefore adopt this verdict
 * (`svelte/osPermissions`), not the value they attempted to write.
 */
export function saveLedger(ledger: PermissionLedger): boolean {
  return writeStoreValueChecked(PERMISSIONS_KEY, normalizeLedger(ledger));
}

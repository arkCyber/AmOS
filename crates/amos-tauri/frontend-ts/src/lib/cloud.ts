/**
 * iCloud-style "cloud sync" for the Settings screen: a persisted on/off pref
 * plus a deterministic backup snapshot of the user-data stores. Pure + headless,
 * so the toggle and snapshot logic are unit-testable.
 */

import { NOTES_KEY } from "./notes";
import { FILES_KEY, FILES_FAV_KEY } from "./files";
import { PHOTOS_KEY } from "./photos";
import { CAPTURES_KEY } from "./cameraCapture";
import { CONV_KEY } from "./messages";
import { DRAFT_KEY } from "./smsDrafts";
import { MUSIC_KEY } from "./music";
import { VMEMOS_KEY } from "./voiceMemos";
import { LISTS_KEY, REMINDERS_KEY } from "./reminders";
import { CONTACTS_KEY } from "./contacts";
import { CALENDAR_KEY, CALENDARS_KEY } from "./calendar";
import { ALARM_KEY } from "./alarmCore";
import { CALLLOG_KEY } from "./calllog";
import { INTERP_LOG_KEY } from "./interp";

export const SETTINGS_KEY = "amos.settings";
export const BACKUP_KEY = "amos.cloud.backup";
/**
 * The user-data stores included in a backup snapshot.
 *
 * Every entry is the **same exported key constant its own module writes** — the
 * list must never re-spell a store key. A stale literal here silently drops the
 * store from every backup, which had happened twice: `amos.files.fav` never
 * matched `FILES_FAV_KEY` (`amos.files.favorites`), and the legacy
 * `amos.messages` never matched the conversations store MessagesApp actually
 * writes (`CONV_KEY` = `amos.messages.convs`) — so file favourites and all
 * message threads were omitted from the snapshot.
 *
 * The **rule** (enforced by `scripts/store-scan.mjs`): a store belongs here when
 * losing it would lose *content the user created*. Configuration/UI state,
 * derived bookkeeping (fired flags, index ids), device mirrors (wifi, bluetooth,
 * …) and this backup itself are listed in `scripts/store-allowlist.json` with a
 * reason instead — so a **new** store key fails `make lint` until someone
 * classifies it, rather than silently missing every backup. Round 50 extended the
 * list from 8 to 17: contacts, calendar events + calendars, alarms, the call log,
 * voice memos, in-app captures, SMS drafts and the interpreter transcript were
 * user content that the snapshot used to omit while the Settings hint promised
 * "data is snapshotted".
 */
export const SYNC_STORES = [
  NOTES_KEY,
  FILES_KEY,
  FILES_FAV_KEY,
  PHOTOS_KEY,
  CAPTURES_KEY,
  CONV_KEY,
  DRAFT_KEY,
  MUSIC_KEY,
  VMEMOS_KEY,
  REMINDERS_KEY,
  LISTS_KEY,
  CONTACTS_KEY,
  CALENDAR_KEY,
  CALENDARS_KEY,
  ALARM_KEY,
  CALLLOG_KEY,
  INTERP_LOG_KEY,
] as const;

export interface CloudPrefs {
  enabled: boolean;
  /** Epoch ms of the last successful snapshot (0 = never). */
  lastSync: number;
}

/** Read {enabled,lastSync} out of a settings blob (tolerant of garbage). */
export function readCloud(prefs: Record<string, unknown> | null | undefined): CloudPrefs {
  if (!prefs || typeof prefs !== "object") return { enabled: false, lastSync: 0 };
  const o = prefs as Record<string, unknown>;
  return {
    enabled: o.iCloudSync === true,
    lastSync: typeof o.cloudLast === "number" && Number.isFinite(o.cloudLast) ? (o.cloudLast as number) : 0,
  };
}

/** Set one or more cloud prefs on a settings blob (returns a fresh object). */
export function setCloudPrefs(
  prefs: Record<string, unknown>,
  partial: Partial<CloudPrefs>,
): Record<string, unknown> {
  const base =
    prefs && typeof prefs === "object" && !Array.isArray(prefs) ? prefs : {};
  const next = { ...base };
  if (partial.enabled !== undefined) next.iCloudSync = partial.enabled;
  if (partial.lastSync !== undefined) next.cloudLast = partial.lastSync;
  return next;
}

/** Format version of the backup envelope written by `snapshotStores`. Bump it when
 *  the blob's shape changes, so an older build can **refuse** a blob it cannot
 *  safely interpret instead of writing mismatched data back over live stores. */
export const BACKUP_VERSION = 1;

/**
 * Deterministic snapshot: an **envelope** carrying the format version, the moment
 * the backup was taken, and the stores keyed by fixed order.
 *
 * The timestamp lives *inside* the blob on purpose: "when was this backup taken?"
 * is a property **of the backup**, not of a separate settings pref that can outlive
 * it — a cleared or corrupt blob used to leave the page still claiming "last synced
 * 10:02". `at` is passed in (never read from the clock) so the output stays pure and
 * byte-stable for a given input.
 */
export function snapshotStores(stores: Record<string, unknown>, at: number): string {
  const out: Record<string, unknown> = {};
  for (const k of SYNC_STORES) {
    const v = stores[k];
    if (v !== undefined) out[k] = v;
  }
  return JSON.stringify({ v: BACKUP_VERSION, at, stores: out });
}

/** What a backup blob holds: how many `SYNC_STORES` entries it carries (`stores`),
 *  how many of those actually hold something (`filled`), the size of the list it is
 *  measured against (`total`, so the UI can say `filled/total`), plus the blob's own
 *  metadata — `at` (epoch ms, `null` for a legacy blob that carried none) and `v`
 *  (format version, `null` for legacy). */
export interface BackupSummary {
  stores: number;
  filled: number;
  total: number;
  at: number | null;
  v: number | null;
}

/** Why a restore declined to run. `malformed` = unreadable/absent blob;
 *  `unsupported-version` = a blob written by a **newer** AmOS. */
export type RestoreFailure = "malformed" | "unsupported-version";

/** What a restore did. `ok: false` (with a `reason`) means **nothing was written**
 *  — a corrupt or too-new backup must never blank the user's stores. `restored` and
 *  `failed` are what the **writer confirmed**: a store whose write was rejected
 *  (full/unavailable storage) is reported in `failed`, never counted as restored.
 *  `refused` lists keys the blob carried that are not backup-eligible content stores
 *  — a crafted backup cannot re-grant a capability (`amos.permissions`), move a radio
 *  (`amos.wifi`) or invent a brand-new store. */
export interface RestoreReport {
  ok: boolean;
  restored: string[];
  failed: string[];
  refused: string[];
  reason?: RestoreFailure;
}

/** The store writer a restore drives. It **must** report whether the value landed:
 *  an attempt that cannot be confirmed is not a restore. */
export type RestoreWriter = (key: string, value: unknown) => boolean;

/** A stored value that carries nothing: absent/null, empty array, empty string or
 *  an object with no keys. (The Settings snapshot writes the caller's `[]` default
 *  for stores the user never touched, so most of a fresh backup is empty.) */
function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "string") return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/** Decode `raw` (a JSON string, as written to `BACKUP_KEY`, or an already-parsed
 *  object) into a plain object — or `null` when it is absent/malformed/not an
 *  object. An *empty* object is a valid decode (`{}`), which is how a caller tells
 *  "this backup carried nothing" apart from "this backup is corrupt". */
function asBackupObject(raw: unknown): Record<string, unknown> | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** A blob split into its metadata + store map. `v`/`at` are `null` for a **legacy**
 *  (pre-envelope) blob, which was a bare store-key → value map with no metadata.
 *  Legacy blobs stay readable, so shipping the envelope does not brick an existing
 *  backup. */
interface BackupEnvelope {
  v: number | null;
  at: number | null;
  stores: Record<string, unknown>;
}

/** Decode a blob into its envelope, or `null` when it is corrupt/absent. The
 *  envelope's `stores` key cannot collide with a legacy store key: store keys are
 *  always `amos.*` / `amos-ui.*`. */
function readEnvelope(raw: unknown): BackupEnvelope | null {
  const obj = asBackupObject(raw);
  if (obj === null) return null;
  const inner = obj.stores;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const v = typeof obj.v === "number" && Number.isFinite(obj.v) ? obj.v : null;
    const at =
      typeof obj.at === "number" && Number.isFinite(obj.at) && obj.at > 0 ? obj.at : null;
    return { v, at, stores: inner as Record<string, unknown> };
  }
  return { v: null, at: null, stores: obj };
}

/** Read a backup blob into the store-key → value map, keeping **only**
 *  `SYNC_STORES` keys (in snapshot order) and `null` for a corrupt blob. */
export function parseBackup(raw: unknown): Record<string, unknown> | null {
  const env = readEnvelope(raw);
  if (env === null) return null;
  const out: Record<string, unknown> = {};
  for (const k of SYNC_STORES) if (env.stores[k] !== undefined) out[k] = env.stores[k];
  return out;
}

/** Describe what a backup holds (with the blob's own timestamp/version), or `null`
 *  when it is corrupt/absent. */
export function summarizeBackup(raw: unknown): BackupSummary | null {
  const env = readEnvelope(raw);
  if (env === null) return null;
  const parsed = parseBackup(raw) ?? {};
  const values = Object.values(parsed);
  return {
    stores: Object.keys(parsed).length,
    filled: values.filter((v) => !isEmptyValue(v)).length,
    total: SYNC_STORES.length,
    at: env.at,
    v: env.v,
  };
}

/**
 * Restore a backup through `write` (the caller's store writer — injected so the
 * logic stays pure/headless). Only `SYNC_STORES` keys are written, in snapshot
 * order; every other key the blob carries is reported in `refused` and left alone.
 *
 * The writer's answer is **honoured**: a store it could not store (full/unavailable
 * storage) is reported in `failed`, not counted as restored — a restore that claims
 * stores it never wrote is the same lie as a backup that was never stored.
 *
 * Writes **nothing** — and says why — when the blob is malformed (`reason:
 * "malformed"`) or was written by a newer format than this build understands
 * (`reason: "unsupported-version"`; applying a future shape would write mismatched
 * data over live stores).
 */
export function restoreStores(raw: unknown, write: RestoreWriter): RestoreReport {
  const env = readEnvelope(raw);
  if (env === null) return { ok: false, restored: [], failed: [], refused: [], reason: "malformed" };
  if (env.v !== null && env.v > BACKUP_VERSION) {
    return { ok: false, restored: [], failed: [], refused: [], reason: "unsupported-version" };
  }
  const eligible = new Set<string>(SYNC_STORES);
  const restored: string[] = [];
  const failed: string[] = [];
  for (const k of SYNC_STORES) {
    if (env.stores[k] === undefined) continue;
    if (write(k, env.stores[k])) restored.push(k);
    else failed.push(k);
  }
  const refused = Object.keys(env.stores)
    .filter((k) => !eligible.has(k))
    .sort();
  return { ok: true, restored, failed, refused };
}

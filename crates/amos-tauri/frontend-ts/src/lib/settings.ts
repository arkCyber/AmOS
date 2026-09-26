import { readStoreValue, writeStoreValueChecked } from "./amosStore";
import { localId } from "./localId";

/** The radios that go through the real `radio_*` backend (wifi / bluetooth / airplane / hotspot). */
export type RadioKey = "wifi" | "bluetooth" | "airplane" | "hotspot";

/** Persisted quick-settings shape (same keys as the legacy amos.settings). */
export type QuickSettings = Partial<Record<QuickKey, boolean>>;

export const NOTIF_KEY = "amos.notifications";
export const SETTINGS_KEY = "amos.settings";

/** Durable torch (illumination) store key — distinct from the preference
 * quick-settings because the torch is ephemeral hardware state, not a setting. */
export const FLASHLIGHT_KEY = "amos.flashlight";

/** Durable shape of the torch store (mirrors the Rust FlashlightPayload). */
export interface FlashlightStore {
  /** Whether the torch is currently lit. */
  on: boolean;
  /** Whether this device actually has a usable torch (rear camera + flash). */
  torch_present: boolean;
}

/** Upper bound on in-memory notifications after normalization. Guards against a
 * pathologically large/bogus store being rendered in full on every open. */
export const NOTIF_CAP = 100;

/** Where a notification came from. The shell's own producers (alarm / timer /
 * reminder / telemetry-spy …) are `"system"`; a remote push delivery is `"push"`.
 * Absent means `"system"`, so every value written before this field existed keeps
 * its old meaning. */
export type NotifSource = "system" | "push";

export interface Notif {
  id: string;
  app?: string;
  title?: string;
  body?: string;
  icon?: string;
  time: number;
  /** Producer. Omitted = the shell made it (`"system"`). */
  source?: NotifSource;
  /** Read state. Only a **push** record carries the device's own flag; shell-made
   * notifications have none (they are *removed* when opened — see
   * `removeAppNotifs`), so "no flag" is not the same as "unread". */
  read?: boolean;
  /** App-icon badge count carried by a push payload (absolute value). */
  badge?: number;
}

/** Pure: flip one quick-toggle boolean (immutable). */
export function flipQuick(s: QuickSettings, key: QuickKey): QuickSettings {
  return { ...s, [key]: !s[key] };
}

/** True when the torch is currently lit in the store. */
export function torchOn(s: FlashlightStore): boolean {
  return s.on && s.torch_present;
}

/** Pure: flip the torch on/off, mirroring the backend's on/off bit (immutable).
 * Hardware presence is untouched — flipping never invents a torch. */
export function flipFlashlight(s: FlashlightStore): FlashlightStore {
  return { ...s, on: !s.on };
}

/** Corruption guard for the torch store. Defaults to a device that *has* a torch
 * (so the control-center tile works offline) but is dark. */
export function normalizeFlashlight(v: unknown): FlashlightStore {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { on: false, torch_present: true };
  const o = v as Record<string, unknown>;
  return {
    on: typeof o.on === "boolean" ? o.on : false,
    torch_present: typeof o.torch_present === "boolean" ? o.torch_present : true,
  };
}

/**
 * Pure: flip one *radio* toggle, mirroring the Rust `RadioManager` policy used
 * when the Tauri backend is available (so an unbridged UI behaves identically):
 * - Turning Airplane mode ON cascades Wi-Fi + Bluetooth + the Wi-Fi AP (personal
 *   hotspot) off.
 * - Wi-Fi / Bluetooth / hotspot cannot be switched on while Airplane mode is active
 *   (the click is a no-op).
 * Returns a new object; never mutates the input.
 */
export function flipRadio(s: QuickSettings, key: RadioKey): QuickSettings {
  if (key === "airplane") {
    const on = !s.airplane;
    if (!on) return { ...s, airplane: false };
    return { ...s, airplane: true, wifi: false, bluetooth: false, hotspot: false };
  }
  // wifi / bluetooth / hotspot — gated by airplane mode.
  if (s.airplane) return s;
  return { ...s, [key]: !s[key] };
}

export function removeNotif(list: Notif[], id: string): Notif[] {
  return list.filter((n) => n.id !== id);
}

/**
 * Remove every notification whose `app` is **exactly** `appName` (open = read).
 *
 * This is the row's own display string, never a name resolved from an app id: the callers
 * that use it (the two banners, the desktop notification centre) hold a specific row and
 * drop its siblings, so an exact-string match is both correct and locale-safe. Dropping rows
 * by app **id** — where the id must be recovered from a display string in any locale — is
 * `lib/notifApp.ts::withoutAppNotifs`, which is what the producers use.
 */
export function removeAppNotifs(list: Notif[], appName: string): Notif[] {
  return list.filter((n) => n.app !== appName);
}

/**
 * Every notification whose `app` is **exactly** `appName` — the rows {@link removeAppNotifs}
 * drops, named from the same single predicate instead of being re-filtered by each caller.
 *
 * The callers that need the dropped set are the ones that must also **relay** the removal to
 * the device: `amos.notifications` is a projection of the device's push history
 * (`osPushWatcher` re-reads it every few seconds and writes back anything the store no longer
 * holds), so a push row removed only locally is resurrected by the next poll — and the
 * arrival banner then reports the same delivery arriving a second time (REQ-A1260).
 */
export function droppedAppNotifs(list: Notif[], appName: string): Notif[] {
  return list.filter((n) => n.app === appName);
}

/**
 * A new notification-centre row id (REQ-A401).
 *
 * The shell-produced notifications (phone / contacts call banners, reminder & calendar
 * alerts, telemetry-spy hits …) all need an id, and the store treats it as identity:
 * `normalizeNotifs` **drops rows whose id repeats**, and `newestAddedNotif` decides what
 * "just arrived" means by comparing id sets — so a repeated id makes a real notification
 * invisible after a reload (and silent when it was shown). Sites that used to inline
 * `Date.now()` + five random digits call this instead.
 */
export function newNotifId(): string {
  return localId("notif");
}

/** Prepend one notification, newest-first, capped at `NOTIF_CAP` (immutable). */
export function addNotif(list: Notif[], n: Notif): Notif[] {
  return [n, ...list].slice(0, NOTIF_CAP);
}

/** The notification (by id) that exists in `curr` but not `prev` — i.e. the one
 * that just arrived. Newest by time wins. `null` when nothing was added. */
export function newestAddedNotif(prev: Notif[], curr: Notif[]): Notif | null {
  const prevIds = new Set(prev.map((n) => n.id));
  const added = curr.filter((n) => !prevIds.has(n.id));
  if (added.length === 0) return null;
  return added.reduce((a, b) => (b.time >= a.time ? b : a));
}

/**
 * The known quick-toggle keys, for validating persisted settings. The array is the one
 * declaration; {@link QuickKey} derives from it, so the validator and the type agree.
 */
const QUICK_KEYS = [
  "wifi",
  "bluetooth",
  "airplane",
  "hotspot",
  "darkmode",
  "dnd",
  "location",
] as const;
export type QuickKey = (typeof QUICK_KEYS)[number];

/** System location-services master switch: ON by default; only an explicit OFF
 * disables location system-wide (regardless of per-app grants). */
export function locationEnabled(s: QuickSettings): boolean {
  return s.location !== false;
}

/** Do-Not-Disturb: OFF by default; when ON, unread badges are hidden and
 * notifications are presented muted. */
export function dndActive(s: QuickSettings): boolean {
  return !!s.dnd;
}

/** Toggle the location master (defaults to ON, so the first tap turns it OFF). */
export function flipLocation(s: QuickSettings): QuickSettings {
  return { ...s, location: !locationEnabled(s) };
}

/** Corruption guard for quick settings: returns an object containing only the
 * known boolean keys, ignoring anything else / non-object input.
 *
 * This is a **read-side** guard. Its result must never be written back to
 * `amos.settings` — it is a narrowing, and that key is a union blob. Use
 * {@link saveQuick} for every quick write. */
export function normalizeQuick(v: unknown): QuickSettings {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const out: QuickSettings = {};
  for (const k of QUICK_KEYS) {
    if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
  }
  return out;
}

/**
 * Apply a **narrowed** quick-settings update onto the raw `amos.settings` blob.
 *
 * `amos.settings` is a union blob: the quick booleans **plus** what other modules
 * keep there — `aiProvider` / `aiModel` / `aiEndpoint` (`lib/providers.ts`) and
 * `iCloudSync` / `cloudLast` (`lib/cloud.ts`). Those writers spread the object they
 * read, so they preserve each other's keys; a caller that writes a `normalizeQuick`
 * **result** keeps only `QUICK_KEYS` and erases the rest of the user's settings.
 *
 * The merge is over the raw blob rather than a normalized one because the point is
 * to carry the keys this module does not own through untouched; a corrupt blob that
 * is not an object is treated as empty, exactly as {@link normalizeQuick} does.
 */
export function mergeSettings(raw: unknown, quick: QuickSettings): Record<string, unknown> {
  const base =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { ...base, ...quick };
}

/**
 * Persist a quick-settings change onto `amos.settings` and hand back the store's verdict.
 *
 * Every quick write goes through here: the value handed in is the narrowed flip
 * (`flipQuick` ∕ `flipRadio` ∕ a single-key literal), and the raw blob underneath it is
 * preserved. Writing the narrowed value directly is what erased `aiProvider` ∕
 * `iCloudSync` from the blob for the whole OS (REQ-A1397 ∕ FMEA F-SH-656).
 */
export function saveQuick(quick: QuickSettings): boolean {
  const raw = readStoreValue<unknown>(SETTINGS_KEY, {});
  return writeStoreValueChecked(SETTINGS_KEY, mergeSettings(raw, quick));
}

/** Corruption guard for the notifications store: keeps entries with a usable id +
 * numeric time, preserves valid optional fields (including the push-only
 * `source`/`read`/`badge`), and de-duplicates ids. */
export function normalizeNotifs(v: unknown): Notif[] {
  if (!Array.isArray(v)) return [];
  const out: Notif[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id === "") continue;
    if (typeof o.time !== "number" || !Number.isFinite(o.time)) continue;
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    const n: Notif = { id: o.id, time: o.time };
    for (const f of ["app", "title", "body", "icon"] as const) {
      if (typeof o[f] === "string") n[f] = o[f] as string;
    }
    // Push-only fields. Each is validated on its own so a bogus one cannot take
    // the rest of a legitimate notification down with it.
    if (o.source === "push" || o.source === "system") n.source = o.source;
    if (typeof o.read === "boolean") n.read = o.read;
    if (typeof o.badge === "number" && Number.isFinite(o.badge)) n.badge = o.badge;
    out.push(n);
  }
  // The store is **newest-first** (`addNotif` prepends; `osTimerWatcher`, `alarmCore`,
  // `calendarCore`, `reminderCore`, `shortcuts` and `mergePushHistory` all keep the head), so
  // the cap must drop the *oldest* rows — it must not keep the tail.
  //
  // Which rows those are is decided by `time`, not by array position: two writers (`MailApp`,
  // `MessagesApp`) *append* their fresh rows rather than prepending, so an over-cap store need
  // not be in canonical order. `time` is the one field every surviving row carries (a row
  // without a finite numeric `time` is already dropped above), and `mergePushHistory` sorts its
  // additions the same way. Within the cap the caller's order is preserved untouched (REQ-A1940).
  if (out.length <= NOTIF_CAP) return out;
  return out.sort((a, b) => b.time - a.time).slice(0, NOTIF_CAP);
}

/** Pure: mark one notification read (immutable). Absent id / already-read is a
 * no-op returning a **new** array, so callers can always treat it as a value. */
export function markNotifRead(list: Notif[], id: string): Notif[] {
  return list.map((n) => (n.id === id && n.read !== true ? { ...n, read: true } : n));
}

/** Pure: how many notifications carry an explicit **unread** push flag. Shell-made
 * notifications have no flag and are *not* counted (they are removed when opened,
 * so counting them would show a badge that never clears). */
export function unreadCount(list: Notif[]): number {
  let n = 0;
  for (const item of list) if (item.read === false) n++;
  return n;
}


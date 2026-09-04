export type QuickKey = "wifi" | "bluetooth" | "airplane" | "darkmode" | "dnd" | "location";

/** The radios that go through the real `radio_*` backend (wifi / bluetooth / airplane). */
export type RadioKey = "wifi" | "bluetooth" | "airplane";

/** Persisted quick-settings shape (same keys as the legacy amos.settings). */
export type QuickSettings = Partial<Record<QuickKey, boolean>>;

export const NOTIF_KEY = "amos.notifications";
export const SETTINGS_KEY = "amos.settings";

/** Upper bound on in-memory notifications after normalization. Guards against a
 * pathologically large/bogus store being rendered in full on every open. */
export const NOTIF_CAP = 100;

export interface Notif {
  id: string;
  app?: string;
  title?: string;
  body?: string;
  icon?: string;
  time: number;
}

/** Pure: flip one quick-toggle boolean (immutable). */
export function flipQuick(s: QuickSettings, key: QuickKey): QuickSettings {
  return { ...s, [key]: !s[key] };
}

/**
 * Pure: flip one *radio* toggle, mirroring the Rust `RadioManager` policy used
 * when the Tauri backend is available (so an unbridged UI behaves identically):
 * - Turning Airplane mode ON cascades Wi-Fi + Bluetooth off.
 * - Wi-Fi / Bluetooth cannot be switched on while Airplane mode is active (the
 *   click is a no-op).
 * Returns a new object; never mutates the input.
 */
export function flipRadio(s: QuickSettings, key: RadioKey): QuickSettings {
  if (key === "airplane") {
    const on = !s.airplane;
    if (!on) return { ...s, airplane: false };
    return { ...s, airplane: true, wifi: false, bluetooth: false };
  }
  // wifi / bluetooth — gated by airplane mode.
  if (s.airplane) return s;
  return { ...s, [key]: !s[key] };
}

/** A visible status-bar indicator derived from quick-settings radio bits.
 * Airplane mode supersedes the wifi/bluetooth indicators (they're forced off). */
export function radioIcons(s: QuickSettings): { kind: RadioKey; on: boolean }[] {
  if (s.airplane) return [{ kind: "airplane", on: true }];
  return [
    { kind: "wifi", on: !!s.wifi },
    { kind: "bluetooth", on: !!s.bluetooth },
  ];
}

/**
 * Combine the radio toggle bits with the browser's real connectivity report: a
 * Wi-Fi glyph only reads as "on" when Wi-Fi is enabled *and* the host is actually
 * online (airplane/bluetooth are unaffected). Pure + testable.
 */
export function applyConnectivity(
  icons: { kind: RadioKey; on: boolean }[],
  online: boolean,
): { kind: RadioKey; on: boolean }[] {
  return icons.map((ic) =>
    ic.kind === "wifi" ? { kind: ic.kind, on: ic.on && online } : ic,
  );
}

/** Seed a handful of notifications (same spirit as the legacy NC). */
export function seedNotifs(now: number): Notif[] {
  return [
    { id: "n1", app: "信息", icon: "💬", title: "小安", body: "Amos 系统感觉怎么样？", time: now },
    { id: "n2", app: "天气", icon: "🌤️", title: "今日天气", body: "北京 26° 多云", time: now - 3600e3 },
    { id: "n3", app: "AI 助手", icon: "🤖", title: "后台任务完成", body: "长文本推理已完成", time: now - 7200e3 },
  ];
}

export function removeNotif(list: Notif[], id: string): Notif[] {
  return list.filter((n) => n.id !== id);
}

/** Count notifications for an app (store uses display names, e.g. Chinese). */
export function countForApp(list: Notif[], appName: string): number {
  return list.filter((n) => n.app === appName).length;
}

/** Remove every notification belonging to an app (open = read). */
export function removeAppNotifs(list: Notif[], appName: string): Notif[] {
  return list.filter((n) => n.app !== appName);
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

/** The known quick-toggle keys, for validating persisted settings. */
const QUICK_KEYS: readonly QuickKey[] = [
  "wifi",
  "bluetooth",
  "airplane",
  "darkmode",
  "dnd",
  "location",
];

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
 * known boolean keys, ignoring anything else / non-object input. */
export function normalizeQuick(v: unknown): QuickSettings {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const out: QuickSettings = {};
  for (const k of QUICK_KEYS) {
    if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
  }
  return out;
}

/** Corruption guard for the notifications store: keeps entries with a usable id +
 * numeric time, preserves valid optional string fields, and de-duplicates ids. */
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
    out.push(n);
  }
  return out.length > NOTIF_CAP ? out.slice(out.length - NOTIF_CAP) : out;
}

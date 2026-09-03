export type QuickKey = "wifi" | "bluetooth" | "airplane" | "darkmode" | "dnd" | "location";

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

/** The known quick-toggle keys, for validating persisted settings. */
const QUICK_KEYS: readonly QuickKey[] = [
  "wifi",
  "bluetooth",
  "airplane",
  "darkmode",
  "dnd",
  "location",
];

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

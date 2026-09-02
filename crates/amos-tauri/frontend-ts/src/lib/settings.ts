export type QuickKey = "wifi" | "bluetooth" | "airplane" | "darkmode" | "dnd" | "location";

/** Persisted quick-settings shape (same keys as the legacy amos.settings). */
export type QuickSettings = Partial<Record<QuickKey, boolean>>;

export const NOTIF_KEY = "amos.notifications";
export const SETTINGS_KEY = "amos.settings";

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

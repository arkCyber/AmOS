/**
 * appMeta.ts — React-free built-in app metadata (single source of truth).
 *
 * id → { titleKey, icon } for the 22 built-in apps. This used to live inside the
 * React `apps.tsx`; extracting it here lets a Svelte shell / registry consume the
 * same data without pulling React, and `apps.tsx` re-exports it so nothing drifts.
 */
import type { MessageKey } from "../i18n/locales/zh";

export interface AppMeta {
  id: string;
  /** i18n key for the app's display name (also used as its title bar). */
  titleKey: MessageKey;
  icon: string;
}

/** The set of built-in apps (metadata only — no React). */
export const APP_META: AppMeta[] = [
  { id: "clock", titleKey: "app.clock", icon: "🕐" },
  { id: "settings", titleKey: "app.settings", icon: "⚙️" },
  { id: "calculator", titleKey: "app.calculator", icon: "🧮" },
  { id: "weather", titleKey: "app.weather", icon: "🌤️" },
  { id: "notes", titleKey: "app.notes", icon: "📝" },
  { id: "reminders", titleKey: "app.reminders", icon: "✅" },
  { id: "vmemos", titleKey: "app.vmemos", icon: "🎙️" },
  { id: "photos", titleKey: "app.photos", icon: "🖼️" },
  { id: "files", titleKey: "app.files", icon: "📁" },
  { id: "android", titleKey: "app.android", icon: "🤖" },
  { id: "messages", titleKey: "app.messages", icon: "💬" },
  { id: "phone", titleKey: "app.phone", icon: "📞" },
  { id: "music", titleKey: "app.music", icon: "🎵" },
  { id: "maps", titleKey: "app.maps", icon: "🗺️" },
  { id: "camera", titleKey: "app.camera", icon: "📷" },
  { id: "ai", titleKey: "app.ai", icon: "🤖" },
  { id: "interpreter", titleKey: "app.interpreter", icon: "🌐" },
  { id: "mail", titleKey: "app.mail", icon: "✉️" },
  { id: "store", titleKey: "app.store", icon: "🛍️" },
  { id: "privacy", titleKey: "app.privacy", icon: "🛡️" },
  { id: "contacts", titleKey: "app.contacts", icon: "👥" },
  { id: "magnifier", titleKey: "app.magnifier", icon: "🔍" },
];

export function appMetaById(id: string): AppMeta | undefined {
  return APP_META.find((a) => a.id === id);
}

export function appTitleKey(id: string): MessageKey | null {
  return appMetaById(id)?.titleKey ?? null;
}

/** Single source of truth for an app's tile icon (emoji). */
export function appIcon(id: string): string {
  return appMetaById(id)?.icon ?? "🧩";
}

export function isKnownApp(id: string): boolean {
  return appMetaById(id) !== undefined;
}

export function appIds(): string[] {
  return APP_META.map((a) => a.id);
}

/**
 * appMeta.ts — React-free built-in app metadata (single source of truth).
 *
 * id → { titleKey, icon } for the built-in apps. It was extracted out of the
 * (now removed) React registry so a Svelte shell / `svelte/appRegistry.ts` can
 * consume the same data without pulling React in.
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
  { id: "calendar", titleKey: "app.calendar", icon: "📅" },
  { id: "vmemos", titleKey: "app.vmemos", icon: "🎙️" },
  { id: "photos", titleKey: "app.photos", icon: "🖼️" },
  { id: "files", titleKey: "app.files", icon: "📁" },
  { id: "android", titleKey: "app.android", icon: "🤖" },
  { id: "messages", titleKey: "app.messages", icon: "💬" },
  { id: "phone", titleKey: "app.phone", icon: "📞" },
  { id: "music", titleKey: "app.music", icon: "🎵" },
  { id: "player", titleKey: "app.player", icon: "▶️" },
  { id: "maps", titleKey: "app.maps", icon: "🗺️" },
  { id: "camera", titleKey: "app.camera", icon: "📷" },
  { id: "ai", titleKey: "app.ai", icon: "🤖" },
  { id: "interpreter", titleKey: "app.interpreter", icon: "🌐" },
  { id: "mail", titleKey: "app.mail", icon: "✉️" },
  { id: "store", titleKey: "app.store", icon: "🛍️" },
  { id: "pwa", titleKey: "app.pwa", icon: "📦" },
  { id: "nativeapps", titleKey: "app.nativeapps", icon: "🪟" },
  { id: "privacy", titleKey: "app.privacy", icon: "🛡️" },
  { id: "contacts", titleKey: "app.contacts", icon: "👥" },
  { id: "magnifier", titleKey: "app.magnifier", icon: "🔍" },
  { id: "monitor", titleKey: "app.monitor", icon: "📈" },
  { id: "devocare", titleKey: "app.devocare", icon: "🧹" },
  { id: "terminal", titleKey: "app.terminal", icon: "🖥️" },
  { id: "webman", titleKey: "app.webman", icon: "🌐" },
  { id: "compass", titleKey: "app.compass", icon: "🧭" },
  { id: "measure", titleKey: "app.measure", icon: "📏" },
  { id: "health", titleKey: "app.health", icon: "❤️" },
  { id: "podcast", titleKey: "app.podcast", icon: "🎧" },
  { id: "shortcuts", titleKey: "app.shortcuts", icon: "⚡" },
  { id: "nfc", titleKey: "app.nfc", icon: "🏷️" },
  { id: "ble", titleKey: "app.ble", icon: "📶" },
  { id: "robot", titleKey: "app.robot", icon: "🦿" },
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

/**
 * The **reverse** of `appMetaById`: which built-in app *displays itself* as `name`?
 *
 * A stored notification names its sender as a display string, never as an app id — every
 * `addNotif` call site writes one (`zh["app.mail"]`, `bgT("app.clock")`, or a push
 * payload's free text). So "which app is this row from?" can only be answered backwards,
 * and one rule has to answer it for both consumers: the notification centre's
 * tap-to-open, and the Dock's unread badge.
 *
 * `dictionaries` is a **list** on purpose, and every locale is meant to be passed:
 * the timer / reminder / calendar producers resolve the name at push time via
 * `bgText.ts::bgT`, so a row written while the UI was Chinese keeps a Chinese name after
 * a switch to English. Resolving against the active locale alone would silently stop
 * finding it — and, worse, would make "open = read" (`removeAppNotifs`) miss its own rows.
 *
 * `null` means **no built-in app names itself that way** — a push payload's free-text
 * `app`, the telemetry spy's own label, a third-party id. That is the honest answer, and
 * the caller must render no affordance rather than invent one; there is no fuzzy match and
 * no fallback to the id, because either would open the wrong window.
 *
 * The name is trimmed first: a push payload is external input (the device-side bridge test
 * feeds `"  Mail  "`), and whitespace around a sender name is not a different sender.
 */
export function appIdForDisplayName(
  name: string | undefined,
  dictionaries: readonly Record<string, string>[],
): string | null {
  const trimmed = (name ?? "").trim();
  if (trimmed === "") return null;
  for (const meta of APP_META) {
    for (const dict of dictionaries) {
      if (dict[meta.titleKey] === trimmed) return meta.id;
    }
  }
  return null;
}

export function appIds(): string[] {
  return APP_META.map((a) => a.id);
}

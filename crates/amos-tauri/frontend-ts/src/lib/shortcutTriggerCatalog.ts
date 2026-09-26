/**
 * shortcutTriggerCatalog.ts — the trigger-type capability catalog.
 *
 * `TriggerType` (`shortcuts.ts`) declares **11** trigger types, but `triggerMatches`
 * can only ever fire the ones the host actually feeds a signal for. Today that is
 * four: `time` (the Rust ledger + the shell heartbeat), `wifi` (a change to the Wi-Fi
 * store, `STORE_CHANGED_EVENT` on `WIFI_KEY`), `app` (`APP_OPENED_EVENT`) and
 * `battery` (`watchHostBattery`).
 * The other seven are `default: false` branches in the matcher — no event source,
 * so they never match.
 *
 * That fact has to be said **somewhere the user can see**, or the editor would offer
 * a switch that silently never fires. This module is the single place it is said:
 * every trigger type is listed, `unavailableReasonKey` is `null` exactly for the four
 * that work, and the editor renders the rest as disabled with the reason attached.
 *
 * Keep this honest: when a signal source is wired for another type, delete its
 * `unavailableReasonKey` here *and* feed the event from `osShortcutTriggers.ts` — the
 * catalog must not get ahead of the runtime (that is the defect this file exists to
 * prevent).
 */
import type { MessageKey } from "../i18n/locales/zh";
import type { TriggerType } from "./shortcuts";

export interface TriggerKind {
  type: TriggerType;
  icon: string;
  /** i18n key for the type's display name. */
  labelKey: MessageKey;
  /**
   * `null` when the host has a signal source for this type; otherwise the i18n key
   * of the reason it cannot fire yet.
   */
  unavailableReasonKey: MessageKey | null;
  /** The config a freshly added trigger of this type starts with. */
  defaultConfig: Record<string, unknown>;
}

/** One shared sentence for every not-yet-wired type (signal sources arrive together). */
const NO_SIGNAL: MessageKey = "shortcuts.triggerNoSignal";

/** The catalog, in the order the picker shows it: the four live types first. */
export const TRIGGER_KINDS: TriggerKind[] = [
  {
    type: "time",
    icon: "🕐",
    labelKey: "shortcuts.trigger.type.time",
    unavailableReasonKey: null,
    // Every day at 08:00 — a rule the user can see and edit immediately.
    defaultConfig: { time: "08:00", days: [] },
  },
  {
    type: "app",
    icon: "📱",
    labelKey: "shortcuts.trigger.type.app",
    unavailableReasonKey: null,
    // `appId: ""` matches any app opening (the matcher treats an empty want as "any").
    defaultConfig: { appId: "" },
  },
  {
    type: "wifi",
    icon: "📶",
    labelKey: "shortcuts.trigger.type.wifi",
    unavailableReasonKey: null,
    // An empty SSID means "any network"; the default phase is joining one.
    defaultConfig: { ssid: "", event: "connect" },
  },
  {
    type: "battery",
    icon: "🔋",
    labelKey: "shortcuts.trigger.type.battery",
    unavailableReasonKey: null,
    // A single condition, so a fresh trigger actually matches something.
    defaultConfig: { levelBelow: 20 },
  },

  {
    type: "location",
    icon: "📍",
    labelKey: "shortcuts.trigger.type.location",
    unavailableReasonKey: NO_SIGNAL,
    defaultConfig: {},
  },
  {
    type: "nfc",
    icon: "🏷️",
    labelKey: "shortcuts.trigger.type.nfc",
    unavailableReasonKey: NO_SIGNAL,
    defaultConfig: {},
  },
  {
    type: "bluetooth",
    icon: "🔵",
    labelKey: "shortcuts.trigger.type.bluetooth",
    unavailableReasonKey: NO_SIGNAL,
    defaultConfig: {},
  },
  {
    type: "airplane",
    icon: "✈️",
    labelKey: "shortcuts.trigger.type.airplane",
    unavailableReasonKey: NO_SIGNAL,
    defaultConfig: {},
  },
  {
    type: "notification",
    icon: "🔔",
    labelKey: "shortcuts.trigger.type.notification",
    unavailableReasonKey: NO_SIGNAL,
    defaultConfig: {},
  },
  {
    type: "email",
    icon: "✉️",
    labelKey: "shortcuts.trigger.type.email",
    unavailableReasonKey: NO_SIGNAL,
    defaultConfig: {},
  },
  {
    type: "message",
    icon: "💬",
    labelKey: "shortcuts.trigger.type.message",
    unavailableReasonKey: NO_SIGNAL,
    defaultConfig: {},
  },
];

/** The catalog entry for a type (or `undefined` for an unknown one). */
export function kindOf(type: TriggerType): TriggerKind | undefined {
  return TRIGGER_KINDS.find((k) => k.type === type);
}

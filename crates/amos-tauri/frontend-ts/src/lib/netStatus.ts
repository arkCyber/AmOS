/**
 * netStatus.ts — honest Wi‑Fi / connectivity view for the status bar.
 *
 * The top status bar used to show a Wi‑Fi glyph purely from the quick-settings
 * *toggle* plus the browser `online` bit. That conflates "Wi‑Fi is enabled" with
 * "we are connected to something". AmOS keeps a real, durable connection model in
 * `amos.wifi` (`WifiCfg.current` = the SSID we have joined, via `lib/wifi.ts`),
 * so here we derive a glyph that distinguishes:
 *
 *   • connected  — Wi‑Fi on AND (the host is online, or we have joined an AP)
 *   • searching   — Wi‑Fi on but nothing joined and no internet (dimmed, like iOS)
 *   • off         — the radio is disabled (dimmed)
 *
 * No fake signal/carrier: AmOS has no real radio yet, so we never invent bars —
 * we only reflect the toggle, the real `navigator.onLine` reachability, and the
 * SSID we actually joined. Pure + headlessly testable.
 *
 * **Locale-free**: the clarifications below are returned as i18n *keys* (plus the
 * SSID to interpolate), never as English sentences. This module used to build
 * `"Wi‑Fi · SSID · no internet"` in code, which the status bar rendered verbatim
 * into a UI that ships zh + en (found by audit, REQ-A180).
 */

import type { QuickSettings, RadioKey } from "./settings";

/** One status-bar indicator as the UI renders it. */
export interface StatusIcon {
  kind: RadioKey;
  /** Light the glyph (`true`) or dim it. */
  on: boolean;
  /** i18n key for the hover/aria clarification (rendered by the caller). */
  titleKey?: string;
  /** SSID to interpolate into `titleKey` when it takes `{ssid}`. */
  titleSsid?: string;
}

/**
 * Wi‑Fi connectivity state for the glyph.
 * - `online` is the real internet reachability bit (`navigator.onLine`).
 * - `joinedSsid` is the SSID we are joined to (`amos.wifi.current`), or null.
 */
export interface WifiConnState {
  /** Whether Wi‑Fi is effectively connected to a network/AP. */
  connected: boolean;
  /** i18n key describing the state; null when Wi‑Fi is off or has nothing to say. */
  detailKey: string | null;
  /** SSID for keys that take `{ssid}`. */
  detailSsid?: string;
}

export function wifiConnState(opts: {
  enabled: boolean;
  online: boolean;
  joinedSsid: string | null;
}): WifiConnState {
  const { enabled, online, joinedSsid } = opts;
  if (!enabled) return { connected: false, detailKey: null };
  // Joined an AP but the host has no internet: still "connected to the network".
  if (online) {
    return joinedSsid
      ? { connected: true, detailKey: "a11y.wifiWithSsid", detailSsid: joinedSsid }
      : { connected: true, detailKey: "a11y.wifi" };
  }
  if (joinedSsid) {
    return { connected: true, detailKey: "a11y.wifiNoInternet", detailSsid: joinedSsid };
  }
  // Enabled, not online, not joined to anything → searching for a network.
  return { connected: false, detailKey: "a11y.wifiNoConnection" };
}

/**
 * The full set of radio indicators for the top status bar (right cluster).
 * Airplane mode supersedes every other radio. Order matches the legacy layout:
 * Wi‑Fi then Bluetooth, each dimmed (`on:false`) when it isn't really active.
 */
export function statusIcons(
  quick: QuickSettings,
  online: boolean,
  joinedSsid: string | null,
): StatusIcon[] {
  if (quick.airplane) return [{ kind: "airplane", on: true, titleKey: "a11y.airplaneMode" }];
  const wifi = wifiConnState({ enabled: !!quick.wifi, online, joinedSsid });
  return [
    {
      kind: "wifi",
      on: wifi.connected,
      ...(wifi.detailKey ? { titleKey: wifi.detailKey } : {}),
      ...(wifi.detailSsid ? { titleSsid: wifi.detailSsid } : {}),
    },
    {
      kind: "bluetooth",
      on: !!quick.bluetooth,
      ...(quick.bluetooth ? { titleKey: "a11y.bluetooth" } : {}),
    },
  ];
}

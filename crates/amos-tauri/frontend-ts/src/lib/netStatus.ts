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
 */

import type { QuickSettings, RadioKey } from "./settings";

/** One status-bar indicator as the UI renders it. */
export interface StatusIcon {
  kind: RadioKey;
  /** Light the glyph (`true`) or dim it. */
  on: boolean;
  /** Optional hover/aria clarification (e.g. the joined SSID). */
  title?: string;
}

/**
 * Wi‑Fi connectivity state for the glyph.
 * - `online` is the real internet reachability bit (`navigator.onLine`).
 * - `joinedSsid` is the SSID we are joined to (`amos.wifi.current`), or null.
 */
export interface WifiConnState {
  /** Whether Wi‑Fi is effectively connected to a network/AP. */
  connected: boolean;
  /** Human clarification; null when Wi‑Fi is off or has nothing to say. */
  detail: string | null;
}

export function wifiConnState(opts: {
  enabled: boolean;
  online: boolean;
  joinedSsid: string | null;
}): WifiConnState {
  const { enabled, online, joinedSsid } = opts;
  if (!enabled) return { connected: false, detail: null };
  // Joined an AP but the host has no internet: still "connected to the network".
  if (online) {
    return {
      connected: true,
      detail: joinedSsid ? `Wi‑Fi · ${joinedSsid}` : "Wi‑Fi",
    };
  }
  if (joinedSsid) {
    return { connected: true, detail: `Wi‑Fi · ${joinedSsid} · no internet` };
  }
  // Enabled, not online, not joined to anything → searching for a network.
  return { connected: false, detail: "Wi‑Fi: no connection" };
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
  if (quick.airplane) return [{ kind: "airplane", on: true, title: "Airplane mode" }];
  const wifi = wifiConnState({ enabled: !!quick.wifi, online, joinedSsid });
  return [
    { kind: "wifi", on: wifi.connected, title: wifi.detail ?? undefined },
    {
      kind: "bluetooth",
      on: !!quick.bluetooth,
      title: quick.bluetooth ? "Bluetooth" : undefined,
    },
  ];
}

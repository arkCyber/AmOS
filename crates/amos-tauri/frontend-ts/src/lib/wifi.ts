/**
 * Wi‑Fi view model (pure, headlessly testable).
 *
 * AmOS has no real Wi‑Fi radio yet: connecting/forgetting an AP needs the Android
 * WifiManager + location/CHANGE_WIFI_STATE on a device (📱). What the settings
 * screen CAN offer offline is an honest, deterministic "nearby networks" view
 * (signal / lock / current), which this module drives — and which a future real
 * scan bridge can feed the same shape. No function here fabricates a real join:
 * `current` only changes through an explicit `connectOpenOrSaved` call.
 */

/** A Wi‑Fi network from a scan. `signal` 0..4 (weak → strong). */
export interface WifiNet {
  ssid: string;
  /** 0..4 signal strength (iOS draws ~1–3 bars). */
  signal: number;
  /** Needs a password to join. */
  secure: boolean;
}

/** Persisted Wi‑Fi preference (which network is current / remembered). */
export interface WifiCfg {
  /** SSID of the current connection (open or already-remembered). */
  current: string | null;
  /** SSIDs AmOS has joined before (remembered; iOS re-joins these automatically). */
  saved: string[];
}

export const WIFI_KEY = "amos.wifi";

/** Clamp a signal into the 0..4 model range (guard stray inputs). */
export function clampSignal(s: number): number {
  if (!Number.isFinite(s)) return 0;
  return Math.min(4, Math.max(0, Math.round(s)));
}

/** iOS-style bar count (1–3) for a signal, mirroring the little arcs. */
export function signalBars(signal: number): number {
  const s = clampSignal(signal);
  if (s <= 0) return 0;
  if (s <= 1) return 1;
  if (s <= 2) return 2;
  return 3;
}

/** Deterministic mock neighbourhood (offline/host; a real bridge would replace it). */
export const NEIGHBORHOOD: readonly WifiNet[] = [
  { ssid: "AmOS-5G", signal: 4, secure: true },
  { ssid: "Home-2.4G", signal: 3, secure: true },
  { ssid: "Cafe_Free", signal: 3, secure: false },
  { ssid: "Library_Guest", signal: 2, secure: false },
  { ssid: "iPhone-Mini", signal: 2, secure: true },
  { ssid: "Neighbor_AX", signal: 1, secure: true },
];

/** Sort a scan for display: the current network first, then by signal desc
 * (stable). Pure — used by the screen and by tests. */
export function sortNetworks(nets: readonly WifiNet[], current: string | null): WifiNet[] {
  const rank = (n: WifiNet) => (n.ssid === current ? 1 : 0);
  return [...nets].sort(
    (a, b) =>
      rank(b) - rank(a) || clampSignal(b.signal) - clampSignal(a.signal) ||
      (a.ssid < b.ssid ? -1 : a.ssid > b.ssid ? 1 : 0),
  );
}

/** The network the given SSID resolves to in a scan, if present. */
export function findBySsid(nets: readonly WifiNet[], ssid: string): WifiNet | null {
  return nets.find((n) => n.ssid === ssid) ?? null;
}

/**
 * Join an AP that needs no password (open) or is already the current network;
 * secure networks a device hasn't joined are NOT connectable offline → returns
 * the config unchanged. Honest: we never fake a passworded join. Joining an open
 * network remembers it (so iOS-like it can re-join automatically later).
 */
export function connectOpenOrSaved(
  cfg: WifiCfg,
  nets: readonly WifiNet[],
  ssid: string,
): WifiCfg {
  const net = findBySsid(nets, ssid);
  if (!net) return cfg;
  if (net.secure && net.ssid !== cfg.current) return cfg; // would need a password / real radio
  const saved = cfg.saved.includes(ssid) ? cfg.saved : [...cfg.saved, ssid];
  return { current: ssid, saved };
}

/** Forget a network: drops it from current and from the remembered list
 * (iOS "Forget This Network"). Pure. */
export function forgetNetwork(cfg: WifiCfg, ssid: string): WifiCfg {
  return {
    current: cfg.current === ssid ? null : cfg.current,
    saved: cfg.saved.filter((s) => s !== ssid),
  };
}

/** Whether a network is in the remembered list. */
export function isSaved(cfg: WifiCfg, ssid: string): boolean {
  return cfg.saved.includes(ssid);
}

/** Coerce any stored value into a valid WifiCfg (corruption guard). */
export function normalizeWifi(v: unknown): WifiCfg {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const current =
      typeof o.current === "string" && o.current !== "" ? o.current : null;
    const saved = Array.isArray(o.saved)
      ? o.saved.filter((s): s is string => typeof s === "string" && s !== "")
      : [];
    return { current, saved: [...new Set(saved)] };
  }
  return { current: null, saved: [] };
}

export const wifiInit = (): WifiCfg => ({ current: null, saved: [] });

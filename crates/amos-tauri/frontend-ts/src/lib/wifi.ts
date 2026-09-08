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
  /** SSID of the current connection (open or one we have the password for). */
  current: string | null;
  /** SSIDs AmOS has joined before (remembered; iOS re-joins these automatically). */
  saved: string[];
  /** Remembered passwords (emulated Keychain), keyed by SSID, so a secure
   * network can re-join automatically on the next visit without re-entry. */
  passwords: Record<string, string>;
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

/** Sort a scan for display: current network first, then remembered ("my
 * networks") by strength, then the rest by strength; ties by ssid. Stable. Pure. */
export function sortNetworks(
  nets: readonly WifiNet[],
  current: string | null,
  saved: readonly string[] = [],
): WifiNet[] {
  const rank = (n: WifiNet) =>
    n.ssid === current ? 2 : saved.includes(n.ssid) ? 1 : 0;
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

/** True when we hold a remembered password for `ssid` (auto-join available). */
export function hasPassword(cfg: WifiCfg, ssid: string): boolean {
  return typeof cfg.passwords[ssid] === "string" && cfg.passwords[ssid]!.length > 0;
}

/** Remember a password for a network (emulated Keychain). Pure. */
export function rememberPassword(cfg: WifiCfg, ssid: string, pw: string): WifiCfg {
  const p = pw.trim();
  if (p === "") return cfg;
  return { ...cfg, passwords: { ...cfg.passwords, [ssid]: p } };
}

/**
 * Join an AP: an open network (or one we already hold a remembered password for)
 * can be connected right away and is remembered. A secure network we have no
 * password for can't join → returns the config unchanged (the caller should ask
 * for a password via `connectWithPassword`). Never fakes a credential-less join.
 */
export function connectOpenOrSaved(
  cfg: WifiCfg,
  nets: readonly WifiNet[],
  ssid: string,
): WifiCfg {
  const net = findBySsid(nets, ssid);
  if (!net) return cfg;
  if (net.secure && !hasPassword(cfg, ssid)) return cfg; // would need a password
  return join(cfg, ssid);
}

/** Join with an explicitly-entered password (remembered for next time). */
export function connectWithPassword(
  cfg: WifiCfg,
  nets: readonly WifiNet[],
  ssid: string,
  pw: string,
): WifiCfg {
  const net = findBySsid(nets, ssid);
  if (!net || pw.trim() === "") return cfg;
  return rememberPassword(join(cfg, ssid), ssid, pw);
}

/** Mark `ssid` as current and add it to the remembered list (pure core). */
function join(cfg: WifiCfg, ssid: string): WifiCfg {
  const saved = cfg.saved.includes(ssid) ? cfg.saved : [...cfg.saved, ssid];
  return { ...cfg, current: ssid, saved };
}

/**
 * Auto-rejoin: when nothing is current but a *remembered* network is in range and
 * joinable (open, or we hold its password), pick the strongest such one — the
 * iOS behaviour of reconnecting to a remembered network. Pure.
 */
export function autoRejoin(cfg: WifiCfg, nets: readonly WifiNet[]): WifiCfg {
  if (cfg.current) return cfg; // already connected
  const candidates = nets
    .filter(
      (n) => cfg.saved.includes(n.ssid) && (!n.secure || hasPassword(cfg, n.ssid)),
    )
    .sort((a, b) => clampSignal(b.signal) - clampSignal(a.signal));
  const top = candidates[0];
  return top ? { ...cfg, current: top.ssid } : cfg;
}

/** Forget a network: drops it from current, from remembered, and forgets the
 * password (iOS "Forget This Network"). Pure. */
export function forgetNetwork(cfg: WifiCfg, ssid: string): WifiCfg {
  const { [ssid]: _drop, ...passwords } = cfg.passwords;
  return {
    current: cfg.current === ssid ? null : cfg.current,
    saved: cfg.saved.filter((s) => s !== ssid),
    passwords,
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
    const passwords: Record<string, string> = {};
    if (o.passwords && typeof o.passwords === "object") {
      for (const [k, val] of Object.entries(o.passwords as Record<string, unknown>)) {
        if (typeof val === "string" && val !== "") passwords[k] = val;
      }
    }
    return { current, saved: [...new Set(saved)], passwords };
  }
  return { current: null, saved: [], passwords: {} };
}

export const wifiInit = (): WifiCfg => ({ current: null, saved: [], passwords: {} });

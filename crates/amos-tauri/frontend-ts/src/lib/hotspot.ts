/**
 * Personal-hotspot (Wi-Fi AP) view model — pure, headlessly testable.
 *
 * AmOS has no real tethering stack yet: starting an AP needs the Android
 * `TetheringManager` (`ConnectivityManager#startTethering`) on a device (📱). What
 * the settings screen CAN offer offline is an honest, deterministic **configuration**
 * (network name / password / band / security / client cap) plus a **validation** that
 * refuses to turn the hotspot on when the config could not possibly work (a blank
 * name, or a WPA2/WPA3 key shorter than the 8 characters the standard requires).
 *
 * Two honesty rules, mirroring `lib/wifi.ts` / `lib/bluetooth.ts`:
 *   • No function here fabricates a running AP. The on/off bit is a radio bit the
 *     `RadioManager` owns (`amos.settings`), never something this module invents.
 *   • No client list is invented — who is connected is device-only knowledge, so the
 *     page says so instead of showing fake devices.
 */

/** Radio band the AP broadcasts on. */
export type HotspotBand = "2.4" | "5";

/** Link security for the AP. `open` = no password (anyone nearby may join). */
export type HotspotSecurity = "wpa2" | "wpa3" | "open";

/** Persisted personal-hotspot configuration. */
export interface HotspotCfg {
  /** The network name (SSID) other devices see. */
  ssid: string;
  /** WPA2/WPA3 pre-shared key. Unused (and not required) when `security` is `open`. */
  password: string;
  /** The band the AP broadcasts on. */
  band: HotspotBand;
  /** The link security. */
  security: HotspotSecurity;
  /** Maximum simultaneous clients, clamped to 1..CLIENTS_MAX. */
  maxClients: number;
}

/** A configuration problem that must block turning the hotspot on. */
export type HotspotProblem = "ssidEmpty" | "passwordTooShort";

export const HOTSPOT_KEY = "amos.hotspot";

/** 802.11 SSID length limit, in **bytes/octets** (not characters). */
const SSID_MAX = 32;

/** UTF-8 encoder (available in every host we run in, incl. the WebView). */
const utf8 = new TextEncoder();
/** WPA2/WPA3 PSK length bounds (a shorter key cannot be provisioned). */
const PW_MIN = 8;
const PW_MAX = 63;
/** Client cap the UI offers. */
const CLIENTS_MAX = 10;
/** The name a fresh hotspot starts with. */
const DEFAULT_SSID = "AmOS Hotspot";

/** The default, untouched hotspot config (single source — mirrors `wifiInit`). */
export const hotspotInit = (): HotspotCfg => ({
  ssid: DEFAULT_SSID,
  password: "",
  band: "5",
  security: "wpa2",
  maxClients: 5,
});

/** Clamp a client count into 1..CLIENTS_MAX. */
export function clampClients(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(CLIENTS_MAX, Math.max(1, Math.round(n)));
}

/**
 * Sanitize a user-typed network name: trimmed, capped at `SSID_MAX` **bytes** —
 * 802.11 counts octets, not characters, so a 32-character CJK name (96 bytes)
 * would be rejected by a real AP while a 32-character check waved it through.
 * The cap never splits a code point (the truncation must stay a valid name).
 * A blank result is allowed: the validator, not this helper, judges it.
 */
export function sanitizeSsid(s: string): string {
  const t = s.trim();
  if (utf8.encode(t).length <= SSID_MAX) return t;
  let out = "";
  for (const ch of t) {
    if (utf8.encode(out + ch).length > SSID_MAX) break;
    out += ch;
  }
  return out;
}

/** Set the network name (sanitized). Pure. */
export function setSsid(cfg: HotspotCfg, ssid: string): HotspotCfg {
  return { ...cfg, ssid: sanitizeSsid(ssid) };
}

/** Set the passphrase (capped at PW_MAX). Pure; not trimmed — spaces are legal. */
export function setPassword(cfg: HotspotCfg, pw: string): HotspotCfg {
  return { ...cfg, password: pw.length > PW_MAX ? pw.slice(0, PW_MAX) : pw };
}

/** Pick the broadcast band. Pure. */
export function setBand(cfg: HotspotCfg, band: HotspotBand): HotspotCfg {
  return { ...cfg, band };
}

/** Pick the security mode. Switching to `open` keeps the stored password so toggling
 *  back to WPA does not force a re-type (it is simply unused while open). Pure. */
export function setSecurity(cfg: HotspotCfg, security: HotspotSecurity): HotspotCfg {
  return { ...cfg, security };
}

/** Set the client cap (clamped). Pure. */
export function setMaxClients(cfg: HotspotCfg, n: number): HotspotCfg {
  return { ...cfg, maxClients: clampClients(n) };
}

/** Alphabet without look-alikes (0/O, 1/l/I) so a password can be read aloud. */
const PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/**
 * The default draw for {@link suggestPassword}: the platform **CSPRNG** when the
 * host has one, `Math.random` otherwise.
 *
 * Why it matters here: this string becomes the AP's Wi-Fi pre-shared key, and a
 * `Math.random` draw is seeded from the clock and not cryptographically strong —
 * a predictable PSK is a real weakness, not a cosmetic one. The same
 * "prefer `crypto`, fall back with the reason written down" shape `lib/customGroups.ts`
 * uses for `crypto.randomUUID`. A host without `crypto` still gets a suggestion
 * (the user can edit it before applying), and this comment says so instead of
 * pretending the fallback is equally strong.
 */
function csprngDraw(): () => number {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.getRandomValues === "function") {
    return () => {
      const buf = new Uint32Array(1);
      c.getRandomValues(buf);
      // 2^32 is unreachable (max draw is (2^32-1)/2^32), so the result is in [0,1).
      // (`buf[0]` is in range by construction; the repo style is `!` here.)
      return buf[0]! / 2 ** 32;
    };
  }
  return Math.random;
}

/**
 * Suggest a random passphrase of `len` chars drawn from an unambiguous alphabet.
 *
 * `rand` stays injectable so tests are deterministic; when it is omitted the
 * platform CSPRNG is used (see {@link csprngDraw}).
 */
export function suggestPassword(rand?: () => number, len = 12): string {
  const draw = rand ?? csprngDraw();
  let out = "";
  for (let i = 0; i < len; i++) {
    const r = draw();
    const idx = Math.min(
      PW_ALPHABET.length - 1,
      Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * PW_ALPHABET.length)),
    );
    out += PW_ALPHABET[idx];
  }
  return out;
}

/**
 * Everything that would stop this config from producing a working AP: a blank
 * network name, or a WPA2/WPA3 key shorter than `PW_MIN`. `open` has no password
 * requirement (its risk is surfaced separately via `isOpenNetwork`). Pure.
 */
export function hotspotProblems(cfg: HotspotCfg): HotspotProblem[] {
  const out: HotspotProblem[] = [];
  if (cfg.ssid === "") out.push("ssidEmpty");
  if (cfg.security !== "open" && cfg.password.trim().length < PW_MIN) {
    out.push("passwordTooShort");
  }
  return out;
}

/** True when the config may be applied as-is (no blocking problem). Pure. */
export function hotspotReady(cfg: HotspotCfg): boolean {
  return hotspotProblems(cfg).length === 0;
}

/** True when the AP would have no password — a warning, never a blocker. Pure. */
export function isOpenNetwork(cfg: HotspotCfg): boolean {
  return cfg.security === "open";
}

/** Coerce any stored value into a valid HotspotCfg (corruption guard). */
export function normalizeHotspot(v: unknown): HotspotCfg {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const d = hotspotInit();
    const band: HotspotBand = o.band === "2.4" || o.band === "5" ? o.band : d.band;
    const security: HotspotSecurity =
      o.security === "wpa2" || o.security === "wpa3" || o.security === "open"
        ? o.security
        : d.security;
    return {
      // A stored blank name stays blank (the validator, not the guard, judges it) —
      // but a *missing* name falls back to the default.
      ssid: typeof o.ssid === "string" ? sanitizeSsid(o.ssid) : d.ssid,
      password:
        typeof o.password === "string" ? setPassword(d, o.password).password : d.password,
      band,
      security,
      maxClients: typeof o.maxClients === "number" ? clampClients(o.maxClients) : d.maxClients,
    };
  }
  return hotspotInit();
}

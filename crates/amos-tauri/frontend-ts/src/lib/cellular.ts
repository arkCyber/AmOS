/**
 * Persistent cellular-data preferences for the Settings「蜂窝网络」page.
 *
 * The OS has no real modem in many builds, so these are honest persisted
 * preferences (like the Wi‑Fi/蓝牙 master bits) rather than fabricated telemetry:
 *   • data    — "cellular data" master (on by default, mirroring a phone).
 *   • roaming — data roaming (off by default, safer).
 * The page notes that real modem wiring is pending; we never fake a signal/carrier.
 */
export const CELLULAR_KEY = "amos.cellular";

export interface CellularPrefs {
  data: boolean;
  roaming: boolean;
}

export function defaultCellular(): CellularPrefs {
  return { data: true, roaming: false };
}

/** Corruption guard: keeps only the known booleans with safe defaults. */
export function normalizeCellular(raw: unknown): CellularPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultCellular();
  const o = raw as Record<string, unknown>;
  return {
    data: typeof o.data === "boolean" ? o.data : true,
    roaming: typeof o.roaming === "boolean" ? o.roaming : false,
  };
}

/** Pure: flip one cellular preference (immutable). */
export function flipCellular(s: CellularPrefs, key: "data" | "roaming"): CellularPrefs {
  return { ...s, [key]: !s[key] };
}

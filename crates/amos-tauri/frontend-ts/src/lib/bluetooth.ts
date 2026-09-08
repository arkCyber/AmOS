/**
 * Bluetooth view model (pure, headlessly testable).
 *
 * Like Wi‑Fi, AmOS has no real radio: pairing/audio needs the Android Bluetooth
 * adapter (📱). What the settings screen offers offline is the iOS-style
 * "this device + discoverable + nearby (demo)" configuration — honest, no fake
 * audio connections. A future device bridge can feed the same shapes.
 */

/** Kind of a Bluetooth device (drives the row glyph). */
export type BtKind = "audio" | "watch" | "keyboard" | "phone" | "other";

/** A discoverable Bluetooth device (nearby scan / paired shape). */
export interface BtDevice {
  id: string;
  name: string;
  kind: BtKind;
}

/** Persisted Bluetooth configuration. */
export interface BtCfg {
  /** This device's user-facing name. */
  name: string;
  /** Whether this device is discoverable by nearby devices. */
  discoverable: boolean;
}

export const BT_KEY = "amos.bluetooth";
export const MY_DEVICE_NAME = "AmOS";

/** Kind → row glyph (honest placeholder faces). */
export function btGlyph(kind: BtKind): string {
  switch (kind) {
    case "audio":
      return "🎧";
    case "watch":
      return "⌚";
    case "keyboard":
      return "⌨️";
    case "phone":
      return "📱";
    default:
      return "🔌";
  }
}

/** Deterministic demo device neighbourhood (offline/host). */
export const DEMO_DEVICES: readonly BtDevice[] = [
  { id: "airpods", name: "AirPods Pro", kind: "audio" },
  { id: "watch", name: "Apple Watch", kind: "watch" },
  { id: "kb", name: "Magic Keyboard", kind: "keyboard" },
  { id: "phone2", name: "iPhone 15", kind: "phone" },
];

export const btInit = (): BtCfg => ({ name: MY_DEVICE_NAME, discoverable: true });

/** Toggle this device's discoverability. Pure. */
export function setDiscoverable(cfg: BtCfg, on: boolean): BtCfg {
  return { ...cfg, discoverable: on };
}

/** Rename this device. Pure; blanks fall back to the default name. */
export function renameDevice(cfg: BtCfg, name: string): BtCfg {
  const n = name.trim();
  return { ...cfg, name: n === "" ? MY_DEVICE_NAME : n };
}

/** Coerce any stored value into a valid BtCfg (corruption guard). */
export function normalizeBt(v: unknown): BtCfg {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return {
      name:
        typeof o.name === "string" && o.name.trim() !== "" ? o.name.trim() : MY_DEVICE_NAME,
      discoverable: typeof o.discoverable === "boolean" ? o.discoverable : true,
    };
  }
  return btInit();
}

/**
 * Bluetooth view model (pure, headlessly testable).
 *
 * Two layers, kept apart on purpose (REQ-A199):
 *
 *  * **Device facts** — {@link BtPeer} is what the *adapter* reports: its paired
 *    devices (via `bluetoothPairedDevices()`) and its own name (via
 *    `bluetoothAdapterName()`). Nothing in this module invents them.
 *  * **The offline preference** — {@link BtCfg} (store key `amos.bluetooth`)
 *    remembers the name this device *should* use and which devices the demo list was
 *    paired with. Offline this is all there is; on a device, the adapter's own values
 *    win and the preference is only the fallback.
 *
 * Why the split matters: the model used to keep only the preference, and its settings
 * row looked exactly like a real radio switch — so "this device is called X" read as
 * device state while nothing ever reached the adapter. The screen now labels which of
 * the two it is showing.
 *
 * **Platform limit this model encodes**: unpairing. On a real device the paired list
 * comes from the adapter and cannot be edited — `BluetoothDevice#removeBond` is not in
 * the Android public SDK — so {@link unpairDevice} only ever edits the *local* demo
 * list, and the screen says so instead of offering a button that would fail.
 */

/** Kind of a Bluetooth device (drives the row glyph). */
export type BtKind = "audio" | "watch" | "keyboard" | "phone" | "other";

/** A device the adapter reports as paired (`BluetoothAdapter#getBondedDevices`). */
export interface BtPeer {
  /** The device's MAC address — the platform's stable identity for it, and the one
   *  field the platform always has. */
  address: string;
  /** What the device reports; empty when the platform has no name for it. */
  name: string;
}

/** A row in the offline nearby list / in the remembered paired list. */
export interface BtDevice {
  id: string;
  name: string;
  kind: BtKind;
}

/** Persisted Bluetooth preference (the offline shape). */
export interface BtCfg {
  /** This device's user-facing name — the value a device would be *asked* to use. */
  name: string;
  /** Whether this device is discoverable by nearby devices. */
  discoverable: boolean;
  /**
   * Devices paired **in this offline model** (the demo list). A device's real paired
   * list arrives as {@link BtPeer}[] and is never written here — mixing the two would
   * make a remembered demo row indistinguishable from an adapter fact.
   */
  paired: BtDevice[];
}

export const BT_KEY = "amos.bluetooth";
export const MY_DEVICE_NAME = "AmOS";

/**
 * How many local pairings are remembered. A remembered demo list is not a device
 * inventory: past this the oldest entry is dropped rather than letting the store grow
 * without bound (`slice(-MAX_PAIRED)` keeps the most recent).
 */
export const MAX_PAIRED = 16;

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

export const btInit = (): BtCfg => ({
  name: MY_DEVICE_NAME,
  discoverable: true,
  paired: [],
});

/** Toggle this device's discoverability. Pure. */
export function setDiscoverable(cfg: BtCfg, on: boolean): BtCfg {
  return { ...cfg, discoverable: on };
}

/** Rename this device. Pure; blanks fall back to the default name. */
export function renameDevice(cfg: BtCfg, name: string): BtCfg {
  const n = name.trim();
  return { ...cfg, name: n === "" ? MY_DEVICE_NAME : n };
}

/** Whether `kind` is one of the known row kinds (guard for stored values). */
export function isBtKind(kind: unknown): kind is BtKind {
  return (
    kind === "audio" ||
    kind === "watch" ||
    kind === "keyboard" ||
    kind === "phone" ||
    kind === "other"
  );
}

/**
 * Infer a row glyph kind from a device **name**.
 *
 * Deliberately name-only, and documented as a heuristic: the platform does not hand us
 * a device class, so this only decides which glyph a row draws — never a capability
 * claim. An unrecognised name is `"other"`, which draws the neutral plug glyph.
 */
export function kindFromName(name: string): BtKind {
  const n = name.toLowerCase();
  if (/airpod|buds|headphone|headset|speaker|soundbar|beats|pods|audio/.test(n)) {
    return "audio";
  }
  if (/watch|band/.test(n)) return "watch";
  if (/keyboard|\bkbd\b|keys/.test(n)) return "keyboard";
  if (/iphone|pixel|galaxy|phone|android|redmi|oneplus/.test(n)) return "phone";
  return "other";
}

/**
 * The row to show for a device the adapter reports. A device with no name is
 * identified by its address — a blank row would be a device the user cannot name.
 */
export function peerToDevice(peer: BtPeer): BtDevice {
  const name = peer.name.trim() !== "" ? peer.name.trim() : peer.address;
  return { id: peer.address, name, kind: kindFromName(name) };
}

/**
 * How many scan rows the screen keeps. Mirrors the device-side cap in
 * `BluetoothGlue.kt` (`MAX_DEVICES`): the merged list is bounded, and beyond it the
 * **weakest** rows go (see {@link mergeScanRows}).
 */
export const MAX_SCAN_ROWS = 64;

/**
 * The platform's bond states (`BluetoothDevice#BOND_*`), mirrored here **by value**.
 *
 * Why the screen needs all three and not a bool (REQ-A201): a pair request that the
 * platform accepted enters `BOND_BONDING` before it can become `BOND_BONDED` or fall
 * back to `BOND_NONE`. Collapsing that into `bonded: false` meant the UI could say
 * nothing at all about a request in flight — the user pressed "pair" and the screen
 * looked exactly as if nothing had happened.
 */
export const BOND_NONE = 10;
export const BOND_BONDING = 11;
export const BOND_BONDED = 12;

/** A row for one device seen by a **scan** (REQ-A200). */
export interface BtScanRow {
  /** The address — the platform's identity, used to pair and to key the row. */
  id: string;
  /** The advertised name, or the address when the device has none. */
  name: string;
  kind: BtKind;
  /** The raw bond state ({@link BOND_NONE} / {@link BOND_BONDING} / {@link BOND_BONDED}). */
  bond: number;
  /** Seen over a Bluetooth LE advertisement (the row carries an "LE" tag when true). */
  le: boolean;
  /** dBm, when the platform reported one. */
  rssi: number | null;
}

/** Shape one scan result into a row (address fallback, glyph kind from the name). */
export function scanRow(dev: {
  address: string;
  name: string;
  rssi?: number | null;
  bond?: number | null;
  le?: boolean | null;
}): BtScanRow {
  const name = dev.name.trim() !== "" ? dev.name.trim() : dev.address.trim();
  return {
    id: dev.address.trim(),
    name,
    kind: kindFromName(name),
    bond: typeof dev.bond === "number" ? dev.bond : BOND_NONE,
    le: dev.le === true,
    rssi: typeof dev.rssi === "number" ? dev.rssi : null,
  };
}

/** Whether a row is paired (as opposed to pairing, or not paired at all). */
export function rowIsBonded(row: BtScanRow): boolean {
  return row.bond === BOND_BONDED;
}

/** Whether a pairing flow for this row is in progress. */
export function rowIsBonding(row: BtScanRow): boolean {
  return row.bond === BOND_BONDING;
}

/**
 * What to show about the pairing request the user just made for `address`.
 *
 * Read from the **device's** bond state (the session records first, then the row), never
 * from the fact that a request was accepted:
 *
 * * `"bonding"` — the platform is running the pairing flow (the peer must confirm).
 * * `"bonded"` — it completed. Note the authoritative paired list is still
 *   `bluetoothPairedDevices()`; this is the same fact arriving through the scan channel.
 * * `"none"` — no transition observed: the request was accepted but nothing has happened
 *   yet, the peer declined, or the pairing fell back. The screen says exactly that
 *   instead of claiming success or failure.
 */
export function pairingProgress(
  bonds: readonly { address: string; state: number }[],
  address: string,
  rows: readonly BtScanRow[] = [],
): "bonding" | "bonded" | "none" {
  const recorded = bonds.find((b) => b.address === address)?.state;
  const state = recorded ?? rows.find((r) => r.id === address)?.bond;
  if (state === BOND_BONDING) return "bonding";
  if (state === BOND_BONDED) return "bonded";
  return "none";
}

/**
 * Sort scan rows for display: strongest signal first, then named rows before the ones
 * that only have an address, then by name/address so the order is stable between polls
 * (a list that reshuffles every 1.5 s is unusable). Rows without an RSSI go last —
 * "unknown signal" is not "weak signal".
 */
export function sortScanRows(rows: readonly BtScanRow[]): BtScanRow[] {
  const cmp = (a: BtScanRow, b: BtScanRow) => {
    const sa = a.rssi ?? Number.NEGATIVE_INFINITY;
    const sb = b.rssi ?? Number.NEGATIVE_INFINITY;
    if (sa !== sb) return sb - sa;
    if (a.name === a.id !== (b.name === b.id)) return a.name === a.id ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  };
  return [...rows].sort(cmp);
}

/**
 * Merge a fresh scan result into the rows already shown, keyed by address.
 *
 * Why merge instead of replace: the platform only re-announces a device when it hears
 * it again, so a straight replace would make rows flicker away between advertisements.
 * A device the new scan did **not** see keeps its last row ({@link sortScanRows} then
 * orders by the last known signal). Only rows with an address are kept — the platform
 * always gives one, and a row without it could not be paired.
 *
 * The merged list is capped like the device-side one, dropping the **weakest** rows
 * beyond {@link MAX_SCAN_ROWS}: a screen left open through many scans would otherwise
 * grow without bound, and a row that has not been heard for several scans is the least
 * useful one to keep.
 *
 * Two fields are merged rather than replaced (REQ-A201): `le` is the **union** (a device
 * seen over LE keeps that fact even if this poll heard it over classic — or vice versa),
 * and `bond` prefers the newer row's state, since a bond transition is what the screen
 * renders pairing progress from.
 */
export function mergeScanRows(
  previous: readonly BtScanRow[],
  incoming: readonly BtScanRow[],
): BtScanRow[] {
  const byId = new Map<string, BtScanRow>();
  for (const r of previous) if (r.id !== "") byId.set(r.id, r);
  for (const r of incoming) {
    if (r.id === "") continue;
    const prev = byId.get(r.id);
    byId.set(r.id, prev ? { ...r, le: r.le || prev.le } : r);
  }
  return sortScanRows([...byId.values()]).slice(0, MAX_SCAN_ROWS);
}

/** Whether this device is in the offline paired list. */
export function isPaired(cfg: BtCfg, id: string): boolean {
  return cfg.paired.some((d) => d.id === id);
}

/**
 * Remember an offline pairing ("Pair" on a demo row). An already-paired id is a no-op;
 * past {@link MAX_PAIRED} the oldest entry is dropped.
 */
export function pairDevice(cfg: BtCfg, dev: BtDevice): BtCfg {
  if (isPaired(cfg, dev.id)) return cfg;
  return { ...cfg, paired: [...cfg.paired, dev].slice(-MAX_PAIRED) };
}

/**
 * Forget an **offline** pairing. This edits the local model only: on a real device
 * unpairing needs `BluetoothDevice#removeBond`, which is not in the Android public SDK,
 * so the screen does not offer it for adapter-reported devices.
 */
export function unpairDevice(cfg: BtCfg, id: string): BtCfg {
  return { ...cfg, paired: cfg.paired.filter((d) => d.id !== id) };
}

/** Coerce a stored `paired` list: keep rows with a usable id + name, drop duplicates. */
function normalizePaired(v: unknown): BtDevice[] {
  if (!Array.isArray(v)) return [];
  const out: BtDevice[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id.trim() === "") continue;
    if (typeof o.name !== "string" || o.name.trim() === "") continue;
    const id = o.id.trim();
    if (out.some((d) => d.id === id)) continue;
    const name = o.name.trim();
    out.push({ id, name, kind: isBtKind(o.kind) ? o.kind : kindFromName(name) });
  }
  return out.slice(0, MAX_PAIRED);
}

/** Coerce any stored value into a valid BtCfg (corruption guard). */
export function normalizeBt(v: unknown): BtCfg {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return {
      name: typeof o.name === "string" && o.name.trim() !== "" ? o.name.trim() : MY_DEVICE_NAME,
      discoverable: typeof o.discoverable === "boolean" ? o.discoverable : true,
      paired: normalizePaired(o.paired),
    };
  }
  return btInit();
}

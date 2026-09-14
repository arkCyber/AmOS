/**
 * Pure unit tests for the Bluetooth view model (lib/bluetooth.ts).
 *
 * The model has two halves (REQ-A199) and both are pinned here:
 *   • the **offline preference** (name / discoverable / local pairings in the store), and
 *   • the shape of a **device fact** (`BtPeer` → row), including the address fallback for
 *     a device the platform never named.
 */
import { describe, expect, test } from "bun:test";
import {
  BOND_BONDED,
  BOND_BONDING,
  BOND_NONE,
  DEMO_DEVICES,
  MAX_PAIRED,
  MY_DEVICE_NAME,
  btGlyph,
  btInit,
  isBtKind,
  isPaired,
  kindFromName,
  normalizeBt,
  MAX_SCAN_ROWS,
  mergeScanRows,
  pairDevice,
  pairingProgress,
  peerToDevice,
  rowIsBonded,
  rowIsBonding,
  scanRow,
  sortScanRows,
  renameDevice,
  setDiscoverable,
  unpairDevice,
  type BtDevice,
  type BtScanRow,
} from "../lib/bluetooth";

describe("bluetooth config", () => {
  test("defaults to the device name, discoverable-on, nothing paired", () => {
    expect(btInit()).toEqual({ name: "AmOS", discoverable: true, paired: [] });
    expect(MY_DEVICE_NAME).toBe("AmOS");
  });

  test("setDiscoverable toggles the flag", () => {
    const off = setDiscoverable(btInit(), false);
    expect(off.discoverable).toBe(false);
    expect(setDiscoverable(off, true).discoverable).toBe(true);
  });

  test("renameDevice trims; blank falls back to the default", () => {
    expect(renameDevice(btInit(), "  MyPhone  ").name).toBe("MyPhone");
    expect(renameDevice(btInit(), "   ").name).toBe(MY_DEVICE_NAME);
  });

  test("normalizeBt coerces junk and keeps valid values", () => {
    expect(normalizeBt(null)).toEqual({ name: "AmOS", discoverable: true, paired: [] });
    expect(normalizeBt("x")).toEqual({ name: "AmOS", discoverable: true, paired: [] });
    expect(normalizeBt({ name: "Phone", discoverable: false })).toEqual({
      name: "Phone",
      discoverable: false,
      paired: [],
    });
    expect(normalizeBt({ name: "  ", discoverable: 1 }).name).toBe("AmOS");
  });
});

describe("bluetooth local pairings", () => {
  const airpods = DEMO_DEVICES[0] as BtDevice;

  test("pairDevice adds once; a repeat is a no-op", () => {
    const once = pairDevice(btInit(), airpods);
    expect(isPaired(once, "airpods")).toBe(true);
    expect(pairDevice(once, airpods).paired.length).toBe(1);
  });

  test("unpairDevice removes the row and leaves the rest alone", () => {
    const kb = DEMO_DEVICES[2] as BtDevice;
    const both = pairDevice(pairDevice(btInit(), airpods), kb);
    const after = unpairDevice(both, "airpods");
    expect(isPaired(after, "airpods")).toBe(false);
    expect(isPaired(after, "kb")).toBe(true);
    // Unpairing something that is not there changes nothing.
    expect(unpairDevice(after, "ghost").paired).toEqual(after.paired);
  });

  test("the remembered list is capped, dropping the oldest", () => {
    let cfg = btInit();
    for (let i = 0; i < MAX_PAIRED + 2; i += 1) {
      cfg = pairDevice(cfg, { id: `d${i}`, name: `Device ${i}`, kind: "other" });
    }
    expect(cfg.paired.length).toBe(MAX_PAIRED);
    expect(isPaired(cfg, "d0")).toBe(false);
    expect(isPaired(cfg, `d${MAX_PAIRED + 1}`)).toBe(true);
  });

  test("a stored paired list is coerced: junk dropped, duplicates collapsed", () => {
    const cfg = normalizeBt({
      name: "Phone",
      paired: [
        { id: "a", name: "Buds", kind: "audio" },
        { id: "a", name: "Buds again" },
        { id: "", name: "no id" },
        { id: "b", name: "  " },
        "junk",
        { id: "c", name: "Mystery Device", kind: "nonsense" },
      ],
    });
    expect(cfg.paired.map((d) => d.id)).toEqual(["a", "c"]);
    expect(cfg.paired[0]?.kind).toBe("audio");
    // An unknown kind is re-derived from the name rather than trusted.
    expect(cfg.paired[1]?.kind).toBe("other");
  });

  test("isBtKind accepts only the known row kinds", () => {
    expect(isBtKind("audio")).toBe(true);
    expect(isBtKind("other")).toBe(true);
    expect(isBtKind("printer")).toBe(false);
    expect(isBtKind(undefined)).toBe(false);
  });
});

describe("bluetooth device rows (adapter facts)", () => {
  test("glyph maps each kind", () => {
    expect(btGlyph("audio")).toBe("🎧");
    expect(btGlyph("watch")).toBe("⌚");
    expect(btGlyph("keyboard")).toBe("⌨️");
    expect(btGlyph("phone")).toBe("📱");
    expect(btGlyph("other")).toBe("🔌");
  });

  test("demo list is non-empty and has unique ids", () => {
    expect(DEMO_DEVICES.length).toBeGreaterThan(0);
    expect(new Set(DEMO_DEVICES.map((d) => d.id)).size).toBe(DEMO_DEVICES.length);
  });

  test("kindFromName is a name-only heuristic with a neutral fallback", () => {
    expect(kindFromName("AirPods Pro")).toBe("audio");
    expect(kindFromName("Galaxy Buds2")).toBe("audio");
    expect(kindFromName("Apple Watch")).toBe("watch");
    expect(kindFromName("Magic Keyboard")).toBe("keyboard");
    expect(kindFromName("iPhone 15")).toBe("phone");
    expect(kindFromName("ESP32-A1B2")).toBe("other");
    expect(kindFromName("")).toBe("other");
  });

  test("a peer becomes a row; an unnamed device is identified by its address", () => {
    const named = peerToDevice({ address: "AA:BB:CC:DD:EE:FF", name: "Buds" });
    expect(named).toEqual({ id: "AA:BB:CC:DD:EE:FF", name: "Buds", kind: "audio" });

    const unnamed = peerToDevice({ address: "AA:BB:CC:DD:EE:01", name: "   " });
    expect(unnamed.name).toBe("AA:BB:CC:DD:EE:01");
    expect(unnamed.kind).toBe("other");
    // The id is always the platform's identity, never the label.
    expect(unnamed.id).toBe("AA:BB:CC:DD:EE:01");
  });
});

describe("bluetooth scan rows (REQ-A200/A201)", () => {
  test("scanRow keeps the address as the id and labels the row with the address when unnamed", () => {
    expect(
      scanRow({ address: "AA:BB", name: "  Buds  ", rssi: -60, bond: BOND_BONDED, le: true }),
    ).toEqual({
      id: "AA:BB",
      name: "Buds",
      kind: "audio",
      bond: BOND_BONDED,
      le: true,
      rssi: -60,
    });
    const unnamed = scanRow({ address: "AA:BB", name: "", rssi: null });
    expect(unnamed.name).toBe("AA:BB");
    // No bond reading is *not* "paired" and not "pairing": the row says nothing about a
    // state the device did not report.
    expect(unnamed.bond).toBe(BOND_NONE);
    expect(unnamed.le).toBe(false);
    expect(unnamed.rssi).toBe(null);
  });

  test("only BOND_BONDED reads as paired, and BOND_BONDING reads as pairing", () => {
    const none = scanRow({ address: "a", name: "x", bond: BOND_NONE });
    const bonding = scanRow({ address: "a", name: "x", bond: BOND_BONDING });
    const bonded = scanRow({ address: "a", name: "x", bond: BOND_BONDED });
    expect([rowIsBonded(none), rowIsBonded(bonding), rowIsBonded(bonded)]).toEqual([
      false,
      false,
      true,
    ]);
    // The three states are mutually exclusive — a bonding device is never shown as paired.
    expect([rowIsBonding(none), rowIsBonding(bonding), rowIsBonding(bonded)]).toEqual([
      false,
      true,
      false,
    ]);
  });

  test("the bond constants mirror the platform's values", () => {
    // Pinned against `BluetoothDevice#BOND_*`; a drift here would relabel real devices
    // (the Rust side pins the same numbers, see amos-radio/src/bluetooth.rs).
    expect([BOND_NONE, BOND_BONDING, BOND_BONDED]).toEqual([10, 11, 12]);
  });

  test("sortScanRows: strongest first, named before address-only, then stable by name", () => {
    const rows = [
      scanRow({ address: "b", name: "Weak", rssi: -90 }),
      scanRow({ address: "a", name: "Strong", rssi: -40 }),
      scanRow({ address: "c", name: "NoSignal", rssi: null }),
      scanRow({ address: "z", name: "", rssi: -40 }),
    ];
    expect(sortScanRows(rows).map((r) => r.name)).toEqual([
      "Strong",
      "z",
      "Weak",
      "NoSignal",
    ]);
  });

  test("mergeScanRows keeps a device the new poll did not see, and refreshes the rest", () => {
    const first = [scanRow({ address: "a", name: "Buds", rssi: -50 })];
    const second = [scanRow({ address: "b", name: "TV", rssi: -70 })];
    // Android only re-announces a device when it hears it again: replacing would make
    // rows flicker away between advertisements.
    expect(mergeScanRows(first, second).map((r) => r.id)).toEqual(["a", "b"]);
    expect(mergeScanRows(first, [scanRow({ address: "a", name: "Buds Pro", rssi: -30 })])).toEqual([
      scanRow({ address: "a", name: "Buds Pro", rssi: -30 }),
    ]);
    // Rows without an address cannot be paired and are dropped.
    expect(mergeScanRows([], [scanRow({ address: "  ", name: "ghost" })])).toEqual([]);
  });

  test("mergeScanRows keeps the LE fact and takes the newer bond state", () => {
    // A device heard over LE in one poll and classic in the next is one device that has
    // answered on both channels (REQ-A201) — the tag must not disappear on the classic
    // poll, and the fresher bond state must win in both directions.
    const le = scanRow({ address: "a", name: "Buds", le: true, bond: BOND_NONE });
    const classic = scanRow({ address: "a", name: "Buds", le: false, bond: BOND_BONDING });
    const [merged] = mergeScanRows([le], [classic]);
    expect(merged?.le).toBe(true);
    expect(merged?.bond).toBe(BOND_BONDING);

    const [backToNone] = mergeScanRows(
      [scanRow({ address: "a", name: "Buds", bond: BOND_BONDING })],
      [scanRow({ address: "a", name: "Buds", bond: BOND_NONE })],
    );
    expect(backToNone?.bond).toBe(BOND_NONE);
  });

  test("mergeScanRows caps the merged list, keeping the strongest rows", () => {
    const previous: BtScanRow[] = [];
    for (let i = 0; i < MAX_SCAN_ROWS; i += 1) {
      previous.push(scanRow({ address: `a${i}`, name: `dev${i}`, rssi: -80 }));
    }
    // A new, stronger device must displace a weak one rather than grow the list.
    const merged = mergeScanRows(previous, [
      scanRow({ address: "strong", name: "Strong", rssi: -30 }),
    ]);
    expect(merged.length).toBe(MAX_SCAN_ROWS);
    expect(merged[0]?.name).toBe("Strong");
    expect(merged.filter((r) => r.rssi === -80).length).toBe(MAX_SCAN_ROWS - 1);
  });

  test("pairingProgress reports what the DEVICE said, for a row or only a session record", () => {
    const rows = [scanRow({ address: "AA:BB", name: "Buds", bond: BOND_NONE })];
    // A request that was accepted but has produced no transition yet: nothing is
    // claimed either way.
    expect(pairingProgress([], "AA:BB", rows)).toBe("none");
    // The row's own state is used when there is no session record…
    expect(pairingProgress([], "AA:BB", [scanRow({ address: "AA:BB", name: "x", bond: BOND_BONDING })])).toBe(
      "bonding",
    );
    // …and the session record wins when there is one (it is the newer fact), which is
    // what makes progress visible for an address that has no row at all.
    expect(
      pairingProgress([{ address: "AA:BB", state: BOND_BONDING }], "AA:BB", rows),
    ).toBe("bonding");
    expect(pairingProgress([{ address: "AA:BB", state: BOND_BONDED }], "AA:BB", [])).toBe("bonded");
    // A transition back to "not paired" (the peer declined) is reported as such, not as
    // a success and not as still pairing.
    expect(pairingProgress([{ address: "AA:BB", state: BOND_NONE }], "AA:BB", rows)).toBe("none");
  });
});

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  BLE_AVAILABLE,
  BLE_PROP_INDICATE,
  BLE_PROP_NOTIFY,
  BLE_PROP_READ,
  BLE_PROP_WRITE,
  BLE_PROP_WRITE_NO_RESPONSE,
  BLE_VALUE_EVENT,
  bleCanNotify,
  bleCanRead,
  bleCanWrite,
  bleConnect,
  bleDisconnect,
  bleDiscoverServices,
  bleOnValueChanged,
  blePropertyNames,
  bleRead,
  bleSetNotifications,
  bleSubscribe,
  bleUnsubscribe,
  bleWrite,
  bytesToHex,
  createBleClient,
  hexToBytes,
  isPlausibleBleUuid,
} from "../ble";

/**
 * Regression for REQ-A412 — the two defects `typecheck` surfaced in this module (and which the
 * tests below could not see, because they only asserted `typeof result === "boolean"` on an
 * *unbridged* host):
 *
 * 1. `bleOnValueChanged` called `.listen` on `bridged()` — a **boolean**. That threw inside its
 *    own `try/catch`, so the subscription silently never happened and no BLE value ever reached
 *    the UI. The fake bridge below records the subscription and the test delivers a frame.
 * 2. `bleConnect`/`bleDisconnect`/`bleSubscribe`/`bleUnsubscribe` returned `invoke<T>(…) ?? false`,
 *    where `??` applies to the **Promise** (never nullish) instead of its value — a missing
 *    bridge resolved to `null` under a `Promise<boolean>` signature.
 */
describe("bytesToHex / hexToBytes (the screen's value formatting)", () => {
  it("formats bytes as zero-padded lowercase hex pairs", () => {
    expect(bytesToHex([0, 1, 0xab, 255])).toBe("0001abff");
    expect(bytesToHex([])).toBe("");
  });

  it("round-trips every byte value through hex", () => {
    const all = Array.from({ length: 256 }, (_, i) => i);
    expect(hexToBytes(bytesToHex(all))).toEqual(all);
  });

  it("accepts separators and mixed case", () => {
    expect(hexToBytes("01 a2-ff")).toEqual([0x01, 0xa2, 0xff]);
    expect(hexToBytes("AA:BB")).toEqual([0xaa, 0xbb]);
  });

  it("refuses a bad payload instead of half-parsing it", () => {
    // Negative control for the whole point of the helper: none of these may reach a
    // device write, so each must be `null` — not `[]`, not a truncated prefix.
    expect(hexToBytes("")).toBeNull();
    expect(hexToBytes("0")).toBeNull(); // odd length
    expect(hexToBytes("0g")).toBeNull(); // not hex
    expect(hexToBytes("zzzz")).toBeNull();
  });
});

describe("isPlausibleBleUuid", () => {
  it("accepts the three legal shapes", () => {
    expect(isPlausibleBleUuid("180d")).toBe(true);
    expect(isPlausibleBleUuid("0000180d")).toBe(true);
    expect(isPlausibleBleUuid("0000180d-0000-1000-8000-00805f9b34fb")).toBe(true);
    expect(isPlausibleBleUuid("  180D  ")).toBe(true); // trimmed
  });

  it("rejects shapes the glue would throw on", () => {
    expect(isPlausibleBleUuid("")).toBe(false);
    expect(isPlausibleBleUuid("180")).toBe(false); // 3 digits
    expect(isPlausibleBleUuid("180dd")).toBe(false);
    expect(isPlausibleBleUuid("180g")).toBe(false);
    expect(isPlausibleBleUuid("0000180d-0000-1000-8000-00805f9b34fb-x")).toBe(false);
    expect(isPlausibleBleUuid("0000180d00001000-8000-00805f9b34fb")).toBe(false);
  });
});

/**
 * The device's own answer about what a characteristic permits — the table the screen gates its
 * three controls on (REQ-A1198 / F-SH-487).
 *
 * The numbers are Android's `BluetoothGattCharacteristic.getProperties()` bits, and the two
 * directions that matter are pinned separately: what the mask says **yes** to, and what it says
 * **no** to (a gate that only ever reads `true` never disables anything).
 */
describe("characteristic property bits", () => {
  it("reads the Android property bitmap", () => {
    expect(bleCanRead(BLE_PROP_READ)).toBe(true);
    expect(bleCanRead(BLE_PROP_NOTIFY)).toBe(false);
    expect(bleCanNotify(BLE_PROP_NOTIFY)).toBe(true);
    expect(bleCanNotify(BLE_PROP_INDICATE)).toBe(true);
    expect(bleCanNotify(BLE_PROP_READ)).toBe(false);
    expect(bleCanRead(0x00)).toBe(false);
  });

  it("a with-response write needs PROPERTY_WRITE; a without-response one takes either bit", () => {
    expect(bleCanWrite(BLE_PROP_WRITE, true)).toBe(true);
    expect(bleCanWrite(BLE_PROP_WRITE_NO_RESPONSE, true)).toBe(false);
    // Refusing here would disable a control the device would have carried out: a Write Command
    // is accepted by a characteristic that advertises only the with-response bit.
    expect(bleCanWrite(BLE_PROP_WRITE, false)).toBe(true);
    expect(bleCanWrite(BLE_PROP_WRITE_NO_RESPONSE, false)).toBe(true);
    expect(bleCanWrite(BLE_PROP_READ, false)).toBe(false);
  });

  it("names what the mask carries, in the spec's bit order", () => {
    expect(blePropertyNames(BLE_PROP_READ | BLE_PROP_WRITE | BLE_PROP_NOTIFY)).toEqual([
      "read",
      "write",
      "notify",
    ]);
    expect(blePropertyNames(0xff)).toHaveLength(8);
    // A mask the table does not know yields nothing — the caller decides what to show instead of
    // this helper inventing a name for a bit that does not exist.
    expect(blePropertyNames(0x00)).toEqual([]);
  });
});

describe("bleSetNotifications", () => {
  it("routes on/off through the client it is given", async () => {
    const seen: string[] = [];
    const client = {
      async connect() {
        return true;
      },
      async disconnect() {
        return true;
      },
      async discoverServices() {
        return { ok: true as const, services: [] };
      },
      async read() {
        return { ok: true as const, bytes: [] };
      },
      async write() {
        return { ok: true as const };
      },
      async subscribe(s: string, c: string) {
        seen.push(`on:${s}:${c}`);
        return true;
      },
      async unsubscribe(s: string, c: string) {
        seen.push(`off:${s}:${c}`);
        return true;
      },
    };
    expect(await bleSetNotifications(client, "180d", "2a37", true)).toBe(true);
    expect(await bleSetNotifications(client, "180d", "2a37", false)).toBe(true);
    // The pair must not drift: on goes to subscribe, off goes to unsubscribe.
    expect(seen).toEqual(["on:180d:2a37", "off:180d:2a37"]);
  });
});

describe("bridge path (fake __TAURI_INTERNALS__)", () => {
  let subscribedChannel: string | null = null;
  let deliver: ((e: { payload: unknown }) => void) | null = null;
  let unsubscribed = 0;
  /** Every `invoke` this fake bridge was asked for, so a test can read what was sent. */
  let calls: { cmd: string; args?: Record<string, unknown> }[] = [];

  const globals = globalThis as Record<string, unknown>;

  beforeEach(() => {
    subscribedChannel = null;
    deliver = null;
    unsubscribed = 0;
    calls = [];
    globals.window = {
      __TAURI_INTERNALS__: {
        // "Bridge present, every command answers nothing" — the state that used to leak `null`.
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          calls.push({ cmd, args });
          return null;
        },
        listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
          subscribedChannel = channel;
          deliver = handler;
          return () => {
            unsubscribed += 1;
          };
        },
      },
    };
  });

  afterEach(() => {
    delete globals.window;
  });

  it("a command the host did not answer is `null`, never `false`", async () => {
    // REQ-A1337 / F-SH-603. `invoke` resolves `null` when the command was refused and never
    // rejects, so the wrapper is the only place that knows the host said nothing. The old
    // `?? false` handed the screen a `false` it words as 「设备拒绝或超出了范围」 — the device
    // named as the refuser of a request it was never sent.
    expect(await bleConnect("AA:BB:CC:DD:EE:FF")).toBeNull();
    expect(await bleDisconnect()).toBeNull();
    const client = createBleClient();
    // `createBleClient` holds a client, not a live host: this one *did* answer, with nothing.
    expect(await client.subscribe("180F", "2A19")).toBeNull();
    expect(await client.unsubscribe("180F", "2A19")).toBeNull();
  });

  it("the object-answering reads are null too, never a cause this side invented", async () => {
    // `{ ok: false, error: "not bridged" }` was a **cause** no host ever said: the screen
    // renders `error` verbatim (「发现失败：not bridged」/「读取失败：not bridged」), so an
    // unanswered discovery printed an English string this module made up (REQ-A1337).
    expect(await bleDiscoverServices()).toBeNull();
    expect(await bleRead("180d", "2a37")).toBeNull();
    expect(await bleWrite("180d", "2a37", [1], false)).toBeNull();
  });

  it("an answered command is passed through unchanged, including `false`", async () => {
    // The counterpart the fold's protection hid: `false` is the host's own report and must
    // stay `false` — it is not the same value as `null`.
    (globals.window as { __TAURI_INTERNALS__: { invoke: unknown } }).__TAURI_INTERNALS__.invoke =
      async (cmd: string) =>
        cmd === "ble_connect" ? false : { ok: false, error: "the host's own words" };
    expect(await bleConnect("AA:BB:CC:DD:EE:FF")).toBe(false);
    expect(await bleRead("180d", "2a37")).toEqual({
      ok: false,
      error: "the host's own words",
    });
  });

  it("sends the UUID that was judged, not the raw input", async () => {
    // `isPlausibleBleUuid` trims before it judges, so the screen's gate admits `"  180d  "`; the
    // Kotlin glue calls `UUID.fromString` on whatever arrives and throws on that string. What the
    // gate validated and what reaches the device must be the same string, so the trim lives at
    // this boundary rather than in each caller (REQ-A1198).
    await bleRead("  180d  ", " 2a37\t");
    await bleWrite(" 180d ", "2a37\n", [1], false);
    await bleSubscribe("180d\n", " 2a37 ");
    await bleUnsubscribe(" 180d ", "2a37 ");

    expect(calls.map((c) => [c.cmd, c.args?.serviceUuid, c.args?.characteristicUuid])).toEqual([
      ["ble_read", "180d", "2a37"],
      ["ble_write", "180d", "2a37"],
      ["ble_subscribe", "180d", "2a37"],
      ["ble_unsubscribe", "180d", "2a37"],
    ]);
  });

  it("subscribing really subscribes, delivers the frames Rust emits, and unsubscribes", async () => {
    const seen: Array<{ event: string; characteristicUuid: string; value: number[] }> = [];
    const unsubscribe = await bleOnValueChanged((v) => seen.push(v));

    expect(subscribedChannel).toBe(BLE_VALUE_EVENT);
    expect(deliver).not.toBeNull();

    // The *literal* shapes `jni_glue` emits (Rust → WebView) — a hand-written `"read"` here
    // used to pass while the mapping tested for an event nothing emits, so every read result
    // reached the UI labelled `"notification"` (REQ-A413).
    deliver!({ payload: { event: "read_result", uuid: "2A19", value: [1, 2, 3] } });
    deliver!({ payload: { event: "notification", uuid: "2A19", value: [4] } });
    // A frame with no uuid is a status frame (connected/services_discovered/write_result): it
    // must not reach the value callback.
    deliver!({ payload: { event: "connected" } });
    deliver!({ payload: { event: "notification", value: [9] } });

    expect(seen).toEqual([
      { event: "read", characteristicUuid: "2A19", value: [1, 2, 3] },
      { event: "notification", characteristicUuid: "2A19", value: [4] },
    ]);

    // REQ-A838：机械适配 —— `bleOnValueChanged` 现在可以是 `null`。蓝牙本轮不在范围内，
    // 因此这里只断言"建立了才退订"，不为蓝牙补判定的可见性。
    unsubscribe?.();
    expect(unsubscribed).toBe(1);
  });
});


describe("BLE constants", () => {
  it("BLE_VALUE_EVENT is the expected string", () => {
    expect(BLE_VALUE_EVENT).toBe("ble-value-changed");
  });
});

describe("createBleClient", () => {
  it("returns a client object with required methods", () => {
    const client = createBleClient();
    expect(typeof client.connect).toBe("function");
    expect(typeof client.disconnect).toBe("function");
    expect(typeof client.discoverServices).toBe("function");
    expect(typeof client.read).toBe("function");
    expect(typeof client.write).toBe("function");
    expect(typeof client.subscribe).toBe("function");
    expect(typeof client.unsubscribe).toBe("function");
  });

  it("connect returns boolean (false on host)", async () => {
    const client = createBleClient();
    const result = await client.connect("AA:BB:CC:DD:EE:FF");
    expect(typeof result).toBe("boolean");
  });

  it("disconnect returns boolean", async () => {
    const client = createBleClient();
    const result = await client.disconnect();
    expect(typeof result).toBe("boolean");
  });

  it("read answers for itself on the Web Bluetooth path — `null` means 'no host', not 'no web'", async () => {
    const client = createBleClient();
    const result = await client.read("180F", "2A19");
    // There is no bridge to defer to here, so this runtime observed the failure itself and
    // answers a real `{ ok: false, error }` (REQ-A1337).
    expect(result).not.toBeNull();
    expect(typeof result?.ok).toBe("boolean");
  });

  it("write answers for itself on the Web Bluetooth path", async () => {
    const client = createBleClient();
    const result = await client.write("180F", "2A19", [0x01], false);
    expect(result).not.toBeNull();
    expect(typeof result?.ok).toBe("boolean");
  });

  it("subscribe returns boolean on host", async () => {
    const client = createBleClient();
    const result = await client.subscribe("180F", "2A19");
    expect(typeof result).toBe("boolean");
  });

  it("unsubscribe returns boolean on host", async () => {
    const client = createBleClient();
    const result = await client.unsubscribe("180F", "2A19");
    expect(typeof result).toBe("boolean");
  });
});

describe("BLE_AVAILABLE", () => {
  it("matches navigator.bluetooth presence", () => {
    // In a DOM environment, this reflects the platform capability.
    expect(typeof BLE_AVAILABLE).toBe("boolean");
  });
});

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  BLE_AVAILABLE,
  bleConnect,
  bleDisconnect,
  bleOnValueChanged,
  createBleClient,
  BLE_VALUE_EVENT,
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
describe("bridge path (fake __TAURI_INTERNALS__)", () => {
  let subscribedChannel: string | null = null;
  let deliver: ((e: { payload: unknown }) => void) | null = null;
  let unsubscribed = 0;

  const globals = globalThis as Record<string, unknown>;

  beforeEach(() => {
    subscribedChannel = null;
    deliver = null;
    unsubscribed = 0;
    globals.window = {
      __TAURI_INTERNALS__: {
        // "Bridge present, every command answers nothing" — the state that used to leak `null`.
        invoke: async () => null,
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

  it("a command that answers nothing is `false`, never `null`", async () => {
    // The old `invoke<boolean>(…) ?? false` coalesced the Promise, not its value.
    expect(await bleConnect("AA:BB:CC:DD:EE:FF")).toBe(false);
    expect(await bleDisconnect()).toBe(false);
    const client = createBleClient();
    expect(await client.subscribe("180F", "2A19")).toBe(false);
    expect(await client.unsubscribe("180F", "2A19")).toBe(false);
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

    unsubscribe();
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

  it("read returns BleReadResult shape on host (false)", async () => {
    const client = createBleClient();
    const result = await client.read("180F", "2A19");
    expect(result).toHaveProperty("ok");
    expect(typeof result.ok).toBe("boolean");
  });

  it("write returns BleWriteResult shape on host (false)", async () => {
    const client = createBleClient();
    const result = await client.write("180F", "2A19", [0x01], false);
    expect(result).toHaveProperty("ok");
    expect(typeof result.ok).toBe("boolean");
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

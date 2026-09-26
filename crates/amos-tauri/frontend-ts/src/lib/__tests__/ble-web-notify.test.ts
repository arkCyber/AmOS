/**
 * The Web Bluetooth runtime's value path (REQ-A1189 / F-SH-478).
 *
 * The screen offers three runtimes and names each honestly. On the middle one — Web Bluetooth,
 * the host/Chromium path the app's own `ble.unavailableHint` calls supported — the screen
 * confirmed a subscribe with 「已订阅：特征值变化会出现在下方记录里。」 and then nothing could
 * ever appear: `webSubscribe` started notifications and answered `true` but attached **no**
 * `characteristicvaluechanged` listener, and `bleOnValueChanged` answered `null` off-device (no
 * Tauri event plugin), so the screen had no sink at all. The device was notifying; no host-side
 * code was reading it.
 *
 * `BLE_AVAILABLE` is read once, at module load, so this file installs a fake
 * `navigator.bluetooth` **before** importing `../ble` — that ordering is the only way to put the
 * module in the web runtime, and it is the runtime under test.
 */
import { afterEach, describe, expect, it } from "vitest";
// `import type` is erased at compile time, so it does not load `../ble` before the stub below
// installs `navigator.bluetooth`; the runtime import is the dynamic one further down.
import type { BleValue } from "../ble";

/** The fake characteristic, shaped like the platform's: `value` set, then the event fired. */
class FakeCharacteristic {
  readonly uuid: string;
  value: DataView | undefined;
  started = 0;
  stopped = 0;
  private listeners = new Set<(ev: Event) => void>();

  constructor(uuid: string) {
    this.uuid = uuid;
  }

  async startNotifications(): Promise<FakeCharacteristic> {
    this.started += 1;
    return this;
  }

  async stopNotifications(): Promise<FakeCharacteristic> {
    this.stopped += 1;
    return this;
  }

  addEventListener(_type: "characteristicvaluechanged", listener: (ev: Event) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "characteristicvaluechanged", listener: (ev: Event) => void): void {
    this.listeners.delete(listener);
  }

  /** Deliver one notification the way the platform does. */
  notify(bytes: number[]): void {
    this.value = new DataView(new Uint8Array(bytes).buffer);
    for (const listener of [...this.listeners]) listener({ target: this } as unknown as Event);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

const characteristic = new FakeCharacteristic("2a37");
let disconnected = 0;

const server = {
  connected: true,
  async connect() {
    return this;
  },
  disconnect() {
    disconnected += 1;
    this.connected = false;
  },
  async getPrimaryService() {
    return {
      uuid: "180d",
      async getCharacteristic() {
        return characteristic;
      },
    };
  },
};

const device = { id: "fake", name: "Fake", gatt: server };

Object.defineProperty(navigator, "bluetooth", {
  configurable: true,
  value: {
    async requestDevice() {
      return device;
    },
  },
});

/** Imported after the stub above so the module loads in the Web Bluetooth runtime. */
const ble = await import("../ble");

afterEach(() => {
  server.connected = true;
  characteristic.value = undefined;
});

describe("Web Bluetooth value path", () => {
  it("loads in the web runtime, not the bridged one", () => {
    // Guard for the whole file: if this is false the test below proves nothing about the
    // web path (it would be exercising the Tauri branch instead).
    expect(ble.BLE_AVAILABLE).toBe(true);
    expect(ble.tauriBleAvailable()).toBe(false);
    expect(ble.createBleClient()).toBeDefined();
  });

  it("a web subscribe delivers the device's notifications to the value callback", async () => {
    const seen: BleValue[] = [];
    const client = ble.createBleClient();
    expect(await client.connect("AA:BB:CC")).toBe(true);

    // What the screen does on mount, before any GATT call.
    const off = await ble.bleOnValueChanged((v) => seen.push(v));
    expect(typeof off).toBe("function");

    expect(await client.subscribe("180d", "2a37")).toBe(true);
    expect(characteristic.started).toBe(1);

    characteristic.notify([1, 2, 255]);
    expect(seen).toEqual([
      { event: "notification", characteristicUuid: "2a37", value: [1, 2, 255] },
    ]);

    // A confirmed unsubscribe stops the stream at the source…
    expect(await client.unsubscribe("180d", "2a37")).toBe(true);
    expect(characteristic.stopped).toBe(1);
    expect(characteristic.listenerCount()).toBe(0);
    characteristic.notify([9]);
    expect(seen.length).toBe(1);

    off?.();
  });

  it("re-subscribing replaces the listener instead of delivering every value twice", async () => {
    const seen: BleValue[] = [];
    const client = ble.createBleClient();
    await client.connect("AA:BB:CC");
    const off = await ble.bleOnValueChanged((v) => seen.push(v));

    expect(await client.subscribe("180d", "2a37")).toBe(true);
    expect(await client.subscribe("180d", "2a37")).toBe(true);
    expect(characteristic.listenerCount()).toBe(1);
    characteristic.notify([7]);
    expect(seen.length).toBe(1);

    off?.();
  });

  it("an unsubscribe the device refuses leaves the listener attached", async () => {
    // The screen keeps reading 「取消订阅」 for a stream it is still displaying, so the library
    // must not tear down the plumbing underneath it.
    const seen: BleValue[] = [];
    const client = ble.createBleClient();
    await client.connect("AA:BB:CC");
    const off = await ble.bleOnValueChanged((v) => seen.push(v));
    await client.subscribe("180d", "2a37");

    const realStop = characteristic.stopNotifications.bind(characteristic);
    characteristic.stopNotifications = async () => {
      throw new Error("device refused");
    };
    expect(await client.unsubscribe("180d", "2a37")).toBe(false);
    characteristic.stopNotifications = realStop;

    expect(characteristic.listenerCount()).toBe(1);
    characteristic.notify([5]);
    expect(seen.length).toBe(1);

    off?.();
  });

  it("the value callback can be detached", async () => {
    const seen: BleValue[] = [];
    const client = ble.createBleClient();
    await client.connect("AA:BB:CC");
    const off = await ble.bleOnValueChanged((v) => seen.push(v));
    await client.subscribe("180d", "2a37");
    off?.();
    characteristic.notify([1]);
    expect(seen).toEqual([]);
  });

  it("disconnecting drops the listeners with the GATT client", async () => {
    const client = ble.createBleClient();
    await client.connect("AA:BB:CC");
    await client.subscribe("180d", "2a37");
    expect(await client.disconnect()).toBe(true);
    expect(disconnected).toBeGreaterThan(0);
    expect(characteristic.listenerCount()).toBe(0);
  });
});

/**
 * BLE GATT client — real device BLE read/write/notify.
 *
 * **Platform support**: `navigator.bluetooth` (Web Bluetooth API, Android Chrome,
 * ChromeOS, Edge 79+, macOS 12+). Not available on iOS Safari / desktop Safari.
 * The caller MUST check `BLE_AVAILABLE` before any operation.
 *
 * **Design**: GATT operations go through the Tauri bridge to the Kotlin
 * `BluetoothGattGlue` on-device (via amos-tauri's BLE commands); offline / host
 * falls back to `navigator.bluetooth` directly. The Kotlin path is the real
 * one (full BLE, stable across OS versions). The Web Bluetooth path is a
 * convenience for host-side development and Chromium-based desktop.
 *
 * **Service / Characteristic UUIDs**: callers pass raw UUID strings.
 * No UUID constants live here — they belong in the device-specific consumer.
 *
 * **Thread safety on Android**: Kotlin BLE callbacks fire on a Binder thread;
 * the Tauri command handler posts results back to the WebView via a oneshot
 * channel, so every `invoke` resolves exactly once.
 */
import { invoke, bridged, subscribe } from "./backend";
import { amosWarn } from "./debugLog";

/** Whether the Web Bluetooth API is available in this runtime. */
export const BLE_AVAILABLE =
  typeof navigator !== "undefined" && typeof navigator.bluetooth !== "undefined";

/** Whether the Tauri Android BLE bridge is available. */
export function tauriBleAvailable(): boolean {
  return bridged();
}

/* ---- Kotlin BLE command surface (the real path on Android) ---- */

/** Outcome of a GATT read: the bytes or an error string. */
export type BleReadResult =
  | { ok: true; bytes: number[] }
  | { ok: false; error: string };

/** Outcome of a GATT write. */
export type BleWriteResult =
  | { ok: true }
  | { ok: false; error: string };

/** One discovered GATT service. */
export interface BleService {
  uuid: string;
}

/** One discovered GATT characteristic. */
export interface BleCharacteristic {
  uuid: string;
  /** Characteristic property flags (android.bluetooth.BluetoothGattCharacteristic). */
  properties: number;
}

/** One discovered GATT descriptor. */
export interface BleDescriptor {
  uuid: string;
}

/** State of a BLE GATT operation. */
export type BleGattState =
  | "idle"
  | "connecting"
  | "discovering"
  | "connected"
  | "reading"
  | "writing"
  | "subscribing"
  | "unsubscribing"
  | "disconnected";

/** Subscribe to BLE value-change events. Channel name emitted by the Kotlin glue. */
export const BLE_VALUE_EVENT = "ble-value-changed";

/**
 * Connect to a BLE device by `address`.
 * Returns `true` when the connection was initiated (Android: bonding flow starts).
 */
export async function bleConnect(address: string): Promise<boolean> {
  return (await invoke<boolean>("ble_connect", { address })) ?? false;
}

/** Disconnect and release the GATT client. */
export async function bleDisconnect(): Promise<boolean> {
  return (await invoke<boolean>("ble_disconnect")) ?? false;
}

/** Discover all services + characteristics on the connected device. */
export async function bleDiscoverServices(): Promise<BleService[] | null> {
  return invoke<BleService[]>("ble_discover_services");
}

/** Read the value of a GATT characteristic.
 *  Returns the raw bytes (little-endian for standard GATT types). */
export async function bleRead(
  serviceUuid: string,
  characteristicUuid: string,
): Promise<BleReadResult> {
  const r = await invoke<BleReadResult>("ble_read", {
    serviceUuid,
    characteristicUuid,
  });
  return r ?? { ok: false, error: "not bridged" };
}

/** Write a value to a GATT characteristic.
 *  `withResponse` = whether to wait for a write confirmation (Android WRITE_TYPE).
 */
export async function bleWrite(
  serviceUuid: string,
  characteristicUuid: string,
  value: number[],
  withResponse = false,
): Promise<BleWriteResult> {
  const r = await invoke<BleWriteResult>("ble_write", {
    serviceUuid,
    characteristicUuid,
    value,
    withResponse,
  });
  return r ?? { ok: false, error: "not bridged" };
}

/** Start receiving notifications/indications for a characteristic.
 *  Values are emitted on the `ble-value-changed` event channel.
 */
export async function bleSubscribe(
  serviceUuid: string,
  characteristicUuid: string,
): Promise<boolean> {
  return (await invoke<boolean>("ble_subscribe", { serviceUuid, characteristicUuid })) ?? false;
}

/** Stop receiving notifications/indications for a characteristic. */
export async function bleUnsubscribe(
  serviceUuid: string,
  characteristicUuid: string,
): Promise<boolean> {
  return (await invoke<boolean>("ble_unsubscribe", { serviceUuid, characteristicUuid })) ?? false;
}

/**
 * Subscribe to BLE characteristic value changes from the Kotlin glue.
 *
 * The Rust bridge (`jni_glue::onCharacteristicReadResult` / `onCharacteristicChanged`) emits
 * two value-bearing shapes on one channel:
 *
 *   `{ event: "read_result", uuid, value }` and `{ event: "notification", uuid, value }`.
 *
 * Both are normalised to the `event` discriminator below. (The mapping used to test for
 * `"read"`, which **nothing emits** — so every read result reached the UI labelled as a
 * notification, while the unit test passed a hand-written `"read"` frame that hid it.) Frames
 * without a `uuid` are status frames (`connected`, `services_discovered`, `write_result`) and
 * are not value notifications, so they are ignored.
 *
 * Returns an unsubscribe function.
 */
export async function bleOnValueChanged(
  onValue: (payload: {
    event: "notification" | "read";
    /** The characteristic UUID the value came from (service UUID not available on the wire). */
    characteristicUuid: string;
    value: number[];
  }) => void,
): Promise<() => void> {
  // `bridged()` answers *whether* a bridge exists (a boolean); the old code called
  // `.listen` on that boolean, which threw and was swallowed by the `try/catch` below — so
  // the subscription silently never happened and no BLE value ever reached the UI
  // (REQ-A412). `subscribe()` is the bridge helper that owns the event-plugin handshake.
  return subscribe(BLE_VALUE_EVENT, (payload) => {
    const raw = payload as {
      event?: string;
      uuid?: string;
      value?: unknown;
    };
    if (!raw || typeof raw.uuid !== "string") return;
    const value = Array.isArray(raw.value)
      ? (raw.value as number[]).filter((n) => typeof n === "number")
      : [];
    const evt = raw.event === "read_result" ? "read" : "notification";
    onValue({ event: evt, characteristicUuid: raw.uuid, value });
  });
}

/* ---- Web Bluetooth fallback (host / Chromium desktop) ---- */

let _webDevice: BluetoothDevice | null = null;
let _webServer: BluetoothRemoteGATTServer | null = null;

async function webConnect(address: string): Promise<boolean> {
  if (!BLE_AVAILABLE) return false;
  try {
    // Web Bluetooth `addressPrefix` is a hex prefix without colons, max 6 chars
    // (the OUI: first 3 bytes of the MAC). Strip colons and take 6 hex chars.
    const hex = address.replace(/:/g, "").toUpperCase();
    const prefix = hex.substring(0, 6);
    if (prefix.length < 6) return false;
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ addressPrefix: prefix }],
    });
    _webDevice = device;
    _webServer = device.gatt ?? null;
    if (!_webServer) return false;
    await _webServer.connect();
    return _webServer.connected;
  } catch (e) {
    amosWarn("ble", "web bluetooth connect failed", e);
    return false;
  }
}

async function webDisconnect(): Promise<void> {
  _webServer?.disconnect();
  _webDevice = null;
  _webServer = null;
}

async function webRead(
  serviceUuid: string,
  characteristicUuid: string,
): Promise<BleReadResult> {
  if (!_webServer || !_webServer.connected || !_webDevice) {
    return { ok: false, error: "not connected" };
  }
  try {
    const svc = await _webServer.getPrimaryService(serviceUuid);
    const chr = await svc.getCharacteristic(characteristicUuid);
    const val = await chr.readValue();
    const bytes = Array.from(new Uint8Array(val.buffer));
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function webWrite(
  serviceUuid: string,
  characteristicUuid: string,
  value: number[],
  withResponse: boolean,
): Promise<BleWriteResult> {
  if (!_webServer || !_webServer.connected || !_webDevice) {
    return { ok: false, error: "not connected" };
  }
  try {
    const svc = await _webServer.getPrimaryService(serviceUuid);
    const chr = await svc.getCharacteristic(characteristicUuid);
    if (withResponse) {
      await chr.writeValueWithResponse(new Uint8Array(value));
    } else {
      await chr.writeValueWithoutResponse(new Uint8Array(value));
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function webSubscribe(
  serviceUuid: string,
  characteristicUuid: string,
): Promise<boolean> {
  if (!_webServer || !_webServer.connected) return false;
  try {
    const svc = await _webServer.getPrimaryService(serviceUuid);
    const chr = await svc.getCharacteristic(characteristicUuid);
    await chr.startNotifications();
    return true;
  } catch (e) {
    amosWarn("ble", "web bluetooth subscribe failed", e);
    return false;
  }
}

async function webUnsubscribe(
  serviceUuid: string,
  characteristicUuid: string,
): Promise<boolean> {
  if (!_webServer || !_webServer.connected) return false;
  try {
    const svc = await _webServer.getPrimaryService(serviceUuid);
    const chr = await svc.getCharacteristic(characteristicUuid);
    await chr.stopNotifications();
    return true;
  } catch (e) {
    amosWarn("ble", "web bluetooth unsubscribe failed", e);
    return false;
  }
}

/**
 * Unified BLE GATT interface: tries the Tauri Kotlin bridge first (real Android),
 * falls back to Web Bluetooth API (host / Chromium desktop).
 */
export interface BleClient {
  connect(address: string): Promise<boolean>;
  disconnect(): Promise<boolean>;
  discoverServices(): Promise<BleService[] | null>;
  read(serviceUuid: string, characteristicUuid: string): Promise<BleReadResult>;
  write(
    serviceUuid: string,
    characteristicUuid: string,
    value: number[],
    withResponse?: boolean,
  ): Promise<BleWriteResult>;
  subscribe(serviceUuid: string, characteristicUuid: string): Promise<boolean>;
  unsubscribe(serviceUuid: string, characteristicUuid: string): Promise<boolean>;
}

/** Returns a BleClient that uses the Tauri bridge on device, Web Bluetooth on host. */
export function createBleClient(): BleClient {
  const useTauri = tauriBleAvailable();

  return {
    async connect(address: string): Promise<boolean> {
      if (useTauri) return bleConnect(address);
      return webConnect(address);
    },
    async disconnect(): Promise<boolean> {
      if (useTauri) return bleDisconnect();
      await webDisconnect();
      return true;
    },
    async discoverServices(): Promise<BleService[] | null> {
      if (useTauri) return bleDiscoverServices();
      return null;
    },
    async read(
      serviceUuid: string,
      characteristicUuid: string,
    ): Promise<BleReadResult> {
      if (useTauri) return bleRead(serviceUuid, characteristicUuid);
      return webRead(serviceUuid, characteristicUuid);
    },
    async write(
      serviceUuid: string,
      characteristicUuid: string,
      value: number[],
      withResponse = false,
    ): Promise<BleWriteResult> {
      if (useTauri) return bleWrite(serviceUuid, characteristicUuid, value, withResponse);
      return webWrite(serviceUuid, characteristicUuid, value, withResponse);
    },
    async subscribe(
      serviceUuid: string,
      characteristicUuid: string,
    ): Promise<boolean> {
      if (useTauri) return bleSubscribe(serviceUuid, characteristicUuid);
      return webSubscribe(serviceUuid, characteristicUuid);
    },
    async unsubscribe(
      serviceUuid: string,
      characteristicUuid: string,
    ): Promise<boolean> {
      if (useTauri) return bleUnsubscribe(serviceUuid, characteristicUuid);
      return webUnsubscribe(serviceUuid, characteristicUuid);
    },
  };
}

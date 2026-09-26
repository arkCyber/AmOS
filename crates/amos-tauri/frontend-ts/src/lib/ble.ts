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

/**
 * Trim a UUID at the bridge boundary.
 *
 * The Kotlin glue calls `UUID.fromString` on this string and throws on anything malformed, and
 * the screen keys its subscribe toggle by a **trimmed** `service/characteristic` pair while it
 * used to send the raw field — so a stray space made the toggle's key disagree with the UUID the
 * device was actually asked about (REQ-A1198). Normalising once, here, is what keeps the key and
 * the wire call the same string; every UUID-bearing sender below goes through it.
 */
const normUuid = (uuid: string): string => uuid.trim();

/** Outcome of a GATT read: the bytes or an error string. */
export type BleReadResult =
  | { ok: true; bytes: number[] }
  | { ok: false; error: string };

/** Outcome of a GATT write. */
export type BleWriteResult =
  | { ok: true }
  | { ok: false; error: string };

/** One discovered GATT service, with the characteristics the platform reported for it. */
export interface BleService {
  uuid: string;
  characteristics: BleCharacteristic[];
}

/**
 * Outcome of a GATT service discovery.
 *
 * Distinct from an **empty** `services` list, which is a real answer ("the device advertises
 * no services"): `ok: false` means the bridge could not get a list at all — no glue, a refused
 * `discoverServices`, a stack that took the request and never answered, a discovery superseded
 * by a newer one, or a service list the platform sent that could not be read. The screen says
 * those apart (REQ-A1157, REQ-A1198).
 */
export type BleDiscoverResult =
  | { ok: true; services: BleService[] }
  | { ok: false; error: string };

/** One discovered GATT characteristic. */
export interface BleCharacteristic {
  uuid: string;
  /** Characteristic property flags (android.bluetooth.BluetoothGattCharacteristic). */
  properties: number;
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

/** One value frame handed to a `bleOnValueChanged` callback. */
export interface BleValue {
  event: "notification" | "read";
  /** The characteristic UUID the value came from (service UUID not available on the wire). */
  characteristicUuid: string;
  value: number[];
}

/**
 * Connect to a BLE device by `address`, or `null` when the host did not answer.
 *
 * `false` means a GATT **client object** was not created and the request was never handed to the
 * platform — no adapter, bad MAC, permission refused. That is a fact this runtime observed.
 * `null` is its own fact (REQ-A1337 / F-SH-603): `invoke` resolves `null` for a refused command
 * and never rejects, and the old `?? false` turned "the host did not answer" into the same `false`
 * — which the screen words as 「连接失败：设备拒绝或超出了范围」, a claim about **the remote
 * device** derived from a question nobody answered.
 *
 * Neither value says whether the device answered; that verdict arrives asynchronously on the
 * `ble-value-changed` channel as `connected` (REQ-A1158 / F-SH-459).
 */
export async function bleConnect(address: string): Promise<boolean | null> {
  return await invoke<boolean>("ble_connect", { address });
}

/**
 * Disconnect and release the GATT client, or `null` when the host did not answer.
 *
 * `false` = the host answered that it did not confirm the teardown; `null` = it did not answer
 * at all. The screen must not word the second as 「系统没有确认」 — that sentence asserts the
 * system spoke (REQ-A1337).
 */
export async function bleDisconnect(): Promise<boolean | null> {
  return await invoke<boolean>("ble_disconnect");
}

/**
 * Discover all services on the connected device, or `null` when the host did not answer.
 *
 * `null` is the same "this runtime could not obtain a list" the unified client has always used
 * for the Web Bluetooth path (`BleClient.discoverServices`). Synthesizing
 * `{ ok: false, error: "not bridged" }` here instead made the screen print a **cause this side
 * invented** — an English string the host never said (REQ-A1337).
 */
export async function bleDiscoverServices(): Promise<BleDiscoverResult | null> {
  return await invoke<BleDiscoverResult>("ble_discover_services");
}

/**
 * Read the value of a GATT characteristic.
 *
 * Returns the raw bytes (little-endian for standard GATT types), or `null` when the host did not
 * answer — `{ ok: false, error }` is the host's own report about the read, and only the host can
 * say that (REQ-A1337).
 */
export async function bleRead(
  serviceUuid: string,
  characteristicUuid: string,
): Promise<BleReadResult | null> {
  return await invoke<BleReadResult>("ble_read", {
    serviceUuid: normUuid(serviceUuid),
    characteristicUuid: normUuid(characteristicUuid),
  });
}

/**
 * Write a value to a GATT characteristic.
 *
 * `withResponse` = whether to wait for a write confirmation (Android WRITE_TYPE). `null` = the
 * host did not answer (REQ-A1337).
 */
export async function bleWrite(
  serviceUuid: string,
  characteristicUuid: string,
  value: number[],
  withResponse = false,
): Promise<BleWriteResult | null> {
  return await invoke<BleWriteResult>("ble_write", {
    serviceUuid: normUuid(serviceUuid),
    characteristicUuid: normUuid(characteristicUuid),
    value,
    withResponse,
  });
}

/**
 * Start receiving notifications/indications for a characteristic.
 * Values are emitted on the `ble-value-changed` event channel.
 *
 * `null` = the host did not answer. The old `?? false` rendered that as 「订阅被设备拒绝。」
 * — the screen naming **the device** as the refuser of a command the device was never asked
 * (REQ-A1337 / F-SH-603).
 */
export async function bleSubscribe(
  serviceUuid: string,
  characteristicUuid: string,
): Promise<boolean | null> {
  return await invoke<boolean>("ble_subscribe", {
    serviceUuid: normUuid(serviceUuid),
    characteristicUuid: normUuid(characteristicUuid),
  });
}

/**
 * Stop receiving notifications/indications for a characteristic.
 *
 * `null` = the host did not answer. This one is the sharpest case: the folded value drove
 * 「取消订阅被设备拒绝：设备仍在推送。」 — an assertion that the device is **still notifying**,
 * made without ever having asked it (REQ-A1337).
 */
export async function bleUnsubscribe(
  serviceUuid: string,
  characteristicUuid: string,
): Promise<boolean | null> {
  return await invoke<boolean>("ble_unsubscribe", {
    serviceUuid: normUuid(serviceUuid),
    characteristicUuid: normUuid(characteristicUuid),
  });
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
 * Returns an unsubscribe function, or `null` when the subscription was not established
 * (REQ-A838). **Bluetooth is out of scope for this round** — this site is widened only so the
 * file compiles against the now-nullable `subscribe`; the callers were left as they were and
 * are called out in the round report rather than silently reworked.
 */
export async function bleOnValueChanged(
  onValue: (payload: BleValue) => void,
): Promise<(() => void) | null> {
  // Off-device there is no Tauri event plugin to listen on, and the Web Bluetooth path
  // delivers frames through its own listener instead (see `webSubscribe`). Returning `null`
  // here — as this used to — left the screen with no value sink at all, so its
  // 「特征值变化会出现在下方记录里。」 was a promise the runtime could not keep
  // (REQ-A1189 / F-SH-478).
  if (!bridged()) {
    _webSinks.add(onValue);
    return () => {
      _webSinks.delete(onValue);
    };
  }
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

/* ---- Characteristic property flags (what the device said it permits) ---- */

/**
 * `BluetoothGattCharacteristic#getProperties()` bits.
 *
 * The numbers are Android's (they cross the bridge raw); the **meaning** lives here so the
 * screen and any test read the same table. A characteristic that does not advertise a property
 * is one the device will refuse: the controls are disabled from this, rather than offering every
 * action and letting the device say no (REQ-A1198 / F-SH-487).
 */
export const BLE_PROP_BROADCAST = 0x01;
export const BLE_PROP_READ = 0x02;
export const BLE_PROP_WRITE_NO_RESPONSE = 0x04;
export const BLE_PROP_WRITE = 0x08;
export const BLE_PROP_NOTIFY = 0x10;
export const BLE_PROP_INDICATE = 0x20;
export const BLE_PROP_SIGNED_WRITE = 0x40;
export const BLE_PROP_EXTENDED_PROPS = 0x80;

const hasProp = (props: number, bit: number): boolean => (props & bit) !== 0;

/** The device advertises a readable value. */
export function bleCanRead(props: number): boolean {
  return hasProp(props, BLE_PROP_READ);
}

/**
 * The device accepts a write.
 *
 * A **with-response** write needs `PROPERTY_WRITE` (a Write Request); a **without-response** one
 * is accepted when *either* write bit is set, because a characteristic that only advertises
 * `PROPERTY_WRITE` still takes a Write Command — refusing there would disable a control the
 * device would have carried out.
 */
export function bleCanWrite(props: number, withResponse: boolean): boolean {
  if (withResponse) return hasProp(props, BLE_PROP_WRITE);
  return hasProp(props, BLE_PROP_WRITE) || hasProp(props, BLE_PROP_WRITE_NO_RESPONSE);
}

/**
 * The device can push values — **notify or indicate**.
 *
 * Both are turned on through the same CCC descriptor write, so the toggle is offered for either;
 * they differ in whether the device expects an acknowledgement, which does not change whether the
 * user may subscribe.
 */
export function bleCanNotify(props: number): boolean {
  return hasProp(props, BLE_PROP_NOTIFY) || hasProp(props, BLE_PROP_INDICATE);
}

/**
 * The property names, in the spec's bit order, for showing what a characteristic permits.
 *
 * Each name is the **suffix of its `ble.prop.*` dictionary key**, so a caller renders it with
 * ``t(`ble.prop.${name}`)`` and the spec's own vocabulary reaches the user in their language —
 * the alternative (printing the raw bit names) puts English protocol words in a Chinese screen.
 * Explicit and set-based rather than a bit-scan loop: the map is the whole contract, and a name
 * that drifts from its key is a `t()` that renders the key itself.
 */
export function blePropertyNames(props: number): string[] {
  return (
    [
      [BLE_PROP_BROADCAST, "broadcast"],
      [BLE_PROP_READ, "read"],
      [BLE_PROP_WRITE_NO_RESPONSE, "writeNoResponse"],
      [BLE_PROP_WRITE, "write"],
      [BLE_PROP_NOTIFY, "notify"],
      [BLE_PROP_INDICATE, "indicate"],
      [BLE_PROP_SIGNED_WRITE, "signedWrite"],
      [BLE_PROP_EXTENDED_PROPS, "extended"],
    ] as const
  )
    .filter(([bit]) => hasProp(props, bit))
    .map(([, name]) => name);
}

/* ---- Pure value helpers (the screen's input/output formatting) ---- */

/**
 * Format raw GATT bytes as lowercase hex pairs (`[1, 171]` → `"01ab"`).
 *
 * The ByteArray crosses the bridge as a number array, and every surface that shows or
 * accepts one has to agree on the spelling — hence one implementation here rather than
 * a `map(toString(16))` in the screen (which is how the two would drift).
 * A byte outside 0..255 is **not** silently truncated: it is the caller's contract
 * violation, and the honest answer is to render what was received.
 */
export function bytesToHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse a hex string into bytes; `null` when the input is not hex or has an odd length.
 *
 * `null` (not `[]`, not a best-effort slice) because the caller is about to hand the
 * bytes to a device write: a half-parsed payload would write something the user did
 * not type.
 */
export function hexToBytes(hex: string): number[] | null {
  const s = hex.replace(/[\s:_-]/g, "");
  if (s.length === 0 || s.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

/**
 * Whether a string is a plausible GATT UUID (16-bit `180d`, 32-bit, or 128-bit with dashes).
 *
 * Deliberately *shape-only*: it does not claim the uuid exists on the connected device —
 * only the device can answer that, and pretending otherwise here would turn a typo into
 * "characteristic not found" noise. Its job is to keep an obviously malformed string from
 * being sent (the glue would throw on `UUID.fromString`).
 */
export function isPlausibleBleUuid(uuid: string): boolean {
  const s = uuid.trim();
  if (s.length === 4 || s.length === 8) return /^[0-9a-fA-F]+$/.test(s);
  if (s.length === 36) {
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
  }
  return false;
}

/* ---- Web Bluetooth fallback (host / Chromium desktop) ---- */

let _webDevice: BluetoothDevice | null = null;
let _webServer: BluetoothRemoteGATTServer | null = null;

/**
 * Value sinks for the Web Bluetooth runtime.
 *
 * The device's frames come out of the platform as `characteristicvaluechanged` events on a
 * `BluetoothRemoteGATTCharacteristic` — there is no event plugin to listen on off-device, so
 * this registry is what carries them to `bleOnValueChanged`'s callers.
 */
const _webSinks = new Set<(v: BleValue) => void>();

/** Live notification listeners, keyed by `service/characteristic`, so each is removed once. */
const _webNotify = new Map<
  string,
  { chr: BluetoothRemoteGATTCharacteristic; handler: (ev: Event) => void }
>();

function webKey(serviceUuid: string, characteristicUuid: string): string {
  return `${serviceUuid.trim()}/${characteristicUuid.trim()}`;
}

/** Turn one `characteristicvaluechanged` into the frame shape the screen already consumes. */
function webFrame(characteristicUuid: string, dv: DataView | undefined): BleValue | null {
  if (!dv) return null;
  return {
    event: "notification",
    characteristicUuid,
    value: Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)),
  };
}

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
  // The GATT client is going away: drop every listener with it, or a late notification on a
  // characteristic nobody holds would still be routed to a screen that has moved on.
  for (const { chr, handler } of _webNotify.values()) {
    chr.removeEventListener("characteristicvaluechanged", handler);
  }
  _webNotify.clear();
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
    const key = webKey(serviceUuid, characteristicUuid);
    // Re-subscribing replaces this characteristic's listener rather than stacking a second
    // one, which would deliver every notification twice.
    const prev = _webNotify.get(key);
    if (prev) prev.chr.removeEventListener("characteristicvaluechanged", prev.handler);
    const handler = (ev: Event): void => {
      const frame = webFrame(characteristicUuid, (ev.target as BluetoothRemoteGATTCharacteristic | null)?.value);
      if (!frame) return;
      for (const sink of _webSinks) sink(frame);
    };
    // Attach before `startNotifications()`: a device that notifies the instant it is enabled
    // must not beat the listener. Detach again if enabling is refused.
    chr.addEventListener("characteristicvaluechanged", handler);
    try {
      await chr.startNotifications();
    } catch (e) {
      chr.removeEventListener("characteristicvaluechanged", handler);
      throw e;
    }
    _webNotify.set(key, { chr, handler });
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
    // Only a *confirmed* stop drops the listener — the same rule the screen applies to its own
    // toggle: a refused unsubscribe leaves the stream live, so its values must keep arriving.
    const key = webKey(serviceUuid, characteristicUuid);
    const live = _webNotify.get(key);
    if (live) {
      live.chr.removeEventListener("characteristicvaluechanged", live.handler);
      _webNotify.delete(key);
    }
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
  /** `null` = the host did not answer (the Web Bluetooth path never returns it — it observed
   *  the failure itself). */
  connect(address: string): Promise<boolean | null>;
  /** `null` = the host did not answer. */
  disconnect(): Promise<boolean | null>;
  /**
   * `null` = **this runtime** cannot enumerate services at all — the Web Bluetooth path, or a
   * host that did not answer; a `BleDiscoverResult` carries what the device answered (including
   * its failures).
   */
  discoverServices(): Promise<BleDiscoverResult | null>;
  /** `null` = the host did not answer; `{ ok: false, error }` is the host's own report. */
  read(serviceUuid: string, characteristicUuid: string): Promise<BleReadResult | null>;
  /** `null` = the host did not answer. */
  write(
    serviceUuid: string,
    characteristicUuid: string,
    value: number[],
    withResponse?: boolean,
  ): Promise<BleWriteResult | null>;
  /** `null` = the host did not answer. */
  subscribe(serviceUuid: string, characteristicUuid: string): Promise<boolean | null>;
  /** `null` = the host did not answer. */
  unsubscribe(serviceUuid: string, characteristicUuid: string): Promise<boolean | null>;
}

/** Returns a BleClient that uses the Tauri bridge on device, Web Bluetooth on host. */
export function createBleClient(): BleClient {
  const useTauri = tauriBleAvailable();

  return {
    async connect(address: string): Promise<boolean | null> {
      if (useTauri) return bleConnect(address);
      return webConnect(address);
    },
    async disconnect(): Promise<boolean | null> {
      if (useTauri) return bleDisconnect();
      await webDisconnect();
      return true;
    },
    async discoverServices(): Promise<BleDiscoverResult | null> {
      if (useTauri) return bleDiscoverServices();
      return null;
    },
    async read(
      serviceUuid: string,
      characteristicUuid: string,
    ): Promise<BleReadResult | null> {
      if (useTauri) return bleRead(serviceUuid, characteristicUuid);
      return webRead(serviceUuid, characteristicUuid);
    },
    async write(
      serviceUuid: string,
      characteristicUuid: string,
      value: number[],
      withResponse = false,
    ): Promise<BleWriteResult | null> {
      if (useTauri) return bleWrite(serviceUuid, characteristicUuid, value, withResponse);
      return webWrite(serviceUuid, characteristicUuid, value, withResponse);
    },
    async subscribe(
      serviceUuid: string,
      characteristicUuid: string,
    ): Promise<boolean | null> {
      if (useTauri) return bleSubscribe(serviceUuid, characteristicUuid);
      return webSubscribe(serviceUuid, characteristicUuid);
    },
    async unsubscribe(
      serviceUuid: string,
      characteristicUuid: string,
    ): Promise<boolean | null> {
      if (useTauri) return bleUnsubscribe(serviceUuid, characteristicUuid);
      return webUnsubscribe(serviceUuid, characteristicUuid);
    },
  };
}

/**
 * Turn characteristic notifications on or off through the unified client.
 *
 * One named call instead of `client.subscribe(…)` / `client.unsubscribe(…)` at the call
 * site: which transport sits underneath (the Kotlin GATT bridge on device vs Web Bluetooth
 * on host) is exactly what a screen should not have to re-decide, and the on/off pair is
 * what must not drift apart — a UI that subscribes through one path and unsubscribes
 * through another leaves a notification stream nobody owns.
 *
 * `null` = the host did not answer, and it is **not** "the device refused" — the screen words
 * those two apart (REQ-A1337).
 */
export async function bleSetNotifications(
  client: BleClient,
  serviceUuid: string,
  characteristicUuid: string,
  on: boolean,
): Promise<boolean | null> {
  return on
    ? client.subscribe(serviceUuid, characteristicUuid)
    : client.unsubscribe(serviceUuid, characteristicUuid);
}


/**
 * The **Web Bluetooth** subset this app uses (`lib/ble.ts`'s desktop/Chromium fallback).
 *
 * Why a declaration file: `lib.dom` ships no Web Bluetooth types at all (`navigator.bluetooth`,
 * `BluetoothDevice`, the GATT objects are a WICG specification, not a WHATWG one). The
 * alternative is `any` at every call site — and `any` is exactly why a misspelled GATT method on
 * a phone stays invisible until someone taps the button. These declarations are **structural**,
 * not a polyfill: nothing here makes the API exist at runtime, and `ble.ts` still guards every
 * use with `BLE_AVAILABLE`.
 *
 * Scope is deliberately the surface `ble.ts` calls: request a device by MAC-OUI prefix, connect,
 * find a service/characteristic, read/write (with and without response) and (un)subscribe to
 * notifications. Anything the app starts using must be added here — that is the point.
 */

interface BluetoothRemoteGATTCharacteristic {
  readonly uuid: string;
  /** The most recently read/notified value. Set by the platform before it fires
   *  `characteristicvaluechanged`; `undefined` until the first one arrives. */
  readonly value?: DataView;
  readValue(): Promise<DataView>;
  writeValueWithResponse(value: BufferSource): Promise<void>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  addEventListener(type: "characteristicvaluechanged", listener: (ev: Event) => void): void;
  removeEventListener(type: "characteristicvaluechanged", listener: (ev: Event) => void): void;
}

interface BluetoothRemoteGATTService {
  readonly uuid: string;
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothDevice {
  readonly id: string;
  readonly name?: string;
  /** Absent on a device that cannot act as a GATT client. */
  readonly gatt?: BluetoothRemoteGATTServer;
}

/** `addressPrefix` is the hex OUI (first 3 bytes of a MAC, no colons). */
interface BluetoothRequestDeviceFilter {
  addressPrefix?: string;
  namePrefix?: string;
  services?: string[];
}

interface Bluetooth {
  requestDevice(options: {
    filters?: BluetoothRequestDeviceFilter[];
    optionalServices?: string[];
    acceptAllDevices?: boolean;
  }): Promise<BluetoothDevice>;
}

interface Navigator {
  readonly bluetooth: Bluetooth;
}

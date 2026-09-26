/**
 * Real-time sensor-data events from the System UI `SensorHost` bus.
 *
 * `crates/amos-tauri/src/sensor_host.rs` emits `sensor-data` whenever a producer —
 * a WebView `sensor_host_record_*` command, the on-device `android_glue` IMU/frame
 * JNI callbacks, or a host feeder — records a new IMU sample / camera frame on the
 * shared stream bus, or the energy mode changes. This module lets the UI listen
 * and update a live sensor tile without polling `sensor_host_snapshot`.
 *
 * Honest semantics:
 *  * A `camera_frame` event carries only *metadata* (id / size / format / seq) —
 *    frame bytes never cross this event bus (they stay in the media plane).
 *  * A `vitals` event carries the wellness pair (cumulative steps / heart rate); each
 *    reading is `number | null` because a device may expose neither, one or both, and
 *    an absent reading is **not** a `0` measurement.
 *  * A `cleared` event means a producer detached and the bus dropped its samples.
 *  * Only *accepted* changes are announced: a stale/out-of-order IMU push or a
 *    malformed frame is silently refused and never broadcasts.
 *
 * Pure helpers are unit-tested; `subscribeSensorData` is the thin `listen` seam
 * (outside Tauri it degrades to a no-op unsubscribe, like the other watchers).
 */
import { subscribe } from "./backend";

/** Tauri event name for one real-time sensor change (Rust bridge emits this). */
export const SENSOR_DATA_EVENT = "sensor-data";

/**
 * Serializable mirror of the Rust `HostImu` sample payload.
 *
 * Axes are `number | null`: `null` means the field was absent or not finite on the wire,
 * and it is **not** the same fact as `0` (a fabricated zero reads as "the device is
 * perfectly still", i.e. a measurement — AEROSPACE P0-3). The live panel prints `—` for
 * `null` and a number for a real sample (REQ-A294).
 */
export interface SensorImuDatum {
  timestamp_ms: number;
  accel_x: number | null;
  accel_y: number | null;
  accel_z: number | null;
  gyro_x: number | null;
  gyro_y: number | null;
  gyro_z: number | null;
  temperature_c: number | null;
}

/** Serializable mirror of the Rust `HostFrameMeta` (metadata only, no bytes). */
export interface SensorFrameDatum {
  id: number;
  width: number;
  height: number;
  format: string;
  seq: number;
}

/**
 * Serializable mirror of the Rust `HostVitals` (the wellness pair).
 *
 * Both readings are `number | null`: `null` means the device reported **no reading**
 * (no such sensor, or a heart-rate sensor with no contact), and it is **not** the same
 * fact as `0` (a fabricated `0` steps / `0` bpm reads as a measurement). The Health app
 * prints `—` for `null` (REQ-A1454).
 */
export interface SensorVitalsDatum {
  timestamp_ms: number;
  /** Cumulative step count since boot (Android `TYPE_STEP_COUNTER` semantics). */
  steps_total: number | null;
  heart_rate_bpm: number | null;
}

/** Serializable mirror of the Rust `SensorHostEvent` (snake_case wire keys). */
export interface SensorDataEvent {
  ts_ms: number;
  kind: SensorDataKind;
  backend: string;
  mode: string;
  /** Set when `kind === "imu"`. */
  imu: SensorImuDatum | null;
  /** Set when `kind === "camera_frame"`. */
  frame: SensorFrameDatum | null;
  /** Set when `kind === "vitals"`. */
  vitals: SensorVitalsDatum | null;
  /** Set when `kind === "mode"` — the mode we left. */
  prev_mode: string | null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** The one declaration of the sensor data kinds; {@link SensorDataKind} derives from it. */
export const KINDS = ["imu", "camera_frame", "vitals", "mode", "cleared"] as const;
export type SensorDataKind = (typeof KINDS)[number];

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function toImu(v: unknown): SensorImuDatum | null {
  if (!isObj(v)) return null;
  const timestamp_ms = num(v.timestamp_ms);
  if (timestamp_ms === null) return null;
  // An absent / non-finite field stays `null` (`num` already rejects those): mapping it to
  // `0` would put a fabricated measurement on screen — the panel would show a perfectly
  // still device where the daemon actually reported nothing (REQ-A294 / P0-3).
  return {
    timestamp_ms,
    accel_x: num(v.accel_x),
    accel_y: num(v.accel_y),
    accel_z: num(v.accel_z),
    gyro_x: num(v.gyro_x),
    gyro_y: num(v.gyro_y),
    gyro_z: num(v.gyro_z),
    temperature_c: num(v.temperature_c),
  };
}

/**
 * Normalize the vitals payload. Both readings are optional by design — a device may
 * expose the step counter, the heart-rate sensor, both or neither — so a well-shaped
 * block is one that carries a finite `timestamp_ms`; the two readings stay `null` when
 * absent/non-finite (never `0`). A block with **neither** reading is still returned: the
 * Rust side only announces a material change, and "both absent" is a real state (the
 * heart rate lost contact while the step counter is not running) the app must be able to
 * show.
 */
export function normalizeVitals(v: unknown): SensorVitalsDatum | null {
  if (!isObj(v)) return null;
  const timestamp_ms = num(v.timestamp_ms);
  if (timestamp_ms === null) return null;
  return {
    timestamp_ms,
    steps_total: num(v.steps_total),
    heart_rate_bpm: num(v.heart_rate_bpm),
  };
}

function toFrame(v: unknown): SensorFrameDatum | null {
  if (!isObj(v)) return null;
  const id = num(v.id);
  const width = num(v.width);
  const height = num(v.height);
  const seq = num(v.seq);
  if (id === null || width === null || height === null || seq === null) return null;
  return { id, width, height, format: str(v.format), seq };
}

/**
 * Defensive normalization of a raw `sensor-data` payload. Returns `null` for
 * anything not well-shaped (never trust the wire blindly). For a family kind the
 * matching payload must be present and well-shaped.
 */
export function toSensorData(raw: unknown): SensorDataEvent | null {
  if (!isObj(raw)) return null;
  const ts_ms = num(raw.ts_ms);
  const kind = str(raw.kind) as SensorDataKind;
  if (ts_ms === null || !KINDS.includes(kind)) return null;
  const imu = toImu(raw.imu);
  const frame = toFrame(raw.frame);
  const vitals = normalizeVitals(raw.vitals);
  if (kind === "imu" && !imu) return null;
  if (kind === "camera_frame" && !frame) return null;
  if (kind === "vitals" && !vitals) return null;
  return {
    ts_ms,
    kind,
    backend: str(raw.backend),
    mode: str(raw.mode, "unknown"),
    imu,
    frame,
    vitals,
    prev_mode: typeof raw.prev_mode === "string" ? raw.prev_mode : null,
  };
}

/** True when an event is of `kind` (narrowing helper for a switch/filter). */
export function isKind(ev: SensorDataEvent, kind: SensorDataKind): boolean {
  return ev.kind === kind;
}

/**
 * Subscribe to the `sensor-data` feed and invoke `onEvent` for every well-shaped
 * change. Returns an unsubscribe, or `null` when the subscription was not established
 * (REQ-A838) — a sensor that is steady and a sensor feed we are not on produce the same
 * silence, so the caller must be able to tell which one it is holding.
 */
export async function subscribeSensorData(
  onEvent: (ev: SensorDataEvent) => void,
): Promise<(() => void) | null> {
  return subscribe(SENSOR_DATA_EVENT, (raw) => {
    const ev = toSensorData(raw);
    if (ev) onEvent(ev);
  });
}

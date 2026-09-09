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

export type SensorDataKind = "imu" | "camera_frame" | "mode" | "cleared";

/** Serializable mirror of the Rust `HostImu` sample payload. */
export interface SensorImuDatum {
  timestamp_ms: number;
  accel_x: number;
  accel_y: number;
  accel_z: number;
  gyro_x: number;
  gyro_y: number;
  gyro_z: number;
  temperature_c: number;
}

/** Serializable mirror of the Rust `HostFrameMeta` (metadata only, no bytes). */
export interface SensorFrameDatum {
  id: number;
  width: number;
  height: number;
  format: string;
  seq: number;
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
  /** Set when `kind === "mode"` — the mode we left. */
  prev_mode: string | null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const KINDS: readonly SensorDataKind[] = ["imu", "camera_frame", "mode", "cleared"];

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
  return {
    timestamp_ms,
    accel_x: num(v.accel_x) ?? 0,
    accel_y: num(v.accel_y) ?? 0,
    accel_z: num(v.accel_z) ?? 0,
    gyro_x: num(v.gyro_x) ?? 0,
    gyro_y: num(v.gyro_y) ?? 0,
    gyro_z: num(v.gyro_z) ?? 0,
    temperature_c: num(v.temperature_c) ?? 0,
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
  if (kind === "imu" && !imu) return null;
  if (kind === "camera_frame" && !frame) return null;
  return {
    ts_ms,
    kind,
    backend: str(raw.backend),
    mode: str(raw.mode, "unknown"),
    imu,
    frame,
    prev_mode: typeof raw.prev_mode === "string" ? raw.prev_mode : null,
  };
}

/** True when an event is of `kind` (narrowing helper for a switch/filter). */
export function isKind(ev: SensorDataEvent, kind: SensorDataKind): boolean {
  return ev.kind === kind;
}

/**
 * Subscribe to the `sensor-data` feed and invoke `onEvent` for every well-shaped
 * change. Returns an unsubscribe (a no-op outside Tauri / when offline).
 */
export async function subscribeSensorData(
  onEvent: (ev: SensorDataEvent) => void,
): Promise<() => void> {
  return subscribe(SENSOR_DATA_EVENT, (raw) => {
    const ev = toSensorData(raw);
    if (ev) onEvent(ev);
  });
}

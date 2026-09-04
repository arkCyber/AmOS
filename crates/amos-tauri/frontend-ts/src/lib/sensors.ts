/**
 * Device-sensor domain view + typed bridge to the Tauri `sensor_*` commands
 * (which reach the daemon's mounted `SensorService` over UDS). Pure normalize /
 * label helpers live here so a surface can render a deterministic view without a
 * daemon; the `sensor*` wrappers return `null` when not bridged so the UI shows a
 * "daemon not connected" state instead of throwing.
 *
 * Wire shapes: crates/amos-tauri/src/sensors.rs payloads.
 */
export type SensorMode = "performance" | "balanced" | "power_save" | "unknown";
export type SensorKind = "camera" | "gnss" | "imu";

export interface SensorCamera {
  id: number;
  width: number;
  height: number;
  fps: number;
  format: string;
}

export interface SensorGnss {
  enabled: boolean;
  has_fix: boolean;
  latitude_deg: number;
  longitude_deg: number;
  accuracy_m: number;
  sats: number;
  fix_mode: string;
}

export interface SensorImu {
  rate_hz: number;
  accel_x: number;
  accel_y: number;
  accel_z: number;
  temp_c: number;
}

export interface SensorSnapshot {
  mode: SensorMode;
  cameras: SensorCamera[];
  gnss: SensorGnss | null;
  imu: SensorImu | null;
}

export interface SensorAcquireResult {
  allowed: boolean;
  error: string;
}

/** Total pixel count of a camera preview (0 when unknown). */
export function sensorPixels(c: SensorCamera): number {
  return c.width > 0 && c.height > 0 ? c.width * c.height : 0;
}

/** Number of cameras the snapshot reports. */
export function sensorCameraCount(s: SensorSnapshot): number {
  return s.cameras.length;
}

/**
 * Coerce a raw `sensor_snapshot` payload into a typed view, tolerating absent /
 * partial fields (daemon offline, older shape). Never throws.
 */
export function normalizeSnapshot(raw: unknown): SensorSnapshot {
  const s = (raw ?? {}) as Partial<SensorSnapshot>;
  return {
    mode: normalizeMode(s.mode),
    cameras: Array.isArray(s.cameras) ? (s.cameras as SensorCamera[]) : [],
    gnss: s.gnss ?? null,
    imu: s.imu ?? null,
  };
}

function normalizeMode(mode: unknown): SensorMode {
  return mode === "performance" || mode === "balanced" || mode === "power_save"
    ? mode
    : "unknown";
}

interface Bridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

function bridge(): Bridge | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: Bridge };
  return w && typeof w.__TAURI_INTERNALS__ === "object"
    ? (w.__TAURI_INTERNALS__ as Bridge)
    : null;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  const b = bridge();
  if (!b) return null;
  return (await b.invoke(command, args)) as T;
}

/** Read cameras + GNSS + IMU + energy mode in one round-trip (null offline). */
export function sensorSnapshot(): Promise<SensorSnapshot | null> {
  return call<SensorSnapshot>("sensor_snapshot");
}

/** Switch the daemon energy mode; returns the new mode (null offline). */
export function sensorSetMode(mode: SensorMode): Promise<string | null> {
  return call<string>("sensor_set_mode", { mode });
}

/** Ask the daemon to allow a continuous stream (null offline). */
export function sensorAcquire(
  kind: SensorKind,
  rateHz: number,
): Promise<SensorAcquireResult | null> {
  return call<SensorAcquireResult>("sensor_acquire", { kind, rateHz });
}

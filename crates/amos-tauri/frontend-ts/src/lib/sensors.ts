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
  /** WGS-84 degrees — `null` when the fix was not reported (never a fabricated 0). */
  latitude_deg: number | null;
  longitude_deg: number | null;
  /** Horizontal accuracy in metres — `null` when not reported. */
  accuracy_m: number | null;
  /** Satellites in use — `null` when not reported. */
  sats: number | null;
  fix_mode: string;
}

export interface SensorImu {
  rate_hz: number;
  /** Acceleration in m/s² — `null` when the bus reported no sample for that axis.
   *  An absent reading is **unknown**, never a fabricated `0` (AEROSPACE P0-3: a
   *  zero here would read as "the device is perfectly still", i.e. a measurement). */
  accel_x: number | null;
  accel_y: number | null;
  accel_z: number | null;
  /** Angular rate in rad/s — `null` when the bus reported no gyro sample. */
  gyro_x: number | null;
  gyro_y: number | null;
  gyro_z: number | null;
  /** Die temperature in °C — `null` when not reported. */
  temp_c: number | null;
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
 *
 * The `imu` / `gnss` blocks are normalized **field by field**, not passed through:
 * the doc promise above is a promise about behaviour, and both consumers format these
 * blocks (`SensorPanel` calls `temp_c.toFixed(1)`, `latitude_deg.toFixed(5)`, …), so a
 * daemon that sends a *partial* block used to reach a component with `undefined` and
 * throw during render (REQ-A294). Numeric fields that are absent / non-finite become
 * `null` — **unknown stays unknown** — and the panels print `—` for them.
 */
export function normalizeSnapshot(raw: unknown): SensorSnapshot {
  const s = (raw ?? {}) as Partial<SensorSnapshot>;
  return {
    mode: normalizeMode(s.mode),
    cameras: Array.isArray(s.cameras) ? (s.cameras as SensorCamera[]) : [],
    gnss: normalizeGnss(s.gnss),
    imu: normalizeImu(s.imu),
  };
}

/** A finite number, else `null` (NaN/Infinity/strings/booleans are not measurements). */
function optNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A boolean, else `false` — the conservative direction for "usable?" flags. */
function optBool(v: unknown): boolean {
  return v === true;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function normalizeImu(raw: unknown): SensorImu | null {
  const imu = asRecord(raw);
  if (!imu) return null;
  return {
    rate_hz: optNum(imu.rate_hz) ?? 0,
    accel_x: optNum(imu.accel_x),
    accel_y: optNum(imu.accel_y),
    accel_z: optNum(imu.accel_z),
    gyro_x: optNum(imu.gyro_x),
    gyro_y: optNum(imu.gyro_y),
    gyro_z: optNum(imu.gyro_z),
    temp_c: optNum(imu.temp_c),
  };
}

function normalizeGnss(raw: unknown): SensorGnss | null {
  const g = asRecord(raw);
  if (!g) return null;
  return {
    enabled: optBool(g.enabled),
    has_fix: optBool(g.has_fix),
    latitude_deg: optNum(g.latitude_deg),
    longitude_deg: optNum(g.longitude_deg),
    accuracy_m: optNum(g.accuracy_m),
    sats: optNum(g.sats),
    fix_mode: typeof g.fix_mode === "string" ? g.fix_mode : "",
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

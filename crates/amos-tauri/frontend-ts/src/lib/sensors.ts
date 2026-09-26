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
  /** Horizontal accuracy in metres, or `null` when the fix carries none. The wire is a
   *  zero-sentinel `double` (no field presence) and Android returns `0.0` from
   *  `getAccuracy()` for a fix with no estimate, so `0` is **unknown**, never a `±0m`
   *  precision claim (REQ-A1623 / F-SH-825). */
  accuracy_m: number | null;
  /** Satellites in use, or `null` when not reported. `Location` carries no satellite
   *  count, so the producer writes `0` to mean "not reported" and `0` is **unknown**,
   *  never a `0sats` count the receiver never had (REQ-A1623 / F-SH-825). */
  sats: number | null;
  fix_mode: string;
}

export interface SensorImu {
  /** The negotiated IMU report rate in Hz, or `null` when the producer has not negotiated
   *  one yet. The wire writes `0` for "not negotiated" (`uint32` has no presence), so `0`
   *  is **unknown**, never a 0 Hz measurement (REQ-A1612 / F-SH-821). */
  rate_hz: number | null;
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

/**
 * The `±Nm` accuracy clause for a GNSS fix, or `null` when there is no accuracy to state.
 *
 * A `null` / non-finite / `≤ 0` accuracy is the platform's "no accuracy reported" sentinel —
 * `0` is the wire's no-presence value and a negative is not a precision — so the clause is
 * dropped, exactly as a `null` field is dropped from the fix line (REQ-A1623).
 *
 * A **positive** accuracy is a measurement and must never be rounded down to `±0m`: `0.4 m`
 * is a real reading, and `±0m` reads as a *perfect* fix — the very string the wire's `0`
 * sentinel produced before it was folded (REQ-A1623 / F-SH-825). Rounding a positive error
 * *up* to `1 m` is the conservative direction (`±1m` is still true of a 0.4 m fix), and it
 * is the rule `gps.ts::accuracyLabel` follows one snapshot over — it tiers a positive
 * accuracy so nothing ever rounds to `±0m`.
 */
export function gnssAccuracyLabel(acc: number | null): string | null {
  if (acc === null || !Number.isFinite(acc) || acc <= 0) return null;
  return `±${Math.max(1, Math.round(acc))}m`;
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
    // The wire's `uint32 rate_hz` has no field presence, and the producer writes `0` to
    // mean "not negotiated yet" (see `SensorImu::rate_hz`), so a wire `0` is **unknown**,
    // never a 0 Hz rate — the same fold the Rust payload applies, kept here so an older
    // daemon that still sends `0` cannot make the panel print `@0 Hz` (REQ-A1612).
    rate_hz: imu.rate_hz === 0 ? null : optNum(imu.rate_hz),
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
    // Both wires are zero-sentinel (`double` / `uint32`, no field presence) and the
    // producer writes `0` for "not reported" — Android's `getAccuracy()` returns `0.0`
    // and `Location` carries no satellite count. Read `0` as **unknown** here too, so an
    // older daemon that still sends `0` cannot make the panel print `±0m · 0sats`
    // (the rule `gps.ts::accuracyLabel` already follows one field over; REQ-A1623).
    accuracy_m: g.accuracy_m === 0 ? null : optNum(g.accuracy_m),
    sats: g.sats === 0 ? null : optNum(g.sats),
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

/**
 * Real GPS location view — frontend seam over the System UI `SensorHost`.
 *
 * **Status**: the real `LocationManager` fix is already on device
 * (`amos-sensor/src/android.rs` → `AndroidSensorProvider::last_known_fix`);
 * `SensorHost::read_gnss()` surfaces it as `HostGnss` on the sensor bus.
 * This module is the honest, reactive UI consumer of that fix.
 *
 * Honest semantics:
 *  * `gnss: null` on the snapshot means the host has no GNSS at all
 *    (desktop / sensor not bound) — NOT "location unknown". The UI says so.
 *  * `has_fix: false` means the receiver is on but has not locked yet.
 *  * `latitude_deg/longitude_deg` are the last fix, not real-time.
 *  * `accuracy_m` is the 68th-percentile horizontal error.
 *
 * GPS is a **device sideband**: it lives on the System UI APK side, not the
 * headless daemon, same pattern as `amos-radio` / `amos-telephony`.
 */
import { invoke } from "./backend";

/** Raw snapshot from `sensor_host_snapshot` (partial shape). */
export interface SensorHostSnapshot {
  backend: string;
  mode: string;
  cameras: unknown[];
  gnss: HostGnss | null;
  imu: unknown;
  stream_gate: unknown;
}

/** Serialisable GNSS fix from `SensorHost`. */
export interface HostGnss {
  enabled: boolean;
  has_fix: boolean;
  latitude_deg: number;
  longitude_deg: number;
  accuracy_m: number;
}

/** Normalised GPS location for the UI. */
export interface GpsLocation {
  latitude: number;
  longitude: number;
  accuracy: number; // metres
  timestamp: number; // ms epoch
}

/** What the GNSS receiver reports. */
export interface GnssStatus {
  enabled: boolean;
  has_fix: boolean;
  location: GpsLocation | null;
}

/** Derive a human-readable accuracy label. */
export function accuracyLabel(m: number): string {
  if (m < 0) return "—";
  if (m <= 5) return "±5 m";
  if (m <= 15) return "±15 m";
  if (m <= 50) return "±50 m";
  return `±${Math.round(m)} m`;
}

/** Derive a street-level place name (honest fallback: coordinates only). */
export function describeLocation(lat: number, lon: number): string {
  // Deliberately no network geocoder here: that belongs in the AI daemon.
  // The UI shows the coordinates directly when no reverse-geocoder is wired.
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/** Whether a snapshot says GNSS is enabled. */
export function gnssEnabled(snap: SensorHostSnapshot): boolean {
  return snap?.gnss?.enabled ?? false;
}

/** Whether a snapshot says GNSS has a fix. */
export function gnssHasFix(snap: SensorHostSnapshot): boolean {
  return snap?.gnss?.has_fix ?? false;
}

/** Derive the normalised GnssStatus from a raw snapshot. Returns null when the
 *  host has no GNSS at all (desktop / sensor not bound on device). */
export function gnssStatus(snap: SensorHostSnapshot): GnssStatus | null {
  const raw = snap?.gnss;
  if (!raw) return null;
  if (!raw.has_fix) {
    return { enabled: raw.enabled, has_fix: false, location: null };
  }
  return {
    enabled: raw.enabled,
    has_fix: true,
    location: {
      latitude: raw.latitude_deg,
      longitude: raw.longitude_deg,
      accuracy: raw.accuracy_m,
      timestamp: Date.now(),
    },
  };
}

/** One-shot read of the current GNSS fix.
 *  Returns null when the bridge is unavailable or the host has no GNSS.
 *  When `has_fix: false` the `location` field is null — the UI says "searching". */
export async function gnssSnapshot(): Promise<GnssStatus | null> {
  const snap = await invoke<SensorHostSnapshot>("sensor_host_snapshot");
  if (!snap) return null;
  return gnssStatus(snap);
}

/** Whether the current sensor host backend is the real Android provider
 *  (vs "live" on the desktop). Drives a "DEMO / DEVICE" badge in the UI. */
export function isAndroidBackend(snap: SensorHostSnapshot): boolean {
  return (snap?.backend ?? "") === "android";
}

/** The sensor energy mode the host is running ("balanced" / "performance" / "power_save"). */
export function sensorMode(snap: SensorHostSnapshot | null): string {
  return snap?.mode && snap.mode !== "" ? snap.mode : "unknown";
}

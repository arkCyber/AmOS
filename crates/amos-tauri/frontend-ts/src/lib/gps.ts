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
 *  * `has_fix: false` is **not** one situation. `status` says which of them it is
 *    (`searching` / `receiver-off` / `permission-required` / `read-failed`), and the
 *    four are different sentences to the user. Read `status`, not `has_fix`.
 *  * `latitude_deg/longitude_deg` are the last fix, not real-time.
 *  * `accuracy_m` is the 68th-percentile horizontal error; `0` is the platform's
 *    "not reported" sentinel, not a sub-metre fix (see [`accuracyLabel`]).
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

/**
 * The wire spelling of the Rust `GnssStatus` enum (`#[serde(rename_all = "kebab-case")]`
 * in `amos-tauri/src/sensor_host.rs`). Bound to its Rust source by
 * `__tests__/declaredMirrors.test.ts`, so a renamed variant fails the build rather than
 * silently falling through to a default here.
 */
export type GnssStatusWire =
  | "fix"
  | "searching"
  | "receiver-off"
  | "permission-required"
  | "read-failed";

/** Serialisable GNSS fix from `SensorHost`. */
export interface HostGnss {
  enabled: boolean;
  has_fix: boolean;
  /** **Why** this block reads the way it does — see [`GnssStatusWire`]. Never re-derive
   *  this locally from `has_fix`: that fold is exactly the defect REQ-A772 removed. */
  status: GnssStatusWire;
  latitude_deg: number;
  longitude_deg: number;
  /** 68th-percentile horizontal error in metres; `0` = the fix carries none
   *  (the platform's sentinel), which the label renders as unknown, not as 0 m. */
  accuracy_m: number;
}

/** Normalised GPS location for the UI. */
export interface GpsLocation {
  latitude: number;
  longitude: number;
  /** Metres; `0` = the fix carries no accuracy estimate (never a claim of 0 m). */
  accuracy: number;
  timestamp: number; // ms epoch
}

/**
 * Derive a human-readable accuracy label, or `—` when there is no accuracy to state.
 *
 * `0` is **not** a statement of perfect precision — it is the platform's "no accuracy
 * reported" sentinel. The device's `Location.getAccuracy()` is read verbatim into
 * `horizontal_accuracy_m` (`crates/amos-sensor/src/android.rs`), and Android returns
 * `0.0` from that call when the fix carries no accuracy estimate at all (the same
 * "0 is honest *not reported*, not a claim" rule the satellite count one field over
 * already follows). Folding that `0` into the first tier would print **±5 m** — a
 * precision claim the receiver never made, and one the user cannot tell apart from a
 * real 5-metre fix. `≤ 0` and a non-finite value are therefore the *absence* of an
 * accuracy, rendered as the same `—` a negative already was.
 */
export function accuracyLabel(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "—";
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

/**
 * The **honest** read of the location block (REQ-A582, extended by REQ-A772 / F-SH-228).
 *
 * A bare one-shot read used to answer `null` for two different situations — "there is no bridge" and
 * "this host has no GNSS at all" — which the UI cannot tell apart, even though this module's own
 * documentation says it must ("`gnss: null` … NOT 'location unknown'. The UI says so"). That was
 * invisible while nothing consumed this module; it stops being invisible the moment a screen does.
 *
 * So the states are named here, once:
 *   * `unavailable`         — no bridge / the command failed (a browser preview, a host build);
 *   * `absent`              — the host answered and has **no GNSS at all** (desktop, sensor not bound);
 *   * `permission-required` — the read **failed** and no OS location grant is held. The user can act
 *                             on this one (grant location), and until REQ-A772 it was reported as
 *                             `no-fix`, i.e. the screen said "searching" forever on a phone that had
 *                             simply never been asked;
 *   * `read-failed`         — the read **failed** for some other reason (a grant is held, so this is
 *                             a real error and must not be dressed up as progress);
 *   * `no-fix`              — a receiver exists, was read successfully, and has not locked yet (the
 *                             `enabled` flag separates "switched off" from "searching");
 *   * `fix`                 — the last fix, with its accuracy (68th-percentile horizontal error).
 *
 * Nothing is fabricated: an unknown fix is never a coordinate, `enabled: false` is its own fact
 * rather than "searching", and a failed read is never "in progress".
 */
export type GnssRead =
  | { kind: "unavailable" }
  | { kind: "absent"; snap: SensorHostSnapshot }
  | { kind: "permission-required"; snap: SensorHostSnapshot }
  | { kind: "read-failed"; snap: SensorHostSnapshot }
  | { kind: "no-fix"; enabled: boolean; snap: SensorHostSnapshot }
  | { kind: "fix"; enabled: boolean; location: GpsLocation; snap: SensorHostSnapshot };

/** Read the GNSS state, distinguishing "no bridge" from "no GNSS hardware". Never throws. */
export async function readGnss(): Promise<GnssRead> {
  const snap = await invoke<SensorHostSnapshot>("sensor_host_snapshot");
  if (snap === null) {
    // `invoke` records why; a browser preview and a refused command both land here, and both mean
    // "we cannot see this host's sensors" — which is what `unavailable` says.
    return { kind: "unavailable" };
  }
  const raw = snap.gnss;
  if (!raw) return { kind: "absent", snap };
  // `has_fix` is checked first on purpose: a real fix is the one thing that must never be hidden
  // behind a status word, whatever the host said beside it.
  if (!raw.has_fix) {
    // The two failure states can only be told apart by the host's `status`, and they are the whole
    // point of this revision — a payload that does not carry one cannot be classified, so it falls
    // through to the `no-fix` reading its `has_fix`/`enabled` pair actually supports.
    if (raw.status === "permission-required") return { kind: "permission-required", snap };
    if (raw.status === "read-failed") return { kind: "read-failed", snap };
    return { kind: "no-fix", enabled: raw.enabled, snap };
  }
  return {
    kind: "fix",
    enabled: raw.enabled,
    location: {
      latitude: raw.latitude_deg,
      longitude: raw.longitude_deg,
      accuracy: raw.accuracy_m,
      timestamp: Date.now(),
    },
    // The snapshot travels with the reading so the caller can ask the *other* questions this
    // module owns about the same fact (`isAndroidBackend`, the energy mode) without a second
    // round-trip that could describe a different moment.
    snap,
  };
}

/**
 * The OS location grant lives in its own module, next to the mic one it mirrors:
 * `backend.ts::{locationPermissionState, locationPermissionRequest}`. It is **not** re-exported
 * here — this module's job is the reading, and a second home for the same seam is how the two
 * drift (`readGnss`'s `permission-required` state is the reading's view of that grant, not a
 * substitute for it).
 */

/** Whether the current sensor host backend is the real Android provider
 *  (vs "live" on the desktop). Drives a "DEMO / DEVICE" badge in the UI. */
export function isAndroidBackend(snap: SensorHostSnapshot): boolean {
  return (snap?.backend ?? "") === "android";
}

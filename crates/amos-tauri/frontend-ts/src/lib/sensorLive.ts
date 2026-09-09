/**
 * Live System-UI sensor stream view — the frontend consumer of the real-time
 * `sensor-data` events emitted by `crates/amos-tauri/src/sensor_host.rs`.
 *
 * `SensorHost` broadcasts each *accepted* IMU sample / camera-frame / energy-mode
 * change on the shared bus as `sensor-data` (see `lib/sensorEvents.ts`). This
 * module keeps a small, reactive accumulator of that live feed so a settings
 * card can show "sensor data is flowing *right now*" instead of only a daemon
 * snapshot taken on demand.
 *
 * Design:
 *  * `applySensorLive(state, ev)` is a **pure reducer** (event-driven refresh) —
 *    unit-tested with no DOM/bridge. Only well-shaped events (already vetted by
 *    `toSensorData`) change the state; garbage never mutates it.
 *  * `createSensorLive()` returns a tiny subscribe/store handle. `start()` opens
 *    the Tauri `sensor-data` listen (a quiet no-op off-device) and best-effort
 *    seeds the current energy mode/backend from `sensor_host_snapshot`.
 *  * `pushRaw(...)` is the host/dev + test seam: feed a payload through the same
 *    normalizer the real listener uses.
 */
import { invoke } from "./backend";
import {
  subscribeSensorData,
  toSensorData,
  type SensorDataEvent,
  type SensorFrameDatum,
  type SensorImuDatum,
} from "./sensorEvents";

export interface SensorLiveState {
  /** Whether the `sensor-data` listener is open. */
  listening: boolean;
  /** Backend the samples come from ("live" / "android"). */
  backend: string;
  /** Current energy mode ("balanced" / "performance" / "power_save" / "unknown"). */
  mode: string;
  /** Mode we left, from the most recent `mode` change (if any). */
  prevMode: string | null;
  /** Counters since the last reset (event-driven). */
  imuCount: number;
  frameCount: number;
  modeCount: number;
  clearCount: number;
  totalEvents: number;
  /** `ts_ms` of the most recent accepted event (0 = none yet). */
  lastTsMs: number;
  /** Wall-clock of the most recent accepted event (for the LIVE pulse). */
  lastSeenAt: number;
  lastImu: SensorImuDatum | null;
  lastFrame: SensorFrameDatum | null;
}

export function initialSensorLive(): SensorLiveState {
  return {
    listening: false,
    backend: "",
    mode: "unknown",
    prevMode: null,
    imuCount: 0,
    frameCount: 0,
    modeCount: 0,
    clearCount: 0,
    totalEvents: 0,
    lastTsMs: 0,
    lastSeenAt: 0,
    lastImu: null,
    lastFrame: null,
  };
}

/**
 * Pure event-driven reducer: fold one already-normalized `sensor-data` event into
 * the live view. Counters only advance for the matching family; stale/malformed
 * events never reach here (the `toSensorData` gate upstream). Never throws.
 */
export function applySensorLive(s: SensorLiveState, ev: SensorDataEvent): SensorLiveState {
  const n: SensorLiveState = {
    ...s,
    totalEvents: s.totalEvents + 1,
    lastTsMs: ev.ts_ms,
    lastSeenAt: Date.now(),
  };
  if (ev.backend) n.backend = ev.backend;
  if (ev.mode && ev.mode !== "unknown") n.mode = ev.mode;
  if (ev.kind === "imu") {
    n.imuCount += 1;
    n.lastImu = ev.imu ?? s.lastImu;
  } else if (ev.kind === "camera_frame") {
    n.frameCount += 1;
    n.lastFrame = ev.frame ?? s.lastFrame;
  } else if (ev.kind === "mode") {
    n.modeCount += 1;
    n.prevMode = ev.prev_mode ?? s.prevMode;
  } else if (ev.kind === "cleared") {
    n.clearCount += 1;
  }
  return n;
}

/** `{ backend, mode } | null` pulled from a `sensor_host_snapshot` raw payload. */
export function toHostSeed(raw: unknown): { backend: string; mode: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const backend = typeof o.backend === "string" ? o.backend : "";
  const mode = typeof o.mode === "string" ? o.mode : "";
  if (!backend && !mode) return null;
  return { backend, mode };
}

export interface SensorLiveHandle {
  /** Current state snapshot (safe to read without subscribing). */
  snapshot(): SensorLiveState;
  /** React to every state change; returns an unsubscribe. */
  subscribe(fn: (s: SensorLiveState) => void): () => void;
  /** Open the `sensor-data` listen (+ best-effort host snapshot seed). Idempotent. */
  start(): Promise<() => void>;
  /** Feed a raw payload through the same normalizer the real listener uses. */
  pushRaw(raw: unknown): void;
  /** Zero the counters/last-sample but keep listening + backend/mode. */
  reset(): void;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Create an independent live-sensor accumulator. `start()` opens the Tauri
 * `sensor-data` subscription (a quiet no-op off-device / when unbridged) and
 * seeds the current energy mode/backend from `sensor_host_snapshot` on a
 * best-effort basis; each well-shaped event is folded in and all subscribers are
 * notified synchronously.
 */
export function createSensorLive(): SensorLiveHandle {
  let state = initialSensorLive();
  const subs = new Set<(s: SensorLiveState) => void>();

  function set(next: SensorLiveState): void {
    state = next;
    // Snapshot subscribers before notifying so a subscriber that unsubscribes
    // mid-iteration cannot skip/re-enter awkwardly.
    for (const fn of [...subs]) fn(state);
  }

  function ingest(ev: SensorDataEvent): void {
    set(applySensorLive(state, ev));
  }

  function seedFromHost(): void {
    invoke<unknown>("sensor_host_snapshot")
      .then((raw) => {
        const seed = toHostSeed(raw);
        if (seed) {
          set({ ...state, backend: seed.backend || state.backend, mode: seed.mode || state.mode });
        }
      })
      .catch(() => {
        /* host snapshot unavailable → keep going; events will carry backend/mode */
      });
  }

  async function start(): Promise<() => void> {
    if (state.listening) return () => {};
    set({ ...state, listening: true });
    seedFromHost();
    const unsubFeed = await subscribeSensorData((ev) => ingest(ev));
    return () => {
      set({ ...state, listening: false });
      unsubFeed();
    };
  }

  return {
    snapshot: () => state,
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    start,
    pushRaw: (raw) => {
      const ev = toSensorData(raw);
      if (ev) ingest(ev);
    },
    reset: () => {
      const cur = initialSensorLive();
      set({
        ...cur,
        listening: state.listening,
        backend: state.backend,
        mode: state.mode,
        prevMode: state.prevMode,
      });
    },
  };
}

/** Whether a raw payload is a well-shaped `sensor-data` event (guard helper). */
export function isSensorDataPayload(
  raw: unknown,
): raw is Record<string, unknown> & { kind: string } {
  return isObj(raw) && toSensorData(raw) !== null;
}


/**
 * System working-status (health) view + typed bridge to the Tauri `system_health`
 * command (which reads the daemon's `get_status.system`, amos-monitor). Pure
 * normalize / derive helpers live here so a surface can render a deterministic
 * view without a daemon; `systemHealth()` returns `null` when not bridged so the
 * UI shows a "daemon not connected" state instead of throwing.
 *
 * Wire shape: crates/amos-tauri/src/system.rs `SystemStatus`. Option fields are
 * JSON `null` == "unknown" (never a fabricated reading).
 */
export interface SystemStatus {
  sampler: string;
  cpu_busy_pct: number | null;
  mem_total_bytes: number | null;
  mem_available_bytes: number | null;
  battery_level_pct: number | null;
  battery_charging: boolean | null;
  live_power_mw: number | null;
  running: number;
  cached: number;
  stopped: number;
  /** Per-app processes the daemon's governor tracks (empty when none registered). */
  apps: AppProc[];
  /** Live resource-governor decision (power regulation), or null when unavailable. */
  governor: SystemGovernor | null;
}

/** One tracked app/process: its id and lifecycle tier. */
export interface AppProc {
  id: string;
  state: string;
}

/** Mirror of `get_status.governor` (GovernorMetrics) — what the energy→lifecycle→
 * scheduler closed loop is doing right now. */
export interface SystemGovernor {
  mode: string; // performance | balanced | power_save
  reason: string; // charging | healthy | battery_low | power_draw | thermal | ...
  cap_inference: boolean;
  throttle_background: boolean;
  ticks: number;
  dvfs_applied: number;
  dvfs_failed: number;
  dropped: number; // deferred jobs expired (never ran) on the last tick
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const num0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/**
 * Coerce a raw `system_health` payload into a typed view, tolerating absent /
 * partial fields (daemon offline, older shape). Never throws.
 */
export function normalizeSystemHealth(raw: unknown): SystemStatus {
  const s = (raw ?? {}) as Partial<SystemStatus>;
  return {
    sampler: typeof s.sampler === "string" ? s.sampler : "",
    cpu_busy_pct: num(s.cpu_busy_pct),
    mem_total_bytes: num(s.mem_total_bytes),
    mem_available_bytes: num(s.mem_available_bytes),
    battery_level_pct: num(s.battery_level_pct),
    battery_charging: bool(s.battery_charging),
    live_power_mw: num(s.live_power_mw),
    running: num0(s.running),
    cached: num0(s.cached),
    stopped: num0(s.stopped),
    apps: normalizeApps(s.apps),
    governor: normalizeGovernor(s.governor),
  };
}

/** Tolerantly coerce the governor block; null when absent / malformed. */
function normalizeGovernor(raw: unknown): SystemGovernor | null {
  const g = (raw ?? null) as Partial<SystemGovernor> | null;
  if (!g || typeof g !== "object" || typeof g.mode !== "string") return null;
  return {
    mode: g.mode,
    reason: typeof g.reason === "string" ? g.reason : "",
    cap_inference: g.cap_inference === true,
    throttle_background: g.throttle_background === true,
    ticks: num0(g.ticks),
    dvfs_applied: num0(g.dvfs_applied),
    dvfs_failed: num0(g.dvfs_failed),
    dropped: num0(g.dropped),
  };
}

/** Tolerantly coerce a per-app list, dropping malformed entries (never throws). */
function normalizeApps(raw: unknown): AppProc[] {
  if (!Array.isArray(raw)) return [];
  const out: AppProc[] = [];
  for (const a of raw) {
    const it = (a ?? {}) as Partial<AppProc>;
    if (typeof it.id === "string" && it.id.length > 0) {
      out.push({ id: it.id, state: typeof it.state === "string" ? it.state : "" });
    }
  }
  return out;
}

/** Used memory in bytes (total − available), or null when either half is unknown. */
export function memUsedBytes(s: SystemStatus): number | null {
  if (s.mem_total_bytes === null || s.mem_available_bytes === null) return null;
  return Math.max(0, s.mem_total_bytes - s.mem_available_bytes);
}

/** Used memory as a 0..100 percentage, or null when it cannot be derived. */
export function memUsedPct(s: SystemStatus): number | null {
  const t = s.mem_total_bytes;
  const u = memUsedBytes(s);
  if (u === null || t === null || t <= 0) return null;
  return (u / t) * 100;
}

/** Human "12.3 GB" / "512 MB" label for a byte count; "n/a" when unknown. */
export function fmtBytes(bytes: number | null): string {
  if (bytes === null || bytes < 0) return "n/a";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Number of live processes (all but stopped). */
export function liveProcesses(s: SystemStatus): number {
  return s.running + s.cached;
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

async function call<T>(command: string): Promise<T | null> {
  const b = bridge();
  if (!b) return null;
  try {
    return (await b.invoke(command)) as T;
  } catch {
    return null;
  }
}

/** Read the OS system working status in one round-trip (null offline). */
export function systemHealth(): Promise<SystemStatus | null> {
  return call<SystemStatus>("system_health");
}

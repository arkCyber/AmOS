/**
 * Resource-governor "Task Manager" view + typed bridge to the Tauri `taskmgr_*`
 * commands (which reach the daemon's mounted `GovernorService` over UDS). Pure
 * normalize helpers live here; `taskmgr*` wrappers return `null` when not bridged
 * so the UI shows a "daemon not connected" state instead of throwing.
 *
 * Wire shapes: crates/amos-tauri/src/taskmgr.rs `TaskSnapshot`/`TaskApp`/`TaskJob`/
 * `TaskDecision`.
 */
export type TaskStateKey =
  | "foreground"
  | "visible"
  | "foreground_service"
  | "background"
  | "cached"
  | "stopped"
  | "unknown";

export interface TaskApp {
  id: string;
  state: TaskStateKey;
}

export interface TaskJob {
  id: string;
  kind: "exact" | "deferred" | "unknown";
  earliest: number;
  latest: number;
}

export interface TaskDecision {
  mode: string;
  reason: string;
  cap_inference: boolean;
  throttle_background: boolean;
  ticks: number;
}

export interface TaskSnapshot {
  apps: TaskApp[];
  jobs: TaskJob[];
  background_count: number;
  decision: TaskDecision | null;
}

/** App actions a Task-Manager can drive into the governor. */
export type AppAction = "foreground" | "background" | "freeze" | "stop" | "kill";

const stateKey = (v: unknown): TaskStateKey =>
  typeof v === "string" &&
  ["foreground", "visible", "foreground_service", "background", "cached", "stopped"].includes(v)
    ? (v as TaskStateKey)
    : "unknown";

/**
 * Coerce a raw `taskmgr_snapshot` payload into a typed view, tolerating absent /
 * partial fields. Never throws.
 */
export function normalizeTaskSnapshot(raw: unknown): TaskSnapshot {
  const s = (raw ?? {}) as Partial<TaskSnapshot>;
  return {
    apps: normalizeApps(s.apps),
    jobs: normalizeJobs(s.jobs),
    background_count:
      typeof s.background_count === "number" && Number.isFinite(s.background_count)
        ? s.background_count
        : 0,
    decision: normalizeDecision(s.decision),
  };
}

function normalizeApps(raw: unknown): TaskApp[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskApp[] = [];
  for (const a of raw) {
    const it = (a ?? {}) as Partial<TaskApp>;
    if (typeof it.id === "string" && it.id.length > 0) {
      out.push({ id: it.id, state: stateKey(it.state) });
    }
  }
  return out;
}

function normalizeJobs(raw: unknown): TaskJob[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskJob[] = [];
  for (const j of raw) {
    const it = (j ?? {}) as Partial<TaskJob>;
    if (typeof it.id === "string" && it.id.length > 0) {
      const kind = it.kind === "exact" || it.kind === "deferred" ? it.kind : "unknown";
      out.push({
        id: it.id,
        kind,
        earliest: num(it.earliest),
        latest: num(it.latest),
      });
    }
  }
  return out;
}

function normalizeDecision(raw: unknown): TaskDecision | null {
  const d = (raw ?? null) as Partial<TaskDecision> | null;
  if (!d || typeof d !== "object" || typeof d.mode !== "string") return null;
  return {
    mode: d.mode,
    reason: typeof d.reason === "string" ? d.reason : "",
    cap_inference: d.cap_inference === true,
    throttle_background: d.throttle_background === true,
    ticks: num(d.ticks),
  };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Whether an app is live (not stopped / cached / unknown). */
export function appIsRunning(app: TaskApp): boolean {
  return app.state === "foreground" || app.state === "visible" || app.state === "foreground_service" || app.state === "background";
}

interface Bridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}
function bridge(): Bridge | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: Bridge };
  return w && typeof w.__TAURI_INTERNALS__ === "object" ? (w.__TAURI_INTERNALS__ as Bridge) : null;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  const b = bridge();
  if (!b) return null;
  try {
    return (await b.invoke(command, args)) as T;
  } catch {
    return null;
  }
}

/** Read the governor's app/job snapshot (null offline). */
export function taskmgrSnapshot(): Promise<TaskSnapshot | null> {
  return call<TaskSnapshot>("taskmgr_snapshot");
}

/** Drive a per-app lifecycle action; returns the fresh snapshot (null offline). */
export function taskmgrAppAction(
  appId: string,
  action: AppAction,
): Promise<TaskSnapshot | null> {
  return call<TaskSnapshot>("taskmgr_app_action", { appId, action });
}

/** Drive a job action (currently only `cancel`); returns the fresh snapshot. */
export function taskmgrJobAction(jobId: string, action: "cancel"): Promise<TaskSnapshot | null> {
  return call<TaskSnapshot>("taskmgr_job_action", { jobId, action });
}

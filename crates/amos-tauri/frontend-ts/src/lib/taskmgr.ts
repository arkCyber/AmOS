/**
 * Resource-governor "Task Manager" view + typed bridge to the Tauri `taskmgr_*`
 * commands (which reach the daemon's mounted `GovernorService` over UDS). Pure
 * normalize helpers live here; `taskmgr*` wrappers return `null` when not bridged
 * so the UI shows a "daemon not connected" state instead of throwing.
 *
 * Wire shapes: crates/amos-tauri/src/taskmgr.rs `TaskSnapshot`/`TaskApp`/`TaskJob`/
 * `TaskDecision`. The **values** are a cross-language contract too (REQ-A669): the
 * lifecycle keys are `taskmgr.rs::app_state_key`'s arms and the job kinds
 * `job_kind_key`'s, which `declaredMirrors.test.ts` reads from the Rust source and
 * requires to survive {@link normalizeTaskSnapshot} unchanged; the action tokens the UI
 * can send are the ones `taskmgr.rs::parse_action` accepts.
 */
import { invoke } from "./backend";

export interface TaskApp {
  id: string;
  state: TaskStateKey;
}

/**
 * The lifecycle keys the UI recognises — **the one declaration** (REQ-A669).
 *
 * {@link TaskStateKey} is *derived* from this array, so an add/rename is one edit and the
 * membership check in `stateKey` can no longer silently disagree with the type. It used to be
 * two hand-written spellings joined by an unchecked `as TaskStateKey` cast — the shape
 * `lib/permissions.ts` documents as a defect (a string present in one spelling only still
 * compiled).
 *
 * `visible` is the **container** tier (`amos_applife::AppState::key()`), which travels on the
 * *LMK* snapshot (`lib/android.ts::runTierForPackage`), not on `TaskSnapshot`: the proto has no
 * `AppState` value for it (`amos_ai::governor_service::proto_app_state` maps it to
 * `APP_STATE_UNSPECIFIED`), so a visible app arrives on this wire as `unknown`. Accepted here
 * because the key is real and the two vocabularies share the other five.
 */
export const TASK_STATE_KEYS = [
  "foreground",
  "visible",
  "foreground_service",
  "background",
  "cached",
  "stopped",
] as const;

/** A lifecycle key the UI recognises, or `unknown` (absent / unrecognised). */
export type TaskStateKey = (typeof TASK_STATE_KEYS)[number] | "unknown";

/** The job kinds `taskmgr.rs::job_kind_key` can emit (`unknown` = absent / unrecognised). */
export const TASK_JOB_KINDS = ["exact", "deferred"] as const;

/** A job kind the UI recognises, or `unknown`. */
export type TaskJobKind = (typeof TASK_JOB_KINDS)[number] | "unknown";

export interface TaskJob {
  id: string;
  kind: TaskJobKind;
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

/**
 * App actions a Task-Manager can drive into the governor — **the one declaration** of the
 * tokens the UI may send, each of which must be one `taskmgr.rs::parse_action` accepts (the
 * bridge answers "unknown task-manager action '…'" for anything else, so a rename on either
 * side would make a button a no-op the user cannot diagnose).
 */
export const APP_ACTIONS = ["foreground", "background", "freeze", "stop", "kill"] as const;

/** An action a Task-Manager can drive into the governor. */
export type AppAction = (typeof APP_ACTIONS)[number];

const stateKey = (v: unknown): TaskStateKey =>
  typeof v === "string" && (TASK_STATE_KEYS as readonly string[]).includes(v)
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
      const kind: TaskJobKind =
        typeof it.kind === "string" && (TASK_JOB_KINDS as readonly string[]).includes(it.kind)
          ? (it.kind as TaskJobKind)
          : "unknown";
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

/**
 * All three wrappers route through `backend.invoke`, so a failure is not only `null` — it
 * is recorded in the per-command diagnostic ledger (`bridgeDiag("taskmgr_app_action")` and
 * friends answer `{kind:"not-bridged"}` vs `{kind:"command-failed", detail}`) and leaves a
 * breadcrumb (REQ-A220). The private `bridge()`/`call<T>` that used to sit here swallowed
 * the rejection with a bare `catch { return null }`: the daemon's actual answer — the
 * `move_app`/`unregister_app` failure, or `"unknown task-manager action"` — was discarded
 * before anything wrote it down, which is why a *refused* action was indistinguishable from
 * an offline daemon (the caller's `.catch` — commented "daemon offline" — was unreachable,
 * and the action simply did nothing).
 */

/** Read the governor's app/job snapshot (null offline or refused — see the ledger). */
export function taskmgrSnapshot(): Promise<TaskSnapshot | null> {
  return invoke<TaskSnapshot>("taskmgr_snapshot");
}

/** Drive a per-app lifecycle action; returns the fresh snapshot (null offline or refused). */
export function taskmgrAppAction(
  appId: string,
  action: AppAction,
): Promise<TaskSnapshot | null> {
  return invoke<TaskSnapshot>("taskmgr_app_action", { appId, action });
}

/** Drive a job action (currently only `cancel`); returns the fresh snapshot. */
export function taskmgrJobAction(jobId: string, action: "cancel"): Promise<TaskSnapshot | null> {
  return invoke<TaskSnapshot>("taskmgr_job_action", { jobId, action });
}

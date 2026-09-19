/**
 * Android LMK surface bridge: consumes the daemon's `lmk-surface` feed (forwarded
 * by `crates/amos-tauri/src/android_lmk.rs` from the `WatchLmk` gRPC stream) and
 * tears down the matching `legacy:<window_id>` external surface in the wm core
 * when the container reclaimed/destroyed it.
 *
 * Pure helpers are unit-tested; `startLmkSurfaceWatcher` is wired once at the app
 * level (outside Tauri it degrades to a no-op unsubscribe).
 */

import { invoke, subscribe } from "./backend";
import { wmWindows } from "./wm";

// The wire type has one owner: `lib/wm.ts` (the `wm_*` bridge). Re-exported here so
// the LMK reconcile's callers/tests keep their import path.
export type { WmWindowInfo } from "./wm";
import type { WmWindowInfo } from "./wm";

/** Tauri event name for one daemon `WatchLmk` decision (Rust side emits this). */
export const LMK_SURFACE_EVENT = "lmk-surface";

/** Serializable container LMK decision forwarded from the Rust bridge. */
export interface LmkSurfacePayload {
  window_id: string;
  package_name: string;
  /** `"reclaimed"` | `"frozen"` | `"thawed"` | `"destroyed"` | `"unknown"`. */
  kind: string;
  /** True when the surface should be torn down (reclaimed/destroyed). */
  close_surface: boolean;
}

/** The `amos-wm` external-surface label for a container window id. */
export function legacySurfaceLabel(windowId: string): string {
  return `legacy:${windowId}`;
}

/** Whether an LMK event asks the shell to tear down the legacy surface. */
export function shouldTearDown(p: LmkSurfacePayload): boolean {
  return Boolean(p && p.close_surface && p.window_id);
}

/** Tear down the `legacy:<windowId>` external surface via the wm core. */
export async function closeLegacySurface(windowId: string): Promise<boolean> {
  const snap = await invoke("wm_close", { label: legacySurfaceLabel(windowId) });
  return snap != null;
}

/** A live container task from the daemon LMK snapshot (`android_lmk_tasks`). */
export interface AndroidLmkTask {
  window_id: string;
  package_name: string;
  state: string;
}

function isLegacyLabel(label: string): boolean {
  return label.startsWith("legacy:");
}

/**
 * Pure reconciliation: which currently-registered `legacy:*` surfaces have no
 * matching live container task (so their app died without a `lmk-surface` event)?
 * `tasks` is the authoritative daemon `GetLmkSnapshot`; `windows` the Rust
 * `wm_windows`. The shell closes these to stay consistent with the authority.
 */
export function staleLegacySurfaceLabels(
  windows: WmWindowInfo[],
  tasks: AndroidLmkTask[],
): string[] {
  // REQ-A407: `t &&` —— 一个坏元素（null / 不是对象）不该让整轮对账炸掉；没有 window_id 的
  // 行本来就不算"活着的容器任务"，丢掉它只会让**更少**的面被保留（保守方向）。
  const alive = new Set(
    tasks.filter((t) => t && t.window_id).map((t) => legacySurfaceLabel(t.window_id)),
  );
  return windows
    .filter((w) => isLegacyLabel(w.label) && !alive.has(w.label))
    .map((w) => w.label);
}

/**
 * Fetch the daemon's authoritative live LMK tasks (null when the daemon is down).
 *
 * REQ-A407: 形状守卫 —— 契约是"权威快照，取不到就是 null"。宿主回一个**不是数组**的东西
 * （旧版守护进程、半截应答、被序列化坏的对象）时不能把它当快照交给对账：`tasks.filter`
 * 会抛，而调用方是把对账 `void` 出去的 ⇒ 一次没人看见的未处理拒绝，`reconcileLegacySurfaces`
 * 自己的"守卫"（daemon down ≠ app dead）也就失效了。取不到 ⇒ null。
 */
export async function androidLmkTasks(): Promise<AndroidLmkTask[] | null> {
  const raw = await invoke<unknown>("android_lmk_tasks");
  return Array.isArray(raw) ? (raw as AndroidLmkTask[]) : null;
}

/**
 * Reconcile: close any `legacy:*` surface that is registered but whose container
 * task is no longer alive per the authoritative daemon snapshot. Guards: if the
 * daemon snapshot is unavailable (daemon down ≠ app dead) or we're not bridged,
 * nothing is closed. Returns the number of stale surfaces closed.
 */
export async function reconcileLegacySurfaces(): Promise<number> {
  const tasks = await androidLmkTasks();
  if (!tasks) return 0; // daemon down is not "everything is dead".
  const wm = await wmWindows();
  const stale = staleLegacySurfaceLabels(wm?.windows ?? [], tasks);
  for (const label of stale) {
    await invoke("wm_close", { label });
  }
  return stale.length;
}

/**
 * Subscribe to the `lmk-surface` feed and auto-tear-down any surface the container
 * reclaimed/destroyed, then reconcile the rest against the authoritative snapshot
 * (covers events we might have missed). Returns an unsubscribe (noop outside Tauri).
 */
export async function startLmkSurfaceWatcher(): Promise<() => void> {
  return subscribe(LMK_SURFACE_EVENT, (raw) => {
    const p = raw as LmkSurfacePayload;
    if (shouldTearDown(p)) {
      void closeLegacySurface(p.window_id);
    }
    // Event-driven nudge: reconcile the whole legacy set too (cheap, rare).
    void reconcileLegacySurfaces();
  });
}

/** Default cadence for the background periodic reconcile (ms). */
export const RECONCILE_INTERVAL_MS = 30_000;
/**
 * Run one reconcile immediately (catches surfaces stale from before the shell
 * started watching), then every `intervalMs`. Returns a stop() that clears the
 * timer. No-op when not bridged (reconcile guards internally). A DOM-side helper;
 * the pure decision logic stays in `reconcileLegacySurfaces`.
 */
export function startPeriodicReconcile(intervalMs = RECONCILE_INTERVAL_MS): () => void {
  void reconcileLegacySurfaces();
  const id = window.setInterval(() => {
    void reconcileLegacySurfaces();
  }, intervalMs);
  return () => window.clearInterval(id);
}

// ---- LMK debug / user entry (bring-up `docs/android-lmk-e2e.md` G3) ---------

/** One container app the daemon LMK reclaimed/froze in a trigger round.
 *
 * The wire shape has **one owner**: `proto/android_compat.proto`'s `LmkVictim`
 * (mirrored by `amos-tauri::android_lmk::LmkVictimOutcome`). It carries exactly
 * `{package_name, window_id, killed}` — there is **no per-victim `outcome`** and no
 * `refusal_reason`, and a round the container refused produces **no row at all**:
 * `amos-android::service::trigger_lmk` builds one row per *decided* victim and ignores
 * the `am force-stop` result entirely. So this type must not invent fields the host
 * cannot send — a UI that reads them is reading its own imagination.
 */
export interface LmkVictim {
  package_name: string;
  window_id: string;
  killed: boolean;
}

/** The three states a victim row can honestly show. */
export type LmkVictimState = "reclaimed" | "frozen" | "unknown";

/**
 * Determine a victim's state from the wire.
 *
 * - `killed === true` ⇒ **reclaimed**: the proto documents `true = killed (surface torn
 *   down)` and the server sets `killed: v.action == LmkAction::Kill`
 *   (`trigger_lmk_critical_reclaims_background_app`: "critical reclaim kills the process").
 * - `killed === false` ⇒ **frozen**: the proto's own comment is `false = frozen`, and the
 *   server's `trigger_lmk_low_freezes_not_kills` moves the task to `cached` — still
 *   tracked, not killed. This is exactly what the host reported, so we say it.
 * - anything else ⇒ **unknown**: a payload whose `killed` is absent or not a boolean is
 *   not evidence of a freeze, so it is not claimed as one.
 *
 * (History: this used to read a per-victim `outcome` — a field the wire never carried —
 * which left `frozen` unreachable and reported every freeze as `unknown`. That inverted
 * the honesty rule: it hid a fact the daemon *had* told us.)
 */
export function victimState(v: LmkVictim): LmkVictimState {
  if (v.killed === true) return "reclaimed";
  if (v.killed === false) return "frozen";
  return "unknown";
}

/** Outcome of an `android_lmk_debug` call (serialized from `LmkDebugOutcome`). */
export interface LmkDebugOutcome {
  victims: LmkVictim[];
  note: string;
}

/**
 * Drive the daemon LMK from the System UI (bring-up debug entry):
 * `action` `"trigger"` asks the daemon to reclaim LRU victims (budget defaults to
 * 1); `"apply_freeze" | "apply_thaw" | "apply_reclaim"` target one container app
 * by `packageName`. Returns `null` when not bridged / daemon down.
 */
export async function androidLmkDebug(
  action: "trigger" | "apply_freeze" | "apply_thaw" | "apply_reclaim",
  packageName?: string,
  budget?: number,
): Promise<LmkDebugOutcome | null> {
  const args: Record<string, unknown> = { action };
  if (packageName !== undefined) args.packageName = packageName;
  if (budget !== undefined) args.budget = budget;
  return invoke<LmkDebugOutcome>("android_lmk_debug", args);
}


import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  androidLmkDebug,
  androidLmkTasks,
  closeLegacySurface,
  legacySurfaceLabel,
  LMK_SURFACE_EVENT,
  reconcileLegacySurfaces,
  shouldTearDown,
  staleLegacySurfaceLabels,
  startLmkSurfaceWatcher,
  startPeriodicReconcile,
  victimState,
  type AndroidLmkTask,
  type LmkSurfacePayload,
  type LmkVictim,
  type WmWindowInfo,
} from "../lib/lmk";

const RECLAIMED: LmkSurfacePayload = {
  window_id: "waydroid_0",
  package_name: "com.tencent.mm",
  kind: "reclaimed",
  close_surface: true,
};

describe("android LMK surface bridge (pure helpers)", () => {
  test("event name matches the Rust bridge const", () => {
    expect(LMK_SURFACE_EVENT).toBe("lmk-surface");
  });

  test("legacySurfaceLabel addresses the amos-wm external surface", () => {
    expect(legacySurfaceLabel("waydroid_0")).toBe("legacy:waydroid_0");
  });

  test("a reclaimed/destroyed surface should be torn down", () => {
    expect(shouldTearDown(RECLAIMED)).toBe(true);
    expect(shouldTearDown({ ...RECLAIMED, kind: "destroyed" })).toBe(true);
  });

  test("frozen/thawed surfaces are kept", () => {
    expect(shouldTearDown({ ...RECLAIMED, kind: "frozen", close_surface: false })).toBe(false);
    expect(shouldTearDown({ ...RECLAIMED, kind: "thawed", close_surface: false })).toBe(false);
  });

  test("no window id (or unknown kind) is never torn down", () => {
    expect(shouldTearDown({ ...RECLAIMED, window_id: "" })).toBe(false);
    expect(shouldTearDown({ ...RECLAIMED, kind: "unknown", close_surface: false })).toBe(false);
    // Defensive: a missing/partial payload must not crash.
    expect(shouldTearDown(undefined as unknown as LmkSurfacePayload)).toBe(false);
  });
});

const W = (label: string): WmWindowInfo => ({
  id: 0,
  label,
  // REQ-A473: the identity the host reports for a window (`""`/0 = "shows no app").
  // These fixtures only exercise label/kind/external, so the identity is derived the same
  // way `normalizeWindows` derives it: a `legacy:` surface shows no app.
  app: label.startsWith("legacy:") ? "" : label,
  instance: label.startsWith("legacy:") ? 0 : 1,
  kind: label.startsWith("legacy:") ? "System" : "App",
  state: "Shown",
  focused: false,
  external: label.startsWith("legacy:"),
});
const T = (window_id: string): AndroidLmkTask => ({
  window_id,
  package_name: "com.tencent.mm",
  state: "background",
});

describe("android LMK surface reconciliation (pure)", () => {
  test("closes a legacy surface whose container task is no longer alive", () => {
    const windows = [W("legacy:a"), W("legacy:b"), W("launcher")];
    const tasks = [T("b")]; // "a" died without an event
    expect(staleLegacySurfaceLabels(windows, tasks)).toEqual(["legacy:a"]);
  });

  test("keeps alive surfaces and non-legacy windows", () => {
    const windows = [W("legacy:a"), W("legacy:b"), W("launcher"), W("notes")];
    const tasks = [T("a"), T("b")];
    expect(staleLegacySurfaceLabels(windows, tasks)).toEqual([]);
  });

  test("ignores tasks with no window id yet bound", () => {
    // Task exists but no surface bound yet: it must NOT mark existing surfaces stale.
    const windows = [W("legacy:a")];
    expect(staleLegacySurfaceLabels(windows, [T("")])).toEqual(["legacy:a"]);
  });

  test("daemon-down (empty task list) closes nothing only when no windows; empty both = []", () => {
    expect(staleLegacySurfaceLabels([], [])).toEqual([]);
  });
});

/**
 * The victim row is read off the **wire**, and the wire has exactly one signal.
 *
 * `proto/android_compat.proto::LmkVictim` = `{package_name, window_id, killed}` and its
 * own comment defines the field: `true = killed (surface torn down); false = frozen`.
 * `amos-android::service::trigger_lmk` implements exactly that (`killed: v.action ==
 * LmkAction::Kill`) and its tests say so out loud:
 *   * `trigger_lmk_critical_reclaims_background_app` — "critical reclaim kills the process"
 *   * `trigger_lmk_low_freezes_not_kills`          — "low pressure freezes, not kills",
 *     and the task stays tracked as `cached`.
 * There is no per-victim `outcome` and no `refusal_reason`; a round the container refused
 * yields **no row at all**. So these cases pin the real contract, not a richer imagined one.
 */
describe("android LMK victim state reads the wire (REQ-A399)", () => {
  /** A row as the bridge really serializes it (`LmkVictimOutcome`). */
  const victim = (killed: unknown, extra: Record<string, unknown> = {}): LmkVictim =>
    ({ package_name: "com.example", window_id: "w1", killed, ...extra }) as LmkVictim;

  test("killed ⇒ reclaimed", () => {
    expect(victimState(victim(true))).toBe("reclaimed");
  });

  test("not killed ⇒ frozen — the proto's own word for `killed = false`", () => {
    // The old code read an `outcome` field the host never sends, so it answered
    // "unknown" here: the one freeze state the daemon *had* reported was hidden.
    expect(victimState(victim(false))).toBe("frozen");
  });

  test("a missing / non-boolean killed stays unknown — never claimed as a freeze", () => {
    expect(victimState(victim(undefined))).toBe("unknown");
    expect(victimState(victim(null))).toBe("unknown");
    expect(victimState(victim("false"))).toBe("unknown");
  });

  test("fields the host cannot send do not steer the answer (negative control)", () => {
    // `outcome`/`refusal_reason` exist in no producer: `grep -rn refusal_reason` finds only
    // frontend files. Judging by `killed` alone is what makes the row traceable to the wire.
    expect(victimState(victim(false, { outcome: "refused", refusal_reason: "boom" }))).toBe("frozen");
    expect(victimState(victim(true, { outcome: "frozen" }))).toBe("reclaimed");
  });

  test("the reachable state set is exactly {reclaimed, frozen, unknown}", () => {
    const seen = [...new Set([victim(true), victim(false), victim(undefined)].map(victimState))];
    expect(seen.sort()).toEqual(["frozen", "reclaimed", "unknown"]);
  });
});

/**
 * REQ-A407 — `lmk.ts` 的**桥接侧**（真的接了宿主时才走到的那些行）。这个文件此前只测了纯函数，
 * 于是 31 行缺失全是"有宿主"的分支：关面、对账、事件驱动、定时对账 —— 而它们恰恰是会**动**
 * 用户窗口的那一半（对账错了就会关掉活着的应用）。判定标准仍是从外部可观察的结果：发了哪些
 * 命令、发了什么参数、返回了几个、以及"宿主说不清的时候有没有动手"。
 *
 * 假宿主与 `backend-bridge.test.ts` / `pushNotifications-bridge.test.ts` 同款。
 */
let respond: (command: string, args?: Record<string, unknown>) => unknown = () => null;
const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
let listeners: Record<string, (e: { payload: unknown }) => void> = {};
let intervalCb: (() => void) | null = null;
let intervalMs = -1;
const cleared: number[] = [];

function installLmkBridge(): void {
  calls.length = 0;
  listeners = {};
  intervalCb = null;
  intervalMs = -1;
  cleared.length = 0;
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return respond(command, args);
      },
      listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
        listeners[channel] = handler;
        return () => {
          delete listeners[channel];
        };
      },
    },
    setInterval: (cb: () => void, ms: number) => {
      intervalCb = cb;
      intervalMs = ms;
      return 7;
    },
    clearInterval: (id: number) => {
      cleared.push(id);
    },
  };
}

beforeEach(() => {
  installLmkBridge();
  respond = () => null;
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** 这一轮对账关掉了哪些面（只看真正会动窗口的那条命令）。 */
const closed = () => calls.filter((c) => c.command === "wm_close").map((c) => c.args?.label);


describe("lmk 桥接路径：宿主说不清的时候不许动手（REQ-A407）", () => {
  test("closeLegacySurface：宿主回了快照 ⇒ true；回 null ⇒ false（不谎报关掉了）", async () => {
    respond = () => ({ torn: true });
    expect(await closeLegacySurface("waydroid_0")).toBe(true);
    expect(closed()).toEqual(["legacy:waydroid_0"]);

    calls.length = 0;
    respond = () => null;
    expect(await closeLegacySurface("waydroid_1")).toBe(false);
    expect(closed()).toEqual(["legacy:waydroid_1"]);
  });

  test("androidLmkTasks：原样落地；宿主回 null / 未桥接都是 null", async () => {
    respond = (cmd) => (cmd === "android_lmk_tasks" ? [T("waydroid_0")] : null);
    expect(await androidLmkTasks()).toEqual([T("waydroid_0")]);

    respond = () => null;
    expect(await androidLmkTasks()).toBeNull();

    delete (globalThis as { window?: unknown }).window;
    expect(await androidLmkTasks()).toBeNull();
  });

  test("对账：守护进程不在（tasks=null）⇒ 0，且一条 wm_close 都不发", async () => {
    respond = (cmd) => (cmd === "wm_windows" ? { windows: [W("legacy:waydroid_0")] } : null);
    expect(await reconcileLegacySurfaces()).toBe(0);
    expect(closed()).toEqual([]);
  });

  test("对账：权威快照说没有活着的容器任务 ⇒ 所有 legacy 面都关掉（且只关这些）", async () => {
    respond = (cmd) => {
      if (cmd === "android_lmk_tasks") return [];
      if (cmd === "wm_windows") {
        return { windows: [W("legacy:waydroid_0"), W("app:notes"), W("legacy:waydroid_1")] };
      }
      return { ok: true };
    };
    expect(await reconcileLegacySurfaces()).toBe(2);
    expect(closed()).toEqual(["legacy:waydroid_0", "legacy:waydroid_1"]);
  });

  test("对账：只关已死的那一个（活着的容器任务不许被连坐）", async () => {
    respond = (cmd) => {
      if (cmd === "android_lmk_tasks") return [T("waydroid_0")];
      if (cmd === "wm_windows") return { windows: [W("legacy:waydroid_0"), W("legacy:waydroid_1")] };
      return { ok: true };
    };
    expect(await reconcileLegacySurfaces()).toBe(1);
    expect(closed()).toEqual(["legacy:waydroid_1"]);
  });

  test("对账：wm_windows 不可用 ⇒ 0（窗口快照缺失 ≠ 窗口都没了）", async () => {
    respond = (cmd) => (cmd === "android_lmk_tasks" ? [] : null);
    expect(await reconcileLegacySurfaces()).toBe(0);
    expect(closed()).toEqual([]);
  });

  test("对账：宿主**拒绝**了 wm_close ⇒ 计数只算真的关掉的（命令照发）(REQ-A845)", async () => {
    // REQ-A845 / F-SH-271: `wm_close` 答 unit，`invoke` 从不 reject，拒绝与成功都到手是
    // `null` —— 所以 `stale.length` 数的是**尝试**，文档却说"关掉了几个"。这里让宿主拒绝，
    // 那条使唤照样要发出去（该关的还是得关），但**计数必须是 0**：屏幕上一个面都没少。
    respond = (cmd) => {
      if (cmd === "android_lmk_tasks") return [];
      if (cmd === "wm_windows") {
        return { windows: [W("legacy:waydroid_0"), W("legacy:waydroid_1")] };
      }
      if (cmd === "wm_close") throw new Error("wm core is locked");
      return { ok: true };
    };
    await expect(reconcileLegacySurfaces()).resolves.toBe(0);
    expect(closed()).toEqual(["legacy:waydroid_0", "legacy:waydroid_1"]);
  });

  test("对账：宿主回了一个**不是数组**的 tasks ⇒ 0，不抛（守卫要对形状负责）", async () => {
    respond = (cmd) =>
      cmd === "android_lmk_tasks" ? { nope: "not an array" } : { windows: [W("legacy:x")] };
    await expect(reconcileLegacySurfaces()).resolves.toBe(0);
    expect(closed()).toEqual([]);
  });

  test("对账：wm_windows 的形状坏了（windows 不是数组）⇒ 0，不抛", async () => {
    respond = (cmd) => (cmd === "android_lmk_tasks" ? [] : { windows: "nope" });
    await expect(reconcileLegacySurfaces()).resolves.toBe(0);
    expect(closed()).toEqual([]);
  });

  test("纯函数也要挡坏元素：null / 没有 window_id 的任务不该让整轮对账炸掉", () => {
    expect(
      staleLegacySurfaceLabels(
        [W("legacy:a"), W("legacy:b")],
        [null as unknown as AndroidLmkTask, {} as AndroidLmkTask, T("b")],
      ),
    ).toEqual(["legacy:a"]);
  });
});


describe("lmk 事件驱动与定时对账（REQ-A407）", () => {
  test("lmk-surface 事件：要拆的面被关掉，并且顺手对账一次", async () => {
    respond = (cmd) => (cmd === "android_lmk_tasks" ? [T("waydroid_0")] : { windows: [] });
    const stop = await startLmkSurfaceWatcher();
    expect(stop, "桥在，监听就该成立（否则下面的断言全都测不到东西）").not.toBeNull();
    listeners["lmk-surface"]!({ payload: RECLAIMED });
    await Promise.resolve(); // 让 void 出去的 promise 跑完
    expect(closed()).toEqual(["legacy:waydroid_0"]);
    expect(calls.some((c) => c.command === "android_lmk_tasks")).toBe(true);

    calls.length = 0;
    listeners["lmk-surface"]!({ payload: { ...RECLAIMED, kind: "frozen", close_surface: false } });
    await Promise.resolve();
    expect(closed()).toEqual([]); // 冻结不拆
    expect(calls.some((c) => c.command === "android_lmk_tasks")).toBe(true); // 但对账照做

    stop!();
    expect(listeners["lmk-surface"]).toBeUndefined();
  });

  test("未桥接：watcher 明确报告「没有订阅」（null），而不是一个可信的空退订（REQ-A838）", async () => {
    delete (globalThis as { window?: unknown }).window;
    // 旧契约在这里返回 `() => {}`，与"订阅成功、只是暂时没有事件"在调用方看来一模一样：
    // 容器回收了界面却永远不拆，而壳层以为自己正在监听。现在"没在听"是可读的。
    expect(await startLmkSurfaceWatcher()).toBeNull();
  });

  test("定时对账：立刻跑一次、按 intervalMs 挂表、stop() 真的清掉（不许泄漏）", async () => {
    respond = (cmd) => (cmd === "android_lmk_tasks" ? [] : { windows: [] });
    const stop = startPeriodicReconcile(1234);
    await Promise.resolve();
    expect(calls.filter((c) => c.command === "android_lmk_tasks")).toHaveLength(1); // 立刻一次
    expect(intervalMs).toBe(1234);

    calls.length = 0;
    intervalCb!(); // 模拟定时器到点
    await Promise.resolve();
    expect(calls.filter((c) => c.command === "android_lmk_tasks")).toHaveLength(1);

    stop();
    expect(cleared).toEqual([7]);
  });

  test("androidLmkDebug：action 必带；packageName / budget **给了才发**（不给的字段不许凭空出现）", async () => {
    respond = () => ({ victims: [], note: "ok" });
    await androidLmkDebug("trigger");
    expect(calls).toEqual([
      { command: "android_lmk_debug", args: { action: "trigger" } },
    ]);

    calls.length = 0;
    await androidLmkDebug("apply_freeze", "com.tencent.mm", 3);
    expect(calls).toEqual([
      {
        command: "android_lmk_debug",
        args: { action: "apply_freeze", packageName: "com.tencent.mm", budget: 3 },
      },
    ]);
  });

  test("androidLmkDebug：宿主回 null / 未桥接都是 null（不发明一条空的 victims 列表）", async () => {
    respond = () => null;
    expect(await androidLmkDebug("trigger")).toBeNull();
    delete (globalThis as { window?: unknown }).window;
    expect(await androidLmkDebug("trigger")).toBeNull();
  });
});


/**
 * DOM tests for the Svelte 5 system-monitor panels (SystemPanel / TaskManager)
 * — the round-3 groups added to SettingsApp.svelte. They read the daemon via
 * lib/system + lib/taskmgr. Offline (no bridge) they render nothing (no broken
 * card); with a fake bridge returning live data they render the readouts.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import SystemPanel from "../src/svelte/SystemPanel.svelte";
import TaskManager from "../src/svelte/TaskManager.svelte";
import { recentDiag } from "../src/lib/debugLog";

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";

function installBridge(systemHealth: unknown, taskmgrSnapshot: unknown) {
  const invoke = async (cmd: string) => {
    if (cmd === "system_health") return systemHealth;
    if (cmd === "taskmgr_snapshot") return taskmgrSnapshot;
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}
const settle = () => new Promise((r) => setTimeout(r, 40));

describe("SystemPanel.svelte", () => {
  test("renders nothing offline (no bridge)", async () => {
    const host = render(SystemPanel);
    await settle();
    expect(txt(host)).not.toContain("系统工作状况");
    expect(host.container.textContent).toBe("");
  });

  test("renders CPU / processes readouts from a bridged system_health", async () => {
    installBridge({ cpu_busy_pct: 42, running: 3, cached: 1, stopped: 0, apps: [] }, null);
    const host = render(SystemPanel);
    await settle();
    await settle();
    expect(txt(host)).toContain("系统工作状况");
    expect(txt(host)).toContain("42%");
    expect(txt(host)).toContain("3 running · 1 cached · 0 stopped");
  });
});

/**
 * REQ-A1356 — a panel whose **first** read is refused used to disappear for good.
 *
 * `SystemPanel` self-hides while it has no data (`{#if hasAny}`, no `else`) and used to
 * arm its 2.5 s poll **only** once `hasAny` was true. So the very state that hides the
 * card also switches off the only thing that could ever un-hide it, and the one retry
 * button lives *inside* the hidden branch — a closed loop with no way back in.
 *
 * The sibling that draws this panel (`MonitorApp`) states the rule the other way round:
 * "each poll is a reconnect probe that flips us back to live the moment the daemon
 * returns" (`online ? REFRESH_MS : RECONNECT_MS`), and its own comment claims the two
 * surfaces "stay in step" because they share the `hasAny` test. They share the *test*
 * but not the *polling*: MonitorApp recovers, its detail panel does not — so a user who
 * waits out an offline mount and taps MonitorApp's 「重试」 gets the overview back and
 * a permanently missing CPU/memory/governor section underneath it.
 */
describe("SystemPanel — a daemon that appears after the first refusal (REQ-A1356)", () => {
  test("the panel comes back while it is still on screen", async () => {
    vi.useFakeTimers();
    try {
      // A host that is *down* at mount and *up* afterwards: the refusal is a rejection
      // (the real shape, `lib/system.ts` routes through `backend.invoke`), and the later
      // answer is a well-formed status. Nothing pushes the change to the panel — the
      // only way it can learn is by asking again.
      let reply: unknown = null;
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string) => {
          if (cmd === "system_health") {
            if (reply === null) throw new Error("system status request failed: connect");
            return reply;
          }
          return null;
        },
        listen: async () => () => {},
      };

      const host = render(SystemPanel);
      await vi.advanceTimersByTimeAsync(0);
      // Offline at mount: the panel hides itself — the documented behaviour, kept.
      expect(host.container.textContent ?? "").toBe("");

      reply = { cpu_busy_pct: 42, running: 3, cached: 1, stopped: 0, apps: [] };
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      // The reconnect probe found the daemon: the readouts are on screen without the
      // user reopening anything.
      expect(txt(host)).toContain("42%");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TaskManager.svelte", () => {
  test("renders nothing offline (no bridge)", async () => {
    const host = render(TaskManager);
    await settle();
    expect(host.container.textContent).toBe("");
  });

  test("lists a governed app with lifecycle actions from a bridged snapshot", async () => {
    installBridge(null, {
      apps: [{ id: "com.example.app", state: "background" }],
      jobs: [],
      decision: null,
    });
    const host = render(TaskManager);
    await settle();
    await settle();
    expect(txt(host)).toContain("任务管理器");
    expect(txt(host)).toContain("com.example.app");
    expect(txt(host)).toContain("结束"); // "kill" action button is always offered
  });
});

/**
 * REQ-A297 phase-2 §4 cont.4 (SystemPanel half): the pre-fix
 * `.catch(() => { ... })` ("daemon offline, keep previous") was dead code
 * because `systemStatusWithHostBattery()` resolves `null` on a refused command
 * rather than rejecting. The fix moved the surfacing into the success arm's
 * `else` branch, which reads `bridgeDiag("system_health")` and logs the typed
 * reason — "the launcher ledger gains a real signal".
 *
 * That branch was itself **dead** until this round: `lib/system.ts` carried its own
 * `bridge()`/`call<T>`, so no producer ever wrote the per-command ledger entry and
 * `bridgeDiag("system_health")` always answered the default `{ ok: true }`. The old
 * assertion here (`textContent === ""`) was unfailable — it held whether or not the
 * ledger was written. This test now pins the signal itself.
 */
describe("SystemPanel — honest error surfacing (REQ-A297 phase-2 §4 cont.4)", () => {
  test("a refused system_health stays off-screen AND records a typed reason in the ledger", async () => {
    // Window on the monotonic `seq`, never a length delta (the ring is bounded).
    const mark = recentDiag(1)[0]?.seq ?? 0;
    // A *rejecting* bridge — the shape a real refused command produces (the old
    // fixture answered `null`, which is the same trace as an absent command).
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "system_health") throw new Error("system status request failed: connect");
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(SystemPanel);
    await settle();
    await settle();
    // No data row is fabricated for a read that failed.
    expect(host.container.textContent ?? "").toBe("");
    // The typed reason reached the ledger — the writer half of the fix, without
    // which SystemPanel's `command-failed` branch could never fire.
    const entry = recentDiag(-1).find((e) => e.seq > mark && e.msg.includes("system_health"));
    expect(entry?.msg).toContain("system_health failed");
  });
});

describe("TaskManager — a refused action is reported, a missing daemon is not", () => {
  const snapshot = {
    apps: [{ id: "com.example.app", state: "background" }],
    jobs: [],
    decision: null,
  };
  const killedButton = (h: { container: HTMLElement }) =>
    [...h.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "结束") as
      | HTMLButtonElement
      | undefined;

  test("the daemon's own refusal is shown (the button used to do nothing, silently)", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "taskmgr_snapshot") return snapshot;
        if (cmd === "taskmgr_app_action") {
          throw new Error("unregister_app 'com.example.app' failed: not registered");
        }
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(TaskManager);
    await settle();
    await settle();
    const kill = killedButton(host);
    expect(kill).toBeTruthy();
    await fireEvent.click(kill!);
    await settle();
    await settle();
    // The daemon is up and answered — so the reason is on screen…
    expect(txt(host)).toContain("unregister_app 'com.example.app' failed");
    // …and it is not mislabelled as an offline daemon.
    expect(txt(host)).not.toContain("离线");
  });

  test("a bridge that goes away mid-session is silent (no fabricated refusal)", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) =>
        cmd === "taskmgr_snapshot" ? snapshot : { ...snapshot },
      listen: async () => () => {},
    };
    const host = render(TaskManager);
    await settle();
    await settle();
    const kill = killedButton(host);
    expect(kill).toBeTruthy();
    // The bridge disappears before the tap: `not-bridged`, not a refusal.
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    await fireEvent.click(kill!);
    await settle();
    await settle();
    expect(host.container.textContent ?? "").not.toContain("操作被拒绝");
  });

  /**
   * A refusal is a verdict about **one action**, so it must not outlive it.
   *
   * `refused` had exactly one writer (`reportRefusal`, called only from the
   * `else` of a *failed* action) and no clearer: a successful action did not
   * clear it and the 3 s refresh never touched it. So after 停止 A was refused,
   * the red line stayed for the panel's whole life — and when a later 停止
   * succeeded, the screen still carried the earlier failure's words, i.e. the
   * panel declared the just-performed action failed. The sibling store
   * (`StoreApp.run`) clears its `actingError` at the top of every action; this
   * is the same rule.
   *
   * Three phases, so neither direction can be satisfied by a degenerate fix:
   * refused ⇒ shown; then a succeeding action ⇒ gone; then a fresh refusal
   * (different words) ⇒ shown again.
   */
  test("a later action supersedes the previous refusal (and a new refusal still shows)", async () => {
    let failMsg: string | null = "first refusal: not registered";
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "taskmgr_snapshot") return snapshot;
        if (cmd === "taskmgr_app_action") {
          if (failMsg !== null) throw new Error(failMsg);
          return snapshot;
        }
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(TaskManager);
    await settle();
    await settle();
    const kill = killedButton(host);
    expect(kill).toBeTruthy();

    // Phase 1 — the refusal is said.
    await fireEvent.click(kill!);
    await settle();
    await settle();
    expect(txt(host)).toContain("first refusal: not registered");

    // Phase 2 — a *successful* action supersedes it: the old words must be gone.
    failMsg = null;
    await fireEvent.click(killedButton(host)!);
    await settle();
    await settle();
    expect(txt(host)).not.toContain("first refusal: not registered");
    expect(txt(host)).not.toContain("操作被拒绝");

    // Phase 3 — a new refusal is not swallowed by the clearing (the reverse half:
    // a fix that simply never renders the alert would pass phase 2 alone).
    failMsg = "second refusal: gone";
    await fireEvent.click(killedButton(host)!);
    await settle();
    await settle();
    expect(txt(host)).toContain("second refusal: gone");
    expect(txt(host)).not.toContain("first refusal");
  });
});

/**
 * REQ-A1364 / F-SH-628 — the sibling half of REQ-A1356, left behind.
 *
 * `SystemPanel` (above) was fixed: the state that hides the card no longer switches off the
 * only thing that could un-hide it. `TaskManager` draws on the **same screens**
 * (`MonitorApp` renders both in a row; `DiagnosticsPage` renders the task manager alone) and
 * kept the pre-fix shape verbatim — `if (!hasAny) return;` right before the `setInterval`.
 * So a daemon absent at mount leaves the whole task-manager section missing for the rest of
 * the session: `{#if hasAny}` has no `else`, the panel's own 刷新 button lives **inside** the
 * hidden branch, and `MonitorApp`'s 重试 only re-reads `system_health` — it never asks
 * `taskmgr_snapshot` again. Nothing on screen can bring it back, even after the governor's
 * daemon returns.
 */
describe("TaskManager — a daemon that appears after the first refusal (REQ-A1364)", () => {
  test("the panel comes back while it is still on screen", async () => {
    vi.useFakeTimers();
    try {
      // A host that is *down* at mount and *up* afterwards: the refusal is a rejection
      // (the real shape, `lib/taskmgr.ts` routes through `backend.invoke`), and the later
      // answer is a well-formed snapshot. Nothing pushes the change to the panel — the
      // only way it can learn is by asking again.
      let reply: unknown = null;
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string) => {
          if (cmd === "taskmgr_snapshot") {
            if (reply === null) throw new Error("taskmgr snapshot request failed: connect");
            return reply;
          }
          return null;
        },
        listen: async () => () => {},
      };

      const host = render(TaskManager);
      await vi.advanceTimersByTimeAsync(0);
      // Refused at mount: the panel hides itself — the documented behaviour, kept.
      expect(host.container.textContent ?? "").toBe("");

      reply = { apps: [{ id: "com.example.app", state: "background" }], jobs: [], decision: null };

      // The probe that stays armed is the *slower* reconnect cadence, not the live one:
      // still nothing past 3 s (a hidden panel polling at `REFRESH_MS` would have fired
      // already) — that is what makes keeping a hidden panel armed cheap…
      await vi.advanceTimersByTimeAsync(3_500);
      await vi.advanceTimersByTimeAsync(0);
      expect(host.container.textContent ?? "").toBe("");

      // …and the reconnect probe at 5 s finds the daemon: the registry is on screen with
      // no reopen and no tap.
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(0);
      expect(txt(host)).toContain("com.example.app");

      // The other polarity: once there *is* a panel to keep fresh it polls at the live
      // cadence, so new data lands within 3 s. Swapping the two periods would leave the
      // visible panel on the slow probe — the reverse of the design, and invisible to the
      // assertions above.
      reply = { apps: [{ id: "com.example.second", state: "background" }], jobs: [], decision: null };
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(txt(host)).toContain("com.example.second");
    } finally {
      vi.useRealTimers();
    }
  });
});

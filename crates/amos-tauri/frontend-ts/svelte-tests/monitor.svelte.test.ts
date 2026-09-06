/**
 * DOM tests for the Svelte 5 system-monitor panels (SystemPanel / TaskManager)
 * — the round-3 groups added to SettingsApp.svelte. They read the daemon via
 * lib/system + lib/taskmgr. Offline (no bridge) they render nothing (no broken
 * card); with a fake bridge returning live data they render the readouts.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import SystemPanel from "../src/svelte/SystemPanel.svelte";
import TaskManager from "../src/svelte/TaskManager.svelte";

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

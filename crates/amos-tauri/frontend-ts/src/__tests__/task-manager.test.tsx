import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot = {
  apps: [
    { id: "com.amos.photos", state: "foreground" },
    { id: "com.amos.maps", state: "background" },
  ],
  jobs: [{ id: "bg.sync", kind: "deferred", earliest: 0, latest: 200 }],
  background_count: 1,
  decision: {
    mode: "power_save",
    reason: "battery_low",
    cap_inference: true,
    throttle_background: true,
    ticks: 3,
  },
};

const calls: Record<string, unknown[]> = {};
const invoke = async (cmd: string, args?: Record<string, unknown>) => {
  (calls[cmd] ||= []).push(args ?? {});
  return cmd === "taskmgr_snapshot" || cmd === "taskmgr_app_action" ? snapshot : "ok";
};

beforeEach(() => {
  window.localStorage.setItem("amos-ui.locale", "en");
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: () => async () => {},
  };
});

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  for (const k of Object.keys(calls)) delete calls[k];
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const wait = () => new Promise((r) => setTimeout(r, 0));
async function flush() {
  await act(async () => {
    await wait();
    await wait();
  });
}

async function mountPanel() {
  const Panel = (await import("../components/TaskManager")).default;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <Panel />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

describe("TaskManager (fake __TAURI_INTERNALS__, DOM)", () => {
  test("lists apps + jobs and offers per-app actions", async () => {
    const host = await mountPanel();
    await flush();

    const text = host.textContent ?? "";
    expect(text).toContain("Task manager");
    expect(text).toContain("Apps");
    expect(text).toContain("com.amos.photos");
    expect(text).toContain("foreground");
    expect(text).toContain("Scheduled jobs");
    expect(text).toContain("bg.sync");
    expect(text).toContain("deferred");
    expect(text).toContain("Power save"); // decision mode localized via sensor keys
    // A background app is offered freeze + kill actions.
    expect(text).toContain("freeze");
    expect(text).toContain("kill");

    // Clicking a per-app action issues taskmgr_app_action then refreshes.
    const freeze = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "freeze",
    );
    expect(freeze).toBeTruthy();
    await act(async () => {
      freeze!.click();
    });
    await flush();
    const sent = calls["taskmgr_app_action"] as Array<{ appId: string; action: string }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ appId: "com.amos.maps", action: "freeze" });

    // Cancelling a scheduled job issues taskmgr_job_action{jobId,action:"cancel"}.
    const cancel = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "cancel",
    );
    expect(cancel).toBeTruthy();
    await act(async () => {
      cancel!.click();
    });
    await flush();
    const jsent = calls["taskmgr_job_action"] as Array<{ jobId: string; action: string }>;
    expect(jsent).toHaveLength(1);
    expect(jsent[0]).toEqual({ jobId: "bg.sync", action: "cancel" });
  });

  test("renders nothing when the daemon is not bridged (no broken card)", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const host = await mountPanel();
    await flush();
    expect(host.childNodes.length).toBe(0);
  });
});

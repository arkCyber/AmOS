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

const calls: Record<string, unknown[]> = {};
const tasks = [{ package_name: "com.amos.maps", window_id: "waydroid_9", state: "cached" }];
const invoke = async (cmd: string, args?: Record<string, unknown>) => {
  (calls[cmd] ||= []).push(args ?? {});
  if (cmd === "android_lmk_tasks") return tasks;
  if (cmd === "android_lmk_debug") {
    const action = args?.action;
    const pkg = typeof args?.packageName === "string" ? args.packageName : "";
    return action === "trigger"
      ? {
          victims: [{ package_name: "com.amos.maps", window_id: "waydroid_9", killed: true }],
          note: "trigger_lmk returned 1 victim(s)",
        }
      : { victims: [], note: `applied host decision to ${pkg}` };
  }
  return null;
};

beforeEach(() => {
  window.localStorage.setItem("amos-ui.locale", "zh");
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
  const Panel = (await import("../components/LmkDebugPanel")).default;
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

describe("LmkDebugPanel (resident, fake __TAURI_INTERNALS__, DOM)", () => {
  test("renders even with nothing registered and lists container tasks for per-surface actions", async () => {
    const host = await mountPanel();
    await flush();

    // Resident: the panel + trigger are present even when the governor has no apps.
    expect(host.textContent).toContain("LMK 调试");
    expect(host.textContent).toContain("com.amos.maps");
    expect(host.textContent).toContain("waydroid_9");

    const reclaim = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "回收 com.amos.maps",
    );
    expect(reclaim).toBeTruthy();
    await act(async () => {
      reclaim!.click();
    });
    await flush();

    const sent = calls["android_lmk_debug"] as Array<{
      action: string;
      packageName: string;
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ action: "apply_reclaim", packageName: "com.amos.maps" });
    expect(host.textContent).toContain("applied host decision");

    // State-filtered actions: a `cached` task offers 解冻 + 回收 but not 冻结.
    expect(host.textContent).toContain("解冻");
    expect(host.textContent).not.toContain("冻结");
  });

  test("note renders as a toast and can be dismissed manually", async () => {
    const host = await mountPanel();
    await flush();

    const go = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "触发 LMK 回收",
    );
    await act(async () => {
      go!.click();
    });
    await flush();
    expect(host.textContent).toContain("returned 1 victim");

    const dismiss = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "关闭 LMK 提示",
    );
    expect(dismiss).toBeTruthy();
    await act(async () => {
      dismiss!.click();
    });
    await flush();
    expect(host.textContent).not.toContain("returned 1 victim");
  });

  test("offline daemon degrades to a graceful note instead of a broken card", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const host = await mountPanel();
    await flush();
    // Still renders (resident), but reports the daemon is unavailable.
    expect(host.textContent).toContain("LMK 调试");
    expect(host.textContent).toContain("daemon 未连接");
  });

  test("trigger records a recent-victims row, passes budget, and history can be cleared", async () => {
    const host = await mountPanel();
    await flush();

    const go = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "触发 LMK 回收",
    );
    await act(async () => {
      go!.click();
    });
    await flush();

    const sent = calls["android_lmk_debug"] as Array<{ action: string; budget: number }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ action: "trigger", budget: 1 });

    expect(host.textContent).toContain("近期回收 victims");
    expect(host.textContent).toContain("com.amos.maps");
    expect(host.textContent).toContain("killed");

    // Clearing the history hides the victim-echo block again.
    const clear = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "清空 LMK 历史",
    );
    await act(async () => {
      clear!.click();
    });
    await flush();
    expect(host.textContent).not.toContain("近期回收 victims");
  });

  test("refresh reloads the container tasks", async () => {
    const host = await mountPanel();
    await flush();
    const n0 = (calls["android_lmk_tasks"] as unknown[]).length; // 1 from mount

    const btn = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "刷新 LMK 任务",
    );
    await act(async () => {
      btn!.click();
    });
    await flush();

    expect((calls["android_lmk_tasks"] as unknown[]).length).toBe(n0 + 1);
  });

  test("renders English strings under en locale", async () => {
    window.localStorage.setItem("amos-ui.locale", "en");
    const host = await mountPanel();
    await flush();

    const text = host.textContent ?? "";
    expect(text).toContain("LMK debug (dev)");
    expect(text).toContain("Trigger LMK reclaim");
    expect(text).toContain("Container tasks (LMK surfaces)");
    // `cached` task offers thaw + reclaim (not freeze) in English.
    expect(text).toContain("thaw");
    expect(text).toContain("reclaim");
    expect(text).not.toContain("freeze");

    // aria labels follow the locale too: trigger + action names are English here.
    const triggerBtn = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Trigger LMK reclaim",
    );
    expect(triggerBtn).toBeTruthy();
    const reclaimBtn = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label")?.startsWith("reclaim "),
    );
    expect(reclaimBtn).toBeTruthy();
  });

  test("en locale offline state reads 'daemon not connected'", async () => {
    window.localStorage.setItem("amos-ui.locale", "en");
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const host = await mountPanel();
    await flush();
    expect(host.textContent).toContain("LMK debug (dev)");
    expect(host.textContent).toContain("daemon not connected");
  });
});

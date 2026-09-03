import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import type { InterpApp } from "../components/BackendApps";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ---- Fake window.__TAURI_INTERNALS__ so the REAL lib/backend works, installed
 *      only for this file's tests (isolated process via bun-iso-test.mjs). ---- */
type Listener = (ev: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();
const invoke = async (cmd: string) => {
  if (cmd === "get_status") return { model: "unit-interp", active_sessions: 1 };
  if (cmd === "tts_synthesize") return null; // auto-speak: no synth -> nothing played
  return "ok"; // interpret_start/stop/pause/resume/text etc.
};

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: (channel: string, cb: Listener) => {
      listeners.set(channel, cb);
      return () => {
        listeners.delete(channel);
      };
    },
  };
});

function emit(kind: string, payload: unknown) {
  listeners.get(kind)?.({ payload });
}

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  listeners.clear();
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

async function mountInterp() {
  const { InterpApp: App } = (await import("../components/BackendApps")) as {
    InterpApp: typeof InterpApp;
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

describe("InterpApp (fake __TAURI_INTERNALS__, DOM)", () => {
  test("starting a session then a segment_final lands in the transcript", async () => {
    const host = await mountInterp();
    await flush(); // subscription effect mounts

    // Press ▶ 开始 to begin a session (interpret_start resolves via fake bridge).
    const start = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "开始");
    expect(start).toBeTruthy();
    await act(async () => {
      start!.click();
    });
    await flush();

    // Running: the 结束 (stop) control replaces the start button.
    expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.trim() === "结束")).toBe(true);

    // A final translated segment streams in from the daemon.
    await act(async () => {
      emit("interpret-output", {
        kind: "segment_final",
        source_text: "hello there",
        source_lang: "en",
        target_text: "你好",
        target_lang: "zh",
      });
    });
    expect(host.textContent).toContain("hello there");
    expect(host.textContent).toContain("你好");

    // A live partial updates the transient display (not a committed line).
    await act(async () => {
      emit("interpret-output", { kind: "partial", text: "world…" });
    });
    expect(host.textContent).toContain("world…");
  });

  test("ending a running session returns to the not-running (开始) state", async () => {
    const host = await mountInterp();
    await flush();

    const start = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "开始");
    await act(async () => {
      start!.click();
    });
    await flush();
    expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.trim() === "结束")).toBe(true);

    const stop = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "结束");
    await act(async () => {
      stop!.click();
    });
    await flush();
    // interpretStop/interpretPause resolved; session torn down -> start control is back.
    expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.trim() === "开始")).toBe(true);
    expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.trim() === "结束")).toBe(false);
  });

  test("copy-all writes the joined transcript to the clipboard", async () => {
    const host = await mountInterp();
    await flush();

    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void writes.push(t) },
    });

    const start = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "开始");
    await act(async () => {
      start!.click();
    });
    await flush();

    await act(async () => {
      emit("interpret-output", { kind: "segment_final", source_text: "hello", target_text: "你好" });
      emit("interpret-output", { kind: "segment_final", source_text: "bye", target_text: "再见" });
    });

    const copy = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("复制全部"));
    expect(copy).toBeTruthy();
    expect((copy as HTMLButtonElement).disabled).toBe(false); // transcript present
    await act(async () => {
      copy!.click();
    });
    await flush(); // let the async copy continuation settle inside act
    expect(writes).toEqual(["你好\n再见"]);

    // Toggle bilingual ON -> re-copy includes source → target.
    writes.length = 0;
    const bil = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "双语")!;
    await act(async () => {
      bil.click();
    });
    await act(async () => {
      copy!.click();
    });
    await flush();
    expect(writes).toEqual(["hello → 你好\nbye → 再见"]);
  });
});

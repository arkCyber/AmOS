/**
 * DOM tests for the Svelte 5 interpreter screen (InterpApp.svelte) — OFFLINE shell.
 *
 * Pure logic (language catalog, prefs, transcript persistence, payload parsers)
 * is unit-tested once against lib/interp.ts (shared React + Svelte). Here we
 * verify the Svelte UI wiring that runs headlessly — outside Tauri `bridged()` is
 * false, so: remembered prefs restore + persist, a persisted transcript renders +
 * clears, copy-all is disabled when empty, and starting/sending explains the
 * missing daemon instead of a silent no-op. Live mic capture + daemon streaming
 * need a real device + amos-interp daemon → device acceptance.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import InterpApp from "../src/svelte/InterpApp.svelte";
import { INTERP_PREFS_KEY, INTERP_LOG_KEY } from "../src/lib/interp";

// Read-aloud's shared AudioContext must be released on teardown; spy on the
// release so the wiring itself is pinned (the close semantics are unit-tested in
// `src/__tests__/realtimeTts.test.ts`).
const resetPlayCtxSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/realtimeTts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/realtimeTts")>();
  return { ...actual, resetPlayCtx: resetPlayCtxSpy };
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(INTERP_PREFS_KEY);
  window.localStorage.removeItem(INTERP_LOG_KEY);
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const selAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("select")].find(
    (s) => s.getAttribute("aria-label") === aria,
  ) as HTMLSelectElement | undefined;
const btnText = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
const inputByPlaceholder = (h: { container: HTMLElement }, p: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("placeholder") === p) as
    HTMLInputElement | undefined;

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return
 * a restore function. (`window.localStorage` is a per-access proxy, so the prototype
 * cannot be patched — the window property itself is replaced.)
 */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

describe("InterpApp.svelte (offline shell)", () => {
  test("a rejected clear keeps the transcript and reports it", async () => {
    window.localStorage.setItem(
      INTERP_LOG_KEY,
      JSON.stringify([{ src: "你好", target: "hello", srcLang: "zh", targetLang: "en" }]),
    );
    const restore = failWritesFor(INTERP_LOG_KEY);
    try {
      const host = render(InterpApp);
      await settle();
      expect(txt(host)).toContain("你好");

      await fireEvent.click(btnText(host, "清空") as HTMLButtonElement);
      await settle();
      // The stored transcript is still there, so it must not be shown as cleared.
      expect(txt(host)).toContain("本机存储写入失败");
      expect(txt(host)).toContain("你好");
    } finally {
      restore();
    }
  });

  test("remembered prefs restore into the selects + auto-speak checkbox", async () => {
    window.localStorage.setItem(
      INTERP_PREFS_KEY,
      JSON.stringify({ source: "ja", target: "en", autospeak: true }),
    );
    const host = render(InterpApp);
    await settle();
    expect(selAria(host, "目标语言")?.value).toBe("en");
    const source = selAria(host, "源语言");
    expect(source?.value).toBe("ja");
    const autospeak = [...host.container.querySelectorAll("input[type=checkbox]")].find((c) =>
      (c.closest("label")?.textContent ?? "").includes("自动朗读译文"),
    ) as HTMLInputElement | undefined;
    expect(autospeak?.checked).toBe(true);
  });

  test("changing the target language persists to the shared store", async () => {
    const host = render(InterpApp);
    await settle();
    const target = selAria(host, "目标语言");
    expect(target?.value).toBe("zh"); // default target
    await fireEvent.change(target as HTMLSelectElement, { target: { value: "en" } });
    await settle();
    const stored = JSON.parse(window.localStorage.getItem(INTERP_PREFS_KEY) ?? "{}") as {
      target?: string;
    };
    expect(stored.target).toBe("en");
  });

  test("persisted transcript renders; clear empties history + store", async () => {
    window.localStorage.setItem(
      INTERP_LOG_KEY,
      JSON.stringify([
        { src: "hello", target: "你好", srcLang: "en", targetLang: "zh" },
        { src: "bye", target: "再见", srcLang: "en", targetLang: "zh" },
      ]),
    );
    const host = render(InterpApp);
    await settle();
    expect(txt(host)).toContain("你好");
    expect(txt(host)).toContain("再见");
    const copyAll = btnText(host, "复制全部译文");
    expect(copyAll?.disabled).toBe(false);
    await fireEvent.click(btnText(host, "清空") as HTMLButtonElement);
    await settle();
    expect(JSON.parse(window.localStorage.getItem(INTERP_LOG_KEY) ?? "[]")).toEqual([]);
    expect(txt(host)).not.toContain("你好");
  });

  test("copy-all is disabled when the transcript is empty", async () => {
    const host = render(InterpApp);
    await settle();
    expect(btnText(host, "复制全部译文")?.disabled).toBe(true);
  });

  test("starting without the daemon explains instead of a silent no-op", async () => {
    const host = render(InterpApp);
    await settle();
    expect(btnText(host, "开始")).toBeTruthy();
    await fireEvent.click(btnText(host, "开始") as HTMLButtonElement);
    await settle();
    expect(txt(host)).toContain("未连接守护进程"); // backend.offline
  });

  test("sending text offline keeps the text and explains", async () => {
    const host = render(InterpApp);
    await settle();
    const input = inputByPlaceholder(host, "输入文字发送…");
    await fireEvent.input(input as HTMLInputElement, { target: { value: "你好" } });
    await fireEvent.click(btnText(host, "发送") as HTMLButtonElement);
    await settle();
    expect(input?.value).toBe("你好"); // not cleared into a no-op
    expect(txt(host)).toContain("未连接守护进程");
  });
});

describe("InterpApp.svelte — read-aloud teardown", () => {
  test("leaving the interpreter releases the playback audio context", async () => {
    resetPlayCtxSpy.mockClear();
    const host = render(InterpApp);
    await tick();
    expect(resetPlayCtxSpy).not.toHaveBeenCalled(); // nothing to release yet

    host.unmount();
    // Without this the shared AudioContext outlived the screen (the audio session
    // stayed held), because the lib only dropped its reference.
    expect(resetPlayCtxSpy).toHaveBeenCalledTimes(1);
  });
});

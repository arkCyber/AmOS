/**
 * DOM tests for the Svelte 5 voice-memos screen (VoiceMemosApp.svelte) — the
 * browser-testable surface. The list is seeded from demo clips (no mic needed);
 * real recording/playback reuse lib/voiceRecorder + lib/mediaStore (device). Here
 * we verify: seeded rows render, inline rename commits, and deleting all reaches
 * the empty state (persisted through the shared amos.vmemos store).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import VoiceMemosApp from "../src/svelte/VoiceMemosApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";

afterEach(cleanup);

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttonsByAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll(`button[aria-label="${aria}"]`)] as HTMLButtonElement[];

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

describe("VoiceMemosApp.svelte (list surface)", () => {
  test("an intentionally emptied store is not re-seeded with demo memos", () => {
    window.localStorage.setItem("amos.vmemos", "[]");
    const host = render(VoiceMemosApp);
    expect(txt(host)).toContain("暂无语音备忘录");
    expect(readStoreValue<unknown>("amos.vmemos", null)).toEqual([]);
  });

  test("seeds a demo list with play rows and a record control", () => {
    const host = render(VoiceMemosApp);
    expect(buttonsByAria(host, "开始录音").length).toBe(1);
    expect(buttonsByAria(host, "播放").length).toBeGreaterThan(0);
    expect(txt(host)).not.toContain("暂无语音备忘录");
  });

  test("a rejected write is reported and the rename stays in edit mode", async () => {
    const restore = failWritesFor("amos.vmemos");
    try {
      const host = render(VoiceMemosApp);
      await fireEvent.click(buttonsByAria(host, "重命名")[0]!);
      const input = host.container.querySelector(
        'input[aria-label="录音标题"]',
      ) as HTMLInputElement;
      await fireEvent.input(input, { target: { value: "我的会议" } });
      await fireEvent.keyDown(input, { key: "Enter" });
      // Not stored ⇒ not claimed: the banner shows and the row is still being edited
      // (the typed title is not thrown away).
      expect(txt(host)).toContain("本机存储写入失败");
      expect(host.container.querySelector('input[aria-label="录音标题"]')).toBeTruthy();
      expect((host.container.querySelector('input[aria-label="录音标题"]') as HTMLInputElement).value).toBe(
        "我的会议",
      );
    } finally {
      restore();
    }
  });

  test("renaming a memo commits the new title inline", async () => {
    const host = render(VoiceMemosApp);
    const rename = buttonsByAria(host, "重命名")[0];
    await fireEvent.click(rename);
    const input = host.container.querySelector('input[aria-label="录音标题"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await fireEvent.input(input, { target: { value: "我的会议" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(txt(host)).toContain("我的会议");
  });

  test("deleting every memo reaches the empty state", async () => {
    const host = render(VoiceMemosApp);
    // Delete rows until none remain (guarded to avoid an infinite loop).
    let guard = 60;
    while (buttonsByAria(host, "删除").length > 0 && guard-- > 0) {
      await fireEvent.click(buttonsByAria(host, "删除")[0]);
    }
    expect(txt(host)).toContain("暂无语音备忘录");
  });
});

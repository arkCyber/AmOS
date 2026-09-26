/**
 * DOM tests for the Svelte 5 voice-memos screen (VoiceMemosApp.svelte) — the
 * browser-testable surface. The list is seeded from demo clips (no mic needed);
 * real recording/playback reuse lib/voiceRecorder + lib/mediaStore (device). Here
 * we verify: seeded rows render, inline rename commits, and deleting all reaches
 * the empty state (persisted through the shared amos.vmemos store).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import VoiceMemosApp from "../src/svelte/VoiceMemosApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { defaultMediaStore } from "../src/lib/mediaStore";
import { zh } from "../src/i18n/locales/zh";

afterEach(cleanup);

// Recording is the one path this file cannot reach through the DOM (it needs a real
// mic + MediaRecorder), so the two seams are doubled: the capture engine, and the id
// mint — the id is load-bearing here, because it is the MediaStore key the bytes are
// written under, and the test must be able to ask for *that* blob afterwards.
const rec = vi.hoisted(() => ({ start: vi.fn(), id: "rec-fresh" }));
vi.mock("../src/lib/voiceRecorder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/voiceRecorder")>();
  return { ...actual, startVoiceRecording: rec.start };
});
vi.mock("../src/lib/voiceMemos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/voiceMemos")>();
  return { ...actual, makeVoiceId: () => rec.id };
});

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

  // REQ-A1263 / F-SH-541: `deleteMemo` discarded `persist`'s verdict and deleted the memo's
  // bytes unconditionally. A refused index write therefore left a **listed-but-unplayable**
  // memo: the row survives (correctly) into the next boot, but its audio is gone. The sibling
  // `removeVideoCapture` (lib/cameraCapture.ts) already applies the rule this file broke — the
  // bytes are removed only once the index no longer lists the item.
  test("a refused delete must not remove the memo's bytes (REQ-A1263)", async () => {
    const rec = {
      id: "rec1",
      title: "会议记录",
      createdAt: 1,
      durationMs: 3000,
      audio: { kind: "recorded" },
      sizeBytes: 3,
      mime: "audio/ogg",
    };
    window.localStorage.setItem("amos.vmemos", JSON.stringify([rec]));
    await defaultMediaStore().put("rec1", new Blob([new Uint8Array([1, 2, 3])]));

    const restore = failWritesFor("amos.vmemos");
    try {
      const host = render(VoiceMemosApp);
      await fireEvent.click(buttonsByAria(host, "删除")[0]!);
      await new Promise((r) => setTimeout(r, 20));

      // The index still lists the memo (the write was refused)…
      const rows = readStoreValue<Array<{ id: string }>>("amos.vmemos", []);
      expect(rows.map((r) => r.id)).toContain("rec1");
      // …so its bytes must still be there — deleting them orphans the row.
      expect(await defaultMediaStore().get("rec1")).not.toBeNull();
      // …and the refusal is reported rather than the row silently vanishing.
      expect(txt(host)).toContain("本机存储写入失败");
    } finally {
      restore();
    }
  });

  // Companion leaf: the guard above must not have been bought by never deleting anything.
  // On a write that lands, the bytes go with the row.
  test("a successful delete removes the memo's bytes too (REQ-A1263)", async () => {
    const rec = {
      id: "rec9",
      title: "会议记录",
      createdAt: 1,
      durationMs: 3000,
      audio: { kind: "recorded" },
      sizeBytes: 3,
      mime: "audio/ogg",
    };
    window.localStorage.setItem("amos.vmemos", JSON.stringify([rec]));
    await defaultMediaStore().put("rec9", new Blob([new Uint8Array([1, 2, 3])]));

    const host = render(VoiceMemosApp);
    await fireEvent.click(buttonsByAria(host, "删除")[0]!);
    await new Promise((r) => setTimeout(r, 20));

    expect(readStoreValue<Array<{ id: string }>>("amos.vmemos", [])).toHaveLength(0);
    expect(await defaultMediaStore().get("rec9")).toBeNull();
  });

  // REQ-A1264 / F-SH-542 — the other half of the same ordering rule the two cases above
  // pin. `stop()` writes the recording's bytes to the MediaStore and *then* the index row;
  // `persist`'s verdict was discarded, so a refused index write left the bytes behind with
  // no row naming them — an unreachable copy of the user's voice sitting in the store
  // forever. The twins that get this right are all three of `persistVideoCapture` (it
  // deletes the blob it just put when the index refuses), `removeVideoCapture`, and this
  // file's own `saveTrim` — `stop` was the writer the sweep did not reach.
  describe("a refused index write after a recording (REQ-A1264)", () => {
    afterEach(async () => {
      await defaultMediaStore().del(rec.id);
      rec.start.mockReset();
      rec.id = "rec-fresh";
    });

    /** Drive a record → stop round-trip with the capture engine doubled. */
    const recordAndStop = async (host: { container: HTMLElement }) => {
      rec.start.mockResolvedValue({
        stop: async () => ({ blob: new Blob([new Uint8Array([1, 2, 3])]), mime: "audio/webm" }),
      });
      await fireEvent.click(buttonsByAria(host, "开始录音")[0]!);
      await vi.waitFor(() => expect(buttonsByAria(host, "停止").length).toBe(1));
      await fireEvent.click(buttonsByAria(host, "停止")[0]!);
    };

    test("the bytes do not outlive the row that names them", async () => {
      rec.id = "rec-orphan";
      window.localStorage.setItem("amos.vmemos", "[]");
      const restore = failWritesFor("amos.vmemos");
      let host: ReturnType<typeof render>;
      try {
        host = render(VoiceMemosApp);
        await recordAndStop(host);
        // The refusal is reported (persist's own job)…
        await vi.waitFor(() => expect(txt(host)).toContain(zh["common.storeWriteFailed"]!));
      } finally {
        restore();
      }
      // …the index never listed it…
      expect(readStoreValue<unknown[]>("amos.vmemos", [])).toHaveLength(0);
      // …so nothing should be holding the user's voice: no row names this blob, so no
      // screen in the app could ever play it back or delete it again.
      expect(
        await defaultMediaStore().get("rec-orphan"),
        "被拒绝的索引写入不得把录音的字节留在库里",
      ).toBeNull();
    });

    // Companion leaf: the guard must not have been bought by dropping the bytes on every
    // save. On an index write that lands, the bytes stay and the row plays.
    test("a recording whose index write lands keeps its bytes", async () => {
      rec.id = "rec-kept";
      window.localStorage.setItem("amos.vmemos", "[]");
      const host = render(VoiceMemosApp);
      await recordAndStop(host);
      await vi.waitFor(() =>
        expect(readStoreValue<unknown[]>("amos.vmemos", [])).toHaveLength(1),
      );
      expect(await defaultMediaStore().get("rec-kept")).not.toBeNull();
    });
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

/**
 * Export to the shared collection (REQ-A350).
 *
 * The `mediaExport` service — and its own tests — existed while **nothing called it**: a memo lived
 * only in this app's internal store, so Files, the gallery and every other app could not see it,
 * which is exactly what REQ-A313 promised would not happen ("a recording must be a file the user can
 * find"). These cases pin the wiring: the button reaches the same two host commands the service was
 * tested against, and the outcome is rendered **as it came back**.
 */
describe("VoiceMemosApp — export to the shared collection (REQ-A350)", () => {
  /** A fake host recording the media commands (the same pair the service's own tests use). */
  function installMediaHost(reply: "item" | "refused" | "missing") {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "media_save") {
          // A refusal is a **rejected** invoke, not a `null`: the service documents that `null`
          // means "no bridge at all" (offline), and a rejection means the host said no.
          if (reply === "refused") throw new Error("media: not authorized to write recordings");
          if (reply === "missing") return null;
          return { id: "saved-1", name: (args?.name as string) ?? "x.wav" };
        }
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  }
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  /** Poll for text instead of sleeping a fixed time (the repo's own anti-flake discipline). */
  async function waitFor(host: { container: HTMLElement }, needle: string, ms = 500) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (txt(host).includes(needle)) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return txt(host).includes(needle);
  }

  test("the button writes a real file: grant, then media_save with the memo's own bytes", async () => {
    const calls = installMediaHost("item");
    const host = render(VoiceMemosApp);
    await fireEvent.click(buttonsByAria(host, "保存到「录音」目录")[0]);
    expect(await waitFor(host, zh["vm.exportSaved"]!), `the outcome is shown, not assumed — got: ${txt(host)}`).toBe(true);
    expect(calls.map((c) => c.cmd)).toContain("media_grant_write");
    const save = calls.find((c) => c.cmd === "media_save");
    expect(save, "the file was written through the host").toBeTruthy();
    // The payload is the host's own type (a byte array), the name comes from the memo's stamp, and
    // the collection is **recordings** — not the service's default (the camera roll).
    expect(Array.isArray((save?.args as { data?: unknown })?.data)).toBe(true);
    expect((save?.args as { collection?: string })?.collection).toBe("recordings");
    expect(String((save?.args as { name?: string })?.name ?? "")).toMatch(/^Amos-\d{8}-\d{6}\.wav$/);
  });

  test("a refusal is reported as a refusal, never as a save", async () => {
    installMediaHost("refused");
    const host = render(VoiceMemosApp);
    await fireEvent.click(buttonsByAria(host, "保存到「录音」目录")[0]);
    expect(await waitFor(host, zh["vm.exportRefused"]!)).toBe(true);
    expect(txt(host), "…and it never claims otherwise").not.toContain(zh["vm.exportSaved"]!);
  });
});

/**
 * Playback-progress affordance. The detail panel renders a seek slider + duration
 * text once a memo is selected; the slider is present even when no recording is
 * playing (it doubles as the position display).
 */
describe("VoiceMemosApp.svelte — playback progress (REQ-A351)", () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("selecting a memo opens a detail panel with the seek slider", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async () => null,
      listen: async () => () => {},
    };
    const host = render(VoiceMemosApp);
    // Click a memo's title (not the play button) to open the detail panel.
    const titleBtn = [...host.container.querySelectorAll("button")].find(
      (b) =>
        !b.hasAttribute("data-icon") &&
        (b.getAttribute("aria-label") ?? "") !== "开始录音",
    );
    expect(titleBtn, "a memo title button is rendered").toBeTruthy();
    await fireEvent.click(titleBtn as HTMLButtonElement);
    const seek = host.container.querySelector(
      'input[type="range"][aria-label="跳到指定位置"]',
    );
    expect(seek, "the seek slider is part of the detail panel").toBeTruthy();
  });
});

/**
 * Trim affordance. The original recording is **retained**; saving a trim creates a
 * new sibling memo (edit-keep). A seed memo has no bytes to cut, so the trim
 * button is suppressed (the panel only renders it for `audio.kind === "recorded"`).
 */
describe("VoiceMemosApp.svelte — trim (REQ-A352, edit-keep)", () => {
  test("opening trim on a seed memo is suppressed (no bytes to cut)", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async () => null,
      listen: async () => () => {},
    };
    const host = render(VoiceMemosApp);
    const titleBtn = [...host.container.querySelectorAll("button")].find(
      (b) =>
        !b.hasAttribute("data-icon") &&
        (b.getAttribute("aria-label") ?? "") !== "开始录音",
    );
    await fireEvent.click(titleBtn as HTMLButtonElement);
    // The seed memo never exposes the trim button.
    expect(buttonsByAria(host, "编辑").length).toBe(0);
  });
});

/**
 * ASR (speech-to-text) affordance. Pressing the "转写" button calls the backend
 * `transcribeAudio` RPC; the daemon reply (or its absence) is reflected in the
 * detail panel as a transcript, an empty notice, or an explicit error reason.
 */
describe("VoiceMemosApp.svelte — ASR transcript (REQ-A353)", () => {
  function installAsrHost(reply: unknown) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "transcribe_audio") return reply;
        return null;
      },
      listen: async () => () => {},
    };
  }
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("a transcribe button is exposed once a memo is selected", async () => {
    const host = render(VoiceMemosApp);
    const titleBtn = [...host.container.querySelectorAll("button")].find(
      (b) =>
        !b.hasAttribute("data-icon") &&
        (b.getAttribute("aria-label") ?? "") !== "开始录音",
    );
    await fireEvent.click(titleBtn as HTMLButtonElement);
    expect(buttonsByAria(host, "转写").length).toBeGreaterThanOrEqual(1);
  });

  test("a transcribe button is exposed for selected memos and the page chrome does not crash", async () => {
    // A bridge is installed but returns null for every command — the screen
    // still renders the transcribe affordance, exactly what an end user with
    // an offline ASR daemon would see.
    installAsrHost(null);
    const host = render(VoiceMemosApp);
    const titleBtn = [...host.container.querySelectorAll("button")].find(
      (b) =>
        !b.hasAttribute("data-icon") &&
        (b.getAttribute("aria-label") ?? "") !== "开始录音",
    );
    await fireEvent.click(titleBtn as HTMLButtonElement);
    await new Promise((r) => setTimeout(r, 30));
    expect(buttonsByAria(host, "转写").length, "the transcribe affordance is part of the panel")
      .toBeGreaterThanOrEqual(1);
  });

  test("a transcribe button is exposed for selected memos (the panel does not crash)", async () => {
    // Install a bridge that returns null for all commands — the screen still
    // renders the transcribe affordance, exactly what an end user with an offline
    // ASR daemon would see.
    installAsrHost(null);
    const host = render(VoiceMemosApp);
    const titleBtn = [...host.container.querySelectorAll("button")].find(
      (b) =>
        !b.hasAttribute("data-icon") &&
        (b.getAttribute("aria-label") ?? "") !== "开始录音",
    );
    await fireEvent.click(titleBtn as HTMLButtonElement);
    await new Promise((r) => setTimeout(r, 30));
    expect(buttonsByAria(host, "转写").length, "the transcribe affordance is in the panel").toBeGreaterThanOrEqual(1);
    // The panel's idle-state content is just the button — no crash, no error.
    expect(txt(host)).not.toContain("undefined");
  });
});


/**
 * REQ-A1464 / F-SH-717 — one fact, two faces, two sources, and the write's verdict between them.
 *
 * The ASR panel drew its transcript from `asrState`, while the memo row drew `m.transcript` — the
 * thing `amos.vmemos` actually holds. `startTranscribe` called `persist(...)` and dropped the
 * verdict, so a refused attach left the panel claiming a transcript the store never accepted: the
 * row (the same fact's other face) showed no 「已转写」 badge, the panel's 「清除」 acted on
 * something that was not stored, and the text vanished silently on the next selection. This same
 * file already reads that verdict for its delete (`if (!persist(removeMemo(...))) return;`) and its
 * rename (`if (!persist(renameMemo(...))) return;`).
 */
describe("VoiceMemosApp.svelte — a transcript the store refused (REQ-A1464)", () => {
  const REC = {
    id: "rec-asr",
    title: "会议记录",
    createdAt: 1,
    durationMs: 3000,
    audio: { kind: "recorded" },
    sizeBytes: 3,
    mime: "audio/ogg",
  } as const;
  const TXT = "你好世界";
  const UNSAVED = '[data-testid="vm-transcript-unsaved"]';

  function installAsrHost(reply: unknown) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => (cmd === "transcribe_audio" ? reply : null),
      listen: async () => () => {},
    };
  }
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    void defaultMediaStore().del(REC.id);
  });

  async function seed() {
    window.localStorage.setItem("amos.vmemos", JSON.stringify([REC]));
    await defaultMediaStore().put(REC.id, new Blob([new Uint8Array([1, 2, 3])]));
  }
  async function selectAndTranscribe(host: { container: HTMLElement }) {
    await fireEvent.click(
      host.container.querySelector(`button[aria-label="${REC.title}"]`) as HTMLButtonElement,
    );
    await fireEvent.click(buttonsByAria(host, zh["vm.transcribe"]!)[0]!);
    await vi.waitFor(() => expect(txt(host)).toContain(TXT));
  }

  test("a refused attach is not drawn as an attached transcript", async () => {
    await seed();
    installAsrHost({ text: TXT, recognized: true });
    const restore = failWritesFor("amos.vmemos");
    try {
      const host = render(VoiceMemosApp);
      await selectAndTranscribe(host);
      // The transcription happened and is kept on screen — it is not thrown away…
      expect(txt(host)).toContain(TXT);
      // …but it must not be dressed as an *attached* transcript: the store never took it.
      expect(host.container.querySelector(UNSAVED)).toBeTruthy();
      // The row's face agrees with the store — no 「已转写」 badge on a memo with no transcript.
      expect(txt(host)).not.toContain(zh["vm.hasTranscript"]!);
      expect(txt(host)).toContain(zh["common.storeWriteFailed"]!);
      const stored = readStoreValue<Array<{ transcript?: unknown }>>("amos.vmemos", []);
      expect(stored[0]?.transcript).toBeUndefined();
    } finally {
      restore();
    }
  });

  // Companion leaf: the marker must not be bought by tagging every transcript as unsaved.
  test("a landed attach carries no unsaved marker and the row badge appears", async () => {
    await seed();
    installAsrHost({ text: TXT, recognized: true });
    const host = render(VoiceMemosApp);
    await selectAndTranscribe(host);
    expect(host.container.querySelector(UNSAVED)).toBeNull();
    expect(txt(host)).not.toContain(zh["common.storeWriteFailed"]!);
    expect(txt(host)).toContain(zh["vm.hasTranscript"]!);
    const stored = readStoreValue<Array<{ transcript?: { text?: string } }>>("amos.vmemos", []);
    expect(stored[0]?.transcript?.text).toBe(TXT);
  });

  test("a refused clear keeps the transcript on screen (matching the row)", async () => {
    await seed();
    installAsrHost({ text: TXT, recognized: true });
    const host = render(VoiceMemosApp);
    await selectAndTranscribe(host);
    const restore = failWritesFor("amos.vmemos");
    try {
      await fireEvent.click(buttonsByAria(host, zh["vm.clearTranscript"]!)[0]!);
      // Still stored ⇒ the panel must still be in its "done" face. (Not `toContain(TXT)`: the
      // row preview draws `m.transcript.text` too, so the text alone cannot tell the two apart.)
      expect(buttonsByAria(host, zh["vm.transcribe"]!).length).toBe(0);
      expect(buttonsByAria(host, zh["vm.clearTranscript"]!).length).toBeGreaterThan(0);
      expect(txt(host)).toContain(zh["vm.hasTranscript"]!);
      expect(txt(host)).toContain(zh["common.storeWriteFailed"]!);
      const stored = readStoreValue<Array<{ transcript?: unknown }>>("amos.vmemos", []);
      expect(stored[0]?.transcript).toBeDefined();
    } finally {
      restore();
    }
  });

  test("a landed clear removes the transcript from the store and the panel", async () => {
    await seed();
    installAsrHost({ text: TXT, recognized: true });
    const host = render(VoiceMemosApp);
    await selectAndTranscribe(host);
    await fireEvent.click(buttonsByAria(host, zh["vm.clearTranscript"]!)[0]!);
    await vi.waitFor(() => expect(txt(host)).not.toContain(TXT));
    expect(txt(host)).not.toContain(zh["vm.hasTranscript"]!);
    const stored = readStoreValue<Array<{ transcript?: unknown }>>("amos.vmemos", []);
    expect(stored[0]?.transcript).toBeUndefined();
  });
});

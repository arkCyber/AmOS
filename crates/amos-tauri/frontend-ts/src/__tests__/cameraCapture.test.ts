import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { memoryMediaStore } from "../lib/mediaStore";
import {
  startVideoRecording,
  persistVideoCapture,
  removeVideoCapture,
  captureBlob,
  listCaptures,
  mediaId,
  toggleCaptureFav,
  resLabelOf,
  RecordingUnavailableError,
} from "../lib/cameraCapture";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

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

/** Minimal MediaRecorder stand-in (headless recording seam). */
class FakeMediaRecorder {
  static isTypeSupported = () => true;
  mimeType: string;
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: MediaStream, opts: { mimeType?: string } = {}) {
    this.mimeType = opts.mimeType ?? "video/webm";
  }
  start() {
    this.state = "recording";
    this.ondataavailable?.({ data: new Blob(["vid"], { type: this.mimeType }) });
  }
  stop() {
    if (this.state !== "inactive") {
      this.state = "inactive";
      this.onstop?.();
    }
  }
}

afterEach(() => {
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  window.localStorage.removeItem("amos.captures");
});

describe("camera video capture library", () => {
  test("records then round-trips through persist → list → remove", async () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
    const store = memoryMediaStore();

    const rec = await startVideoRecording({} as MediaStream, "c1");
    const { capture, blob } = await rec.stop();
    expect(capture.id).toBe("c1");
    expect(capture.mime).toContain("video/webm");
    expect(blob.size).toBeGreaterThan(0);

    await persistVideoCapture(capture, blob, store);
    const list = listCaptures();
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe("c1");
    const stored = await store.get(mediaId("c1"));
    expect(stored).toBeTruthy();
    expect(await captureBlob("c1", store)).toBeTruthy();

    await removeVideoCapture("c1", store);
    expect(listCaptures().length).toBe(0);
    expect(await store.get(mediaId("c1"))).toBeNull();
  });

  test("a rejected library-index write is reported and leaves no orphaned bytes", async () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
    const store = memoryMediaStore();

    const rec = await startVideoRecording({} as MediaStream, "c2");
    const { capture, blob } = await rec.stop();

    // Storage refuses the metadata write (full/unavailable) — the video would never
    // be listed, so nothing may claim it was saved.
    const restore = failWritesFor("amos.captures");
    try {
      expect(await persistVideoCapture(capture, blob, store)).toBe(false);
    } finally {
      restore();
    }
    expect(listCaptures().length).toBe(0);
    // The bytes were cleaned up again instead of leaking as an invisible blob.
    expect(await store.get(mediaId("c2"))).toBeNull();
  });

  test("a rejected delete keeps the row and its bytes", async () => {
    const store = memoryMediaStore();
    window.localStorage.setItem(
      "amos.captures",
      JSON.stringify([{ id: "d1", ts: 1, mime: "video/webm", durationMs: 1 }]),
    );
    await store.put(mediaId("d1"), new Blob(["v"]));

    const restore = failWritesFor("amos.captures");
    try {
      // The index write was rejected, so the row is still listed — deleting the bytes
      // would have left a listed-but-unplayable video.
      expect(await removeVideoCapture("d1", store)).toBe(false);
    } finally {
      restore();
    }
    expect(listCaptures().length).toBe(1);
    expect(await store.get(mediaId("d1"))).toBeTruthy();

    // With storage healthy the delete completes and only then do the bytes go.
    expect(await removeVideoCapture("d1", store)).toBe(true);
    expect(listCaptures().length).toBe(0);
    expect(await store.get(mediaId("d1"))).toBeNull();
  });

  test("cancel aborts without persisting anything", async () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
    const store = memoryMediaStore();
    const rec = await startVideoRecording({} as MediaStream, "c2");
    rec.cancel();
    expect(listCaptures().length).toBe(0);
    expect(await store.get(mediaId("c2"))).toBeNull();
  });

  test("throws RecordingUnavailableError when MediaRecorder is missing", async () => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    await expect(startVideoRecording({} as MediaStream, "c3")).rejects.toBeInstanceOf(
      RecordingUnavailableError,
    );
  });
});

describe("capture favourite flag", () => {
  test("toggleCaptureFav flips and persists fav, and reports a rejected write", () => {
    window.localStorage.setItem(
      "amos.captures",
      JSON.stringify([{ id: "f1", ts: 1, mime: "video/webm", durationMs: 1000 }]),
    );
    const on = toggleCaptureFav("f1");
    expect(on.ok).toBe(true);
    expect(on.list.length).toBe(1);
    expect(on.list[0]!.fav).toBe(true);
    const persisted = JSON.parse(window.localStorage.getItem("amos.captures") ?? "[]");
    expect(persisted[0].fav).toBe(true);
    const off = toggleCaptureFav("f1");
    expect(off.list[0]!.fav).toBe(false);

    // Rejected write ⇒ `ok: false` and the stored row keeps its old flag (the caller
    // must not draw a heart the library does not have).
    const restore = failWritesFor("amos.captures");
    try {
      const rejected = toggleCaptureFav("f1");
      expect(rejected.ok).toBe(false);
      expect(rejected.list[0]!.fav).toBe(true); // what the caller *asked* for
    } finally {
      restore();
    }
    const after = JSON.parse(window.localStorage.getItem("amos.captures") ?? "[]");
    expect(after[0].fav).toBe(false); // the store still says "not favourite"
  });
});

describe("capture resolution label", () => {
  test("resLabelOf maps pixel height to a tier label", () => {
    expect(resLabelOf({})).toBeNull();
    expect(resLabelOf({ w: 640, h: 480 })).toBe("SD");
    expect(resLabelOf({ h: 720 })).toBe("HD");
    expect(resLabelOf({ h: 1080 })).toBe("FHD");
    expect(resLabelOf({ h: 2160 })).toBe("2160p");
  });
});

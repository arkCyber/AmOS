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
  test("toggleCaptureFav flips and persists fav", () => {
    window.localStorage.setItem(
      "amos.captures",
      JSON.stringify([{ id: "f1", ts: 1, mime: "video/webm", durationMs: 1000 }]),
    );
    const on = toggleCaptureFav("f1");
    expect(on.length).toBe(1);
    expect(on[0]!.fav).toBe(true);
    const persisted = JSON.parse(window.localStorage.getItem("amos.captures") ?? "[]");
    expect(persisted[0].fav).toBe(true);
    const off = toggleCaptureFav("f1");
    expect(off[0]!.fav).toBe(false);
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

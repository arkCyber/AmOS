import { describe, expect, test } from "bun:test";
import { memoryMediaStore } from "../lib/mediaStore";
import { startVoiceRecording } from "../lib/voiceRecorder";
import { buildWavBytes } from "../lib/voiceMemos";

const g = globalThis as unknown as {
  MediaRecorder?: unknown;
  navigator?: { mediaDevices?: { getUserMedia?: (c: { audio: boolean }) => Promise<unknown> } };
};

/** Minimal fake MediaRecorder that "records" by emitting `known` on stop. */
function makeFakeRecorder(known: Blob) {
  return class FakeMediaRecorder {
    static isTypeSupported = () => true;
    mimeType: string;
    state = "inactive";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(_stream: unknown, opts?: { mimeType?: string }) {
      this.mimeType = opts?.mimeType ?? "audio/webm";
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: known });
      this.onstop?.();
    }
  };
}

describe("voice recording E2E — binary round-trip", () => {
  test("fake mic → recorder → MediaStore → byte-identical read-back", async () => {
    const wavBytes = buildWavBytes({ seconds: 0.2, sampleRate: 8000, toneHz: 440 });
    const known = new Blob([wavBytes as unknown as BlobPart], { type: "audio/wav" });

    // Stub the platform: a working MediaRecorder + a mic stream.
    const prevRec = g.MediaRecorder;
    const hadNav = "navigator" in globalThis;
    if (!hadNav) (globalThis as { navigator?: object }).navigator = {};
    const nav = g.navigator!;
    const prevMD = nav.mediaDevices;
    g.MediaRecorder = makeFakeRecorder(known);
    nav.mediaDevices = {
      getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }),
    };

    const bytesOf = async (b: Blob) => Array.from(new Uint8Array(await b.arrayBuffer()));

    try {
      // 1) Record: the seam hands back a binary blob (as the real Opus would).
      const rec = await startVoiceRecording();
      const res = await rec.stop();
      expect(res.blob.size).toBe(known.size);
      expect(await bytesOf(res.blob)).toEqual(Array.from(wavBytes));

      // 2) Persist the binary blob (no base64) and read it back byte-identical.
      const media = memoryMediaStore();
      await media.put("e2e-1", res.blob);
      const back = await media.get("e2e-1");
      expect(back).not.toBeNull();
      expect(back!.size).toBe(known.size);
      expect(await bytesOf(back!)).toEqual(Array.from(wavBytes));

      // 3) "Playback parse": a fresh read yields the same decodable payload.
      const again = await media.get("e2e-1");
      expect(await bytesOf(again!)).toEqual(await bytesOf(known));
    } finally {
      // Restore the environment.
      g.MediaRecorder = prevRec;
      nav.mediaDevices = prevMD;
      if (!hadNav) delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});

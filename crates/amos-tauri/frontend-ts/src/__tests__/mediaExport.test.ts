/**
 * Unit tests for `lib/mediaExport.ts` — the **write** half of the media domain.
 *
 * The pure pieces (name, data-URL decode) are pinned exhaustively; the bridge action is
 * driven through a fake bridge so every outcome is exercised off-device: the point of the
 * module is that a refusal can never be reported as a save.
 */
import { describe, expect, it } from "bun:test";
import {
  blobBytes,
  CAMERA_EXPORT_DIR,
  RECORDING_EXPORT_DIR,
  dataUrlToBytes,
  exportNameFor,
  exportToSharedCollection,
} from "../lib/mediaExport";

function withBridge<T>(
  handler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const w = globalThis as unknown as { window?: unknown };
  const prev = w.window;
  w.window = { __TAURI_INTERNALS__: { invoke: handler } } as unknown;
  return fn().finally(() => {
    if (prev === undefined) delete w.window;
    else w.window = prev;
  });
}

describe("exportNameFor", () => {
  it("names the file from the timestamp, so exports sort and never collide", () => {
    // 2026-09-16T18:05:07 local → deterministic digits, no "NaN", no separators.
    const ts = new Date(2026, 8, 16, 18, 5, 7).getTime();
    expect(exportNameFor(ts, "video/mp4")).toBe("Amos-20260916-180507.mp4");
    expect(exportNameFor(ts, "image/jpeg")).toBe("Amos-20260916-180507.jpg");
  });

  it("takes the extension from the MIME, ignoring parameters and case", () => {
    const ts = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(exportNameFor(ts, "VIDEO/WEBM")).toBe("Amos-20260102-030405.webm");
    expect(exportNameFor(ts, "text/plain;charset=utf-8")).toBe("Amos-20260102-030405.bin");
    expect(exportNameFor(ts, null)).toBe("Amos-20260102-030405.bin");
    expect(exportNameFor(ts, undefined)).toBe("Amos-20260102-030405.bin");
  });

  it("is total: a non-finite timestamp still yields a usable name", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const name = exportNameFor(bad, "image/png");
      expect(name.startsWith("Amos-")).toBe(true);
      expect(name.endsWith(".png")).toBe(true);
      expect(name).not.toContain("NaN");
    }
  });
});

describe("dataUrlToBytes", () => {
  it("decodes a base64 data URL into the exact bytes", () => {
    // "hi" → aGk=
    const bytes = dataUrlToBytes("data:image/jpeg;base64,aGk=");
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes ?? [])).toEqual([104, 105]);
  });

  it("decodes every byte value (binary-safe)", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    let binary = "";
    for (const b of all) binary += String.fromCharCode(b);
    const url = `data:image/png;base64,${btoa(binary)}`;
    expect(Array.from(dataUrlToBytes(url) ?? [])).toEqual(Array.from(all));
  });

  it("refuses anything that is not a base64 data URL instead of guessing", () => {
    for (const bad of ["", "not-a-url", "data:image/jpeg,plain", "https://x/y.png", "data:;base64"]) {
      expect(dataUrlToBytes(bad)).toBeNull();
    }
  });
});

describe("exportToSharedCollection (the write half of the media domain)", () => {
  const CAM = CAMERA_EXPORT_DIR;
  const BYTES = new Uint8Array([1, 2, 3]);

  it("declares the write grant, then saves into DCIM/Camera with base64 bytes", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const outcome = await withBridge(
      (cmd, args) => {
        calls.push({ cmd, args });
        return Promise.resolve(cmd === "media_save" ? { id: "mock-1", name: "x.mp4" } : null);
      },
      () => exportToSharedCollection("video", "Amos-20260916-180507.mp4", BYTES),
    );
    expect(outcome).toBe("saved");
    expect(calls.map((c) => c.cmd)).toEqual(["media_grant_write", "media_save"]);
    expect(calls[0]?.args).toEqual({ collection: CAM });
    expect(calls[1]?.args).toEqual({
      collection: CAM,
      kind: "video",
      name: "Amos-20260916-180507.mp4",
      // The bytes travel **as the host's own type**: `media_save(…, data: Vec<u8>)`
      // (`crates/amos-tauri/src/media.rs`), which Tauri serializes as a number array. REQ-A305's
      // "bytes never travel as a number array" is superseded by that signature — the host takes
      // `Vec<u8>` and there is no base64 parameter, so a `data_b64` string is what the bridge would
      // now reject. Measured, not assumed: this expectation is what the live command asks for.
      data: Array.from(BYTES),
    });
  });

  it("reports a host refusal as refused — never as saved", async () => {
    const outcome = await withBridge(
      (cmd) =>
        cmd === "media_save"
          ? Promise.reject("media: not authorized to write camera")
          : Promise.resolve(null),
      () => exportToSharedCollection("image", "Amos-20260916-180507.jpg", BYTES),
    );
    expect(outcome).toBe("refused");
  });

  it("reports a missing host as offline (a null reply is not a save)", async () => {
    const outcome = await withBridge(() => Promise.resolve(null), () =>
      exportToSharedCollection("image", "Amos-20260916-180507.jpg", BYTES),
    );
    expect(outcome).toBe("offline");
  });

  it("refuses an empty payload locally, without touching the host", async () => {
    let called = 0;
    const outcome = await withBridge(
      () => {
        called += 1;
        return Promise.resolve(null);
      },
      () => exportToSharedCollection("image", "Amos-20260916-180507.jpg", new Uint8Array([])),
    );
    expect(outcome).toBe("invalid");
    expect(called).toBe(0);
  });
});

/* ---- REQ-A313: the voice-memo half of the write path ------------------------ */

describe("audio exports (REQ-A313: a recording must be a file the user can find)", () => {
  const ts = new Date(2026, 8, 16, 18, 5, 7).getTime();

  it("maps the audio MIMEs a recorder can produce to real extensions", () => {
    // `.bin` would be a file the user cannot find, play, or hand to another app.
    expect(exportNameFor(ts, "audio/wav")).toBe("Amos-20260916-180507.wav");
    expect(exportNameFor(ts, "audio/webm")).toBe("Amos-20260916-180507.webm");
    expect(exportNameFor(ts, "audio/mp4")).toBe("Amos-20260916-180507.m4a");
    expect(exportNameFor(ts, "audio/ogg")).toBe("Amos-20260916-180507.ogg");
    expect(exportNameFor(ts, "audio/mpeg")).toBe("Amos-20260916-180507.mp3");
    // codec parameters are stripped, so the extension still matches the container
    expect(exportNameFor(ts, "audio/webm;codecs=opus")).toBe("Amos-20260916-180507.webm");
    expect(exportNameFor(ts, "AUDIO/OGG; codecs=vorbis")).toBe("Amos-20260916-180507.ogg");
    // an unknown audio MIME still gets a name (never "NaN", never no name)
    expect(exportNameFor(ts, "audio/x-something")).toBe("Amos-20260916-180507.bin");
  });

  it("points recordings at Recordings and photos at DCIM/Camera", () => {
    expect(RECORDING_EXPORT_DIR).toBe("recordings");
    expect(CAMERA_EXPORT_DIR).toBe("camera");
  });
});

describe("blobBytes (REQ-A313)", () => {
  it("reads a Blob into bytes 1:1", async () => {
    const bytes = await blobBytes(new Blob([new Uint8Array([1, 2, 3])]));
    expect(Array.from(bytes ?? [])).toEqual([1, 2, 3]);
  });

  it("an empty Blob reads as zero bytes (the caller decides what that means)", async () => {
    const bytes = await blobBytes(new Blob([]));
    expect(bytes?.length).toBe(0);
  });

  it("a failed read is null — never a fabricated empty buffer", async () => {
    // Writing a 0-byte file into the user's storage would claim a recording that is
    // not there, so the failure has to survive as "no bytes".
    const broken = { arrayBuffer: () => Promise.reject(new Error("store gone")) } as unknown as Blob;
    expect(await blobBytes(broken)).toBeNull();
  });
});

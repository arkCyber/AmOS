/**
 * hostFileOpen.test.ts — the host browser's "open this file" decision (REQ-A971 / F-SH-307).
 *
 * The defect this pins is a *polarity* one, and polarity bugs are invisible to a test that
 * only exercises the happy path: before the fix, `hostFsReadText` was the only reader, so a
 * binary file's outcome was an error banner and nothing else. Every assertion below therefore
 * has a control that reaches the other branch:
 *
 *   • a text file MUST NOT touch the bytes reader (or the fallback is really "always bytes");
 *   • a `read_not_utf8` refusal MUST fall back, and MUST NOT surface as an error;
 *   • every *other* refusal MUST surface as an error and MUST NOT reach the bytes reader
 *     (or the fallback is "any failure reads twice and then reports the wrong thing").
 *
 * The mock installs `window.__TAURI_INTERNALS__` the way `hostFs.test.ts` does, so the module
 * runs through the real `hostFs`/`planPreview` wrappers and the real wire shapes — including
 * `mime: mime ?? ""`, the blank sentinel `files.rs` now reads as *absent*.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HOST_FS_CODES, base64ToBytes, bytesToBase64 } from "../hostFs";
import { openHostFile, type HostOpenOutcome } from "../hostFileOpen";

/** The refusal the host sends for a non-text payload, as the host spells it. */
const READ_NOT_UTF8 = "amos.host_fs.read_not_utf8";

type Recorded = { command: string; args: Record<string, unknown> | undefined };

let calls: Recorded[] = [];
let respond: (command: string, args?: Record<string, unknown>) => unknown = () => null;
/** Command → the `{code, message}` envelope `invoke` should reject with. */
let refusing: Map<string, { code: string; message: string }> = new Map();
let originalWindow: unknown;

function installInternals(): void {
  calls = [];
  respond = () => null;
  refusing = new Map();
  const internals = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      const refusal = refusing.get(command);
      if (refusal) throw refusal;
      return respond(command, args);
    },
    listen: async () => () => {},
  };
  (globalThis as { window?: object }).window = {
    ...((globalThis as { window?: object }).window ?? {}),
    __TAURI_INTERNALS__: internals,
  };
}

function restoreWindow(): void {
  if (originalWindow !== undefined) {
    (globalThis as { window?: object }).window = originalWindow as object;
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
}

beforeEach(() => {
  originalWindow = (globalThis as { window?: unknown }).window;
  installInternals();
});
afterEach(restoreWindow);

const TEXT_REPLY = { path: "/root/notes.md", size: 12, body: "hello\nworld\n", truncated: false };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const BYTES_REPLY = { path: "/root/photo.jpg", size: 6, body: bytesToBase64(JPEG), truncated: false };
const IMAGE_PLAN = {
  kind: "image",
  data: "data:image/jpeg;base64,/9j/4AAQ",
  mime: "image/jpeg",
  isText: false,
  sizeLabel: "6 B",
  error: null,
};

/** The commands a run issued, in order. */
const commands = (): string[] => calls.map((c) => c.command);

/** A host that serves `read_text` and `read_bytes` from the given replies. */
function servingHost() {
  respond = (cmd) => {
    if (cmd === "host_fs_read_text") return TEXT_REPLY;
    if (cmd === "host_fs_read_bytes") return BYTES_REPLY;
    if (cmd === "files_preview_bytes") return IMAGE_PLAN;
    return null;
  };
}

describe("openHostFile — the reader the host's verdict selects", () => {
  test("a text file opens as text and never touches the bytes reader", async () => {
    servingHost();
    const out = await openHostFile("notes.md", "/root/notes.md");
    expect(out).toEqual({ kind: "text", path: "/root/notes.md", body: "hello\nworld\n", truncated: false });
    // The control that makes the fallback meaningful: `host_fs_read_bytes` exists and would
    // have answered, so "no bytes read" is a decision rather than a missing capability.
    expect(commands()).toEqual(["host_fs_read_text"]);
  });

  test("read_not_utf8 falls back to bytes and reaches the preview classifier", async () => {
    servingHost();
    refusing.set("host_fs_read_text", { code: READ_NOT_UTF8, message: "host_fs: not valid UTF-8" });
    const out = await openHostFile("photo.jpg", "/root/photo.jpg");
    const seen = calls.find((c) => c.command === "files_preview_bytes");
    expect(out).toEqual({
      kind: "preview",
      plan: {
        kind: "image",
        src: "data:image/jpeg;base64,/9j/4AAQ",
        bytes: 0,
        isText: false,
        error: null,
        sizeLabel: "6 B",
        mime: "image/jpeg",
      },
      sourceTruncated: false,
    });
    expect(commands()).toEqual(["host_fs_read_text", "host_fs_read_bytes", "files_preview_bytes"]);
    // `mime: ""` is what `backend.ts` sends for a caller with no MIME, and `files.rs` now
    // reads it as *absent* so the extension table classifies the file. If this ever becomes
    // `"image/jpeg"` computed here, the TS twin table has taken over the decision.
    expect(seen?.args?.["mime"]).toBe("");
    expect(seen?.args?.["name"]).toBe("photo.jpg");
  });

  test("every other refusal is an error, and does not read the file a second time", async () => {
    // The negative control for the whole module. `file_too_large` and `read_failed` are the
    // two most plausible wrong answers here: both are real failures, and a fallback for
    // "any refusal" would read the bytes and then show a preview of a file the host refused.
    for (const code of ["amos.host_fs.file_too_large", "amos.host_fs.read_failed", "amos.host_fs.path_not_found"]) {
      installInternals();
      servingHost();
      refusing.set("host_fs_read_text", { code, message: code });
      const out: HostOpenOutcome = await openHostFile("photo.jpg", "/root/photo.jpg");
      expect(out, code).toEqual({ kind: "error", code, isOffline: false });
      expect(commands(), code).toEqual(["host_fs_read_text"]);
    }
  });

  test("a host that is not bridged at all stays a typed offline error", async () => {
    delete (globalThis as { window?: unknown }).window;
    const out = await openHostFile("notes.md", "/root/notes.md");
    expect(out.kind).toBe("error");
    if (out.kind === "error") {
      expect(out.code).toBe("amos.host_fs.read_failed");
      expect(out.isOffline).toBe(true);
    }
  });

  test("the fallback read's own refusal is reported as itself", async () => {
    servingHost();
    refusing.set("host_fs_read_text", { code: READ_NOT_UTF8, message: "not UTF-8" });
    refusing.set("host_fs_read_bytes", { code: "amos.host_fs.file_too_large", message: "too large" });
    const out = await openHostFile("photo.jpg", "/root/photo.jpg");
    // Not `read_not_utf8`: the second failure is a different fact and the banner must say so.
    expect(out).toEqual({ kind: "error", code: "amos.host_fs.file_too_large", isOffline: false });
    expect(commands()).toEqual(["host_fs_read_text", "host_fs_read_bytes"]);
  });

  test("a truncated read is carried as data, not folded into the preview notice", async () => {
    servingHost();
    respond = (cmd) => {
      if (cmd === "host_fs_read_bytes") return { ...BYTES_REPLY, truncated: true };
      if (cmd === "files_preview_bytes") return IMAGE_PLAN;
      return TEXT_REPLY;
    };
    refusing.set("host_fs_read_text", { code: READ_NOT_UTF8, message: "not UTF-8" });
    const out = await openHostFile("photo.jpg", "/root/photo.jpg");
    expect(out.kind).toBe("preview");
    if (out.kind === "preview") {
      expect(out.sourceTruncated).toBe(true);
      // The preview command's own notice is a separate field and must not be overwritten.
      expect(out.plan.error).toBeNull();
    }
  });

  test("a non-base64 reply from the host is unreadable, not a refusal", async () => {
    servingHost();
    respond = (cmd) =>
      cmd === "host_fs_read_bytes" ? { ...BYTES_REPLY, body: "!!!not base64!!!" } : TEXT_REPLY;
    refusing.set("host_fs_read_text", { code: READ_NOT_UTF8, message: "not UTF-8" });
    const out = await openHostFile("photo.jpg", "/root/photo.jpg");
    expect(out.kind).toBe("preview");
    if (out.kind === "preview") {
      expect(out.plan.kind, "a wire violation must not be rendered as a file kind").toBe("unavailable");
      expect(out.plan.reason).toBe("unreadable");
    }
    // The classifier is never asked about bytes we could not decode.
    expect(commands()).not.toContain("files_preview_bytes");
    // Sanity: the fake is genuinely not decodable, so the assertion above is not vacuous.
    expect(base64ToBytes("!!!not base64!!!")).toBeNull();
  });
});

describe("exactly one code in the host's vocabulary licenses the bytes reader", () => {
  /**
   * The polarity, measured across the whole vocabulary rather than asserted from the module's
   * side. `expect(licenses).toEqual([READ_NOT_UTF8])` is set equality on purpose: a **floor**
   * ("read_not_utf8 is in there") would leave the opposite defect — a second code quietly
   * gaining the fallback — free to ship, which is the `gate_floor_is_not_a_pin` shape. The
   * module no longer exports its constant, so this sweep is also what keeps the literal it
   * keys on equal to the one the host actually sends: a typo leaves the list empty.
   */
  test("one licenser, out of every code the host can send", async () => {
    const licenses: string[] = [];
    for (const code of HOST_FS_CODES) {
      installInternals();
      servingHost();
      refusing.set("host_fs_read_text", { code, message: code });
      const out: HostOpenOutcome = await openHostFile("photo.jpg", "/root/photo.jpg");
      if (out.kind === "preview") licenses.push(code);
    }
    // Non-vacuity: the sweep must have seen a real vocabulary, not an empty array.
    expect(HOST_FS_CODES.length).toBeGreaterThanOrEqual(10);
    expect(licenses).toEqual([READ_NOT_UTF8]);
  });
});

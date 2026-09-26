/**
 * hostFs.test.ts — unit tests for the hostFs wrapper.
 *
 * The Rust chokepoint (`crates/amos-tauri/src/host_fs.rs`) has its own tests;
 * these tests cover the JS wrapper shape: how `invoke<T>(...)` collapsing
 * errors into `null` is restored into a typed envelope, how the result
 * discriminated union behaves, and how the pure helpers (`bytesToBase64`,
 * `base64ToBytes`) round-trip.
 *
 * The mock installs a fake `window.__TAURI_INTERNALS__` (same wiring the
 * project uses for `backend-bridge.test.ts`), so `hostFs.ts` runs through
 * the same `invoke` path it would take in a live build — there is no module
 * shadowing and no assignment to frozen exports.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  HOST_FS_CODES,
  HOST_FS_EVENT,
  base64ToBytes,
  bytesToBase64,
  hostFsReadDir,
  hostFsReadText,
  hostFsRootStatus,
  hostFsStat,
  hostFsWatchList,
  hostFsWatchSubscribe,
  hostFsWatchUnsubscribe,
  hostFsWriteBytes,
  hostFsWriteText,
  hostFsCreateDir,
  hostFsRename,
  hostFsRemove,
  hostFsCopy,
  hostParent,
  normalizeHostDir,
  normalizeHostEntry,
} from "../hostFs";

type Recorded = { command: string; args: Record<string, unknown> | undefined };

let calls: Recorded[] = [];
let respond: (command: string, args?: Record<string, unknown>) => unknown = () => null;
let rejecting: Set<string> = new Set<string>();
let originalInternals: unknown;

function installInternals(): void {
  calls = [];
  respond = () => null;
  rejecting = new Set<string>();
  const internals = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (rejecting.has(command)) {
        throw {
          code: "amos.host_fs.path_escapes_root",
          message: "host_fs: '../etc' resolves outside the allowed root",
        };
      }
      return respond(command, args);
    },
  };
  (globalThis as { window?: object }).window = {
    ...((globalThis as { window?: object }).window ?? {}),
    __TAURI_INTERNALS__: internals,
  };
}

function restoreInternals(): void {
  // We never want to keep the fake `window` past a test case — happy-dom
  // and vitest provide their own `window` for non-bridge tests.
  if (originalInternals !== undefined) {
    (globalThis as { window?: object }).window = originalInternals as object;
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
}

beforeEach(() => {
  originalInternals = (globalThis as { window?: unknown }).window;
  installInternals();
});
afterEach(restoreInternals);

describe("hostFs command wrappers (wire args are camelCase and match the Rust types)", () => {
  test("read_text passes the Args shape `{ path, cap }`", async () => {
    const captured = await hostFsReadText("notes.md");
    // Bridge returns `null` for both "offline" and "command failed"; the
    // wrapper collapses both into the same `{ok:false, isOffline:true}`
    // shape so callers can branch once. The cause chain lives in
    // `backend.bridgeDiag("host_fs_read_text")` for the per-call lookup.
    expect(captured.ok).toBe(false);
    if (!captured.ok) {
      expect(captured.code).toBe("amos.host_fs.read_failed");
      expect(captured.isOffline).toBe(true);
    }
    expect(calls[0]?.command).toBe("host_fs_read_text");
    expect(calls[0]?.args).toEqual({ args: { path: "notes.md", cap: null } });
  });

  test("write_text nests `path` and `content` under `args` (the Rust param name)", async () => {
    await hostFsWriteText("a.txt", "你好");
    expect(calls[0]?.command).toBe("host_fs_write_text");
    // `host_fs_write_text(args: WriteArgs)` looks the payload up under `args`;
    // top-level `{path, content}` is a missing-key rejection before any write.
    expect(calls[0]?.args).toEqual({ args: { path: "a.txt", content: "你好", cap: null, createOnly: false } });
  });

  test("write_text forwards an explicit `cap` (the write-side default is 8 MiB)", async () => {
    await hostFsWriteText("big.txt", "x", 32 * 1024 * 1024);
    expect(calls[0]?.args).toEqual({ args: { path: "big.txt", content: "x", cap: 32 * 1024 * 1024, createOnly: false } });
  });

  test("write_text flags `createOnly` for a New File (a collision must refuse, not overwrite)", async () => {
    await hostFsWriteText("fresh.txt", "", undefined, true);
    expect(calls[0]?.args).toEqual({ args: { path: "fresh.txt", content: "", cap: null, createOnly: true } });
  });

  test("write_bytes nests `path` and `dataB64` under `args`", async () => {
    const b64 = bytesToBase64(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    await hostFsWriteBytes("x.bin", b64);
    expect(calls[0]?.command).toBe("host_fs_write_bytes");
    expect(calls[0]?.args).toEqual({ args: { path: "x.bin", dataB64: b64, cap: null } });
  });

  test("returns the success value on a happy call", async () => {
    const happy = { path: "/Users/me/Documents/notes.md", size: 12, body: "hello\n", truncated: false };
    respond = () => happy;
    const r = await hostFsReadText("notes.md");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(happy);
  });

  test("a host refusal surfaces as the typed code, not a generic failure", async () => {
    rejecting = new Set(["host_fs_read_text"]);
    // `backend.invoke` catches the rejection; the envelope survives in the
    // per-command ledger, which is what the wrapper reads back. Before that,
    // every failure collapsed to `read_failed` + `isOffline`, so a UI could not
    // tell "escape refused" from "no host filesystem".
    const r = await hostFsReadText("../etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("amos.host_fs.path_escapes_root");
      expect(r.isOffline).toBeUndefined();
      expect(r.message).toContain("outside the allowed root");
    }
  });

  test("read_dir forwards the path", async () => {
    respond = () => [];
    const r = await hostFsReadDir("docs");
    expect(r.ok).toBe(true);
    expect(calls[0]?.command).toBe("host_fs_read_dir");
    expect(calls[0]?.args).toEqual({ args: { path: "docs", cap: null } });
  });

  test("stat forwards the path with no cap", async () => {
    respond = () => ({ path: "/x", exists: true, isDir: false, size: 0, mtimeMs: 0 });
    await hostFsStat("a.txt");
    expect(calls[0]?.command).toBe("host_fs_stat");
    expect(calls[0]?.args).toEqual({ args: { path: "a.txt", cap: null } });
  });

  test("root_status is data, not a Result — null means offline", async () => {
    expect(await hostFsRootStatus()).toBeNull();
    expect(calls[0]?.command).toBe("host_fs_root_status");
    expect(calls[0]?.args).toBeUndefined();
  });

  test("watch_subscribe / unsubscribe / list forward what they promise", async () => {
    let subCalls = 0;
    respond = (cmd) => {
      if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 7 };
      if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
      if (cmd === "host_fs_watch_list") return [3, 7];
      return null;
    };
    const sub = await hostFsWatchSubscribe("docs");
    if (sub.ok) expect(sub.value.subscriptionId).toBe(7);
    const unsub = await hostFsWatchUnsubscribe(7);
    if (unsub.ok) expect(unsub.value.removed).toBe(true);
    const list = await hostFsWatchList();
    expect(list).toEqual([3, 7]);
    subCalls++;
    expect(subCalls).toBe(1);
  });

  test("create_dir nests `{ path, recursive }` under `args` (defaults false)", async () => {
    await hostFsCreateDir("docs/new");
    expect(calls[0]?.command).toBe("host_fs_create_dir");
    // `recursive: false` is the safe default: a missing parent is a refusal, not
    // a silent tree the caller never asked for.
    expect(calls[0]?.args).toEqual({ args: { path: "docs/new", recursive: false } });
    await hostFsCreateDir("a/b/c", true);
    expect(calls[1]?.args).toEqual({ args: { path: "a/b/c", recursive: true } });
  });

  test("rename nests `{ from, to, overwrite }` under `args`", async () => {
    await hostFsRename("old.txt", "new.txt");
    expect(calls[0]?.command).toBe("host_fs_rename");
    expect(calls[0]?.args).toEqual({ args: { from: "old.txt", to: "new.txt", overwrite: false } });
    await hostFsRename("a", "b", true);
    expect(calls[1]?.args).toEqual({ args: { from: "a", to: "b", overwrite: true } });
  });

  test("remove returns the bridge's `{ path, removed, kind }` result", async () => {
    respond = () => ({ path: "tmp/x", removed: true, kind: "file" });
    const r = await hostFsRemove("tmp/x");
    expect(calls[0]?.command).toBe("host_fs_remove");
    expect(calls[0]?.args).toEqual({ args: { path: "tmp/x", recursive: false } });
    if (r.ok) expect(r.value).toEqual({ path: "tmp/x", removed: true, kind: "file" });
  });

  test("copy nests `{ from, to, overwrite }` under `args`", async () => {
    await hostFsCopy("a.txt", "a copy.txt");
    expect(calls[0]?.command).toBe("host_fs_copy");
    expect(calls[0]?.args).toEqual({ args: { from: "a.txt", to: "a copy.txt", overwrite: false } });
    await hostFsCopy("a", "b", true);
    expect(calls[1]?.args).toEqual({ args: { from: "a", to: "b", overwrite: true } });
  });

  test("a mutation refusal surfaces as its typed code, not as offline", async () => {
    rejecting = new Set(["host_fs_rename"]);
    const r = await hostFsRename("a.txt", "b.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("amos.host_fs.path_escapes_root");
      // `isOffline` is only set on the offline branch; a typed refusal leaves it
      // unset, so `FilesApp`'s `r.isOffline === true` test correctly reads false.
      expect(r.isOffline).not.toBe(true);
    }
  });
});

describe("onHostFsEvent shape", () => {
  test("the exported event name matches the Rust `WATCH_EVENT` constant", () => {
    expect(HOST_FS_EVENT).toBe("host-fs-event");
  });
});

describe("host_fs error-code vocabulary (frozen, and mirrors the Rust enum)", () => {
  // The codes `crates/amos-tauri/src/error.rs` maps to their `ErrorCode`
  // variants. They are a **wire contract**: the UI picks its sentence by code
  // (`FilesApp`'s `HOST_ERR_KEYS`) and `extractEnvelope` only accepts a code it
  // recognises, so a code the frontend drops turns a specific refusal into the
  // generic `read_failed`.
  const FROZEN: readonly string[] = [
    "amos.host_fs.root_not_configured",
    "amos.host_fs.root_not_found",
    "amos.host_fs.root_not_a_dir",
    "amos.host_fs.path_not_found",
    "amos.host_fs.path_is_a_dir",
    "amos.host_fs.path_is_not_a_dir",
    "amos.host_fs.path_escapes_root",
    "amos.host_fs.file_too_large",
    "amos.host_fs.read_failed",
    "amos.host_fs.write_failed",
    "amos.host_fs.read_not_utf8",
    "amos.host_fs.write_atomics_failed",
    "amos.host_fs.target_exists",
    "amos.host_fs.dir_not_empty",
    "amos.host_fs.recursion_limit",
    "amos.host_fs.create_dir_failed",
    "amos.host_fs.remove_failed",
    "amos.host_fs.rename_failed",
    "amos.host_fs.copy_failed",
  ];

  test("the one declaration is frozen (add/rename/remove == wire break)", () => {
    expect([...HOST_FS_CODES] as string[]).toEqual([...FROZEN]);
  });

  test("…and mirrors the Rust `ErrorCode` enum exactly, both directions", () => {
    // Read the host's own declaration, so a rename on either side fails here
    // instead of quietly downgrading every refusal it names.
    const errorRs = readFileSync(new URL("../../../../src/error.rs", import.meta.url), "utf8");
    // `[a-z0-9_]` — `read_not_utf8` ends in a digit; `[a-z_]+` would miss it.
    const rust = [
      ...new Set([...errorRs.matchAll(/"amos\.host_fs\.[a-z0-9_]+"/g)].map((m) => m[0].slice(1, -1))),
    ].sort();
    // A vacuous pass is the failure mode of a source-reading test: assert the
    // regex actually found the host's codes before comparing the two sets.
    expect(rust.length).toBe(FROZEN.length);
    expect(rust).toEqual([...HOST_FS_CODES].sort());
  });
});

describe("fence-relative navigation helpers (pure)", () => {
  test("hostParent walks up, and reports the root instead of `..`", () => {
    expect(hostParent("a/b/c.txt")).toBe("a/b");
    expect(hostParent("a")).toBeNull(); // at the fence root
    expect(hostParent("a/")).toBeNull();
    expect(hostParent("/a/b")).toBe("/a"); // absolute-inside-root form
    expect(hostParent("/a")).toBeNull(); // …whose own parent is the fence root
    // Never emits a `..` segment — `host_fs::resolve` refuses those outright.
    expect(hostParent("a/b")).not.toContain("..");
  });

  test("normalizeHostEntry drops a malformed entry rather than inventing one", () => {
    expect(normalizeHostEntry(null)).toBeNull();
    expect(normalizeHostEntry({ name: "x" })).toBeNull(); // no path
    expect(normalizeHostEntry({ path: "a", name: "x" })).toEqual({
      path: "a",
      name: "x",
      isDir: false,
      size: 0,
      mtimeMs: 0,
    });
    // camelCase wire: `isDir`/`mtimeMs`, never `is_dir`/`mtime_ms`.
    expect(normalizeHostEntry({ path: "a", name: "x", isDir: true, mtimeMs: 5 })?.isDir).toBe(true);
  });

  test("normalizeHostDir filters a non-array to empty, keeping the parseable rows", () => {
    expect(normalizeHostDir(null)).toEqual([]);
    const rows = normalizeHostDir([
      { path: "a", name: "a", isDir: false, size: 1, mtimeMs: 2 },
      "junk",
      { path: "b", name: "b", isDir: true, size: 0, mtimeMs: 0 },
    ]);
    expect(rows.map((r) => r.name)).toEqual(["a", "b"]);
  });
});

describe("base64 helpers (pure, byte-level)", () => {
  test("round-trips a binary payload through standard base64", () => {
    const raw = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const b64 = bytesToBase64(raw);
    // 9 bytes / 3 = 3 groups → 12-char string. The exact alphabet is the
    // standard table; pinning both halves of the round trip so a future
    // off-by-one in the chunking helper is caught.
    expect(b64).toBe("AAEC+vv8/f7/");
    const back = base64ToBytes(b64);
    expect(back).not.toBeNull();
    if (back) expect(Array.from(back)).toEqual(Array.from(raw));
  });

  test("a 1-byte leftover is padded with ==", () => {
    const b64 = bytesToBase64(new Uint8Array([0x41]));
    expect(b64.endsWith("==")).toBe(true);
    expect(b64.length % 4).toBe(0);
  });

  test("a 2-byte leftover is padded with one =", () => {
    const b64 = bytesToBase64(new Uint8Array([0x41, 0x42]));
    expect(b64.endsWith("=")).toBe(true);
    expect(b64.endsWith("==")).toBe(false);
    expect(b64.length % 4).toBe(0);
  });

  test("malformed base64 decodes to null", () => {
    expect(base64ToBytes("!!!not base64!!!")).toBeNull();
    // Strict-base64 should reject incomplete groups. happy-dom / Bun's `atob`
    // may be lenient; the wrapper's stricter check catches the rest.
    // (We just assert the obviously-misformed string is rejected.)
  });

  test("round-trips UTF-8 中文", () => {
    // The helper itself is byte-level; we encode/decode through TextEncoder
    // so the assertion proves the helper is text-safe, not unicode-hostile.
    // The bridge's `content` arg does the encoding in user code — this
    // helper just ships bytes either direction.
    const text = "你好，世界";
    const bytes = new TextEncoder().encode(text);
    const b64 = bytesToBase64(bytes);
    const back = base64ToBytes(b64);
    expect(back).not.toBeNull();
    if (back) {
      const round = new TextDecoder().decode(back);
      expect(round).toBe(text);
    }
  });
});

// REQ-A813：把「声明的线缆镜像」绑定到 host_fs.rs 本身，而不是同文件里手打的本地说法。
describe("hostFs.ts wire mirrors == host_fs.rs (result structs + request args + camelCase)", () => {
  // WHY: `lib/hostFs.ts` says its wire types "mirror host_fs.rs serde `rename_all =
  // "camelCase"`". Both sides are plain serde structs whose *field names* are the wire
  // contract, and neither compiler can see the other across the Tauri IPC boundary: rename
  // a Rust field (or drop its `rename_all`), and the TS side silently reads `undefined` —
  // a directory row renders blank, a stat reports "missing", a write's `size`/`mtimeMs`
  // vanish — while every existing test that compares against a **local literal** stays
  // green (its camelCase keys match the interface only because a human typed both). The
  // error-code half is already pinned to `error.rs` above; this pins the *shape* half to
  // `host_fs.rs`, in both directions of drift: a renamed Rust field, and a dropped
  // `rename_all` (which would put snake_case on the wire under a camelCase reader).
  const rs = readFileSync(new URL("../../../../src/host_fs.rs", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../hostFs.ts", import.meta.url), "utf8");
  const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

  /** The `pub` field names of a Rust struct, in source order, and its camelCase attribute. */
  function rustFields(name: string): string[] {
    const at = rs.indexOf(`pub struct ${name} {`);
    expect(at, `pub struct ${name} not found in host_fs.rs`).toBeGreaterThan(0);
    // Attributes sit between the previous item's `}` and this struct; the block contains no
    // `}` of its own, so this slice is exactly this struct's derives + serde attrs.
    const attrs = rs.slice(rs.lastIndexOf("\n}", at) + 1, at);
    expect(attrs, `${name} must be #[serde(rename_all = "camelCase")]`).toContain(
      'rename_all = "camelCase"',
    );
    const body = rs.slice(at, rs.indexOf("\n}", at));
    return [...body.matchAll(/^\s+pub (\w+):/gm)].map((m) => m[1] ?? "");
  }
  /** The field names of a TS interface, in source order. */
  function tsFields(name: string): string[] {
    const at = lib.indexOf(`interface ${name} {`);
    expect(at, `interface ${name} not found in hostFs.ts`).toBeGreaterThan(0);
    const body = lib.slice(at, lib.indexOf("\n}", at));
    return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1] ?? "");
  }
  /** The keys of the `{ args: { … } }` literal a wrapper sends for `command`. */
  function argKeys(command: string): string[] {
    const marker = `"${command}", { args: {`;
    const at = lib.indexOf(marker);
    expect(at, `wrapper args for ${command} not found`).toBeGreaterThan(0);
    const from = at + marker.length;
    const body = lib.slice(from, lib.indexOf("}", from));
    return body
      .split(",")
      .map((p) => p.trim().split(":")[0]!.trim())
      .filter(Boolean);
  }

  test("every result interface's fields == its Rust struct (camelCased), in order", () => {
    const pairs: ReadonlyArray<[string, string]> = [
      ["FsDirEntry", "FsDirEntry"],
      ["FsReadTextResult", "FsRead"],
      ["FsReadBytesResult", "FsRead"], // read_text and read_bytes share one Rust FsRead
      ["FsWriteResult", "FsWrite"],
      ["FsStatResult", "FsStat"],
      ["FsRemovedResult", "FsRemoved"],
      ["FsRootStatus", "FsRootStatus"],
      ["FsSubscribeResult", "FsSubscribe"],
      ["FsUnsubscribeResult", "FsUnsubscribe"],
      ["FsWatchEvent", "FsWatchEvent"],
    ];
    for (const [tsName, rustName] of pairs) {
      const rust = rustFields(rustName);
      // Guard against a vacuous pass: the parse must have found fields.
      expect(rust.length, `${rustName} parsed no fields`).toBeGreaterThan(0);
      expect(tsFields(tsName), `${tsName} vs ${rustName}`).toEqual(rust.map(camel));
    }
  });

  test("every request `args` shape's keys == its Rust Args struct (camelCased)", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["host_fs_read_dir", "Args"],
      ["host_fs_read_text", "Args"],
      ["host_fs_read_bytes", "Args"],
      ["host_fs_stat", "Args"],
      ["host_fs_watch_subscribe", "Args"],
      ["host_fs_write_text", "WriteArgs"],
      ["host_fs_write_bytes", "WriteBytesArgs"],
      ["host_fs_create_dir", "CreateDirArgs"],
      ["host_fs_rename", "RenameArgs"],
      ["host_fs_remove", "RemoveArgs"],
      ["host_fs_copy", "CopyArgs"],
    ];
    for (const [command, rustName] of cases) {
      const rust = rustFields(rustName).map(camel);
      expect(rust.length, `${rustName} parsed no fields`).toBeGreaterThan(0);
      // The wrapper literal key order may differ from the struct's; compare as sets.
      expect(argKeys(command).sort(), `${command} args vs ${rustName}`).toEqual([...rust].sort());
    }
  });

  test("the unsubscribe scalar param and the event channel name are the Rust spellings", () => {
    // `host_fs_watch_unsubscribe` takes `subscription_id: u32` as a *top-level* param (not
    // nested under `args`); Tauri camelCases the param name, so the wrapper must send
    // `subscriptionId`. Reading the Rust signature keeps this from being a guess.
    const at = rs.indexOf("pub fn host_fs_watch_unsubscribe(");
    expect(at).toBeGreaterThan(0);
    const sig = rs.slice(at, rs.indexOf(")", at));
    expect(sig).toContain("subscription_id");
    expect(lib).toContain("invoke<FsUnsubscribeResult>(\"host_fs_watch_unsubscribe\", { subscriptionId })");
    // Event channel: TS `HOST_FS_EVENT` must equal Rust `WATCH_EVENT`'s literal.
    const ev = rs.match(/pub const WATCH_EVENT: &str = "([^"]+)"/);
    expect(ev?.[1], "WATCH_EVENT literal").toBeTruthy();
    expect(lib).toContain(`export const HOST_FS_EVENT = "${ev![1]}"`);
  });
});

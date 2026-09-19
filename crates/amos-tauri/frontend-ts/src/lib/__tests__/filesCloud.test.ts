/**
 * Tests for filesCloud.ts — local snapshot of device files.
 *
 * The actual save/load/delete goes through `amosStore` (which mirrors writes
 * to the Rust `SharedStore`). The Rust `files_cloud_validate` command validates
 * the structure on the host side before persisting; these tests pin the
 * snapshot builder + formatter + delete behaviour.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  buildSnapshot,
  deleteSnapshot,
  formatSnapshotSize,
  loadSnapshot,
  saveSnapshot,
  toCloudFile,
  type CloudSnapshot,
} from "../filesCloud";
// The **real** shape: the local copy this file used to declare typed `kind`/`collection` as
// plain `string`, so every call into `filesCloud` was unchecked (and `typecheck` failed).
import type { ExternalFile } from "../externalFiles";

// ── Memory localStorage + minimal Tauri bridge ──────────────────────────────────
// Bun test runtime doesn't have `window.localStorage` or the Tauri bridge.
// We stub both so `amosStore` reads/writes succeed and `invoke` echoes its
// argument back (for `files_cloud_validate`).

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
}

const memory = new Map<string, string>();
let tauriInvoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> = async () => null;

const stubWindow = {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => { memory.set(key, String(value)); },
    removeItem: (key: string) => { memory.delete(key); },
    clear: () => memory.clear(),
    key: (i: number) => [...memory.keys()][i] ?? null,
    get length() { return memory.size; },
  },
  dispatchEvent: () => true,
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args?: Record<string, unknown>) => tauriInvoke(cmd, args),
    listen: async () => () => {},
  } as TauriInternals,
} as unknown as Window;

const globals = globalThis as Record<string, unknown>;
const previousWindow = globals.window;
globals.window = stubWindow;

beforeEach(() => {
  memory.clear();
  tauriInvoke = async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "files_cloud_validate") return args?.snapshot;
    return null;
  };
});

function extFile(partial: Partial<ExternalFile> & { name: string; uri: string; ts: number }): ExternalFile {
  return {
    id: partial.uri,
    kind: "file",
    collection: "download",
    mime: null,
    sizeBytes: null,
    ...partial,
  };
}

describe("toCloudFile", () => {
  it("promotes an ExternalFile to the minimal cloud shape", () => {
    const cf = toCloudFile(extFile({ name: "report.pdf", uri: "u", ts: 1, sizeBytes: 1024, collection: "download" }));
    expect(cf.id).toBe("u");
    expect(cf.name).toBe("report.pdf");
    expect(cf.collection).toBe("download");
    expect(cf.sizeBytes).toBe(1024);
  });
});

describe("buildSnapshot", () => {
  it("aggregates counts, sizes, and collections", () => {
    const files = [
      extFile({ name: "a", uri: "u-a", ts: 1, sizeBytes: 100, collection: "download" }),
      extFile({ name: "b", uri: "u-b", ts: 2, sizeBytes: 200, collection: "download" }),
      extFile({ name: "c", uri: "u-c", ts: 3, sizeBytes: 300, collection: "pictures" }),
    ];
    const snap = buildSnapshot("device-files", files);
    expect(snap.fileCount).toBe(3);
    expect(snap.totalBytes).toBe(600);
    expect(snap.collections).toEqual(["download", "pictures"]);
    expect(snap.files).toHaveLength(3);
    expect(snap.label).toBe("device-files");
    expect(snap.savedAt).toBeGreaterThan(0);
  });

  it("handles an empty file list", () => {
    const snap = buildSnapshot("empty", []);
    expect(snap.fileCount).toBe(0);
    expect(snap.totalBytes).toBe(0);
    expect(snap.collections).toEqual([]);
    expect(snap.files).toEqual([]);
  });

  it("treats unknown sizes as zero in the total", () => {
    const files = [extFile({ name: "a", uri: "u-a", ts: 0 })];
    const snap = buildSnapshot("t", files);
    expect(snap.totalBytes).toBe(0);
  });
});

describe("saveSnapshot / loadSnapshot / deleteSnapshot", () => {
  it("saves then loads the same snapshot", async () => {
    const snap: CloudSnapshot = {
      label: "test",
      savedAt: 1700000000,
      collections: ["download"],
      totalBytes: 1024,
      fileCount: 1,
      files: [{ id: "u-a", name: "a", kind: "file", collection: "download", sizeBytes: 1024, ts: 0 }],
    };
    const ok = await saveSnapshot(snap);
    expect(ok).toBe(true);
    const loaded = loadSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded?.label).toBe("test");
    expect(loaded?.fileCount).toBe(1);
  });

  it("returns null when no snapshot has been saved", () => {
    expect(loadSnapshot()).toBeNull();
  });

  it("deleteSnapshot clears the saved snapshot", async () => {
    const snap: CloudSnapshot = {
      label: "tmp",
      savedAt: 1,
      collections: [],
      totalBytes: 0,
      fileCount: 0,
      files: [],
    };
    await saveSnapshot(snap);
    expect(loadSnapshot()).not.toBeNull();
    deleteSnapshot();
    expect(loadSnapshot()).toBeNull();
  });
});

// Bun runs every pure test file in **one** process, so the stub below must not outlive this
// file: `previousWindow` existed only to be assigned and never used (REQ-A412).
afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
});

describe("formatSnapshotSize", () => {
  it("formats human-readable sizes", () => {
    expect(formatSnapshotSize(0)).toBe("0 B");
    expect(formatSnapshotSize(512)).toBe("512 B");
    expect(formatSnapshotSize(1024)).toBe("1 KB");
    expect(formatSnapshotSize(1536)).toBe("1.5 KB");
    expect(formatSnapshotSize(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatSnapshotSize(-1)).toBe("—");
  });
});

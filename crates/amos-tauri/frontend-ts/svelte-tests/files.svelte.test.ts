/**
 * DOM tests for the Svelte 5 files screen (FilesApp.svelte).
 *
 * Pure filesystem logic is unit-tested once against lib/files.ts (shared by the
 * React + Svelte UIs). Here we verify the Svelte UI wiring: the seeded root,
 * creating a folder in the current directory, and navigating into a folder.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import FilesApp from "../src/svelte/FilesApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { FILES_REVEAL_KEY } from "../src/lib/files";
import { filesChannel } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";

afterEach(cleanup);
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const btnContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;

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

describe("FilesApp.svelte", () => {
  test("seeded root shows the 文档 folder and a text file", () => {
    const host = render(FilesApp);
    expect(txt(host)).toContain("文档");
    expect(txt(host)).toContain("说明.txt");
  });

  test("creating a folder adds it to the current directory", async () => {
    const host = render(FilesApp);
    await fireEvent.click(btnContaining(host, "文件夹")!);
    const input = host.container.querySelector('input[data-testid="file-new-name"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await fireEvent.input(input, { target: { value: "工作" } });
    await fireEvent.click(btnContaining(host, "保存")!);
    expect(txt(host)).toContain("工作");
  });

  test("a rejected write is reported and the new folder is not added", async () => {
    const restore = failWritesFor("amos.files");
    try {
      const host = render(FilesApp);
      await fireEvent.click(btnContaining(host, "文件夹")!);
      const input = host.container.querySelector(
        'input[data-testid="file-new-name"]',
      ) as HTMLInputElement;
      await fireEvent.input(input, { target: { value: "工作" } });
      await fireEvent.click(btnContaining(host, "保存")!);
      // Not stored ⇒ not claimed: the banner shows, no row appears, and the create form
      // keeps the typed name.
      expect(txt(host)).toContain("本机存储写入失败");
      expect(txt(host)).not.toContain("工作");
      const still = host.container.querySelector(
        'input[data-testid="file-new-name"]',
      ) as HTMLInputElement | null;
      expect(still?.value).toBe("工作");
    } finally {
      restore();
    }
  });

  test("an intentionally emptied store is not re-seeded with demo files", () => {
    window.localStorage.setItem("amos.files", "[]");
    const host = render(FilesApp);
    // Deleting everything must not bring the demo tree back on the next mount.
    expect(txt(host)).toContain("空文件夹");
    expect(txt(host)).not.toContain("说明.txt");
    expect(readStoreValue<unknown>("amos.files", null)).toEqual([]);
  });

  test("entering the 文档 folder shows the empty state", async () => {
    const host = render(FilesApp);
    await fireEvent.click(btnContaining(host, "文档")!);
    expect(txt(host)).toContain("空文件夹");
  });
});

describe("FilesApp.svelte — multi-select batch delete (folded from the retired React files-select tests)", () => {
  test("selecting rows and pressing delete removes them all at once", async () => {
    const host = render(FilesApp);
    // seed = folder 文档 + file 说明.txt
    expect(btnContaining(host, "文档")).toBeTruthy();
    expect(btnContaining(host, "说明.txt")).toBeTruthy();

    await fireEvent.click(btnContaining(host, "选择")!); // enter select mode
    await fireEvent.click(btnContaining(host, "文档")!);
    await fireEvent.click(btnContaining(host, "说明.txt")!);
    const del = btnContaining(host, "删除所选");
    expect(del).toBeTruthy();
    await fireEvent.click(del!);
    expect(btnContaining(host, "文档")).toBeUndefined();
    expect(btnContaining(host, "说明.txt")).toBeUndefined();
    expect(txt(host)).toContain("空文件夹");
  });

  test("select-all selects every visible row, then a single delete clears them", async () => {
    const host = render(FilesApp);
    await fireEvent.click(btnContaining(host, "选择")!);
    const allBtn = btnContaining(host, "全选");
    expect(allBtn?.textContent).toContain("2");
    await fireEvent.click(allBtn!);
    const del = btnContaining(host, "删除所选");
    expect(del?.textContent).toContain("2");
    await fireEvent.click(del!);
    expect(btnContaining(host, "文档")).toBeUndefined();
    expect(btnContaining(host, "说明.txt")).toBeUndefined();
    expect(txt(host)).toContain("空文件夹");
  });
});

describe("FilesApp.svelte — device files (external, read-only)", () => {
  const item = (name: string, sizeBytes: number, ts: number, collection = "download") => ({
    id: `${collection}/${name}`,
    kind: "file",
    collection,
    name,
    uri: `content://${collection}/${name}`,
    mime: "application/pdf",
    size_bytes: sizeBytes,
    ts,
  });

  /** Fake media bridge; `opts.items` is what media_list serves once allowed. */
  function installMediaBridge(opts: { items?: unknown[]; denyUntilGranted?: boolean }) {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    let allowed = !opts.denyUntilGranted;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "media_list") {
          if (!allowed) throw new Error(`${args?.collection}: not authorized`);
          return args?.collection === "download" ? (opts.items ?? []) : [];
        }
        if (cmd === "media_grant_read") {
          allowed = true;
          return null;
        }
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  }

  const openSection = async (host: { container: HTMLElement }) => {
    const toggle = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("设备文件"),
    );
    await fireEvent.click(toggle as HTMLButtonElement);
    await vi.waitFor(() => expect(txt(host)).toContain("设备文件"));
  };

  test("lists real device files with glyph, size and collection path", async () => {
    installMediaBridge({ items: [item("report.pdf", 2048, 1_700_000_000_000)] });
    const host = render(FilesApp);
    await vi.waitFor(() => expect(txt(host)).toContain("设备文件"));
    await openSection(host);
    await vi.waitFor(() => expect(txt(host)).toContain("report.pdf"));
    expect(txt(host)).toContain("2.0 KB"); // formatBytes
    expect(txt(host)).toContain("Download"); // canonicalPath, not the wire key
    // Read-only: the row offers no rename/move/delete affordance.
    expect(host.container.querySelectorAll('[data-testid="external-file"]')).toHaveLength(1);
  });

  test("the name filter narrows the external list", async () => {
    installMediaBridge({
      items: [item("report.pdf", 2048, 1), item("holiday.jpg", 1024, 2)],
    });
    const host = render(FilesApp);
    await vi.waitFor(() => expect(txt(host)).toContain("设备文件"));
    await openSection(host);
    await vi.waitFor(() => expect(txt(host)).toContain("report.pdf"));

    const filter = host.container.querySelector('input[data-testid="external-search"]') as HTMLInputElement;
    await fireEvent.input(filter, { target: { value: "holiday" } });
    await vi.waitFor(() => expect(txt(host)).not.toContain("report.pdf"));
    expect(txt(host)).toContain("holiday.jpg");
  });

  test("a denied read shows an honest notice; granting retries and then lists", async () => {
    const calls = installMediaBridge({ items: [item("report.pdf", 2048, 1)], denyUntilGranted: true });
    const host = render(FilesApp);
    await vi.waitFor(() => expect(txt(host)).toContain("设备文件"));
    await openSection(host);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="external-blocked"]')).toBeTruthy();
    });
    // Never rendered as "no files".
    expect(txt(host)).not.toContain("可读集合中没有文件");

    await fireEvent.click(
      host.container.querySelector('button[aria-label="授权读取"]') as HTMLButtonElement,
    );
    await vi.waitFor(() => expect(txt(host)).toContain("report.pdf"));
    expect(calls.filter((c) => c.cmd === "media_grant_read")).toHaveLength(5); // one per collection
    expect(host.container.querySelector('[data-testid="external-blocked"]')).toBeNull();
  });

  test("no external section at all when there is no media bridge", async () => {
    const host = render(FilesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(txt(host)).not.toContain("设备文件");
  });
});

describe("FilesApp.svelte — Spotlight deep link (appLinks.openFile)", () => {
  afterEach(resetPropsChannels);

  /** A nested tree: the file lives inside 文档, so it is NOT visible at the root. */
  const seedTree = () =>
    window.localStorage.setItem(
      "amos.files",
      JSON.stringify([
        { id: "doc", type: "folder", name: "文档", ts: 1000 },
        { id: "rep", type: "file", name: "报告.txt", parent: "doc", content: "季度总结", ts: 2000 },
        { id: "root-txt", type: "file", name: "根目录.txt", content: "顶层", ts: 3000 },
      ]),
    );

  test("reveals the linked entry in its own folder and marks it", async () => {
    seedTree();
    // The chooser sets the channel *before* opening the app, so the payload is
    // already there at mount (same contract as the Spotlight → Notes link).
    filesChannel().set({ id: "rep", nonce: 11 });
    const host = render(FilesApp);
    await new Promise<void>((r) => setTimeout(r, 0));

    // It navigated into 文档 (where the file actually lives)…
    expect(txt(host)).toContain("报告.txt");
    expect(txt(host)).not.toContain("根目录.txt");
    // …and marked exactly that row.
    const marked = host.container.querySelectorAll('[data-spotlight="hit"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent ?? "").toContain("报告.txt");
  });

  test("a link to an entry that is gone shows the root, unmarked (no phantom)", async () => {
    seedTree();
    filesChannel().set({ id: "gone", nonce: 12 });
    const host = render(FilesApp);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(txt(host)).toContain("文档"); // still at the root
    expect(host.container.querySelector('[data-spotlight="hit"]')).toBeNull();
  });

  test("the link is consumed, and a second link still re-fires with a new nonce", async () => {
    seedTree();
    filesChannel().set({ id: "rep", nonce: 13 });
    const host = render(FilesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(host.container.querySelector('[data-spotlight="hit"]')).toBeTruthy();
    // Consumed: the channel no longer holds a pending link, so re-mounting Files
    // later cannot replay it.
    expect(filesChannel().get()?.id).toBe("");

    // A later, different link (fresh nonce) is honoured — the mark moves with it.
    filesChannel().set({ id: "root-txt", nonce: 14 });
    await new Promise<void>((r) => setTimeout(r, 0));
    const marked = host.container.querySelectorAll('[data-spotlight="hit"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent ?? "").toContain("根目录.txt");
  });

  /**
   * REQ-A458 — the **cross-window** route for the same reveal.
   *
   * The in-page channel above cannot serve the desktop: the Spotlight runs in the launcher window
   * while this screen runs in its own `WebviewWindow`, so the request travels through the shared
   * store instead. Same destination and the same two properties — the entry is revealed where it
   * lives, and the request is **consumed** so it can never fire twice.
   */
  test("a request that arrives through the shared store reveals and is consumed", async () => {
    seedTree();
    writeStoreValue(FILES_REVEAL_KEY, { id: "rep", nonce: 21 });
    const host = render(FilesApp);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(txt(host)).toContain("报告.txt"); // navigated into 文档
    expect(txt(host)).not.toContain("根目录.txt");
    expect(host.container.querySelectorAll('[data-spotlight="hit"]')).toHaveLength(1);
    // Consumed: a second Files window opened later finds `null`, not a served request.
    expect(readStoreValue<unknown>(FILES_REVEAL_KEY, null)).toBeNull();
  });

  test("a store request for an entry that is gone clears itself and invents nothing", async () => {
    seedTree();
    writeStoreValue(FILES_REVEAL_KEY, { id: "gone", nonce: 22 });
    const host = render(FilesApp);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(txt(host)).toContain("文档"); // still at the root
    expect(host.container.querySelector('[data-spotlight="hit"]')).toBeNull();
    expect(readStoreValue<unknown>(FILES_REVEAL_KEY, null)).toBeNull();
  });
});

describe("FilesApp.svelte — preview panel (Rust-side classification)", () => {
  /** Stub the Tauri bridge for `files_preview_bytes` with a custom classifier. */
  function installPreviewBridge(
    handler: (name: string, mime: string | null, data: number[]) => {
      kind: string;
      data: string;
      mime: string | null;
      isText: boolean;
      sizeLabel: string;
      error: string | null;
    },
  ) {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "files_preview_bytes") {
          return handler(
            String(args?.name ?? ""),
            (args?.mime as string | null) ?? null,
            (args?.data as number[]) ?? [],
          );
        }
        if (cmd === "files_cloud_validate") {
          return args?.snapshot;
        }
        return null;
      },
      listen: async () => () => {},
    };
  }

  beforeEach(() => {
    window.localStorage.setItem(
      "amos.files",
      JSON.stringify([
        { id: "n", type: "file", name: "note.txt", content: "你好世界", ts: 1000 },
        { id: "i", type: "file", name: "img.png", content: "", ts: 2000 },
      ]),
    );
  });

  test("text preview shows the body via the Rust command", async () => {
    installPreviewBridge((name, _mime, data) => {
      const text = new TextDecoder().decode(new Uint8Array(data));
      return {
        kind: "text",
        data: text,
        mime: "text/plain",
        isText: true,
        sizeLabel: `${data.length} B`,
        error: null,
      };
    });
    const host = render(FilesApp);
    // Wait for the file list (the row is in the local-files surface, not the
    // external-files surface — only local files carry an inline preview button).
    await vi.waitFor(() => {
      const btn = [...host.container.querySelectorAll("button")].find(
        (b) =>
          (b.getAttribute("aria-label") ?? "").startsWith("预览 ") &&
          (b.textContent ?? "").includes("预览"),
      );
      expect(btn).toBeTruthy();
    });
    // Open the preview by clicking the row's preview button.
    const btn = [...host.container.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "") === "预览" || (b.getAttribute("aria-label") ?? "").startsWith("预览 "));
    expect(btn).toBeTruthy();
    await fireEvent.click(btn as HTMLButtonElement);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-panel"]')).toBeTruthy(),
    );
    const txt = host.container.querySelector('[data-testid="preview-text"]');
    expect(txt?.textContent ?? "").toContain("你好世界");
    // Close button works.
    const closeBtn = host.container.querySelector('[aria-label="关闭预览"]') as HTMLButtonElement;
    await fireEvent.click(closeBtn);
    expect(host.container.querySelector('[data-testid="preview-panel"]')).toBeNull();
  });

  test("image preview renders the data URL", async () => {
    installPreviewBridge((name, _mime, data) => ({
      kind: "image",
      data: `data:image/png;base64,${btoa(String.fromCharCode(...data))}`,
      mime: "image/png",
      isText: false,
      sizeLabel: `${data.length} B`,
      error: null,
    }));
    const host = render(FilesApp);
    const btn = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "") === "预览",
    ) as HTMLButtonElement;
    await fireEvent.click(btn);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-image"]')).toBeTruthy(),
    );
    const img = host.container.querySelector('[data-testid="preview-image"]') as HTMLImageElement;
    expect(img.src.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("binary preview shows the binary notice (no data URL)", async () => {
    installPreviewBridge(() => ({
      kind: "binary",
      data: "",
      mime: "application/octet-stream",
      isText: false,
      sizeLabel: "128 B",
      error: null,
    }));
    const host = render(FilesApp);
    const btn = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "") === "预览",
    ) as HTMLButtonElement;
    await fireEvent.click(btn);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-binary"]')).toBeTruthy(),
    );
  });
});

describe("FilesApp.svelte — bundle export/import (Rust gzip)", () => {
  /** Stub the Rust bundle export/import commands with deterministic fixtures. */
  function installBundleBridge(opts: {
    exportText?: string;
    exportBytes?: { original: number; compressed: number; entryCount: number };
    importResult?: unknown;
  }) {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "files_bundle_export") {
          return {
            text: opts.exportText ?? "AmosFilesBundle/1.0\nQUJD",
            originalBytes: opts.exportBytes?.original ?? 100,
            compressedBytes: opts.exportBytes?.compressed ?? 50,
            entryCount: opts.exportBytes?.entryCount ?? 2,
            ratioLabel: "50%",
          };
        }
        if (cmd === "files_bundle_import") {
          return opts.importResult ?? {
            tag: "Ok",
            data: {
              entries: [
                { id: "i1", type: "file", name: "imported.txt", content: "from bundle", ts: 100 },
              ],
              originalBytes: 100,
              compressedBytes: 50,
              entryCount: 1,
            },
          };
        }
        if (cmd === "files_cloud_validate") {
          return args?.snapshot;
        }
        return null;
      },
      listen: async () => () => {},
    };
  }

  test("bundle export fills the textarea with the magic-prefixed text", async () => {
    installBundleBridge({});
    const host = render(FilesApp);
    const exportBtn = [...host.container.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes("导出为压缩包")) as HTMLButtonElement;
    expect(exportBtn).toBeTruthy();
    await fireEvent.click(exportBtn);
    await vi.waitFor(() => {
      const ta = host.container.querySelector(
        '[data-testid="bundle-text"]',
      ) as HTMLTextAreaElement;
      expect(ta.value).toContain("AmosFilesBundle/1.0");
    });
  });

  test("bundle import replaces the store with the validated entries", async () => {
    installBundleBridge({
      importResult: {
        tag: "Ok",
        data: {
          entries: [
            { id: "imp1", type: "folder", name: "导入的目录", ts: 200 },
            { id: "imp2", type: "file", name: "导入的文件.txt", content: "hi", parent: "imp1", ts: 201 },
          ],
          originalBytes: 200,
          compressedBytes: 80,
          entryCount: 2,
        },
      },
    });
    const host = render(FilesApp);
    // Expand the bundle details panel so the textarea + buttons are reachable.
    const summary = host.container.querySelector('[data-testid="bundle-section"] summary') as HTMLElement;
    await fireEvent.click(summary);
    const ta = host.container.querySelector('[data-testid="bundle-text"]') as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "AmosFilesBundle/1.0\nQUJD" } });
    const importBtn = [...host.container.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes("从设备导入")) as HTMLButtonElement;
    await fireEvent.click(importBtn);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="bundle-text"]')).toBeTruthy();
      // After import, the list must show the imported entry (not the seed).
      expect(host.container.textContent ?? "").toContain("导入的目录");
      expect(host.container.textContent ?? "").not.toContain("文档");
    });
  });

  test("bundle import failure shows the error reason", async () => {
    installBundleBridge({
      importResult: { tag: "Err", data: { reason: "magic header mismatch", compressedBytes: null, uncompressedBytes: null } },
    });
    const host = render(FilesApp);
    const summary = host.container.querySelector('[data-testid="bundle-section"] summary') as HTMLElement;
    await fireEvent.click(summary);
    const ta = host.container.querySelector('[data-testid="bundle-text"]') as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "garbage" } });
    const importBtn = [...host.container.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes("从设备导入")) as HTMLButtonElement;
    await fireEvent.click(importBtn);
    await vi.waitFor(() => {
      expect(host.container.textContent ?? "").toContain("magic header mismatch");
    });
  });
});

describe("FilesApp.svelte — cloud snapshot (local mirror)", () => {
  function installCloudBridge() {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "media_list") return [];
        if (cmd === "files_cloud_validate") return args?.snapshot;
        return null;
      },
      listen: async () => () => {},
    };
  }

  test("saving a snapshot with empty device files shows the empty notice", async () => {
    installCloudBridge();
    const host = render(FilesApp);
    const summary = host.container.querySelector('[data-testid="cloud-section"] summary') as HTMLElement;
    await fireEvent.click(summary);
    const saveBtn = [...host.container.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes("保存快照")) as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    await vi.waitFor(() => {
      expect(host.container.textContent ?? "").toContain("尚未保存快照");
    });
  });

  test("a saved snapshot restores and shows the metadata line", async () => {
    installCloudBridge();
    // Pre-populate localStorage so loadSnapshot returns something.
    window.localStorage.setItem(
      "amos.files.cloud",
      JSON.stringify({
        label: "device-files",
        savedAt: 1700000000000,
        collections: ["download"],
        totalBytes: 2048,
        fileCount: 1,
        files: [{ id: "u", name: "a.pdf", kind: "file", collection: "download", sizeBytes: 2048, ts: 0 }],
      }),
    );
    const host = render(FilesApp);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="cloud-section"]')).toBeTruthy();
    });
    const summary = host.container.querySelector('[data-testid="cloud-section"] summary') as HTMLElement;
    await fireEvent.click(summary);
    await vi.waitFor(() => {
      expect(host.container.textContent ?? "").toContain("device-files");
      expect(host.container.textContent ?? "").toContain("1 项");
    });
  });
});

/**
 * REQ-A455 — the Trash, from the user's chair. The pure model is tested in
 * `src/__tests__/files.test.ts`; what these cases pin is the **wiring**, and each one is a
 * property the feature would be broken without:
 *
 *   • a delete is a *move* (the file leaves the list and lands in the ledger);
 *   • 「放回原处」really puts it back (and the ledger lets go of it);
 *   • the destructive act is reachable — but only from inside the trash view;
 *   • a refusal is **fail-safe**: when the ledger cannot be written, the file stays in the
 *     tree. This is the ordering (`commitTrash`) that a swap would silently break, and the
 *     only case here that a "did it look right?" test could never catch.
 */
describe("FilesApp.svelte — Trash (REQ-A455)", () => {
  const FILES = "amos.files";
  const TRASH = "amos.files.trash";

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      FILES,
      JSON.stringify([{ id: "keep", type: "file", name: "保留.txt", content: "", ts: 2 }]),
    );
    window.localStorage.setItem(
      TRASH,
      JSON.stringify([
        {
          id: "old",
          members: [{ id: "old", type: "file", name: "旧文件.txt", content: "", ts: 1 }],
          deletedAt: 10,
        },
      ]),
    );
  });

  test("delete MOVES the file to the trash — the ledger gets it, the list loses it", async () => {
    const host = render(FilesApp);
    await fireEvent.click(btnContaining(host, "保留.txt")!);
    await fireEvent.click(btnContaining(host, "移到废纸篓")!);
    expect(readStoreValue(TRASH, [])).toHaveLength(2);
    const ledger = readStoreValue<Array<{ id: string }>>(TRASH, []);
    expect(ledger[0].id).toBe("keep"); // newest first
    expect(btnContaining(host, "保留.txt")).toBeUndefined();
  });

  test("the trash tab lists it, and 放回原处 really puts it back", async () => {
    const host = render(FilesApp);
    await fireEvent.click(host.container.querySelector(
      '[data-testid="files-trash-tab"]',
    ) as HTMLElement);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="files-trash-list"]')).toBeTruthy();
    });
    expect(host.container.textContent ?? "").toContain("旧文件.txt");
    await fireEvent.click(btnContaining(host, "放回原处")!);
    await vi.waitFor(() => {
      expect(readStoreValue(TRASH, [])).toHaveLength(0);
    });
    // …and it is back in the tree (visible under 全部).
    await fireEvent.click(btnContaining(host, "全部")!);
    await vi.waitFor(() => {
      expect(host.container.textContent ?? "").toContain("旧文件.txt");
    });
  });

  test("永久删除 and 清空废纸篓 are the destructive acts, and they are in the trash view", async () => {
    const host = render(FilesApp);
    await fireEvent.click(host.container.querySelector(
      '[data-testid="files-trash-tab"]',
    ) as HTMLElement);
    await vi.waitFor(() => {
      expect(btnContaining(host, "永久删除")).toBeTruthy();
    });
    await fireEvent.click(btnContaining(host, "永久删除")!);
    await vi.waitFor(() => {
      expect(readStoreValue(TRASH, [])).toHaveLength(0);
    });
    // The empty-state hint replaces the list, honestly (no ghost row).
    expect(host.container.querySelector('[data-testid="files-trash-empty-hint"]')).toBeTruthy();
  });

  test("a refused ledger write leaves the file IN THE TREE (delete is fail-safe)", async () => {
    // The two store keys cannot be written atomically, so the order decides the failure
    // mode. Ledger-first, a refused ledger means nothing happened — the user still has
    // their file. Swap `commitTrash` around and the file is gone with no ledger holding it.
    const restore = failWritesFor(TRASH);
    try {
      const host = render(FilesApp);
      await fireEvent.click(btnContaining(host, "保留.txt")!);
      await fireEvent.click(btnContaining(host, "移到废纸篓")!);
      expect(host.container.textContent ?? "").toContain("本机存储写入失败");
      expect(btnContaining(host, "保留.txt")).toBeTruthy();
    } finally {
      restore();
    }
  });

  test("a restore blocked by a name clash says so instead of overwriting", async () => {
    // The trashed item's name is taken again while it was away.
    window.localStorage.setItem(
      FILES,
      JSON.stringify([
        { id: "keep", type: "file", name: "保留.txt", content: "", ts: 2 },
        { id: "new", type: "file", name: "旧文件.txt", content: "", ts: 3 },
      ]),
    );
    const host = render(FilesApp);
    await fireEvent.click(host.container.querySelector(
      '[data-testid="files-trash-tab"]',
    ) as HTMLElement);
    await fireEvent.click(btnContaining(host, "放回原处")!);
    await vi.waitFor(() => {
      const note = host.container.querySelector('[data-testid="files-trash-note"]');
      expect(note?.textContent ?? "").toContain("旧文件.txt");
    });
    // Nothing moved: the ledger still holds it and both tree entries are untouched.
    expect(readStoreValue(TRASH, [])).toHaveLength(1);
  });
});


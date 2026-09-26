/**
 * DOM tests for the Svelte 5 files screen (FilesApp.svelte).
 *
 * Pure filesystem logic is unit-tested once against lib/files.ts (shared by the
 * React + Svelte UIs). Here we verify the Svelte UI wiring: the seeded root,
 * creating a folder in the current directory, and navigating into a folder.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import FilesApp from "../src/svelte/FilesApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { FILES_REVEAL_KEY, FILES_VIEW_KEY } from "../src/lib/files";
import { filesChannel } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { base64ToBytes } from "../src/lib/hostFs";

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

  test("a refused write is named for what it is: unavailable-or-full, not 'busy' (REQ-A510)", async () => {
    // The store can only answer "it did not land" — so the banner must not claim a *cause*
    // (the old label said "存储繁忙，请重试" / "storage is busy", which this app cannot observe,
    // and which is simply wrong when the store is full). The retry affordance stays, because the
    // store's state can change (REQ-A468's test drives exactly that half).
    const restore = failWritesFor("amos.files");
    try {
      const host = render(FilesApp);
      await fireEvent.click(btnContaining(host, "文件夹")!);
      const input = host.container.querySelector(
        'input[data-testid="file-new-name"]',
      ) as HTMLInputElement;
      await fireEvent.input(input, { target: { value: "工作" } });
      await fireEvent.click(btnContaining(host, "保存")!);

      const banner = host.container.querySelector('[data-testid="file-error-banner"]');
      const text = banner?.textContent ?? "";
      expect(text).toContain("本机存储不可用或已满");
      expect(text).not.toContain("存储繁忙");
      expect(text).not.toContain("请重试");
      // …and the exception is safe to act on: the button is still there.
      expect(host.container.querySelector('[data-testid="retry-button"]')).toBeTruthy();
    } finally {
      restore();
    }
  });

  test("重试 really re-runs the refused action — it does not just hide the error (REQ-A468)", async () => {
    const restore = failWritesFor("amos.files");
    try {
      const host = render(FilesApp);
      await fireEvent.click(btnContaining(host, "文件夹")!);
      const input = host.container.querySelector(
        'input[data-testid="file-new-name"]',
      ) as HTMLInputElement;
      await fireEvent.input(input, { target: { value: "工作" } });
      await fireEvent.click(btnContaining(host, "保存")!);

      const retry = () =>
        host.container.querySelector('[data-testid="retry-button"]') as HTMLButtonElement | null;
      expect(retry()).toBeTruthy();

      // The store still refuses, so 重试 must *try again*: the banner stays and nothing is claimed.
      // (The old handler only cleared the error, which made 重试 and 关闭 the same button.)
      await fireEvent.click(retry()!);
      expect(txt(host)).toContain("本机存储写入失败");
      expect(txt(host)).not.toContain("工作");
      expect(retry()).toBeTruthy();

      // The store accepts now: the same press completes the ORIGINAL action and clears the banner.
      restore();
      await fireEvent.click(retry()!);
      expect(txt(host)).toContain("工作");
      expect(host.container.querySelector('[data-testid="file-error-banner"]')).toBeNull();
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

  // REQ-A1525 / F-SH-770 — the header is the claim surface. A file whose size the
  // platform never reported (`size_bytes` absent) is printed 「—」 on its own row;
  // the header used to fold that same file to 0 and print "2 · 2.0 KB", a byte count
  // nobody measured. Withholding the total is the only honest answer.
  test("the header withholds the total when a listed file's size was not reported", async () => {
    installMediaBridge({
      items: [
        item("report.pdf", 2048, 1),
        // No `size_bytes` at all — the platform did not report this file's size.
        {
          id: "download/scan.pdf",
          kind: "file",
          collection: "download",
          name: "scan.pdf",
          uri: "content://download/scan.pdf",
          mime: "application/pdf",
          ts: 2,
        },
      ],
    });
    const host = render(FilesApp);
    await vi.waitFor(() => expect(txt(host)).toContain("设备文件"));
    await openSection(host);
    await vi.waitFor(() => expect(txt(host)).toContain("scan.pdf"));

    const header = host.container.querySelector('[data-testid="external-total"]') as HTMLElement;
    expect(header).toBeTruthy();
    const shown = (header.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(shown).toBe("2 · —");
  });

  // Positive control: when every size *was* reported, the header still totals them —
  // the withhold must not degrade into "never show a total".
  test("the header still totals when every listed file's size was reported", async () => {
    installMediaBridge({
      items: [item("report.pdf", 2048, 1), item("scan.pdf", 1024, 2)],
    });
    const host = render(FilesApp);
    await vi.waitFor(() => expect(txt(host)).toContain("设备文件"));
    await openSection(host);
    await vi.waitFor(() => expect(txt(host)).toContain("scan.pdf"));

    const header = host.container.querySelector('[data-testid="external-total"]') as HTMLElement;
    const shown = (header.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(shown).toBe("2 · 3.0 KB");
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

/**
 * REQ-A783 — the cross-window **view** intent: the desktop Dock's trash tile asking this screen to
 * land on its trash pane.
 *
 * The reveal block above carries an entry to navigate to; this one carries one of the four views,
 * for a caller that has no entry to name. Same route (the shared store), same two properties (the
 * request is served, and it is consumed), plus one the reveal cannot exercise: the request is
 * written **before the window exists** — `wmOpen("files")` is create-or-focus, so on a first click
 * there is no Files window to receive a broadcast, and the intent is only ever seen as the store's
 * *initial* value. That is why the dock tile writes first and opens second, and why these cases
 * write before `render()`.
 */
describe("FilesApp.svelte — cross-window view intent (the Dock's trash tile, REQ-A783)", () => {
  const FILES = "amos.files";
  const TRASH = "amos.files.trash";
  const onTrash = (host: { container: HTMLElement }) =>
    host.container.querySelector('[data-testid="files-trash-tab"]')?.getAttribute("aria-pressed");

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

  test("a request written BEFORE the window exists still lands on that view, and is consumed", async () => {
    // The dock tile's order: the intent is in the store, *then* the window is created. Nothing
    // broadcasts to a window that is not there — the value has to be read at mount.
    writeStoreValue(FILES_VIEW_KEY, { view: "trash", nonce: 31 });
    const host = render(FilesApp);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(onTrash(host)).toBe("true");
    expect(host.container.textContent ?? "").toContain("旧文件.txt");
    // Consumed: a Files window opened later finds `null`, not a served request — otherwise every
    // future Files window would open straight into the trash.
    expect(readStoreValue<unknown>(FILES_VIEW_KEY, null)).toBeNull();
  });

  test("it lands on the trash pane AND NOT on the root view (the two-part route, both halves)", async () => {
    // The failure this pins is the one the greyed tile was afraid of: "Files opened, and not on
    // the trash". A request that opened the window (or the screen) without moving the view would
    // look exactly like a working tile to anyone asserting only that Files is up.
    writeStoreValue(FILES_VIEW_KEY, { view: "trash", nonce: 32 });
    const host = render(FilesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(host.container.querySelector('[data-testid="files-trash-list"]')).toBeTruthy();
    // …and the *live tree* is not what it settled on: 保留.txt is in `amos.files`, not the ledger,
    // so seeing it here would mean the screen is still on a tree view with the trash appended.
    expect(host.container.textContent ?? "").not.toContain("保留.txt");
  });

  test("asking for the same view again still fires (the nonce, not the view, is the marker)", async () => {
    writeStoreValue(FILES_VIEW_KEY, { view: "trash", nonce: 33 });
    const host = render(FilesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(onTrash(host)).toBe("true");

    // The user wanders off to 全部…
    await fireEvent.click(btnContaining(host, "全部")!);
    expect(onTrash(host)).toBe("false");

    // …and the dock tile is clicked again. Same view, fresh nonce: it must come back, or the tile
    // would be dead for every user who had ever opened the trash before.
    writeStoreValue(FILES_VIEW_KEY, { view: "trash", nonce: 34 });
    await vi.waitFor(() => expect(onTrash(host)).toBe("true"));
    expect(readStoreValue<unknown>(FILES_VIEW_KEY, null)).toBeNull();
  });

  test("the same request replayed at the same nonce does NOT yank the user back", async () => {
    // The store can re-announce a change (`store-updated`) without its value having changed — and
    // a served intent must never re-fire, or a background store echo would fight the user's own
    // navigation, moving them back to the trash every time they clicked away.
    writeStoreValue(FILES_VIEW_KEY, { view: "trash", nonce: 35 });
    const host = render(FilesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    await fireEvent.click(btnContaining(host, "全部")!);

    writeStoreValue(FILES_VIEW_KEY, { view: "trash", nonce: 35 });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(onTrash(host)).toBe("false"); // stayed where the user put it
  });

  test("a view this build cannot serve is left alone, both the screen and the value", async () => {
    // A newer writer's view name. The screen must not switch to a state no branch of its template
    // renders (an empty screen), and the value is deliberately **not** cleared: this build cannot
    // serve it, but it also must not destroy an intent that a reader which understands it can.
    writeStoreValue(FILES_VIEW_KEY, { view: "shared", nonce: 36 });
    const host = render(FilesApp);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(onTrash(host)).toBe("false");
    expect(host.container.textContent ?? "").toContain("保留.txt"); // an ordinary root view
    expect(readStoreValue<unknown>(FILES_VIEW_KEY, null)).toEqual({ view: "shared", nonce: 36 });
  });

  test("a non-object in the key is not a request (nothing pending)", async () => {
    window.localStorage.setItem(FILES_VIEW_KEY, JSON.stringify("trash"));
    const host = render(FilesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(onTrash(host)).toBe("false");
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
 *   • a refusal is **fail-safe in both directions**: a refused delete leaves the file in the
 *     tree, and a refused *restore* leaves it in the ledger. That is the direction-aware
 *     ordering (`commitDelete` / `commitRestore`) that a single shared write order silently
 *     breaks on one side, and the only two cases here that a "did it look right?" test could
 *     never catch.
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
    // their file. Swap `commitDelete` around and the file is gone with no ledger holding it.
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

  test("a refused TREE write does not lose a restore — the file stays in the ledger", async () => {
    // The mirror of the case above. Restore is a **move in the other direction**: the tree
    // gains the item and the ledger drops it, so ledger-first (the delete order) would drop
    // the ledger row and then fail to put the item in the tree — the file would be in
    // neither store. The order must follow the direction, and this is the case that a single
    // fixed `commitTrash` silently breaks.
    const restore = failWritesFor(FILES);
    try {
      const host = render(FilesApp);
      await fireEvent.click(host.container.querySelector(
        '[data-testid="files-trash-tab"]',
      ) as HTMLElement);
      await vi.waitFor(() => expect(btnContaining(host, "放回原处")).toBeTruthy());
      await fireEvent.click(btnContaining(host, "放回原处")!);
      expect(host.container.textContent ?? "").toContain("本机存储写入失败");
      // The restore did not land: the file must still be in the ledger, not gone from both.
      expect(readStoreValue(TRASH, []), "还原没落地 ⇒ 账本还得拿着它").toHaveLength(1);
      expect(btnContaining(host, "放回原处"), "行还在，还原按钮还在").toBeTruthy();
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


describe("FilesApp.svelte — host filesystem (fenced by AMOS_HOST_FS_ROOT)", () => {
  /** A fake `host_fs_*` bridge. `dirs` is keyed by the fence-relative path the
   *  screen asks for; anything absent is a refusal, so a missing map entry cannot
   *  masquerade as "an empty folder". */
  function installHostBridge(opts: {
    root?: string | null;
    exists?: boolean;
    dirs?: Record<string, unknown[]>;
    files?: Record<string, string>;
  }) {
    const calls: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push(cmd);
        const path = (args?.args as { path?: string } | undefined)?.path ?? "";
        if (cmd === "host_fs_root_status") {
          return { root: opts.root ?? null, exists: opts.exists ?? false, reason: null };
        }
        if (cmd === "host_fs_read_dir") {
          const rows = opts.dirs?.[path];
          if (rows === undefined) throw { code: "amos.host_fs.path_escapes_root", message: "outside" };
          return rows;
        }
        if (cmd === "host_fs_read_text") {
          const body = opts.files?.[path];
          if (body === undefined) throw { code: "amos.host_fs.read_not_utf8", message: "binary" };
          return { path, size: body.length, body, truncated: false };
        }
        if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 1 };
        if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  }

  const entry = (path: string, name: string, isDir: boolean, size = 0) => ({
    path,
    name,
    isDir,
    size,
    mtimeMs: 1_700_000_000_000,
  });

  const openHost = async (host: { container: HTMLElement }) => {
    await vi.waitFor(() => expect(txt(host)).toContain("主机文件系统"));
    const toggle = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("主机文件系统"),
    );
    await fireEvent.click(toggle as HTMLButtonElement);
  };

  test("no host section at all when the fence is not configured", async () => {
    installHostBridge({ root: null });
    const host = render(FilesApp);
    await new Promise<void>((r) => setTimeout(r, 0));
    // The optional env var means "unconfigured" is normal — and must not read as
    // "an empty folder".
    expect(txt(host)).not.toContain("主机文件系统");
  });

  test("lists the fenced directory and opens a text file read-only", async () => {
    installHostBridge({
      root: "/tmp/fence",
      exists: true,
      dirs: {
        "": [entry("/tmp/fence/docs", "docs", true), entry("/tmp/fence/notes.txt", "notes.txt", false, 10)],
        "/tmp/fence/docs": [entry("/tmp/fence/docs/readme.md", "readme.md", false, 5)],
      },
      files: { "/tmp/fence/notes.txt": "hello host", "/tmp/fence/docs/readme.md": "# doc" },
    });
    const host = render(FilesApp);
    await openHost(host);

    await vi.waitFor(() => expect(txt(host)).toContain("notes.txt"));
    expect(host.container.querySelector('[data-testid="host-root"]')?.textContent).toBe("/tmp/fence");
    expect(host.container.querySelectorAll('[data-testid="host-entry"]')).toHaveLength(2);

    // Descend into the folder: the listing is the child's, not a stale root.
    const docs = [...host.container.querySelectorAll('[data-testid="host-entry"]')].find((b) =>
      (b.textContent ?? "").includes("docs"),
    ) as HTMLElement;
    await fireEvent.click(docs);
    await vi.waitFor(() => expect(txt(host)).toContain("readme.md"));
    expect(host.container.querySelector('[data-testid="host-cwd"]')?.textContent).toContain("docs");

    // Open the text file: the body is shown, and there is no write affordance.
    await fireEvent.click(
      host.container.querySelector('[data-testid="host-entry"]') as HTMLElement,
    );
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="host-file"]')?.textContent).toContain("# doc");
    });
  });

  test("a refusal is named, never rendered as an empty folder", async () => {
    // `dirs` has no "" entry, so the first listing is refused with a typed code.
    installHostBridge({ root: "/tmp/fence", exists: true, dirs: {} });
    const host = render(FilesApp);
    await openHost(host);

    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="host-error"]')?.textContent).toContain(
        "已拒绝：该路径超出允许的根目录。",
      );
    });
    expect(txt(host)).not.toContain("此文件夹为空");
  });
});

describe("FilesApp.svelte — a binary host file reaches the preview panel (REQ-A971)", () => {
  /**
   * The seam `lib/hostFileOpen.test.ts` cannot reach. That module's tests pin the *decision*
   * (which refusal licenses the bytes reader) but they stop at the module's return value; the
   * wiring that turns a `preview` outcome into `previewTarget`/`previewPlan` lives here, in
   * `openHostEntry`. Reverting that function to its old text-only body — send every entry to
   * `hostFsReadText` and render the refusal as a banner — would leave **every** unit test in
   * that file green. So the assertions below are on the rendered panel, not on a return value.
   */
  const entry = (path: string, name: string, isDir: boolean, size = 0) => ({
    path,
    name,
    isDir,
    size,
    mtimeMs: 1_700_000_000_000,
  });

  /** The base64 the fake host hands back for any bytes read; 4 bytes, so decoding is real. */
  const BYTES_B64 = "AAECAwQ=";

  /**
   * A fake `host_fs_*` bridge that has **both** readers. `files` holds the paths that decode
   * as UTF-8; every other path is refused with the host's real `read_not_utf8`, exactly how
   * `host_fs.rs` answers a JPEG.
   *
   * `refuseWith` replaces that refusal, which is what the negative control at the bottom
   * needs: the point of the fix is that **one** code licenses the bytes reader, and a bridge
   * that can only ever say `read_not_utf8` cannot tell the difference.
   */
  function installPreviewBridge(opts: { files?: Record<string, string>; refuseWith?: string } = {}) {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    // The listing is mutable so a test can model an edit landing outside AmOS and then push the
    // host's own watch event — the real trigger for a same-directory refresh, which the tests that
    // only read `calls` never need.
    const state = {
      rows: [
        entry("/tmp/fence/photo.jpg", "photo.jpg", false, 4),
        entry("/tmp/fence/notes.txt", "notes.txt", false, 5),
      ],
      emit: null as ((e: { payload: unknown }) => void) | null,
    };
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        const path = (args?.args as { path?: string } | undefined)?.path ?? "";
        if (cmd === "host_fs_root_status") return { root: "/tmp/fence", exists: true, reason: null };
        if (cmd === "host_fs_read_dir") return state.rows;
        if (cmd === "host_fs_read_text") {
          const body = opts.files?.[path];
          if (body === undefined) {
            throw { code: opts.refuseWith ?? "amos.host_fs.read_not_utf8", message: "no" };
          }
          return { path, size: body.length, body, truncated: false };
        }
        if (cmd === "host_fs_read_bytes") {
          return { path, size: 4, body: BYTES_B64, truncated: false };
        }
        if (cmd === "files_preview_bytes") {
          // The Rust command's reply shape, verbatim (`FilesPreviewResult`). `data` is the
          // `data:` URL the `<img>` gets.
          return {
            kind: "image",
            data: "data:image/jpeg;base64,AAECAwQ=",
            mime: "image/jpeg",
            isText: false,
            sizeLabel: "4 B",
            error: null,
          };
        }
        if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 1 };
        if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
        if (cmd === "host_fs_watch_list") return [1];
        return null;
      },
      listen: async (_ch: string, cb: (e: { payload: unknown }) => void) => {
        state.emit = cb;
        return () => {};
      },
    };
    return {
      calls,
      state,
      cmd: (name: string) => calls.filter((c) => c.cmd === name),
      /** An edit lands outside AmOS: the host pushes a change for the subscription we hold. */
      fireWatchEvent: () => {
        state.emit!({ payload: { subscriptionId: 1, path: "/tmp/fence/photo.jpg", kind: "modify" } });
      },
      /** The same edit, seen in the next listing: the row is no longer there. */
      dropRow: (path: string) => {
        state.rows = state.rows.filter((r) => r.path !== path);
      },
    };
  }

  const openHost = async (host: { container: HTMLElement }) => {
    await vi.waitFor(() => expect(txt(host)).toContain("主机文件系统"));
    const toggle = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("主机文件系统"),
    );
    await fireEvent.click(toggle as HTMLButtonElement);
  };

  /** The `host-entry` row whose text is `name`. */
  const hostEntry = (host: { container: HTMLElement }, name: string) =>
    [...host.container.querySelectorAll('[data-testid="host-entry"]')].find((b) =>
      (b.textContent ?? "").includes(name),
    ) as HTMLElement | undefined;

  /** Let every pending microtask + timer callback drain. */
  const settle = async () => {
    for (let i = 0; i < 3; i += 1) {
      await tick();
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  };

  test("a non-UTF-8 host file renders an <img>, not a sentence about UTF-8", async () => {
    const bridge = installPreviewBridge();
    const host = render(FilesApp);
    await openHost(host);

    await vi.waitFor(() => expect(txt(host)).toContain("photo.jpg"));
    await fireEvent.click(hostEntry(host, "photo.jpg")!);

    await vi.waitFor(() => {
      const img = host.container.querySelector('[data-testid="preview-image"]');
      expect(img?.getAttribute("src")).toBe("data:image/jpeg;base64,AAECAwQ=");
    });
    // The panel names the file it is showing, so the assertion above cannot be satisfied by
    // a preview of some other entry.
    expect(host.container.querySelector('[data-testid="preview-title"]')?.textContent).toContain(
      "photo.jpg",
    );
    // The two halves of the defect, each named: the refusal is gone, and the text reader's
    // `host-file` pane is not showing some stale other file.
    expect(txt(host)).not.toContain("不是合法的 UTF-8");
    expect(host.container.querySelector('[data-testid="host-file"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="host-error"]')).toBeNull();

    // The route actually taken, and the blank-MIME sentinel that makes `files.rs`'s
    // extension table the classifier rather than the TS twin table.
    expect(bridge.cmd("host_fs_read_text")).toHaveLength(1);
    expect(bridge.cmd("host_fs_read_bytes")).toHaveLength(1);
    // Flat, not `{ args: … }` — `backend.ts::filesPreviewBytes` passes its object straight
    // through, unlike the `host_fs_*` wrappers. Reading the wrong nesting here would make
    // the blanks below `undefined`, i.e. a test of nothing.
    const previewArgs = (bridge.cmd("files_preview_bytes")[0]?.args ?? {}) as {
      mime?: string;
      name?: string;
    };
    expect(previewArgs.mime).toBe("");
    expect(previewArgs.name).toBe("photo.jpg");
  });

  test("opening a text host file afterwards closes the preview panel", async () => {
    // One file, one surface: without this, the panel keeps showing the photo while the
    // `<pre>` below shows the notes file, and the screen claims two files at once.
    const bridge = installPreviewBridge({ files: { "/tmp/fence/notes.txt": "hello host" } });
    const host = render(FilesApp);
    await openHost(host);
    await vi.waitFor(() => expect(txt(host)).toContain("photo.jpg"));

    await fireEvent.click(hostEntry(host, "photo.jpg")!);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-image"]')).not.toBeNull(),
    );

    await fireEvent.click(hostEntry(host, "notes.txt")!);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="host-file"]')?.textContent).toContain(
        "hello host",
      );
    });
    expect(host.container.querySelector('[data-testid="preview-image"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="preview-panel"]')).toBeNull();
    // The control that makes the first test's routing a decision: this path still uses the
    // text reader alone, so "it read the bytes" is not true of every host file.
    expect(bridge.cmd("host_fs_read_bytes")).toHaveLength(1);
  });

  test("a refresh that drops the row retires the host binary preview describing it", async () => {
    // The `previewTarget` arm of the `gone` sweep is the one clause of it with no coverage: the
    // `<pre>` and the stat card each have a refresh-drops-the-row control, but the panel a host
    // **binary** file opens is retired by a *different* line (`gone.has(previewTarget.id)`, its id
    // being the row's path). A refresh of the directory on screen takes no panel token (`moved` is
    // false), so nothing else can retire it: without this arm the panel keeps a photo whose row has
    // left the listing, next to a listing that no longer names it.
    const bridge = installPreviewBridge();
    const host = render(FilesApp);
    await openHost(host);
    await vi.waitFor(() => expect(txt(host)).toContain("photo.jpg"));

    await fireEvent.click(hostEntry(host, "photo.jpg")!);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-image"]')).not.toBeNull(),
    );

    bridge.dropRow("/tmp/fence/photo.jpg");
    bridge.fireWatchEvent();
    await vi.waitFor(() => expect(bridge.cmd("host_fs_read_dir")).toHaveLength(2));
    await settle();

    expect(
      host.container.querySelector('[data-testid="preview-panel"]'),
      "the listing that lands no longer holds the row the panel was describing",
    ).toBeNull();
  });

  test("a refresh that keeps the row leaves the host binary preview standing", async () => {
    // The negative control for the arm above — and the reason it is a *difference* set rather than
    // an unconditional retire: the watch is recursive from the root, so a refresh whose listing
    // still holds the photo (an edit to some other file in the tree) must not throw away what the
    // user opened. A `closePreview()` on every refresh passes the arm above and fails here.
    const bridge = installPreviewBridge();
    const host = render(FilesApp);
    await openHost(host);
    await vi.waitFor(() => expect(txt(host)).toContain("photo.jpg"));

    await fireEvent.click(hostEntry(host, "photo.jpg")!);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-image"]')).not.toBeNull(),
    );

    bridge.fireWatchEvent();
    await vi.waitFor(() => expect(bridge.cmd("host_fs_read_dir")).toHaveLength(2));
    await settle();

    expect(
      host.container.querySelector('[data-testid="preview-image"]')?.getAttribute("src"),
      "the refresh lists the same row, so the panel is still describing a file on screen",
    ).toBe("data:image/jpeg;base64,AAECAwQ=");
  });

  test("opening a device file's preview closes the host text panel", async () => {
    // The reciprocal of 「opening a text host file afterwards closes the preview panel」, and the
    // same rule: one file, one surface. `openHostEntry` retires the panel before painting the
    // `<pre>`; the device-list route (`openPreview`) painted the panel **without** retiring the
    // `<pre>`, so the screen claimed two files at once — the host notes file under the host
    // browser and the device file in the shared panel above it.
    writeStoreValue("amos.files", [
      { id: "n", type: "file", name: "note.txt", content: "你好世界", ts: 1000 },
    ]);
    const bridge = installPreviewBridge({ files: { "/tmp/fence/notes.txt": "hello host" } });
    const host = render(FilesApp);
    await openHost(host);
    await vi.waitFor(() => expect(txt(host)).toContain("notes.txt"));

    await fireEvent.click(hostEntry(host, "notes.txt")!);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="host-file"]')?.textContent).toContain(
        "hello host",
      ),
    );

    const btn = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "") === "预览" || (b.getAttribute("aria-label") ?? "").startsWith("预览 "),
    ) as HTMLButtonElement;
    expect(btn, "本地文件的「预览」按钮应与主机区同页").toBeTruthy();
    await fireEvent.click(btn);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-image"]')).not.toBeNull(),
    );

    expect(
      host.container.querySelector('[data-testid="host-file"]'),
      "一个文件一个界面：主机 <pre> 不许在设备文件预览打开后继续留着",
    ).toBeNull();
    void bridge;
  });

  test("a host read that lands after a device file's preview does not repaint the <pre>", async () => {
    // The other half of `retireHostSurfaces`: clearing the surfaces closes the ones already on
    // screen, but only claiming the token stops a host read **still in flight** from painting its
    // `<pre>` back over the device file the user opened while waiting.
    writeStoreValue("amos.files", [
      { id: "n", type: "file", name: "note.txt", content: "你好世界", ts: 1000 },
    ]);
    let releaseText: ((v: unknown) => void) | null = null;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "host_fs_root_status") return { root: "/tmp/fence", exists: true, reason: null };
        if (cmd === "host_fs_read_dir")
          return [entry("/tmp/fence/notes.txt", "notes.txt", false, 5)];
        if (cmd === "host_fs_read_text")
          return new Promise((resolve) => {
            releaseText = (v) => resolve(v);
          });
        if (cmd === "files_preview_bytes")
          return { kind: "image", data: "data:image/jpeg;base64,AAECAwQ=", mime: "image/jpeg", isText: false, sizeLabel: "4 B", error: null };
        if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 1 };
        if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(FilesApp);
    await openHost(host);
    await vi.waitFor(() => expect(txt(host)).toContain("notes.txt"));

    // The host read is held; the device preview opens meanwhile.
    await fireEvent.click(hostEntry(host, "notes.txt")!);
    const btn = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "") === "预览" || (b.getAttribute("aria-label") ?? "").startsWith("预览 "),
    ) as HTMLButtonElement;
    await fireEvent.click(btn);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-image"]')).not.toBeNull(),
    );

    releaseText!({ path: "/tmp/fence/notes.txt", size: 10, body: "hello host", truncated: false });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(
      host.container.querySelector('[data-testid="host-file"]'),
      "迟到的主机读取不许把 <pre> 画回设备文件的预览之上",
    ).toBeNull();
  });

  test("two device file previews racing: the one opened last is the one that paints", async () => {
    // The device family has the same race as the host one, and the 「预览」 button is never
    // disabled: `openPreview` writes `previewTarget` at once but `previewPlan` only after the
    // await, so a slower reply for the *first* file lands under the *second* file's title —
    // the panel names one file and draws another.
    writeStoreValue("amos.files", [
      { id: "a", type: "file", name: "alpha.txt", content: "A", ts: 1000 },
      { id: "b", type: "file", name: "beta.txt", content: "B", ts: 1001 },
    ]);
    const pending: { name: string; resolve: (v: unknown) => void }[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "files_preview_bytes") {
          const name = (args as { name?: string } | undefined)?.name ?? "";
          return new Promise((resolve) => pending.push({ name, resolve: (v) => resolve(v) }));
        }
        if (cmd === "host_fs_root_status") return { root: "/tmp/fence", exists: true, reason: null };
        if (cmd === "host_fs_read_dir") return [];
        if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 1 };
        if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(FilesApp);
    await vi.waitFor(() => expect(txt(host)).toContain("alpha.txt"));

    const plan = (b64: string) => ({
      kind: "image" as const,
      data: `data:image/png;base64,${b64}`,
      mime: "image/png",
      isText: false,
      sizeLabel: "1 B",
      error: null,
    });
    const previewBtn = (name: string) =>
      host.container.querySelector<HTMLButtonElement>(`button[aria-label="预览 ${name}"]`);

    await fireEvent.click(previewBtn("alpha.txt")!);
    await vi.waitFor(() => expect(pending.some((p) => p.name === "alpha.txt")).toBe(true));
    await fireEvent.click(previewBtn("beta.txt")!);
    await vi.waitFor(() => expect(pending.some((p) => p.name === "beta.txt")).toBe(true));

    // The file opened last answers first; the earlier one answers late and must not win.
    pending.find((p) => p.name === "beta.txt")!.resolve(plan("BE="));
    await new Promise((r) => setTimeout(r, 0));
    pending.find((p) => p.name === "alpha.txt")!.resolve(plan("QQ=="));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(
      host.container.querySelector('[data-testid="preview-title"]')?.textContent,
    ).toContain("beta.txt");
    expect(
      host.container.querySelector('[data-testid="preview-image"]')?.getAttribute("src"),
      "面板标着最后点开的文件，就必须画那个文件的预览",
    ).toContain("BE=");
  });

  test("a host navigation that fails retires the device preview it superseded", async () => {
    // The panel's spinner is owned by whoever took the surface last. Every taker resolves it —
    // except a **failed** host listing, whose branch leaves the old listing on screen and so
    // never called `closePreview()`. A device preview superseded by that failure therefore had
    // its reply dropped *and* nobody to end its spinner: the panel showed the device file's
    // title over a spinner that never stopped.
    writeStoreValue("amos.files", [
      { id: "n", type: "file", name: "note.txt", content: "你好世界", ts: 1000 },
    ]);
    let dirCalls = 0;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "host_fs_root_status") return { root: "/tmp/fence", exists: true, reason: null };
        if (cmd === "host_fs_read_dir") {
          dirCalls += 1;
          if (dirCalls === 1) return [entry("/tmp/fence/sub", "sub", true)];
          throw { code: "amos.host_fs.root_not_found", message: "no" };
        }
        if (cmd === "files_preview_bytes")
          return new Promise(() => {}); // never answers: the reply is not the point here
        if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 1 };
        if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(FilesApp);
    await openHost(host);
    await vi.waitFor(() => expect(txt(host)).toContain("sub"));

    // Hold a device preview open, then walk into a folder the host refuses to list.
    const previewBtn = [...host.container.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? "").startsWith("预览 "),
    ) as HTMLButtonElement;
    await fireEvent.click(previewBtn);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-panel"]')).not.toBeNull(),
    );

    await fireEvent.click(hostEntry(host, "sub")!);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="host-error"]')?.textContent).not.toBe(""),
    );

    expect(
      host.container.querySelector('[data-testid="preview-panel"]'),
      "被失败导航取代的预览必须被收走，不许永远转圈",
    ).toBeNull();
  });

  test("a host file open that fails retires the device preview it superseded", async () => {
    // The sibling of the failed-navigation case above, in `openHostEntry`: its success arms
    // resolve the shared panel — text calls `closePreview()`, a preview paints the panel
    // itself — but its **error** arm only sets the banner. A device preview superseded by a
    // host open the host then refuses therefore had its reply dropped *and* nobody to end its
    // spinner: the same stuck panel, one function over from the one the other test pins.
    writeStoreValue("amos.files", [
      { id: "n", type: "file", name: "note.txt", content: "你好世界", ts: 1000 },
    ]);
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "host_fs_root_status") return { root: "/tmp/fence", exists: true, reason: null };
        if (cmd === "host_fs_read_dir") return [entry("/tmp/fence/host.txt", "host.txt", false, 5)];
        // Not `read_not_utf8`: a real refusal, so `openHostFile` answers `kind:"error"` and the
        // bytes reader is never licensed.
        if (cmd === "host_fs_read_text") throw { code: "amos.host_fs.file_too_large", message: "no" };
        if (cmd === "files_preview_bytes") return new Promise(() => {}); // the device reply is not the point
        if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 1 };
        if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(FilesApp);
    await openHost(host);
    await vi.waitFor(() => expect(txt(host)).toContain("host.txt"));

    // Hold a device preview open, then tap a host row whose read the host refuses.
    const previewBtn = [...host.container.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? "").startsWith("预览 "),
    ) as HTMLButtonElement;
    await fireEvent.click(previewBtn);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-panel"]')).not.toBeNull(),
    );

    await fireEvent.click(hostEntry(host, "host.txt")!);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="host-error"]')?.textContent).not.toBe(""),
    );

    expect(
      host.container.querySelector('[data-testid="preview-panel"]'),
      "被失败的主机打开取代的预览必须被收走，不许永远转圈",
    ).toBeNull();
  });

  test("a device preview does not discard a host listing that is still in flight", async () => {
    // A listing and the shared info panel are two different regions, and rounds 1-9 guarded
    // both with **one** counter — so a device preview opened while a folder was still listing
    // dropped that listing: the folder the user had just clicked into never opened. (Once the
    // takeover began clearing `hostBusy` for the strand that caused, the region did not even
    // say 「加载中」: it settled on 「此文件夹为空」, a claim nobody established.)
    writeStoreValue("amos.files", [
      { id: "n", type: "file", name: "note.txt", content: "你好世界", ts: 1000 },
    ]);
    let releaseDir: ((v: unknown) => void) | null = null;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "host_fs_root_status") return { root: "/tmp/fence", exists: true, reason: null };
        // The root listing is held open until the test releases it.
        if (cmd === "host_fs_read_dir")
          return new Promise((r) => {
            releaseDir = r;
          });
        if (cmd === "files_preview_bytes")
          return {
            kind: "image",
            data: "data:image/jpeg;base64,AAECAwQ=",
            mime: "image/jpeg",
            isText: false,
            sizeLabel: "4 B",
            error: null,
          };
        if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 1 };
        if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(FilesApp);
    await openHost(host);

    // A device preview claims the shared panel while the listing is still unanswered.
    const previewBtn = [...host.container.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? "").startsWith("预览 "),
    ) as HTMLButtonElement;
    await fireEvent.click(previewBtn);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-panel"]')).not.toBeNull(),
    );

    // The listing finally answers. It belongs to its own region, so it must still paint — and
    // the panel it never claimed must not have been retired to make room for it.
    releaseDir!([entry("/tmp/fence/sub", "sub", true)]);
    await vi.waitFor(() => expect(txt(host)).toContain("sub"));
    expect(
      txt(host),
      "被丢弃的主机列目录只会让区域谎称「此文件夹为空」",
    ).not.toContain("此文件夹为空");
    expect(host.container.querySelector('[data-testid="preview-panel"]')).not.toBeNull();
  });

  test("a device preview opened while a navigation is in flight survives the folder landing", async () => {
    // The test above is the *non-moving* case, where the landing's own `!moved` clause already
    // spares any newer claim. Here the landing **does** move (a folder click), so only the device
    // half of the gate can spare the preview: a device claim belongs to no directory
    // (`takeOverSharedPanel`), so the folder the user clicked into must not close it on the way in.
    writeStoreValue("amos.files", [
      { id: "n", type: "file", name: "note.txt", content: "你好世界", ts: 1000 },
    ]);
    let dirCalls = 0;
    let releaseDir: ((v: unknown) => void) | null = null;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "host_fs_root_status") return { root: "/tmp/fence", exists: true, reason: null };
        if (cmd === "host_fs_read_dir") {
          dirCalls += 1;
          if (dirCalls === 1) return [entry("/tmp/fence/sub", "sub", true)];
          // The navigation is held open until the test releases it.
          return new Promise((r) => {
            releaseDir = r;
          });
        }
        if (cmd === "files_preview_bytes")
          return {
            kind: "image",
            data: "data:image/jpeg;base64,AAECAwQ=",
            mime: "image/jpeg",
            isText: false,
            sizeLabel: "4 B",
            error: null,
          };
        if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 1 };
        if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(FilesApp);
    await openHost(host);
    await vi.waitFor(() => expect(hostEntry(host, "sub")).toBeDefined());

    // The user descends into `sub`; the listing is unanswered.
    await fireEvent.click(hostEntry(host, "sub")!);
    await vi.waitFor(() => expect(releaseDir).not.toBeNull());

    // A device preview claims the shared panel while that navigation is in flight.
    const previewBtn = [...host.container.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? "").startsWith("预览 "),
    ) as HTMLButtonElement;
    await fireEvent.click(previewBtn);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-panel"]')).not.toBeNull(),
    );

    // The navigation answers: the breadcrumb moves into `sub`.
    releaseDir!([entry("/tmp/fence/sub/readme.md", "readme.md", false, 3)]);
    await vi.waitFor(() => expect(txt(host)).toContain("readme.md"));

    expect(
      host.container.querySelector('[data-testid="preview-panel"]'),
      "the device preview belongs to no directory — a folder landing must not close it",
    ).not.toBeNull();
  });

  test("a host open superseded by a device preview releases the busy flag", async () => {
    // The one host read a device takeover *does* drop (its token bump supersedes the panel
    // claim an open holds), and therefore the one whose `hostBusy` the takeover must release:
    // the dropped reply can never reach its own `hostBusy = false`, and the takeover never set
    // the flag. A listing is not dropped, so it keeps its flag and clears it itself.
    writeStoreValue("amos.files", [
      { id: "n", type: "file", name: "note.txt", content: "你好世界", ts: 1000 },
    ]);
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "host_fs_root_status") return { root: "/tmp/fence", exists: true, reason: null };
        if (cmd === "host_fs_read_dir") return [entry("/tmp/fence/a.txt", "a.txt", false, 5)];
        // The open is held open; it will be superseded and its reply dropped.
        if (cmd === "host_fs_read_text") return new Promise(() => {});
        if (cmd === "files_preview_bytes")
          return {
            kind: "image",
            data: "data:image/jpeg;base64,AAECAwQ=",
            mime: "image/jpeg",
            isText: false,
            sizeLabel: "4 B",
            error: null,
          };
        if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 1 };
        if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(FilesApp);
    await openHost(host);
    await vi.waitFor(() => expect(txt(host)).toContain("a.txt"));

    const statBtn = () =>
      host.container.querySelector('[data-testid="host-stat-button"]') as HTMLButtonElement | null;

    // Open the host file: it never answers, so the host browser is busy.
    await fireEvent.click(hostEntry(host, "a.txt")!);
    await vi.waitFor(() => expect(statBtn()!.disabled).toBe(true));

    // A device preview supersedes it.
    const previewBtn = [...host.container.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? "").startsWith("预览 "),
    ) as HTMLButtonElement;
    await fireEvent.click(previewBtn);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-panel"]')).not.toBeNull(),
    );

    expect(
      statBtn()?.disabled,
      "被设备预览取代的主机「打开」必须放开 hostBusy，否则主机栏永远停在「加载中」且所有控制禁用",
    ).toBe(false);
  });

  test("any other refusal is still an error, and never opens the preview panel", async () => {
    // The negative control for the wiring. `file_too_large` is a real failure; a fallback
    // keyed on "any refusal" would read the bytes, ask the classifier, and render a preview
    // of a file the host declined to hand over.
    const bridge = installPreviewBridge({ refuseWith: "amos.host_fs.file_too_large" });
    const host = render(FilesApp);
    await openHost(host);
    await vi.waitFor(() => expect(txt(host)).toContain("photo.jpg"));

    await fireEvent.click(hostEntry(host, "photo.jpg")!);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="host-error"]')?.textContent).not.toBe(""),
    );
    expect(host.container.querySelector('[data-testid="preview-panel"]')).toBeNull();
    expect(bridge.cmd("host_fs_read_bytes")).toHaveLength(0);
    expect(bridge.cmd("files_preview_bytes")).toHaveLength(0);
  });

  test("a host read's truncation notice does not follow onto the next file's preview", async () => {
    // The notice says a fact about **one host read**: "the host stopped at the cap, so this
    // preview is of a prefix". It is drawn inside the shared preview panel, which outlives the
    // file it was showing — so a writer that paints the panel for a *different* file without
    // clearing it makes the panel state that fact about a file the host never read.
    // `openHostEntry` sets it; `openPreview`/`openExternalPreview` (the local and MediaStore
    // routes into the same panel) did not clear it.
    writeStoreValue("amos.files", [
      { id: "n", type: "file", name: "note.txt", content: "你好世界", ts: 1000 },
    ]);
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "host_fs_root_status") return { root: "/tmp/fence", exists: true, reason: null };
        if (cmd === "host_fs_read_dir")
          return [{ path: "/tmp/fence/photo.jpg", name: "photo.jpg", isDir: false, size: 9, mtimeMs: 1 }];
        if (cmd === "host_fs_read_text") throw { code: "amos.host_fs.read_not_utf8", message: "no" };
        // **Truncated** — the host read stopped at the cap. This is the fact under test.
        if (cmd === "host_fs_read_bytes")
          return { path: "/tmp/fence/photo.jpg", size: 9, body: "AAECAwQ=", truncated: true };
        if (cmd === "files_preview_bytes")
          return { kind: "image", data: "data:image/jpeg;base64,AAECAwQ=", mime: "image/jpeg", isText: false, sizeLabel: "4 B", error: null };
        if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 1 };
        if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(FilesApp);
    await openHost(host);
    await vi.waitFor(() => expect(txt(host)).toContain("photo.jpg"));

    await fireEvent.click(hostEntry(host, "photo.jpg")!);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-truncated"]')).not.toBeNull(),
    );

    // Without closing the panel, open a **local** file — the same "open a file" gesture, a
    // different reader, and a file the host never touched.
    const btn = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "") === "预览" || (b.getAttribute("aria-label") ?? "").startsWith("预览 "),
    ) as HTMLButtonElement;
    expect(btn, "本地文件的「预览」按钮应与主机区同页").toBeTruthy();
    await fireEvent.click(btn);

    // Wait for the **plan**, not the title (same reason as the MediaStore case below).
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-image"]')).not.toBeNull(),
    );
    expect(
      host.container.querySelector('[data-testid="preview-title"]')?.textContent,
    ).toContain("note.txt");
    expect(
      host.container.querySelector('[data-testid="preview-truncated"]'),
      "上一次主机读取的截断提示，不许跟到这个文件的预览里",
    ).toBeNull();
  });

  test("the same panel's MediaStore route must not carry it either", async () => {
    // The second of the two writers that painted the panel without clearing the notice.
    // `openExternalPreview` is reached from the 设备文件 list, and a MediaStore item was
    // never read from the host — so the host-truncation sentence is a claim nobody made.
    const item = {
      id: "d1",
      kind: "file",
      collection: "download",
      name: "report.pdf",
      uri: "content://download/report.pdf",
      mime: "application/pdf",
      size_bytes: 2048,
      ts: 1,
    };
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "host_fs_root_status") return { root: "/tmp/fence", exists: true, reason: null };
        if (cmd === "host_fs_read_dir")
          return [{ path: "/tmp/fence/photo.jpg", name: "photo.jpg", isDir: false, size: 9, mtimeMs: 1 }];
        if (cmd === "host_fs_read_text") throw { code: "amos.host_fs.read_not_utf8", message: "no" };
        if (cmd === "host_fs_read_bytes")
          return { path: "/tmp/fence/photo.jpg", size: 9, body: "AAECAwQ=", truncated: true };
        if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 1 };
        if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
        if (cmd === "media_list") return args?.collection === "download" ? [item] : [];
        if (cmd === "media_load") return [1, 2, 3, 4];
        if (cmd === "files_preview_bytes")
          return { kind: "text", data: "….", mime: "text/plain", isText: true, sizeLabel: "4 B", error: null };
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(FilesApp);
    await openHost(host);
    await vi.waitFor(() => expect(txt(host)).toContain("photo.jpg"));
    await fireEvent.click(hostEntry(host, "photo.jpg")!);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-truncated"]')).not.toBeNull(),
    );

    await fireEvent.click(btnContaining(host, "设备文件") as HTMLButtonElement);
    await vi.waitFor(() => expect(txt(host)).toContain("report.pdf"));
    await fireEvent.click(
      host.container.querySelector('[data-testid="external-preview-btn"]') as HTMLButtonElement,
    );
    // Wait for the **plan**, not the title: the title renders while the panel is still in its
    // `{#if previewBusy}` branch, and `preview-truncated` lives in the branch *after* it — so
    // asserting on the title alone would pass whatever `previewTrunc` holds. (An assertion that
    // agrees off the boundary.)
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-text"]')).not.toBeNull(),
    );
    expect(
      host.container.querySelector('[data-testid="preview-title"]')?.textContent,
    ).toContain("report.pdf");
    expect(
      host.container.querySelector('[data-testid="preview-truncated"]'),
      "设备文件不是从主机读的，截断提示不许留在这里",
    ).toBeNull();
  });
});

describe("FilesApp.svelte — host filesystem mutations (REQ-A740)", () => {
  const entry = (path: string, name: string, isDir: boolean) => ({
    path,
    name,
    isDir,
    size: 0,
    mtimeMs: 1_700_000_000_000,
  });
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  // create/rename/copy reply with `FsStat` (camelCase on the wire), not `null` —
  // the wrapper reads a `null` reply as offline, so a wrong shape here would look
  // like a host outage rather than a bug in the test.
  const stat = (path: string, isDir: boolean) => ({
    path,
    exists: true,
    isDir,
    size: 0,
    mtimeMs: 1_700_000_000_000,
  });

  /**
   * A fake `host_fs_*` bridge that actually mutates its listing, so "did the screen
   * relist and show the new truth?" is answerable — not just "was a command sent".
   * Every mutation records its wire args so the `{ args: { … } }` nesting and the
   * `recursive`/`overwrite` defaults are pinned, not assumed.
   */
  function installMutableBridge() {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const rows: Record<string, ReturnType<typeof entry>[]> = {
      "": [entry("/tmp/fence/docs", "docs", true), entry("/tmp/fence/notes.txt", "notes.txt", false)],
      "/tmp/fence/docs": [entry("/tmp/fence/docs/readme.md", "readme.md", false)],
    };
    let confirmAnswer = true;
    const confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => confirmAnswer);

    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        const a = (args?.args ?? {}) as { path?: string; from?: string; to?: string };
        if (cmd === "host_fs_root_status") return { root: "/tmp/fence", exists: true, reason: null };
        if (cmd === "host_fs_read_dir") {
          const list = rows[a.path ?? ""];
          if (list === undefined) throw { code: "amos.host_fs.path_escapes_root", message: "outside" };
          return list;
        }
        if (cmd === "host_fs_read_text") {
          return { path: a.path, size: 0, body: "", truncated: false };
        }
        if (cmd === "host_fs_create_dir") {
          const path = a.path ?? "";
          (rows[parentOf(path)] ??= []).push(entry(path, path.slice(path.lastIndexOf("/") + 1), true));
          rows[path] = [];
          return stat(path, true);
        }
        if (cmd === "host_fs_write_text") {
          const path = a.path ?? "";
          const createOnly = (a as { createOnly?: boolean }).createOnly === true;
          const exists = (rows[parentOf(path)] ?? []).some((e) => e.path === path);
          // The real host refuses a collision when `createOnly` is set; mirroring
          // that here is what lets the test prove a New File cannot eat a file.
          if (createOnly && exists) throw { code: "amos.host_fs.target_exists", message: "exists" };
          if (!exists) {
            (rows[parentOf(path)] ??= []).push(entry(path, path.slice(path.lastIndexOf("/") + 1), false));
          }
          // `host_fs_write_text` replies with `FsWrite` (`{path, size, mtimeMs}`).
          return { path, size: 0, mtimeMs: 1_700_000_000_000 };
        }
        if (cmd === "host_fs_remove") {
          const path = a.path ?? "";
          rows[parentOf(path)] = (rows[parentOf(path)] ?? []).filter((e) => e.path !== path);
          delete rows[path];
          // `host_fs_remove` is the one mutation whose reply is `FsRemoved`, not a stat.
          return { path, removed: true, kind: "file" };
        }
        if (cmd === "host_fs_rename") {
          const from = a.from ?? "";
          const to = a.to ?? "";
          rows[parentOf(from)] = (rows[parentOf(from)] ?? []).map((e) =>
            e.path === from ? { ...e, path: to, name: to.slice(to.lastIndexOf("/") + 1) } : e,
          );
          return stat(to, false);
        }
        if (cmd === "host_fs_copy") {
          const to = a.to ?? "";
          (rows[parentOf(to)] ??= []).push(entry(to, to.slice(to.lastIndexOf("/") + 1), false));
          return stat(to, false);
        }
        if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 1 };
        if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
        return null;
      },
      listen: async () => () => {},
    };
    return {
      calls,
      confirmSpy,
      setConfirm: (v: boolean) => {
        confirmAnswer = v;
      },
      cmd: (name: string) => calls.filter((c) => c.cmd === name),
    };
  }

  const openHost = async (host: { container: HTMLElement }) => {
    await vi.waitFor(() => expect(txt(host)).toContain("主机文件系统"));
    const toggle = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("主机文件系统"),
    );
    await fireEvent.click(toggle as HTMLButtonElement);
  };

  /** Descend into `docs`, so the mutations below run against a real subdirectory. */
  const enterDocs = async (host: { container: HTMLElement }) => {
    await vi.waitFor(() => expect(txt(host)).toContain("docs"));
    const docs = [...host.container.querySelectorAll('[data-testid="host-entry"]')].find((b) =>
      (b.textContent ?? "").includes("docs"),
    ) as HTMLElement;
    await fireEvent.click(docs);
    await vi.waitFor(() => expect(txt(host)).toContain("readme.md"));
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("new folder sends create_dir and the list shows the new truth", async () => {
    const bridge = installMutableBridge();
    const host = render(FilesApp);
    await openHost(host);
    await enterDocs(host);

    await fireEvent.click(host.container.querySelector('[data-testid="host-new-folder"]') as HTMLElement);
    const input = host.container.querySelector('[data-testid="host-name-input"]') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "sub" } });
    await fireEvent.click(host.container.querySelector('[data-testid="host-name-confirm"]') as HTMLElement);

    await vi.waitFor(() => expect(bridge.cmd("host_fs_create_dir")).toHaveLength(1));
    // `recursive: false` is the safe default; the path is the cwd-joined leaf.
    expect(bridge.cmd("host_fs_create_dir")[0]?.args).toEqual({
      args: { path: "/tmp/fence/docs/sub", recursive: false },
    });
    await vi.waitFor(() => expect(txt(host)).toContain("sub"));
  });

  test("rename sends rename(from, to) and relists", async () => {
    const bridge = installMutableBridge();
    const host = render(FilesApp);
    await openHost(host);
    await enterDocs(host);

    await fireEvent.click(host.container.querySelector('[data-testid="host-rename"]') as HTMLElement);
    const input = host.container.querySelector('[data-testid="host-name-input"]') as HTMLInputElement;
    expect(input.value).toBe("readme.md");
    await fireEvent.input(input, { target: { value: "guide.md" } });
    await fireEvent.click(host.container.querySelector('[data-testid="host-name-confirm"]') as HTMLElement);

    await vi.waitFor(() => expect(bridge.cmd("host_fs_rename")).toHaveLength(1));
    expect(bridge.cmd("host_fs_rename")[0]?.args).toEqual({
      args: { from: "/tmp/fence/docs/readme.md", to: "/tmp/fence/docs/guide.md", overwrite: false },
    });
    await vi.waitFor(() => expect(txt(host)).toContain("guide.md"));
  });

  test("duplicate copies beside itself with a suffixed name", async () => {
    const bridge = installMutableBridge();
    const host = render(FilesApp);
    await openHost(host);
    await enterDocs(host);

    await fireEvent.click(host.container.querySelector('[data-testid="host-duplicate"]') as HTMLElement);

    await vi.waitFor(() => expect(bridge.cmd("host_fs_copy")).toHaveLength(1));
    expect(bridge.cmd("host_fs_copy")[0]?.args).toEqual({
      args: {
        from: "/tmp/fence/docs/readme.md",
        to: "/tmp/fence/docs/readme.md 副本",
        overwrite: false,
      },
    });
    await vi.waitFor(() => expect(txt(host)).toContain("readme.md 副本"));
  });

  test("delete asks first: a declined confirm sends no command", async () => {
    const bridge = installMutableBridge();
    const host = render(FilesApp);
    await openHost(host);
    await enterDocs(host);

    bridge.setConfirm(false);
    await fireEvent.click(host.container.querySelector('[data-testid="host-delete"]') as HTMLElement);

    expect(bridge.confirmSpy).toHaveBeenCalledTimes(1);
    expect(bridge.cmd("host_fs_remove")).toHaveLength(0);
    expect(txt(host)).toContain("readme.md");
  });

  test("a confirmed delete removes it and relists", async () => {
    const bridge = installMutableBridge();
    const host = render(FilesApp);
    await openHost(host);
    await enterDocs(host);

    bridge.setConfirm(true);
    await fireEvent.click(host.container.querySelector('[data-testid="host-delete"]') as HTMLElement);

    await vi.waitFor(() => expect(bridge.cmd("host_fs_remove")).toHaveLength(1));
    // A file, so the recursive flag stays off — a folder would opt the tree in.
    expect(bridge.cmd("host_fs_remove")[0]?.args).toEqual({
      args: { path: "/tmp/fence/docs/readme.md", recursive: false },
    });
    await vi.waitFor(() => expect(txt(host)).not.toContain("readme.md"));
  });

  test("new file sends write_text with createOnly and the list shows it", async () => {
    const bridge = installMutableBridge();
    const host = render(FilesApp);
    await openHost(host);
    await enterDocs(host);

    await fireEvent.click(host.container.querySelector('[data-testid="host-new-file"]') as HTMLElement);
    const input = host.container.querySelector('[data-testid="host-name-input"]') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "todo.txt" } });
    await fireEvent.click(host.container.querySelector('[data-testid="host-name-confirm"]') as HTMLElement);

    await vi.waitFor(() => expect(bridge.cmd("host_fs_write_text")).toHaveLength(1));
    // Empty body, no cap override, and `createOnly: true` — the whole contract.
    expect(bridge.cmd("host_fs_write_text")[0]?.args).toEqual({
      args: { path: "/tmp/fence/docs/todo.txt", content: "", cap: null, createOnly: true },
    });
    await vi.waitFor(() => expect(txt(host)).toContain("todo.txt"));
  });

  test("a New File whose name already exists is refused, never a save-over", async () => {
    const bridge = installMutableBridge();
    const host = render(FilesApp);
    await openHost(host);
    await enterDocs(host);

    await fireEvent.click(host.container.querySelector('[data-testid="host-new-file"]') as HTMLElement);
    const input = host.container.querySelector('[data-testid="host-name-input"]') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "readme.md" } });
    await fireEvent.click(host.container.querySelector('[data-testid="host-name-confirm"]') as HTMLElement);

    // The collision reaches the user as its own sentence (the `target_exists`
    // code), and the `createOnly` flag is what made the host refuse it.
    await vi.waitFor(() => expect(txt(host)).toContain("已拒绝：同名项目已存在。"));
    expect(bridge.cmd("host_fs_write_text")).toHaveLength(1);
    expect(bridge.cmd("host_fs_write_text")[0]?.args).toEqual({
      args: { path: "/tmp/fence/docs/readme.md", content: "", cap: null, createOnly: true },
    });
  });

  test("a refused action keeps the listing on screen — only a failed read hides it", async () => {
    // The list region used to key off `hostErr`, so this exact refusal (a New File that
    // collided) wiped a listing that was still correct: the user lost the folder they were
    // looking at. Two facts, two states — the banner is `hostErr`, the hidden list is only
    // `hostListFailed`, which a refused *mutation* never sets.
    const bridge = installMutableBridge();
    const host = render(FilesApp);
    await openHost(host);
    await enterDocs(host);
    const before = host.container.querySelectorAll('[data-testid="host-entry"]').length;
    expect(before).toBeGreaterThan(0);

    await fireEvent.click(host.container.querySelector('[data-testid="host-new-file"]') as HTMLElement);
    const input = host.container.querySelector('[data-testid="host-name-input"]') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "readme.md" } });
    await fireEvent.click(host.container.querySelector('[data-testid="host-name-confirm"]') as HTMLElement);

    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="host-error"]')?.textContent).toContain(
        "已拒绝：同名项目已存在。",
      ),
    );
    // The refusal is stated **and** the listing it happened in is still there, unchanged.
    expect(host.container.querySelectorAll('[data-testid="host-entry"]')).toHaveLength(before);
    expect(txt(host)).toContain("readme.md");
    // …and it is still not a fabricated "empty folder" (REQ-A542's rule).
    expect(txt(host)).not.toContain("此文件夹为空");
  });
});

describe("FilesApp.svelte — Quick Look has a keyboard route (REQ-A789)", () => {
  /** Stub `files_preview_bytes` so a preview actually renders (mirrors the panel block above). */
  function installPreviewBridge() {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "files_preview_bytes") {
          return {
            kind: "text",
            data: new TextDecoder().decode(new Uint8Array((args?.data as number[]) ?? [])),
            mime: "text/plain",
            isText: true,
            sizeLabel: "1 B",
            error: null,
          };
        }
        if (cmd === "files_cloud_validate") return args?.snapshot;
        return null;
      },
      listen: async () => () => {},
    };
  }

  /** Seed a folder first, then a file — so ArrowDown lands somewhere predictable. */
  function seed() {
    window.localStorage.setItem(
      "amos.files",
      JSON.stringify([
        { id: "doc", type: "folder", name: "文档", ts: 1000 },
        { id: "n", type: "file", name: "note.txt", content: "你好世界", ts: 2000 },
      ]),
    );
  }

  const panel = (h: { container: HTMLElement }) =>
    h.container.querySelector('[data-testid="preview-panel"]');

  beforeEach(seed);

  test("⌘Y previews the focused file (it used to be mouse-only)", async () => {
    installPreviewBridge();
    const host = render(FilesApp);

    // Nothing is focused yet: ArrowDown focuses the first row, the folder.
    await fireEvent.keyDown(window, { key: "ArrowDown" });
    // …and a second one reaches the file.
    await fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(panel(host)).toBeNull();

    await fireEvent.keyDown(window, { key: "y", metaKey: true });
    await vi.waitFor(() => expect(panel(host)).toBeTruthy());
    expect(host.container.querySelector('[data-testid="preview-text"]')?.textContent ?? "").toContain(
      "你好世界",
    );

    // The key is advertised, not secret: the row's own button carries the WAI-ARIA spelling, the
    // same way the shell's overlay triggers do. A keyboard route nobody is told about is half a route.
    const previewBtn = host.container.querySelector('[aria-keyshortcuts="Meta+Y"]');
    expect(previewBtn).toBeTruthy();
    expect(previewBtn?.getAttribute("aria-label") ?? "").toContain("note.txt");
  });

  test("⌘Y on a FOLDER opens nothing — a directory is not previewable", async () => {
    installPreviewBridge();
    const host = render(FilesApp);

    await fireEvent.keyDown(window, { key: "ArrowDown" }); // focus the folder
    await fireEvent.keyDown(window, { key: "y", metaKey: true });
    await new Promise<void>((r) => setTimeout(r, 0));
    // The folder must not have been entered either — ⌘Y is not ⌘O.
    expect(panel(host)).toBeNull();
    expect(txt(host)).toContain("文档");
  });

  test("Enter on a FILE previews it — it used to do nothing at all", async () => {
    installPreviewBridge();
    const host = render(FilesApp);

    await fireEvent.keyDown(window, { key: "ArrowDown" }); // folder
    await fireEvent.keyDown(window, { key: "ArrowDown" }); // file
    await fireEvent.keyDown(window, { key: "Enter" });

    await vi.waitFor(() => expect(panel(host)).toBeTruthy());
  });

  test("Enter on a FOLDER still navigates in, not previews", async () => {
    installPreviewBridge();
    const host = render(FilesApp);

    await fireEvent.keyDown(window, { key: "ArrowDown" }); // focus the folder
    await fireEvent.keyDown(window, { key: "Enter" });

    await vi.waitFor(() => expect(txt(host)).toContain("空文件夹"));
    expect(panel(host)).toBeNull();
  });

  test("Space still toggles selection and does NOT preview", async () => {
    installPreviewBridge();
    const host = render(FilesApp);

    await fireEvent.keyDown(window, { key: "ArrowDown" });
    await fireEvent.keyDown(window, { key: "ArrowDown" }); // the file
    await fireEvent.keyDown(window, { key: " " });

    await new Promise<void>((r) => setTimeout(r, 0));
    expect(panel(host)).toBeNull();
  });
});

describe("FilesApp.svelte — an external file whose bytes could not be read (F-SH-281)", () => {
  const item = {
    id: "download/report.pdf",
    kind: "file",
    collection: "download",
    name: "report.pdf",
    uri: "content://download/report.pdf",
    mime: "application/pdf",
    size_bytes: 2048,
    ts: 1,
  };

  /**
   * A media bridge whose `media_load` does what `opts.load` says.
   *
   * Three outcomes matter here and they are not two: bytes, `null` (offline / no host, per
   * `lib/media.ts`'s contract), and a **rejection** on a real host error. `lib/media.ts`'s
   * private `call` does not catch and does not go through `backend.ts::invoke`, so that
   * rejection reaches `void openExternalPreview(…)` unhandled.
   */
  function installLoadBridge(load: () => unknown) {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "media_list") return args?.collection === "download" ? [item] : [];
        if (cmd === "media_load") return load();
        if (cmd === "files_preview_bytes") {
          return {
            kind: "text",
            data: new TextDecoder().decode(new Uint8Array((args?.data as number[]) ?? [])),
            mime: "text/plain",
            isText: true,
            sizeLabel: "2.0 KB",
            error: null,
          };
        }
        return null;
      },
      listen: async () => () => {},
    };
  }

  async function openExternalPreview(host: { container: HTMLElement }): Promise<void> {
    await vi.waitFor(() => expect(txt(host)).toContain("设备文件"));
    await fireEvent.click(btnContaining(host, "设备文件") as HTMLButtonElement);
    await vi.waitFor(() => expect(txt(host)).toContain("report.pdf"));
    await fireEvent.click(
      host.container.querySelector('[data-testid="external-preview-btn"]') as HTMLButtonElement,
    );
  }

  test("a read that rejected is not rendered as a fact about the file", async () => {
    installLoadBridge(() => {
      throw new Error("media_load: permission needed");
    });
    const host = render(FilesApp);
    await openExternalPreview(host);

    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-unavailable"]')).toBeTruthy(),
    );
    // The panel has no `{:else}` after `{:else if previewPlan}`, so before this fix the body
    // was simply absent — an open preview that said nothing at all.
    expect(
      host.container.querySelector('[data-testid="preview-binary"]'),
      "「二进制文件」 is a claim about the file, and nobody read it",
    ).toBeNull();
    expect(
      host.container.querySelector('[data-testid="preview-unavailable-reason"]')?.textContent ?? "",
    ).toContain("宿主拒绝提供该文件的内容");
  });

  test("a read that answered `null` is not rendered as a fact about the file either", async () => {
    installLoadBridge(() => null);
    const host = render(FilesApp);
    await openExternalPreview(host);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-unavailable"]')).toBeTruthy(),
    );
    expect(host.container.querySelector('[data-testid="preview-binary"]')).toBeNull();
  });

  test("a host that went away mid-session says so, distinctly from a refusal", async () => {
    installLoadBridge(() => new Uint8Array([1, 2, 3]));
    const host = render(FilesApp);
    await vi.waitFor(() => expect(txt(host)).toContain("设备文件"));
    await fireEvent.click(btnContaining(host, "设备文件") as HTMLButtonElement);
    await vi.waitFor(() => expect(txt(host)).toContain("report.pdf"));
    // The host is gone before the click: `media_load` answers `null` for "nothing to ask",
    // which is a different sentence from "the host would not serve it".
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    await fireEvent.click(
      host.container.querySelector('[data-testid="external-preview-btn"]') as HTMLButtonElement,
    );
    await vi.waitFor(() =>
      expect(
        host.container.querySelector('[data-testid="preview-unavailable-reason"]')?.textContent ?? "",
      ).toContain("没有可以读取该文件的宿主"),
    );
  });

  test("control: a read that answered bytes still shows the host's own classification", async () => {
    installLoadBridge(() => [104, 105]); // "hi"
    const host = render(FilesApp);
    await openExternalPreview(host);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-text"]')?.textContent ?? "").toContain("hi"),
    );
    expect(
      host.container.querySelector('[data-testid="preview-unavailable"]'),
      "the notice belongs to a failed read, not to every external preview",
    ).toBeNull();
  });
});

/**
 * The select-all chip must **label itself with the same predicate it acts on** (REQ-A1081).
 *
 * `toggleSelectAll` decides from membership (`display.every(id => selIds.has(id))`), but the
 * label was computed from a **count** (`selIds.size === display.length`). Selection deliberately
 * survives a view switch (`applyView`'s own comment) and a search edit (only the *query* changes),
 * so `selIds` routinely holds ids that are no longer on screen — and when the counts coincide the
 * chip reads 「全不选」 while the click **selects** everything shown. A control whose label
 * promises the opposite of what pressing it does.
 */
describe("FilesApp.svelte — the select-all chip's label is its action (REQ-A1081)", () => {
  beforeEach(() => window.localStorage.clear());

  const chip = (host: { container: HTMLElement }) =>
    [...host.container.querySelectorAll("button")].find((b) => {
      const s = (b.textContent ?? "").trim();
      return s === "全不选" || s.startsWith("全选");
    }) as HTMLButtonElement | undefined;

  test("a selection that is off-screen does not make the chip claim 「全不选」", async () => {
    const host = render(FilesApp);
    await fireEvent.click(btnContaining(host, "选择")!); // enter select mode
    await fireEvent.click(btnContaining(host, "文档")!); // selIds = {文档}

    // Narrow the view to the one row that is NOT selected: display = [说明.txt], length 1,
    // while selIds.size is also 1 — the count test says "all shown are selected".
    const search = host.container.querySelector<HTMLInputElement>('[data-testid="file-search"]')!;
    await fireEvent.input(search, { target: { value: "说明" } });

    expect(
      chip(host)?.textContent?.trim(),
      "说明.txt is not selected, so the chip must offer to select — not to clear",
    ).toBe("全选 (1)");
  });

  test("the same lie by the other door: switching the view keeps the selection too", async () => {
    const host = render(FilesApp);
    await fireEvent.click(btnContaining(host, "选择")!);
    await fireEvent.click(btnContaining(host, "文档")!); // selIds = {文档}

    // 最近 lists *files only*, so display = [说明.txt]: one shown, one selected, no overlap.
    await fireEvent.click(btnContaining(host, "最近")!);
    expect(chip(host)?.textContent?.trim()).toBe("全选 (1)");
  });

  test("control: whatever the label says, the click selects exactly what is shown", async () => {
    const host = render(FilesApp);
    await fireEvent.click(btnContaining(host, "选择")!);
    await fireEvent.click(btnContaining(host, "文档")!);
    const search = host.container.querySelector<HTMLInputElement>('[data-testid="file-search"]')!;
    await fireEvent.input(search, { target: { value: "说明" } });

    await fireEvent.click(chip(host)!);
    // The action is membership-based and was always right: it takes `new Set(visible)`, so the
    // off-screen 文档 is dropped and only the shown row is selected.
    expect(chip(host)?.textContent?.trim()).toBe("全不选");
    expect(btnContaining(host, "删除所选")?.textContent).toContain("1");
  });
});

/**
 * The three `host_fs_*` reads that `lib/hostFs.ts` exported with no production caller
 * (REQ-A1443 / F-SH-699). Each test drives the surface's own control and then reads the
 * **wire**, because a helper that is imported but whose answer is thrown away would still
 * satisfy a"does it compile" check.
 */
describe("FilesApp.svelte — hostFsStat / hostFsWriteBytes / hostFsWatchList (REQ-A1443 / F-SH-699)", () => {
  type Invoke = { cmd: string; args?: Record<string, unknown> };

  function installWiredBridge(
    opts: {
      root?: string | null;
      stat?: Record<string, unknown>;
      statCode?: string;
      watchIds?: number[];
      writeCode?: string;
    } = {},
  ) {
    const invokes: Invoke[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        invokes.push({ cmd, args });
        if (cmd === "files_bundle_export") {
          return {
            text: "AmosFilesBundle/1.0\nQUJD",
            originalBytes: 100,
            compressedBytes: 50,
            entryCount: 2,
            ratioLabel: "50%",
          };
        }
        if (cmd === "host_fs_root_status") {
          return { root: opts.root === undefined ? "/tmp/fence" : opts.root, exists: true, reason: null };
        }
        if (cmd === "host_fs_read_dir") {
          const path = (args?.args as { path?: string } | undefined)?.path ?? "";
          if (path !== "") return [];
          return [
            { path: "/tmp/fence/notes.txt", name: "notes.txt", isDir: false, size: 10, mtimeMs: 1_700_000_000_000 },
            { path: "/tmp/fence/docs", name: "docs", isDir: true, size: 0, mtimeMs: 1_700_000_000_000 },
          ];
        }
        if (cmd === "host_fs_watch_subscribe") return { subscriptionId: 1 };
        if (cmd === "host_fs_watch_unsubscribe") return { removed: true };
        if (cmd === "host_fs_watch_list") return opts.watchIds ?? [1];
        if (cmd === "host_fs_stat") {
          if (opts.statCode) throw { code: opts.statCode, message: "refused" };
          return (
            opts.stat ?? {
              path: "/tmp/fence/notes.txt",
              exists: true,
              isDir: false,
              size: 42,
              mtimeMs: 1_700_000_000_000,
            }
          );
        }
        if (cmd === "host_fs_write_bytes") {
          if (opts.writeCode) throw { code: opts.writeCode, message: "refused" };
          return { path: "/tmp/fence/amos-bundle-x.amos-bundle", size: 24, mtimeMs: 1_700_000_000_000 };
        }
        return null;
      },
      listen: async () => () => {},
    };
    return invokes;
  }

  const hostOf = async (h: { container: HTMLElement }, first = "notes.txt") => {
    await vi.waitFor(() => expect(txt(h)).toContain("主机文件系统"));
    // Scope to the host section and match its `aria-pressed` toggle: matching on text would
    // also catch the bundle actions that mention the host, and other chips carry aria-pressed.
    const toggle = h.container.querySelector<HTMLButtonElement>(
      'section[aria-label="主机文件系统"] button[aria-pressed]',
    );
    await fireEvent.click(toggle as HTMLButtonElement);
    await vi.waitFor(() => expect(txt(h)).toContain(first));
  };

  /** The action button in the row whose name contains `name`. */
  const rowButton = (h: { container: HTMLElement }, name: string, testid: string) => {
    const entry = [...h.container.querySelectorAll<HTMLElement>('[data-testid="host-entry"]')].find(
      (b) => (b.textContent ?? "").includes(name),
    );
    return entry?.parentElement?.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`) ?? null;
  };

  const argsOf = (invokes: Invoke[], cmd: string) =>
    invokes.filter((i) => i.cmd === cmd).map((i) => i.args?.args as Record<string, unknown> | undefined);

  /**
   * A bridge whose `host_fs_stat` / `host_fs_read_text` **do not resolve until the test says so** —
   * the window in which the user can navigate out of the folder before the read answers. The
   * row that navigates (`host-entry`) is deliberately never disabled, so this window is real.
   */
  function installDeferredReplyBridge() {
    const invokes: Invoke[] = [];
    let releaseStat: ((v: unknown) => void) | null = null;
    let releaseText: ((v: unknown) => void) | null = null;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        invokes.push({ cmd, args });
        if (cmd === "host_fs_root_status") {
          return Promise.resolve({ root: "/tmp/fence", exists: true, reason: null });
        }
        if (cmd === "host_fs_read_dir") {
          const path = (args?.args as { path?: string } | undefined)?.path ?? "";
          if (path === "") {
            return Promise.resolve([
              { path: "/tmp/fence/notes.txt", name: "notes.txt", isDir: false, size: 10, mtimeMs: 1_700_000_000_000 },
              { path: "/tmp/fence/docs", name: "docs", isDir: true, size: 0, mtimeMs: 1_700_000_000_000 },
            ]);
          }
          return Promise.resolve([
            { path: `${path}/readme.md`, name: "readme.md", isDir: false, size: 3, mtimeMs: 1_700_000_000_000 },
          ]);
        }
        if (cmd === "host_fs_watch_subscribe") return Promise.resolve({ subscriptionId: 1 });
        if (cmd === "host_fs_watch_unsubscribe") return Promise.resolve({ removed: true });
        if (cmd === "host_fs_watch_list") return Promise.resolve([1]);
        if (cmd === "host_fs_stat") {
          return new Promise((resolve) => {
            releaseStat = (v) => resolve(v);
          });
        }
        if (cmd === "host_fs_read_text") {
          return new Promise((resolve) => {
            releaseText = (v) => resolve(v);
          });
        }
        return Promise.resolve(null);
      },
    };
    return {
      invokes,
      releaseStat: (v: unknown) => releaseStat?.(v),
      releaseText: (v: unknown) => releaseText?.(v),
      sawStat: () => releaseStat !== null,
      sawText: () => releaseText !== null,
    };
  }

  /** Let every pending microtask + timer callback drain. */
  const settle = async () => {
    for (let i = 0; i < 3; i += 1) {
      await tick();
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  };

  /**
   * A bridge whose `host_fs_read_dir` replies are held until the test releases them, so two
   * navigations can be in flight at once and answered **out of order** — the host is free to
   * answer the second before the first. The row button that starts a navigation is never
   * disabled, so this is reachable by clicking two folders in quick succession.
   */
  function installRacingDirBridge() {
    const invokes: Invoke[] = [];
    const pending: { path: string; resolve: (v: unknown) => void }[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        invokes.push({ cmd, args });
        if (cmd === "host_fs_root_status") {
          return Promise.resolve({ root: "/tmp/fence", exists: true, reason: null });
        }
        if (cmd === "host_fs_read_dir") {
          const path = (args?.args as { path?: string } | undefined)?.path ?? "";
          return new Promise((resolve) => {
            pending.push({ path, resolve: (v) => resolve(v) });
          });
        }
        if (cmd === "host_fs_watch_subscribe") return Promise.resolve({ subscriptionId: 1 });
        if (cmd === "host_fs_watch_unsubscribe") return Promise.resolve({ removed: true });
        if (cmd === "host_fs_watch_list") return Promise.resolve([1]);
        return Promise.resolve(null);
      },
    };
    const dir = (path: string) => ({ path, name: path.split("/").pop(), isDir: true, size: 0, mtimeMs: 1_700_000_000_000 });
    const file = (path: string) => ({ path, name: path.split("/").pop(), isDir: false, size: 4, mtimeMs: 1_700_000_000_000 });
    return {
      invokes,
      rows: { root: [dir("/tmp/fence/docs"), dir("/tmp/fence/src")], docs: [file("/tmp/fence/docs/readme.md")], src: [file("/tmp/fence/src/main.rs")] },
      hasPending: (path: string) => pending.some((p) => p.path === path),
      resolveDir: (path: string, rows: unknown[]) => {
        const i = pending.findIndex((p) => p.path === path);
        const hit = pending.splice(i, 1)[0];
        hit.resolve(rows);
      },
    };
  }

  test("a listing that answers after a newer navigation does not repaint the folder", async () => {
    const bridge = installRacingDirBridge();
    const host = render(FilesApp);

    // The first listing is held too, so open the panel and hand it the root rows by hand.
    await vi.waitFor(() => expect(bridge.hasPending("")).toBe(true));
    const toggle = host.container.querySelector<HTMLButtonElement>(
      'section[aria-label="主机文件系统"] button[aria-pressed]',
    );
    await fireEvent.click(toggle as HTMLButtonElement);
    bridge.resolveDir("", bridge.rows.root);
    await vi.waitFor(() => expect(txt(host)).toContain("docs"));

    // Two navigations issued while the first is still unanswered: docs, then src.
    await fireEvent.click(rowButton(host, "docs", "host-entry")!);
    await vi.waitFor(() => expect(bridge.hasPending("/tmp/fence/docs")).toBe(true));
    await fireEvent.click(rowButton(host, "src", "host-entry")!);
    await vi.waitFor(() => expect(bridge.hasPending("/tmp/fence/src")).toBe(true));

    // The newer navigation answers first, then the older one arrives late.
    bridge.resolveDir("/tmp/fence/src", bridge.rows.src);
    await settle();
    bridge.resolveDir("/tmp/fence/docs", bridge.rows.docs);
    await settle();

    const cwd = host.container.querySelector('[data-testid="host-cwd"]')?.textContent ?? "";
    expect(cwd, "the folder the user last chose is the one that stays on screen").toContain("src");
    expect(cwd).not.toContain("docs");
    expect(txt(host)).toContain("main.rs");
    expect(txt(host)).not.toContain("readme.md");
  });

  test("ⓘ stats the row's path and the card shows what the host says now", async () => {
    const invokes = installWiredBridge({});
    const host = render(FilesApp);
    await hostOf(host);

    await fireEvent.click(rowButton(host, "notes.txt", "host-stat-button")!);

    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="host-stat-line"]')?.textContent).toContain("文件");
    });
    expect(argsOf(invokes, "host_fs_stat")[0]?.path).toBe("/tmp/fence/notes.txt");
  });

  test("exists:false is drawn as a stale listing, not as a refusal", async () => {
    // The listing is a snapshot; a file removed outside AmOS is the only case where this
    // answer says something the row above cannot.
    installWiredBridge({
      stat: { path: "/tmp/fence/notes.txt", exists: false, isDir: false, size: 0, mtimeMs: 0 },
    });
    const host = render(FilesApp);
    await hostOf(host);

    await fireEvent.click(rowButton(host, "notes.txt", "host-stat-button")!);

    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="host-stat-line"]')?.textContent).toContain(
        "已不存在——列表可能已过期。",
      );
    });
    expect(host.container.querySelector('[data-testid="host-error"]')).toBeNull();
  });

  test("a refused stat goes to the banner and leaves no card behind", async () => {
    installWiredBridge({ statCode: "amos.host_fs.path_escapes_root" });
    const host = render(FilesApp);
    await hostOf(host);

    await fireEvent.click(rowButton(host, "notes.txt", "host-stat-button")!);

    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="host-error"]')?.textContent).toContain(
        "已拒绝：该路径超出允许的根目录。",
      );
    });
    expect(host.container.querySelector('[data-testid="host-stat"]')).toBeNull();
  });

  test("the watcher chip reports the host's count, not this screen's one subscription", async () => {
    installWiredBridge({ watchIds: [1, 4, 9] });
    const host = render(FilesApp);
    await vi.waitFor(() => expect(txt(host)).toContain("主机文件系统"));

    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="host-watch-count"]')?.textContent).toContain(
        "3 个活动监视",
      );
    });
  });

  test("saving the bundle writes the exported bytes through host_fs_write_bytes", async () => {
    const invokes = installWiredBridge({});
    const host = render(FilesApp);
    await vi.waitFor(() => expect(txt(host)).toContain("主机文件系统"));

    const summary = host.container.querySelector('[data-testid="bundle-section"] summary') as HTMLElement;
    await fireEvent.click(summary);
    await fireEvent.click(btnContaining(host, "导出为压缩包")!);
    await vi.waitFor(() =>
      expect((host.container.querySelector('[data-testid="bundle-text"]') as HTMLTextAreaElement).value).toContain(
        "AmosFilesBundle/1.0",
      ),
    );

    await fireEvent.click(host.container.querySelector('[data-testid="bundle-save-host"]') as HTMLButtonElement);

    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="bundle-save-msg"]')?.textContent).toContain("已保存到");
    });

    const write = argsOf(invokes, "host_fs_write_bytes")[0];
    expect(write?.path).toMatch(/^amos-bundle-\d{8}-\d{9}\.amos-bundle$/);
    const bytes = base64ToBytes(String(write?.dataB64));
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("AmosFilesBundle/1.0\nQUJD");
  });

  test("two saves inside the same second land on different paths (no silent replace)", async () => {
    const invokes = installWiredBridge({});
    const host = render(FilesApp);
    await vi.waitFor(() => expect(txt(host)).toContain("主机文件系统"));

    const summary = host.container.querySelector('[data-testid="bundle-section"] summary') as HTMLElement;
    await fireEvent.click(summary);
    await fireEvent.click(btnContaining(host, "导出为压缩包")!);
    await vi.waitFor(() =>
      expect((host.container.querySelector('[data-testid="bundle-text"]') as HTMLTextAreaElement).value).toContain(
        "AmosFilesBundle/1.0",
      ),
    );

    // Same wall-clock second, 400 ms apart: a second-resolution stamp names both saves
    // `…-HHMMSS`, and `host_fs_write_bytes` has no create-only flag — so the second would
    // silently replace the first artifact. The millisecond field is what separates them.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 8, 25, 14, 30, 45, 100));
      await fireEvent.click(host.container.querySelector('[data-testid="bundle-save-host"]') as HTMLButtonElement);
      await vi.waitFor(() => expect(invokes.filter((i) => i.cmd === "host_fs_write_bytes")).toHaveLength(1));
      vi.setSystemTime(new Date(2026, 8, 25, 14, 30, 45, 500));
      await fireEvent.click(host.container.querySelector('[data-testid="bundle-save-host"]') as HTMLButtonElement);
      await vi.waitFor(() => expect(invokes.filter((i) => i.cmd === "host_fs_write_bytes")).toHaveLength(2));
    } finally {
      vi.useRealTimers();
    }

    const paths = argsOf(invokes, "host_fs_write_bytes").map((w) => w?.path);
    expect(paths[0]).toMatch(/-143045100\.amos-bundle$/);
    expect(paths[1]).toMatch(/-143045500\.amos-bundle$/);
    expect(paths[0]).not.toBe(paths[1]);
  });

  test("a refused bundle write is a sentence, never a success report", async () => {
    installWiredBridge({ writeCode: "amos.host_fs.path_escapes_root" });
    const host = render(FilesApp);
    await vi.waitFor(() => expect(txt(host)).toContain("主机文件系统"));

    const summary = host.container.querySelector('[data-testid="bundle-section"] summary') as HTMLElement;
    await fireEvent.click(summary);
    await fireEvent.click(btnContaining(host, "导出为压缩包")!);
    await vi.waitFor(() =>
      expect((host.container.querySelector('[data-testid="bundle-text"]') as HTMLTextAreaElement).value).toContain(
        "AmosFilesBundle/1.0",
      ),
    );

    await fireEvent.click(host.container.querySelector('[data-testid="bundle-save-host"]') as HTMLButtonElement);

    await vi.waitFor(() => {
      const msg = host.container.querySelector('[data-testid="bundle-save-msg"]')?.textContent ?? "";
      expect(msg).toContain("已拒绝：该路径超出允许的根目录。");
      expect(msg).not.toContain("已保存到");
    });
  });

  test("no save-to-host button when the fence is unset", async () => {
    installWiredBridge({ root: null });
    const host = render(FilesApp);
    const summary = host.container.querySelector('[data-testid="bundle-section"] summary') as HTMLElement;
    await fireEvent.click(summary);
    await fireEvent.click(btnContaining(host, "导出为压缩包")!);
    await vi.waitFor(() =>
      expect((host.container.querySelector('[data-testid="bundle-text"]') as HTMLTextAreaElement).value).toContain(
        "AmosFilesBundle/1.0",
      ),
    );
    expect(host.container.querySelector('[data-testid="bundle-save-host"]')).toBeNull();
  });

  // ---- the two reports must not outlive what they describe -------------------

  test("the stat card retires when the listing changes under it", async () => {
    installWiredBridge({});
    const host = render(FilesApp);
    await hostOf(host);

    await fireEvent.click(rowButton(host, "notes.txt", "host-stat-button")!);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="host-stat"]')).not.toBeNull(),
    );

    // Descend into another folder: the card describes a path from the folder being left, so a
    // card still on screen would be a claim about a listing that is no longer drawn.
    await fireEvent.click(rowButton(host, "docs", "host-entry")!);

    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="host-cwd"]')?.textContent).toContain("docs");
      expect(host.container.querySelector('[data-testid="host-stat"]')).toBeNull();
    });
  });

  test("a stat reply that lands after the user left the folder does not resurrect the card", async () => {
    const bridge = installDeferredReplyBridge();
    const host = render(FilesApp);
    await hostOf(host);

    await fireEvent.click(rowButton(host, "notes.txt", "host-stat-button")!);
    await vi.waitFor(() => expect(bridge.sawStat()).toBe(true));

    // Descend while the stat is still in flight — the row button that navigates is never
    // disabled, so this is a state the surface really reaches, not a contrived one.
    await fireEvent.click(rowButton(host, "docs", "host-entry")!);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="host-cwd"]')?.textContent).toContain("docs"),
    );

    // The answer for the row in the folder we left arrives only now.
    bridge.releaseStat({ path: "/tmp/fence/notes.txt", exists: true, isDir: false, size: 10, mtimeMs: 1_700_000_000_000 });
    await settle();

    expect(
      host.container.querySelector('[data-testid="host-stat"]'),
      "a card for a row that is not in the listing on screen is a claim about a listing that is gone",
    ).toBeNull();
  });

  test("a file read that lands after the user left the folder does not paint the preview", async () => {
    const bridge = installDeferredReplyBridge();
    const host = render(FilesApp);
    await hostOf(host);

    await fireEvent.click(rowButton(host, "notes.txt", "host-entry")!);
    await vi.waitFor(() => expect(bridge.sawText()).toBe(true));

    await fireEvent.click(rowButton(host, "docs", "host-entry")!);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="host-cwd"]')?.textContent).toContain("docs"),
    );

    bridge.releaseText({ path: "/tmp/fence/notes.txt", size: 2, body: "hi", truncated: false });
    await settle();

    expect(host.container.querySelector('[data-testid="host-file"]')).toBeNull();
  });

  test("the reverse order: a host open answers after the navigation it started behind", async () => {
    // The test above exercises open-then-navigate, where the navigation's token bump drops the
    // open. This is the order the token cannot see: the navigation starts **first**, the user
    // then clicks a row of the listing it is replacing, and the navigation answers before the
    // open does. The listing lands (the breadcrumb moves into `docs`) while the open is the
    // newest *panel* claim, so the listing's panel gate spares it — and its late reply paints a
    // `<pre>` for a root file under a breadcrumb that now names `docs`. That is the claim
    // `loadHostDir`'s success branch states the rule against: a surface describing a row that is
    // not in the listing on screen must not stand.
    const invokes: Invoke[] = [];
    let releaseDir: ((v: unknown) => void) | null = null;
    let releaseText: ((v: unknown) => void) | null = null;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        invokes.push({ cmd, args });
        if (cmd === "host_fs_root_status") {
          return Promise.resolve({ root: "/tmp/fence", exists: true, reason: null });
        }
        if (cmd === "host_fs_read_dir") {
          const path = (args?.args as { path?: string } | undefined)?.path ?? "";
          if (path === "") {
            return Promise.resolve([
              { path: "/tmp/fence/notes.txt", name: "notes.txt", isDir: false, size: 10, mtimeMs: 1_700_000_000_000 },
              { path: "/tmp/fence/docs", name: "docs", isDir: true, size: 0, mtimeMs: 1_700_000_000_000 },
            ]);
          }
          // The navigation is held, so the open below is clicked while it is unanswered.
          return new Promise((resolve) => {
            releaseDir = (v) => resolve(v);
          });
        }
        if (cmd === "host_fs_watch_subscribe") return Promise.resolve({ subscriptionId: 1 });
        if (cmd === "host_fs_watch_unsubscribe") return Promise.resolve({ removed: true });
        if (cmd === "host_fs_watch_list") return Promise.resolve([1]);
        if (cmd === "host_fs_read_text") {
          return new Promise((resolve) => {
            releaseText = (v) => resolve(v);
          });
        }
        return Promise.resolve(null);
      },
    };
    const host = render(FilesApp);
    await hostOf(host);

    await fireEvent.click(rowButton(host, "docs", "host-entry")!);
    await vi.waitFor(() => expect(releaseDir).not.toBeNull());
    await fireEvent.click(rowButton(host, "notes.txt", "host-entry")!);
    await vi.waitFor(() => expect(releaseText).not.toBeNull());

    // The navigation answers first: the breadcrumb is inside docs now.
    releaseDir!([
      { path: "/tmp/fence/docs/readme.md", name: "readme.md", isDir: false, size: 3, mtimeMs: 1_700_000_000_000 },
    ]);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="host-cwd"]')?.textContent).toContain("docs"),
    );

    // The open answers late, with a file from the directory the user just left.
    releaseText!({ path: "/tmp/fence/notes.txt", size: 2, body: "hi", truncated: false });
    await settle();

    expect(
      host.container.querySelector('[data-testid="host-file"]'),
      "the breadcrumb names docs; a <pre> for root's notes.txt is a claim about a listing that is gone",
    ).toBeNull();
  });

  test("a refresh of the same directory does not discard the open the user made meanwhile", async () => {
    // The test above is the *moving* case: the listing lands somewhere else, so the file the open
    // claims is a row the user left behind and the landing must retire it. A **refresh** of the
    // directory already on screen (`loadHostDir(hostCwd)`, fired by the host's watch event when
    // an edit lands outside AmOS) moves nothing — the row that was clicked is a row of the very
    // listing that lands. So the landing must spare a host claim here exactly as it spares a
    // device one; retiring it drops the user's click with no sentence at all, the silent no-op
    // this file's own `hostSurfaceGen` note states the rule against.
    const invokes: Invoke[] = [];
    let dirCalls = 0;
    let releaseDir: ((v: unknown) => void) | null = null;
    let releaseText: ((v: unknown) => void) | null = null;
    let emitEvent: ((e: { payload: unknown }) => void) | null = null;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        invokes.push({ cmd, args });
        if (cmd === "host_fs_root_status") {
          return Promise.resolve({ root: "/tmp/fence", exists: true, reason: null });
        }
        if (cmd === "host_fs_read_dir") {
          dirCalls += 1;
          if (dirCalls === 1) {
            return Promise.resolve([
              { path: "/tmp/fence/notes.txt", name: "notes.txt", isDir: false, size: 10, mtimeMs: 1_700_000_000_000 },
            ]);
          }
          // The refresh is held, so the open below is clicked while it is unanswered.
          return new Promise((resolve) => {
            releaseDir = (v) => resolve(v);
          });
        }
        if (cmd === "host_fs_watch_subscribe") return Promise.resolve({ subscriptionId: 1 });
        if (cmd === "host_fs_watch_unsubscribe") return Promise.resolve({ removed: true });
        if (cmd === "host_fs_watch_list") return Promise.resolve([1]);
        if (cmd === "host_fs_read_text") {
          return new Promise((resolve) => {
            releaseText = (v) => resolve(v);
          });
        }
        return Promise.resolve(null);
      },
      listen: async (_ch: string, cb: (e: { payload: unknown }) => void) => {
        emitEvent = cb;
        return () => {};
      },
    };
    const host = render(FilesApp);
    await hostOf(host);
    await vi.waitFor(() => expect(emitEvent).not.toBeNull());

    // An edit lands outside AmOS: the host pushes a change for the subscription this screen holds.
    emitEvent!({ payload: { subscriptionId: 1, path: "/tmp/fence/notes.txt", kind: "modify" } });
    await vi.waitFor(() => expect(dirCalls).toBe(2));

    // The user opens a row of the **same** directory while the refresh is unanswered.
    await fireEvent.click(rowButton(host, "notes.txt", "host-entry")!);
    await vi.waitFor(() => expect(releaseText).not.toBeNull());

    // The refresh lands first — same directory, so the row it names is still the one on screen.
    releaseDir!([
      { path: "/tmp/fence/notes.txt", name: "notes.txt", isDir: false, size: 10, mtimeMs: 1_700_000_000_000 },
    ]);
    await settle();

    // Then the open answers.
    releaseText!({ path: "/tmp/fence/notes.txt", size: 2, body: "hi", truncated: false });
    await settle();

    expect(
      host.container.querySelector('[data-testid="host-file"]'),
      "the listing never moved, so the file the user clicked is still a row on screen — dropping it is a silent no-op",
    ).not.toBeNull();
  });

  /**
   * A bridge that answers `host_fs_read_dir` with whatever `rows` currently holds (the test swaps
   * it to model an edit landing outside AmOS) and lets the test **emit** the host's watch event —
   * the real trigger for a same-directory refresh, which the other bridges all stub away.
   */
  function installWatchedDirBridge(opts: { holdText?: boolean; holdStat?: boolean } = {}) {
    const invokes: Invoke[] = [];
    const dir = (path: string, name: string, isDir: boolean) => ({ path, name, isDir, size: 4, mtimeMs: 1_700_000_000_000 });
    const state = {
      rows: [dir("/tmp/fence/notes.txt", "notes.txt", false), dir("/tmp/fence/docs", "docs", true)],
      dirCalls: 0,
      emit: null as ((e: { payload: unknown }) => void) | null,
      releaseDir: null as ((v: unknown) => void) | null,
      releaseText: null as ((v: unknown) => void) | null,
      refuseText: null as ((code: string) => void) | null,
      releaseStat: null as ((v: unknown) => void) | null,
    };
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string) => {
        invokes.push({ cmd });
        if (cmd === "host_fs_root_status") return Promise.resolve({ root: "/tmp/fence", exists: true, reason: null });
        if (cmd === "host_fs_read_dir") {
          state.dirCalls += 1;
          if (state.dirCalls === 1) return Promise.resolve(state.rows);
          return new Promise((resolve) => {
            state.releaseDir = (v) => resolve(v);
          });
        }
        if (cmd === "host_fs_watch_subscribe") return Promise.resolve({ subscriptionId: 1 });
        if (cmd === "host_fs_watch_unsubscribe") return Promise.resolve({ removed: true });
        if (cmd === "host_fs_watch_list") return Promise.resolve([1]);
        if (cmd === "host_fs_read_text") {
          const reply = { path: "/tmp/fence/notes.txt", size: 2, body: "hi", truncated: false };
          // Held open only for the controls that need the row to leave the listing first. A held
          // read can also be *refused* on release, the way `installPreviewBridge` refuses: the
          // mock's rejection is caught by `backend.invoke` and reaches `hostFs.ts` as the typed
          // envelope on the diagnostic ledger.
          if (opts.holdText)
            return new Promise((resolve, reject) => {
              state.releaseText = (v) => resolve(v);
              state.refuseText = (code) => reject({ code, message: "no" });
            });
          return Promise.resolve(reply);
        }
        if (cmd === "host_fs_stat") {
          const reply = { path: "/tmp/fence/notes.txt", exists: true, isDir: false, size: 42, mtimeMs: 1_700_000_000_000 };
          if (opts.holdStat) return new Promise((resolve) => { state.releaseStat = (v) => resolve(v); });
          return Promise.resolve(reply);
        }
        // The device preview's reader never answers, so the panel stays on its spinner — the state
        // a superseding host open is obliged to end.
        if (cmd === "files_preview_bytes") return new Promise(() => {});
        return Promise.resolve(null);
      },
      listen: async (_ch: string, cb: (e: { payload: unknown }) => void) => {
        state.emit = cb;
        return () => {};
      },
    };
    return {
      state,
      invokes,
      /** An edit lands outside AmOS: the host pushes a change for the subscription we hold. */
      fireWatchEvent: () => {
        state.emit!({ payload: { subscriptionId: 1, path: "/tmp/fence/notes.txt", kind: "modify" } });
      },
    };
  }

  test("an unrelated edit on disk does not close the file the user is reading", async () => {
    // A same-directory refresh replaces the listing with itself, so a surface whose row is still
    // listed is still a claim about the listing on screen — retiring it throws away what the user
    // asked for. The watch is **recursive from the root**, so the event that triggers this can come
    // from a file in a different folder (any process appending to a log anywhere under the fence):
    // the `<pre>` used to vanish on an edit that had nothing to do with the file being read.
    const bridge = installWatchedDirBridge();
    const host = render(FilesApp);
    await hostOf(host);
    await vi.waitFor(() => expect(bridge.state.emit).not.toBeNull());

    await fireEvent.click(rowButton(host, "notes.txt", "host-entry")!);
    await vi.waitFor(() => expect(host.container.querySelector('[data-testid="host-file"]')).not.toBeNull());

    bridge.fireWatchEvent();
    await vi.waitFor(() => expect(bridge.state.dirCalls).toBe(2));
    bridge.state.releaseDir!(bridge.state.rows);
    await settle();

    expect(
      host.container.querySelector('[data-testid="host-file"]')?.textContent,
      "the refresh lists the same row, so the file being read is still on screen",
    ).toContain("hi");
  });

  test("a refresh cannot drop a file open that was already in flight when it started", async () => {
    // The order round 12's fix cannot see. The user clicks a file, and *then* an edit elsewhere
    // starts a same-directory refresh: the refresh's token bump supersedes the open (its reply is
    // dropped) and the landing retires the surface, so the click vanishes with no sentence — the
    // silent no-op, from the other side. The file is a row of the directory that lands either way.
    const bridge = installWatchedDirBridge();
    const host = render(FilesApp);
    await hostOf(host);
    await vi.waitFor(() => expect(bridge.state.emit).not.toBeNull());

    await fireEvent.click(rowButton(host, "notes.txt", "host-entry")!);

    bridge.fireWatchEvent();
    await vi.waitFor(() => expect(bridge.state.dirCalls).toBe(2));
    bridge.state.releaseDir!(bridge.state.rows);
    await settle();

    expect(
      host.container.querySelector('[data-testid="host-file"]')?.textContent,
      "the refresh moved nothing, so the row the user clicked is still listed",
    ).toContain("hi");
  });

  /** The same listing minus `notes.txt` — an edit outside AmOS that removes the file being shown. */
  const withoutNotes = () => [
    { path: "/tmp/fence/docs", name: "docs", isDir: true, size: 4, mtimeMs: 1_700_000_000_000 },
  ];

  test("a refresh that drops the row retires the <pre> that was describing it", async () => {
    // The other side of the `gone` sweep: sparing a surface whose row a same-directory refresh still
    // lists is right, but a refresh that *removes* the row makes the `<pre>` a claim about a file
    // that is no longer in the listing on screen — the rule `loadHostDir`'s own comment states.
    const bridge = installWatchedDirBridge();
    const host = render(FilesApp);
    await hostOf(host);
    await vi.waitFor(() => expect(bridge.state.emit).not.toBeNull());

    await fireEvent.click(rowButton(host, "notes.txt", "host-entry")!);
    await vi.waitFor(() => expect(host.container.querySelector('[data-testid="host-file"]')).not.toBeNull());

    bridge.fireWatchEvent();
    await vi.waitFor(() => expect(bridge.state.dirCalls).toBe(2));
    bridge.state.releaseDir!(withoutNotes());
    await settle();

    expect(
      host.container.querySelector('[data-testid="host-file"]'),
      "the listing that lands no longer holds the row the <pre> was describing",
    ).toBeNull();
  });

  test("an open whose row a refresh dropped while the read was in flight paints nothing", async () => {
    // A same-directory refresh takes no panel token (it moved nothing), so the token is no longer
    // what keeps this reply off a listing it does not belong to: the reply has to ask the other half
    // itself. Without the row-membership check the `<pre>` paints over a listing its row left.
    const bridge = installWatchedDirBridge({ holdText: true });
    const host = render(FilesApp);
    await hostOf(host);
    await vi.waitFor(() => expect(bridge.state.emit).not.toBeNull());

    await fireEvent.click(rowButton(host, "notes.txt", "host-entry")!);

    bridge.fireWatchEvent();
    await vi.waitFor(() => expect(bridge.state.dirCalls).toBe(2));
    bridge.state.releaseDir!(withoutNotes());
    await settle();
    bridge.state.releaseText!({ path: "/tmp/fence/notes.txt", size: 2, body: "hi", truncated: false });
    await settle();

    expect(
      host.container.querySelector('[data-testid="host-file"]'),
      "the row the open names is gone from the listing, so there is nothing for the <pre> to describe",
    ).toBeNull();
  });

  test("a stat whose row a refresh dropped while the read was in flight paints no card", async () => {
    // The card's own arm of the same rule: the read is a fact, the card is a claim about the row.
    const bridge = installWatchedDirBridge({ holdStat: true });
    const host = render(FilesApp);
    await hostOf(host);
    await vi.waitFor(() => expect(bridge.state.emit).not.toBeNull());

    await fireEvent.click(rowButton(host, "notes.txt", "host-stat-button")!);

    bridge.fireWatchEvent();
    await vi.waitFor(() => expect(bridge.state.dirCalls).toBe(2));
    bridge.state.releaseDir!(withoutNotes());
    await settle();
    bridge.state.releaseStat!({
      path: "/tmp/fence/notes.txt", exists: true, isDir: false, size: 42, mtimeMs: 1_700_000_000_000,
    });
    await settle();

    expect(
      host.container.querySelector('[data-testid="host-stat"]'),
      "the row the stat names is gone from the listing, so the card would describe a row not on screen",
    ).toBeNull();
  });

  test("a refusal reaches the user even when a refresh drops the row the open named", async () => {
    // The refusal is a fact about the **read**, not a claim about a row — the rule `hostShowStat`'s
    // refusal arm states, and the reason that arm sits *above* the row-membership check. Applying
    // the check to the refusal would leave a pressed button with no sentence at all: the same
    // silent no-op the spare/hold split exists to avoid, from the failure side.
    const bridge = installWatchedDirBridge({ holdText: true });
    const host = render(FilesApp);
    await hostOf(host);
    await vi.waitFor(() => expect(bridge.state.emit).not.toBeNull());

    await fireEvent.click(rowButton(host, "notes.txt", "host-entry")!);

    bridge.fireWatchEvent();
    await vi.waitFor(() => expect(bridge.state.dirCalls).toBe(2));
    bridge.state.releaseDir!(withoutNotes());
    await settle();
    bridge.state.refuseText!("amos.host_fs.file_too_large");
    await settle();

    expect(
      host.container.querySelector('[data-testid="host-error"]')?.textContent,
      "the host refused the read, so the user must be told even though the row is gone",
    ).toContain("文件过大");
  });

  test("a host open whose row a refresh dropped still ends the device preview it superseded", async () => {
    // The row-membership check is new; the obligation to resolve the shared panel's transient is
    // not. This open holds the token, so a device preview it superseded had its reply dropped and
    // nobody else can end its spinner — if the row check returns early *first*, the panel keeps the
    // device file's title over a spinner that never stops. Round 4's defect, reached through round
    // 13's check instead of the error arm.
    writeStoreValue("amos.files", [
      { id: "n", type: "file", name: "device.txt", content: "你好", ts: 1000 },
    ]);
    const bridge = installWatchedDirBridge({ holdText: true });
    const host = render(FilesApp);
    await hostOf(host);
    await vi.waitFor(() => expect(bridge.state.emit).not.toBeNull());

    // A device preview on the shared panel: its reply never lands, so the spinner stands.
    const previewBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") ?? "").startsWith("预览 "),
    ) as HTMLButtonElement;
    await fireEvent.click(previewBtn);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-panel"]')).not.toBeNull(),
    );

    // A host open supersedes it, and a same-directory refresh drops the row before the read lands.
    await fireEvent.click(rowButton(host, "notes.txt", "host-entry")!);
    bridge.fireWatchEvent();
    await vi.waitFor(() => expect(bridge.state.dirCalls).toBe(2));
    bridge.state.releaseDir!(withoutNotes());
    await settle();
    bridge.state.releaseText!({ path: "/tmp/fence/notes.txt", size: 2, body: "hi", truncated: false });
    await settle();

    expect(
      host.container.querySelector('[data-testid="preview-panel"]'),
      "被主机打开取代的预览必须被收走，不许永远转圈",
    ).toBeNull();
  });

  test("a listing dropped by order still ends the device preview it superseded", async () => {
    // The listing-side twin of the open's strand. A **moving** listing takes the panel token, so the
    // device claim it supersedes has its reply dropped and only this listing can end its spinner. But
    // the listing that beats it may not be a taker at all: a same-directory refresh (the watch event)
    // never takes the token, so the order check that drops this reply also drops the only owner of the
    // panel's transient — the device file's title sits over a spinner that never stops.
    writeStoreValue("amos.files", [
      { id: "n", type: "file", name: "device.txt", content: "你好", ts: 1000 },
    ]);
    const dir = (path: string, name: string, isDir: boolean) => ({
      path, name, isDir, size: 4, mtimeMs: 1_700_000_000_000,
    });
    const root = [dir("/tmp/fence/notes.txt", "notes.txt", false), dir("/tmp/fence/docs", "docs", true)];
    const held: ((v: unknown) => void)[] = [];
    let dirCalls = 0;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string) => {
        if (cmd === "host_fs_root_status") return Promise.resolve({ root: "/tmp/fence", exists: true, reason: null });
        if (cmd === "host_fs_read_dir") {
          dirCalls += 1;
          if (dirCalls === 1) return Promise.resolve(root);
          return new Promise((resolve) => { held.push((v) => resolve(v)); });
        }
        if (cmd === "host_fs_watch_subscribe") return Promise.resolve({ subscriptionId: 1 });
        if (cmd === "host_fs_watch_unsubscribe") return Promise.resolve({ removed: true });
        if (cmd === "host_fs_watch_list") return Promise.resolve([1]);
        // The device preview's reader never answers, so the panel stays on its spinner.
        if (cmd === "files_preview_bytes") return new Promise(() => {});
        return Promise.resolve(null);
      },
      listen: async (_ch: string, cb: (e: { payload: unknown }) => void) => {
        emit = cb;
        return () => {};
      },
    };
    let emit!: (e: { payload: unknown }) => void;
    const host = render(FilesApp);
    await hostOf(host);

    const previewBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") ?? "").startsWith("预览 "),
    ) as HTMLButtonElement;
    await fireEvent.click(previewBtn);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="preview-panel"]')).not.toBeNull(),
    );

    // A moving listing (into `docs`) that takes the panel, then a same-directory refresh that wins.
    await fireEvent.click(rowButton(host, "docs", "host-entry")!);
    emit({ payload: { subscriptionId: 1, path: "/tmp/fence/notes.txt", kind: "modify" } });
    await vi.waitFor(() => expect(held).toHaveLength(2));
    held[1](root); // the refresh lands first …
    await settle();
    held[0]([]); // … and the folder click is dropped by the order check
    await settle();

    expect(
      host.container.querySelector('[data-testid="preview-panel"]'),
      "被移动列表取代的预览必须被收走，不许永远转圈",
    ).toBeNull();
  });

  /**
   * A bridge whose `host_fs_read_text` / `host_fs_stat` replies are held per path, so two reads of
   * the same surface can be in flight and answered in any order. Both row buttons (open, ⓘ) stay
   * enabled throughout, which is what makes these interleavings reachable.
   */
  function installRacingOpenBridge() {
    const invokes: Invoke[] = [];
    const pending: { cmd: string; path: string; resolve: (v: unknown) => void }[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        invokes.push({ cmd, args });
        const path = (args?.args as { path?: string } | undefined)?.path ?? "";
        if (cmd === "host_fs_root_status") {
          return Promise.resolve({ root: "/tmp/fence", exists: true, reason: null });
        }
        if (cmd === "host_fs_read_dir") {
          return Promise.resolve([
            { path: "/tmp/fence/a.txt", name: "a.txt", isDir: false, size: 4, mtimeMs: 1_700_000_000_000 },
            { path: "/tmp/fence/b.txt", name: "b.txt", isDir: false, size: 4, mtimeMs: 1_700_000_000_000 },
          ]);
        }
        if (cmd === "host_fs_watch_subscribe") return Promise.resolve({ subscriptionId: 1 });
        if (cmd === "host_fs_watch_unsubscribe") return Promise.resolve({ removed: true });
        if (cmd === "host_fs_watch_list") return Promise.resolve([1]);
        if (cmd === "host_fs_read_text" || cmd === "host_fs_stat") {
          return new Promise((resolve) => {
            pending.push({ cmd, path, resolve: (v) => resolve(v) });
          });
        }
        return Promise.resolve(null);
      },
    };
    return {
      pending,
      has: (cmd: string, path: string) => pending.some((p) => p.cmd === cmd && p.path === path),
      release: (cmd: string, path: string, v: unknown) => {
        const i = pending.findIndex((p) => p.cmd === cmd && p.path === path);
        pending.splice(i, 1)[0].resolve(v);
      },
    };
  }

  test("two file opens racing: the file clicked last is the one that paints", async () => {
    const bridge = installRacingOpenBridge();
    const host = render(FilesApp);
    await hostOf(host, "a.txt");

    await fireEvent.click(rowButton(host, "a.txt", "host-entry")!);
    await vi.waitFor(() => expect(bridge.has("host_fs_read_text", "/tmp/fence/a.txt")).toBe(true));
    await fireEvent.click(rowButton(host, "b.txt", "host-entry")!);
    await vi.waitFor(() => expect(bridge.has("host_fs_read_text", "/tmp/fence/b.txt")).toBe(true));

    // The file clicked last answers first; the earlier click answers late and must not win.
    bridge.release("host_fs_read_text", "/tmp/fence/b.txt", { path: "/tmp/fence/b.txt", size: 4, body: "BBB", truncated: false });
    await settle();
    bridge.release("host_fs_read_text", "/tmp/fence/a.txt", { path: "/tmp/fence/a.txt", size: 4, body: "AAA", truncated: false });
    await settle();

    expect(host.container.querySelector('[data-testid="host-file"]')?.textContent).toContain("b.txt");
    expect(txt(host)).not.toContain("AAA");
  });

  test("a stat reply cannot land alongside the preview a later open claimed", async () => {
    const bridge = installRacingOpenBridge();
    const host = render(FilesApp);
    await hostOf(host, "a.txt");

    // Ask for the card, then open the row before the stat answers.
    await fireEvent.click(rowButton(host, "a.txt", "host-stat-button")!);
    await vi.waitFor(() => expect(bridge.has("host_fs_stat", "/tmp/fence/a.txt")).toBe(true));
    await fireEvent.click(rowButton(host, "a.txt", "host-entry")!);
    await vi.waitFor(() => expect(bridge.has("host_fs_read_text", "/tmp/fence/a.txt")).toBe(true));

    bridge.release("host_fs_read_text", "/tmp/fence/a.txt", { path: "/tmp/fence/a.txt", size: 4, body: "AAA", truncated: false });
    await settle();
    bridge.release("host_fs_stat", "/tmp/fence/a.txt", { path: "/tmp/fence/a.txt", exists: true, isDir: false, size: 4, mtimeMs: 1_700_000_000_000 });
    await settle();

    expect(
      host.container.querySelector('[data-testid="host-stat"]'),
      "one info surface at a time — the stat card must not come back over the preview a later open claimed",
    ).toBeNull();
    expect(host.container.querySelector('[data-testid="host-file"]')).not.toBeNull();
  });

  test("a second export retires the previous save report", async () => {
    installWiredBridge({});
    const host = render(FilesApp);
    await vi.waitFor(() => expect(txt(host)).toContain("主机文件系统"));

    const summary = host.container.querySelector('[data-testid="bundle-section"] summary') as HTMLElement;
    await fireEvent.click(summary);
    await fireEvent.click(btnContaining(host, "导出为压缩包")!);
    await vi.waitFor(() =>
      expect((host.container.querySelector('[data-testid="bundle-text"]') as HTMLTextAreaElement).value).toContain(
        "AmosFilesBundle/1.0",
      ),
    );
    await fireEvent.click(host.container.querySelector('[data-testid="bundle-save-host"]') as HTMLButtonElement);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="bundle-save-msg"]')?.textContent).toContain("已保存到"),
    );

    // The textarea now holds a *different* bundle, so "saved to …" no longer describes it.
    await fireEvent.click(btnContaining(host, "导出为压缩包")!);

    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="bundle-save-msg"]')).toBeNull();
    });
  });

  test("editing the bundle text retires the save report too", async () => {
    installWiredBridge({});
    const host = render(FilesApp);
    await vi.waitFor(() => expect(txt(host)).toContain("主机文件系统"));

    const summary = host.container.querySelector('[data-testid="bundle-section"] summary') as HTMLElement;
    await fireEvent.click(summary);
    await fireEvent.click(btnContaining(host, "导出为压缩包")!);
    await vi.waitFor(() =>
      expect((host.container.querySelector('[data-testid="bundle-text"]') as HTMLTextAreaElement).value).toContain(
        "AmosFilesBundle/1.0",
      ),
    );
    await fireEvent.click(host.container.querySelector('[data-testid="bundle-save-host"]') as HTMLButtonElement);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="bundle-save-msg"]')?.textContent).toContain("已保存到"),
    );

    const ta = host.container.querySelector('[data-testid="bundle-text"]') as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "AmosFilesBundle/1.0\nOTHER" } });

    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="bundle-save-msg"]')).toBeNull();
    });
  });
});

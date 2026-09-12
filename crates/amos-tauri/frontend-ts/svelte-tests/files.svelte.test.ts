/**
 * DOM tests for the Svelte 5 files screen (FilesApp.svelte).
 *
 * Pure filesystem logic is unit-tested once against lib/files.ts (shared by the
 * React + Svelte UIs). Here we verify the Svelte UI wiring: the seeded root,
 * creating a folder in the current directory, and navigating into a folder.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import FilesApp from "../src/svelte/FilesApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
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
    const input = host.container.querySelector('input[aria-label="file-new-name"]') as HTMLInputElement;
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
        'input[aria-label="file-new-name"]',
      ) as HTMLInputElement;
      await fireEvent.input(input, { target: { value: "工作" } });
      await fireEvent.click(btnContaining(host, "保存")!);
      // Not stored ⇒ not claimed: the banner shows, no row appears, and the create form
      // keeps the typed name.
      expect(txt(host)).toContain("本机存储写入失败");
      expect(txt(host)).not.toContain("工作");
      const still = host.container.querySelector(
        'input[aria-label="file-new-name"]',
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

    const filter = host.container.querySelector('input[aria-label="external-search"]') as HTMLInputElement;
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
});


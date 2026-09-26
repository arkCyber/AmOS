/**
 * files-cloud-snapshot-refusal.svelte.test.ts — 「云快照」（Files 设置里的本地快照）的
 * **删除**把存储的裁决丢在地上（REQ-A1439 / FMEA F-SH-697）。
 *
 * 这个「云」就是一枚键 —— `amos.files.cloud`。两个动词都写它：`saveSnapshot`（经
 * `writeStoreValueChecked`）与 `deleteSnapshot`（经 `removeStoreValue`）。**保存**那条路
 * 一直读裁决（`doSaveCloud` 逐字 `const ok = await saveSnapshot(snap); if (ok) … else …`），
 * 但**删除**那条逐字是：
 *
 *     function doDeleteCloud(): void {
 *       deleteSnapshot();
 *       cloudSnap = null;
 *       cloudMsg = "";
 *     }
 *
 * `deleteSnapshot()` 的签名是 `boolean`（其 doc 逐字「Returns `true` on success」），
 * `removeStoreValue` 在 `localStorage.removeItem` 抛错时（存储不可用 —— 那个 catch 分支就是
 * 为它写的、并逐字记 `amosError("store", "remove failed …")`）返回 `false`。裁决被丢，
 * 面板照旧翻到「尚未保存快照」：信息行与删除按钮一起消失，屏幕上写着「没有快照」，
 * 而键还在盘上 —— 下次启动 `loadSnapshot()` 又把它读回来，「恢复快照」再次可用。
 * 这正是同一键的姊妹动词（保存）不会犯的错。
 *
 * 同一次修的另一半：失败句 `files.cloudSaveFailed` 原先落在 `cloudMsg` 那个**绿色成功行**
 * 里 —— 一句「保存快照失败」被画成成功的颜色。归法：拒写进各自的失败槽，用共享的
 * `StoreErrorBar` 说出来（`role="status"`、`data-testid="store-write-error"`）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import FilesApp from "../src/svelte/FilesApp.svelte";
import { writeStoreValueChecked } from "../src/lib/amosStore";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const SNAPSHOT_KEY = "amos.files.cloud";
const REFUSED = zh["common.storeWriteFailed"];
const SAVE_FAILED = zh["files.cloudSaveFailed"];
const EMPTY = zh["files.cloudEmpty"];

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const text = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const btnContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
/** The cloud snapshot `<details>` and only what is inside it. */
const cloudBox = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="cloud-section"]') as HTMLElement;
const cloudRefusal = (h: { container: HTMLElement }) =>
  cloudBox(h)?.querySelector('[data-testid="store-write-error"]') ?? null;

/** A device file (wire shape) so `extFlat` is non-empty and the save path is reachable. */
const deviceItem = (name: string) => ({
  id: `download/${name}`,
  kind: "file",
  collection: "download",
  name,
  uri: `content://download/${name}`,
  mime: "application/pdf",
  size_bytes: 2048,
  ts: 1_700_000_000_000,
});

/**
 * Bridge stub: it is what makes the cloud section render at all (`hasMediaBridge()`), and
 * it answers the two commands the flow needs — `media_list` (device files) and
 * `files_cloud_validate` (the Rust validator, which echoes the snapshot back as valid, the
 * same way `filesCloud.test.ts` stubs it) — so a save failure can only come from the store.
 */
function installBridge(items: unknown[]): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "media_list") return args?.collection === "download" ? items : [];
      if (cmd === "files_cloud_validate") return args?.snapshot ?? null;
      return null;
    },
    listen: async () => () => {},
  };
}

/** A storage whose `removeItem` / `setItem` throw for `key` the way an unavailable store does. */
function installRefusingStorage(refuse: { remove?: string; set?: string }): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => {
      if (refuse.remove === k) throw new Error("SecurityError");
      real.removeItem(k);
    },
    setItem: (k: string, v: string) => {
      if (refuse.set === k) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}

const SNAP = {
  label: "device-files",
  savedAt: 1_700_000_000_000,
  collections: ["download"],
  totalBytes: 2048,
  fileCount: 1,
  files: [
    { id: "download/report.pdf", name: "report.pdf", kind: "file", collection: "download", sizeBytes: 2048, ts: 1 },
  ],
};

const heldSnapshot = (): unknown => JSON.parse(window.localStorage.getItem(SNAPSHOT_KEY) ?? "null");

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
});

afterEach(() => {
  cleanup();
  setLocale("zh");
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

describe("Files 云快照的删除 —— 存储拒绝时不许画成「已删除」（REQ-A1439）", () => {
  test("拒绝删除：说出口，盘上照旧，面板不许翻到「尚未保存快照」", async () => {
    writeStoreValueChecked(SNAPSHOT_KEY, SNAP);
    installBridge([]);
    const restore = installRefusingStorage({ remove: SNAPSHOT_KEY });
    try {
      const h = render(FilesApp);
      await settle();
      const box = cloudBox(h);
      expect(box, "桥在，云快照区就该在").toBeTruthy();
      expect(box.textContent, "快照在盘上，面板先画出它的信息行").toContain("device-files");

      await fireEvent.click(btnContaining(h, zh["files.cloudDelete"])!);
      await settle();

      expect(cloudRefusal(h)?.textContent ?? "", "一次没生效的删除必须说出口").toContain(REFUSED);
      expect(box.textContent, "盘上原样（没删掉）").not.toContain(EMPTY);
      expect(heldSnapshot(), "键还在盘上").toMatchObject({ label: "device-files" });
      expect(box.textContent, "信息行还在（屏幕与盘一致）").toContain("device-files");
      expect(
        btnContaining(h, zh["files.cloudDelete"]),
        "快照还在，删除按钮就该还在",
      ).toBeTruthy();
    } finally {
      restore();
    }
  });

  test("对照：存储收下 ⇒ 键从盘上消失、面板说「尚未保存快照」，且绝不出现那句拒绝", async () => {
    writeStoreValueChecked(SNAPSHOT_KEY, SNAP);
    installBridge([]);
    const h = render(FilesApp);
    await settle();
    expect(cloudBox(h).textContent).toContain("device-files");

    await fireEvent.click(btnContaining(h, zh["files.cloudDelete"])!);
    await settle();

    expect(cloudRefusal(h), "没有被拒的东西").toBeNull();
    expect(window.localStorage.getItem(SNAPSHOT_KEY), "键真的删掉了").toBeNull();
    expect(cloudBox(h).textContent).toContain(EMPTY);
    expect(btnContaining(h, zh["files.cloudDelete"]), "没有快照，删除按钮收起").toBeUndefined();
  });
});

describe("Files 云快照的保存 —— 失败句不属于那条绿色的成功行（REQ-A1439）", () => {
  test("存储拒绝保存：`保存快照失败` 落在拒绝槽里，不落在绿行里", async () => {
    installBridge([deviceItem("report.pdf")]);
    const restore = installRefusingStorage({ set: SNAPSHOT_KEY });
    try {
      const h = render(FilesApp);
      await vi.waitFor(() => expect(text(h)).toContain("设备文件 1"));
      await fireEvent.click(btnContaining(h, zh["files.cloudSnapshot"])!);
      await settle();

      const box = cloudBox(h);
      expect(cloudRefusal(h)?.textContent ?? "", "拒写要说出口").toContain(SAVE_FAILED);
      // 绿行是成功槽：它必须没有这句话，也没有画出一个并不存在的快照。
      expect(box.textContent, "失败句不在绿行里 —— 只是同屏出现一次").toContain(SAVE_FAILED);
      expect(
        [...box.querySelectorAll("p")].filter((p) => p.className.includes("text-green")),
        "绿色成功行不出现",
      ).toHaveLength(0);
      expect(window.localStorage.getItem(SNAPSHOT_KEY), "盘上什么都没落下").toBeNull();
    } finally {
      restore();
    }
  });

  test("对照：验证器收下、存储收下 ⇒ 绿行说「已保存」，拒绝槽空着", async () => {
    installBridge([deviceItem("report.pdf")]);
    const h = render(FilesApp);
    await vi.waitFor(() => expect(text(h)).toContain("设备文件 1"));

    await fireEvent.click(btnContaining(h, zh["files.cloudSnapshot"])!);
    await settle();

    const box = cloudBox(h);
    expect(cloudRefusal(h), "没有被拒的东西").toBeNull();
    expect(box.textContent).toContain(zh["files.cloudSaved"].replace("{count}", "1"));
    expect(heldSnapshot(), "盘上有快照了").toMatchObject({ fileCount: 1 });
  });
});

/**
 * files-cloud-save-blank.svelte.test.ts — 「保存快照」在**没有设备文件可存**时说的是哪句话
 * （REQ-A1829 / FMEA F-SH-907）。
 *
 * 快照是从**设备文件清单**（`extFlat`，由 `loadExternal` 的 `media_list` 读出）构建的，
 * 所以一次保存只能说一件**这个壳真的读过**的事实。修前逐字：
 *
 *     async function doSaveCloud(): Promise<void> {
 *       cloudErr = "";
 *       if (extFlat.length === 0) {
 *         cloudMsg = t("files.cloudEmpty");   // 「尚未保存快照」/「No snapshot saved」
 *         return;
 *       }
 *       …
 *
 * `files.cloudEmpty` 是**快照那一行**的话（模板 `{:else}` 分支），意思是「还没有快照」——
 * 正是「保存」这个动作要改变的状态。把它拿去回答另一个事实（「设备上没有可存的文件」），
 * 用户按下保存后，**绿色的成功行**里写着「尚未保存快照」：读起来像保存悄悄失败了。
 * 同一个键同时说两件事，正是本文件 `previewUnavailableText` 的注释明令禁止的
 *（「三句分开，因为是三件不同的事实——每件拒绝一句话，会让三个事件在缺陷报告里读起来一样」）。
 *
 * 并且「空」不是唯一会让 `extFlat` 为空的处境：清单**还在读**（`extBusy`）时它也是空的，
 * 读**被拒**（`extBlocked`）时它还是空的。用「没有可保存的设备文件」回答前两者，就是把一件
 * 从没读过的清单说成设备上没有文件——同样是那句注释要挡的谎。三者各有各的话。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import FilesApp from "../src/svelte/FilesApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const SNAPSHOT_KEY = "amos.files.cloud";

/** 本轮新增的两句，按字面量断言：键不存在时 `t()` 回落到键名，字面量能挡住空断言。 */
const NOTHING_TO_SAVE = "没有可保存的设备文件";
const STILL_READING = "设备文件仍在读取中";

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const text = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const cloudBox = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="cloud-section"]') as HTMLElement | null;
const boxText = (h: { container: HTMLElement }) => cloudBox(h)?.textContent ?? "";
/** 拒绝槽（共享的 `StoreErrorBar`），只在快照区内取。 */
const cloudRefusal = (h: { container: HTMLElement }) =>
  cloudBox(h)?.querySelector('[data-testid="store-write-error"]') ?? null;
/**
 * 那条**绿行**（`cloudMsg`）——本轮要判的就是它说了什么。不能拿整个快照区来断言：
 * 没有快照时，`{:else}` 那一行本来就写着「尚未保存快照」，那是它**该**说的；缺陷是这条
 * 绿行把同一句话拿来说了另一件事。
 */
const greenLine = (h: { container: HTMLElement }) =>
  [...(cloudBox(h)?.querySelectorAll("p") ?? [])].find((p) =>
    (p as HTMLElement).className.includes("text-green"),
  )?.textContent ?? "";
const btnContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    | HTMLButtonElement
    | undefined;

/** One device file (wire shape), so `extFlat` is non-empty and the save path is reachable. */
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
 * How `media_list` answers. Every mode leaves the cloud section rendered
 * (`hasMediaBridge()` is true) but puts the device-file list in a different state.
 */
type ListMode = "empty" | "pending" | "refuse" | "one";

function installBridge(mode: ListMode): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "media_list") {
        if (mode === "pending") return new Promise<never>(() => {}); // read never lands
        if (mode === "refuse") throw new Error("Unauthorized");
        if (mode === "one") return args?.collection === "download" ? [deviceItem("report.pdf")] : [];
        return []; // "empty": every collection answers, all of them empty
      }
      if (cmd === "files_cloud_validate") return args?.snapshot ?? null;
      return null;
    },
    listen: async () => () => {},
  };
}

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

describe("「保存快照」在没有设备文件可存时说哪句话（REQ-A1829）", () => {
  test("清单已读完、确实是空的：说「没有可保存的设备文件」，不是「尚未保存快照」", async () => {
    installBridge("empty");
    const h = render(FilesApp);
    await settle();
    expect(cloudBox(h), "桥在，云快照区就该在").toBeTruthy();

    await fireEvent.click(btnContaining(h, zh["files.cloudSnapshot"])!);
    await settle();

    expect(greenLine(h), "说的是设备上没有文件").toContain(NOTHING_TO_SAVE);
    expect(
      greenLine(h),
      "「尚未保存快照」是快照那一行的话：它属于**还没有快照**，不属于「这次没得存」",
    ).not.toContain(zh["files.cloudEmpty"]);
    expect(window.localStorage.getItem(SNAPSHOT_KEY), "什么都没落下").toBeNull();
  });

  test("清单还在读：不许声称设备上没有文件——说「仍在读取中」", async () => {
    installBridge("pending");
    const h = render(FilesApp);
    await settle();

    await fireEvent.click(btnContaining(h, zh["files.cloudSnapshot"])!);
    await settle();

    expect(greenLine(h), "还没读完就不作断言").toContain(STILL_READING);
    expect(greenLine(h), "读没读完都还不知道，不能说空").not.toContain(NOTHING_TO_SAVE);
    expect(greenLine(h)).not.toContain(zh["files.cloudEmpty"]);
    expect(window.localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  test("清单读取被拒：走拒绝槽，说出那句拒绝，且不许声称设备上没有文件", async () => {
    installBridge("refuse");
    const h = render(FilesApp);
    await settle();

    await fireEvent.click(btnContaining(h, zh["files.cloudSnapshot"])!);
    await settle();

    expect(
      cloudRefusal(h)?.textContent ?? "",
      "一次读不动的拒绝要说出口（外部文件区说的同一句话）",
    ).toContain(zh["files.externalBlocked"]);
    expect(greenLine(h), "读被拒 ≠ 设备为空").not.toContain(NOTHING_TO_SAVE);
    expect(greenLine(h), "拒绝不进绿行").not.toContain(zh["files.cloudEmpty"]);
    expect(window.localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  test("对照：真的读到文件时，保存照常成功，绿行说「已保存」", async () => {
    installBridge("one");
    const h = render(FilesApp);
    await vi.waitFor(() =>
      expect(h.container.querySelector('[data-testid="external-total"]')).toBeTruthy(),
    );

    await fireEvent.click(btnContaining(h, zh["files.cloudSnapshot"])!);
    await settle();

    expect(cloudRefusal(h), "没有被拒的东西").toBeNull();
    expect(boxText(h), "绿行说保存成功了").toContain(
      zh["files.cloudSaved"].replace("{count}", "1"),
    );
    expect(text(h), "新句不该在成功路径上出现").not.toContain(NOTHING_TO_SAVE);
    expect(window.localStorage.getItem(SNAPSHOT_KEY), "盘上有快照了").not.toBeNull();
  });
});

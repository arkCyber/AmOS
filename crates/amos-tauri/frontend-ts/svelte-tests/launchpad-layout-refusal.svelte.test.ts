/**
 * launchpad-layout-refusal.svelte.test.ts — 存储拒写时「隐藏 ∕ 还原」不许假装生效（REQ-A1346 / FMEA F-SH-611）。
 *
 * `hideApp` ∕ `restoreApp` 原先都写作 `layout = next; saveLayout(next);` —— 记忆里的
 * `layout` 先改了、屏幕跟着画，而 `saveLayout` 签 `void`、里面的 `writeJson` 的返回值被丢掉。
 * 存储拒写（满 ∕ 不可用）时盘上还是旧布局：重启之后被「隐藏」的 app 又回来了，而这一路
 * 一句提示都没有 —— 用户看到的是一次「成功」的隐藏，实际上什么都没发生。
 *
 * 同一个键（`amos.home.layout`）的**另一个**写者 —— Dock 的拖拽排序 —— 早就走
 * `writeStoreValueChecked` + `StoreErrorBar`，并在被拒时保持内存里的旧顺序
 * （`Dock.svelte` 的 `onWindowDragEnd`）。本文件把 Launchpad 这一半也钉住，两向都钉：
 * 拒写 ⇒ 屏幕上那句提示出现、图标**还在**、盘上原样；收下 ⇒ 图标消失、盘上真的变了、没有提示。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import Launchpad from "../src/svelte/Launchpad.svelte";
import { LAYOUT_KEY, readStoreValue, writeStoreValueChecked, type HomeLayout } from "../src/lib/amosStore";
import { nameForId } from "../src/lib/appLookup";
import { zh } from "../src/i18n/locales/zh";

const SEEDED: HomeLayout = { page: ["notes", "files", "clock"], dock: [], hidden: [] };

/**
 * 让 `localStorage.setItem` 只在**布局那个键**上抛错 —— 存储拒写的真身
 * （`writeJson` 把它变成 `false` 并记一条 `store` 错误）。
 *
 * 用替换整个 `window.localStorage` 的写法（同 `hotspot-page.svelte.test.ts`）：`writeJson`
 * 调的是 `window.localStorage.setItem`，而 happy-dom 的 `Storage` 全局与本例的补丁未必同源。
 */
let refuseLayoutWrites = false;
let restoreStorage: (() => void) | null = null;

function installRefusingStorage(): void {
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
      if (refuseLayoutWrites && k === LAYOUT_KEY) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  restoreStorage = () => {
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
  };
}

beforeEach(() => {
  window.localStorage.clear();
  refuseLayoutWrites = false;
  installRefusingStorage();
  writeStoreValueChecked(LAYOUT_KEY, SEEDED);
});

afterEach(() => {
  cleanup();
  refuseLayoutWrites = false;
  restoreStorage?.();
  restoreStorage = null;
  window.localStorage.clear();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const storedLayout = () => readStoreValue<HomeLayout>(LAYOUT_KEY, SEEDED);
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")] as HTMLButtonElement[];
const appTile = (h: { container: HTMLElement }, id: string) =>
  buttons(h).find(
    (b) => b.getAttribute("aria-label") === nameForId(id, [], (k: string) => zh[k] ?? k),
  );

/** 进编辑模式，然后点某个 app 的图标（编辑模式下那一击 = 隐藏）。 */
async function hideVia(h: { container: HTMLElement }, id: string) {
  const edit = buttons(h).find((b) => (b.textContent ?? "").trim() === zh["desktop.edit"])!;
  expect(edit, "应有「编辑」按钮").toBeTruthy();
  expect(edit.getAttribute("aria-pressed")).toBe("false");
  await fireEvent.click(edit);
  await settle();
  const tile = appTile(h, id);
  expect(tile, `编辑模式里应有 ${id} 的图标`).toBeTruthy();
  await fireEvent.click(tile!);
  await settle();
}

describe("Launchpad — 隐藏一个 app 时，存储的裁决必须决定屏幕", () => {
  test("存储拒写 ⇒ 说出那一句，且图标**还在**（没发生的隐藏不许画出来）", async () => {
    const h = render(Launchpad);
    await settle();
    refuseLayoutWrites = true;

    await hideVia(h, "notes");

    expect(txt(h)).toContain(zh["common.storeWriteFailed"]);
    expect(appTile(h, "notes"), "盘上没变 ⇒ 图标不该消失").toBeTruthy();
    expect(storedLayout().page, "盘上原样").toEqual(["notes", "files", "clock"]);
  });

  test("存储收下 ⇒ 图标消失、盘上真的变了，且没有那句提示（对照，不是一律报失败）", async () => {
    const h = render(Launchpad);
    await settle();

    await hideVia(h, "notes");

    expect(txt(h)).not.toContain(zh["common.storeWriteFailed"]);
    expect(appTile(h, "notes"), "真的隐藏了").toBeUndefined();
    expect(storedLayout().page).toEqual(["files", "clock"]);
    expect(storedLayout().hidden).toContain("notes");
  });

  test("拒写之后再成功一次 ⇒ 提示消失（这句话说的是**这一次**的裁决）", async () => {
    const h = render(Launchpad);
    await settle();
    refuseLayoutWrites = true;
    await hideVia(h, "notes");
    expect(txt(h)).toContain(zh["common.storeWriteFailed"]);

    refuseLayoutWrites = false;
    await fireEvent.click(appTile(h, "notes")!);
    await settle();

    expect(txt(h)).not.toContain(zh["common.storeWriteFailed"]);
    expect(appTile(h, "notes")).toBeUndefined();
  });
});

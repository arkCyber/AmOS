/**
 * desktop-icon-drag-refusal.svelte.test.ts — 桌面图标拖拽排序把布局写入的裁决丢在地上
 * （REQ-A1390 / FMEA F-SH-649）。
 *
 * `DesktopStage.svelte::onWindowMouseUp` 的 move 支收尾处原先逐字：
 *
 *     saveLayout(next);
 *     layout = getLayout(APP_META.map((a) => a.id));
 *
 * `lib/amosStore.ts::saveLayout` 签 `void`（逐字 `export function saveLayout(layout): void {
 * writeJson(LAYOUT_KEY, layout); }`），`writeJson` 在 `setItem` 抛错时只记一条 `store` 日志
 * 并回 `false` —— **裁决被丢在地上**。存储拒写（满 ∕ 不可用）时盘上那一行还是旧顺序，而下面
 * 那句 `getLayout()` 是**从盘上重读**的 ⇒ 图标静静地**弹回原位**：用户拖了一次，看着它跳回去，
 * 没有一个字说为什么。「一次没生效的拖拽」与「一颗坏掉的图标」在屏幕上一模一样。
 *
 * 这不是新形状 —— 同一枚键（`amos.home.layout`）的另外三个写者早就门住了裁决：
 *   • `Dock.svelte::onWindowDragEnd`（REQ-A1346 ∕ F-SH-611 同族），
 *   • `Launchpad` 的隐藏 ∕ 还原（REQ-A1346 ∕ F-SH-611，见 `launchpad-layout-refusal`），
 *   • `shellState.svelte.ts::applyLayout`（REQ-A1378 ∕ F-SH-641）。
 * 那一轮把写者数成「**三个**，两个早就门住了、第三个把 `_layout` 先搬走」—— 桌面这一处不在
 * 那张名单上，因为它是从**另一个面**（桌面舞台，不是手机主屏）写同一个键的：按**形状**枚举
 * 写者（`_layout = next; saveLayout(next)`）看不见它，只有按**键**枚举才看得见。
 *
 * 两向都钉：拒写 ⇒ 说出那一句、屏幕与盘上都停在旧顺序；收下 ⇒ 顺序真的变了、没有提示。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopShell from "../src/svelte/DesktopShell.svelte";
import { LAYOUT_KEY, readStoreValue, writeStoreValueChecked, type HomeLayout } from "../src/lib/amosStore";
import { zh } from "../src/i18n/locales/zh";

const SNAPSHOT = {
  screen_w: 1496,
  screen_h: 882,
  split: null,
  candidates: [],
  form: "desktop",
  columns: 4,
  multi_window: true,
  free_resize: true,
  divider_gap: 8,
};

/** The two wm reads the desktop shell makes at mount. */
function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "wm_layout_snapshot") return SNAPSHOT;
      if (cmd === "wm_windows") return { windows: [] };
      return null;
    },
    listen: async () => () => {},
  };
}

/** 只让**布局那个键**上的写入抛错 —— 存储拒写的真身（同 `launchpad-layout-refusal`）。 */
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

const SEEDED: HomeLayout = { page: ["clock", "notes", "calendar", "files"], dock: [], hidden: [] };

beforeEach(() => {
  window.localStorage.clear();
  refuseLayoutWrites = false;
  installRefusingStorage();
  installHost();
  writeStoreValueChecked(LAYOUT_KEY, SEEDED);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  refuseLayoutWrites = false;
  restoreStorage?.();
  restoreStorage = null;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 40));
  await tick();
};

const page = (): string[] => readStoreValue<HomeLayout | null>(LAYOUT_KEY, null)?.page ?? [];
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
/**
 * 屏幕上图标的**绘制顺序**（DOM 序即网格序）。
 *
 * 只取前 4 个：`getLayout` 会把"还没被摆过"的应用 id 一律补进 `page`（`for (const id of
 * available) if (!placed.has(id)) page.push(id)`），而 `DesktopStage` 每次写完都从盘上重读一遍，
 * 于是屏幕上排在前面的始终是用户的 4 个图标、后面跟着其余应用。本文件钉的是**那 4 个的顺序**。
 */
const iconOrder = (h: { container: HTMLElement }): string[] =>
  [...h.container.querySelectorAll<HTMLElement>("[data-desktop-icon-id]")]
    .map((n) => n.dataset.desktopIconId ?? "")
    .slice(0, 4);

/** 把 `clock` 拖到 `files` 上 —— 走真实指针序列（mousedown → mousemove → mouseup）。 */
async function dragClockOntoFiles(h: { container: HTMLElement }) {
  const clock = h.container.querySelector<HTMLElement>('[data-desktop-icon-id="clock"]')!;
  const files = h.container.querySelector<HTMLElement>('[data-desktop-icon-id="files"]')!;
  await fireEvent.click(clock); // 先选中：拖拽移动的是选区
  await tick();
  await fireEvent.mouseDown(clock, { button: 0, clientX: 40, clientY: 40 });
  await tick();
  vi.spyOn(document, "elementFromPoint").mockReturnValue(files);
  await fireEvent.mouseMove(window, { clientX: 300, clientY: 300 });
  await fireEvent.mouseUp(window, { clientX: 300, clientY: 300 });
  await settle();
}

describe("DesktopStage — 拖拽排序时，存储的裁决必须决定屏幕", () => {
  test("存储拒写 ⇒ 说出那一句，屏幕与盘上都停在旧顺序（弹回去也要说话）", async () => {
    const h = render(DesktopShell);
    await settle();
    refuseLayoutWrites = true;

    await dragClockOntoFiles(h);

    expect(txt(h), "一次没生效的拖拽必须说出口").toContain(zh["common.storeWriteFailed"]);
    expect(page(), "盘上原样").toEqual(["clock", "notes", "calendar", "files"]);
    expect(iconOrder(h), "屏幕也停在旧顺序（重读盘 = 旧序）").toEqual([
      "clock",
      "notes",
      "calendar",
      "files",
    ]);
  });

  test("存储收下 ⇒ 顺序真的变了，且没有那句提示（对照，不是一律报失败）", async () => {
    const h = render(DesktopShell);
    await settle();

    await dragClockOntoFiles(h);

    expect(txt(h)).not.toContain(zh["common.storeWriteFailed"]);
    expect(page()).toEqual(["notes", "calendar", "clock", "files"]);
    expect(iconOrder(h).slice(0, 4)).toEqual(["notes", "calendar", "clock", "files"]);
  });

  test("拒写之后再成功拖一次 ⇒ 提示消失（这句话说的是**这一次**的裁决）", async () => {
    const h = render(DesktopShell);
    await settle();
    refuseLayoutWrites = true;
    await dragClockOntoFiles(h);
    expect(txt(h)).toContain(zh["common.storeWriteFailed"]);

    refuseLayoutWrites = false;
    await dragClockOntoFiles(h);

    expect(txt(h)).not.toContain(zh["common.storeWriteFailed"]);
    // 第二次拖拽是在**重读之后**的 `layout` 上做的，而那次重读会把其余应用 id 补进 `page`
    // （`getLayout` 的既有行为）—— 所以这一支只看前 4 个，那才是用户的桌面图标。
    expect(page().slice(0, 4)).toEqual(["notes", "calendar", "clock", "files"]);
  });
});

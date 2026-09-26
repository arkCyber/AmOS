/**
 * camera-photos-corrupt-shape.svelte.test.ts — `amos.photos` 的**读取侧**：相册页
 * （`PhotosApp`）过了这个键自己的守卫，**相机**（`CameraApp`）没过。REQ-A1422 ∕ FMEA F-SH-680。
 * 核实如下（对工作树，逐字）：
 *
 *   • 这个键有一条自己的守卫：`src/lib/photos.ts:98`
 *     `export function normalizePhotos(list: unknown): Photo[] { if (!Array.isArray(list)) return []; … }`
 *     —— 注释逐字写着「a corrupted `amos.photos` can never break grids ∕ viewer navigation」。
 *   • `PhotosApp.svelte` 两处都走它：种子 `:111` `if (raw !== undefined) return normalizePhotos(raw);`、
 *     订阅 `:136` `photosStore.subscribe((v) => (list = normalizePhotos(v)))`。
 *   • `CameraApp.svelte` 的**两处读取逐字不归一化**：
 *     `:109` `let last = $state<Photo | null>(latestPhoto(readStoreValue<Photo[]>(PHOTOS_KEY, [])) ?? null);`
 *     —— 它落在**组件初始化的 `$state` 初始值**里，而本文件的 `latestPhoto` 逐字
 *     `for (const p of list) if (p.data) return p;` —— 非数组即 `list is not iterable`，
 *     抛在渲染之前 ⇒ **相机整个打不开**（不是「缩略图不对」）。
 *     `:369` `const list = readStoreValue<Photo[]>(PHOTOS_KEY, []);`，随后 `:410`
 *     `writeStoreValueChecked(PHOTOS_KEY, [photo, ...list])` —— 非数组即展开抛错 ⇒ **按快门失败**。
 *   • `readJson` 只隔离**解析不了的**字节：合法 JSON 的 `{}` ∕ `5` ∕ `null` ∕ `"x"` 原样返回，
 *     `fallback` 仅在**字符串缺席**时生效（`lib/amosStore.ts:52` `if (raw == null) return fallback;`）。
 *     这个键又是**云端备份集合**里的一个（`lib/cloud.ts:62` `SYNC_STORES` 含 `PHOTOS_KEY`），
 *     而 `restoreBackup`（`cloud.ts:278-281`）逐字 `if (write(k, env.stores[k])) restored.push(k);`
 *     —— 把备份里的值**原样**写进存储，**没有任何形状校验**（`readEnvelope` 只要求 `stores` 是
 *     非数组对象）。于是「从备份恢复」这条正常用户路径就能把一个非数组合法地放进 `amos.photos`。
 *   • 同键的**写者**不止一个：`PhotosApp` 自己的动词走 `persist()`，而相机快门写**同一个相册**
 *     （`PhotosApp.svelte` 的 REQ-A1354 注释逐字点名 `CameraApp.doCapture`）。
 *
 * 修法：相机那两处读侧归一化（`normalizePhotos`），与相册页同形。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import CameraApp from "../src/svelte/CameraApp.svelte";
import { PHOTOS_KEY, type Photo } from "../src/lib/photos";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

/** Valid JSON that is **not** an array — the shape `readJson` hands back verbatim. */
const CORRUPT = "{}";

/** Seed the raw *bytes*: `writeStoreValue` would JSON.stringify the string itself. */
const corrupt = () => window.localStorage.setItem(PHOTOS_KEY, CORRUPT);

const FAKE_STREAM = {
  getTracks: () => [{ stop: () => {} }],
  getVideoTracks: () => [{ applyConstraints: () => Promise.resolve() }],
};

function setupMedia() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve(FAKE_STREAM) },
  });
}
function tearDownMedia() {
  try {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  } catch {
    /* ignore */
  }
}

async function settle() {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
}

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const btnAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === aria,
  ) as HTMLButtonElement | undefined;

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
  resetPropsChannels();
});

afterEach(() => {
  cleanup();
  tearDownMedia();
  resetPropsChannels();
  setLocale("zh");
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
});

describe("amos.photos 的读取侧必须归一化（REQ-A1422 ∕ F-SH-680）", () => {
  test("盘上是一个合法的非数组时相机仍然打得开（那处读在 `$state` 初始值里，抛在渲染之前）", async () => {
    corrupt();
    const host = render(CameraApp);
    await settle();

    // 修前：`latestPhoto({})` 的 `for (const p of list)` ⇒ TypeError，相机整个打不开。
    expect(btnAria(host, zh["a11y.shutter"])).toBeTruthy();
    expect(btnAria(host, zh["a11y.shutter"])?.disabled).toBe(true); // 无摄像头 ⇒ 演示取景器
  });

  test("盘上是一个合法的非数组时不抛错，且归零成空相册（不是「把它当照片画」）", async () => {
    corrupt();
    const host = render(CameraApp);
    await settle();
    // 归一化 ≠ 画一个假条目：缩略图条没有 `last?.data`，一枚缩略图都不画。
    expect(host.container.querySelector('img[src^="data:image"]')).toBeNull();
  });

  test("live 模式：快门那一刻盘上是合法的非数组时不抛错，并把这张照片写成一个真数组", async () => {
    // 盘上先是一本**完好**的相册（挂载读得过），在按下快门**之前**才把它写坏 ——
    // 这样这一例只钉 `doCapture` 那处读，不被挂载那处读的抛错遮住。
    setupMedia();
    const host = render(CameraApp);
    await settle();
    corrupt();

    const shot = btnAria(host, zh["a11y.shutter"]);
    expect(shot?.disabled).toBe(false);
    await fireEvent.click(shot as HTMLButtonElement);
    await settle();

    // 修前：`[photo, ...list]` 展开 `{}` ⇒ TypeError，快门按下没有任何结果。
    expect(txt(host)).toContain("已保存到相册"); // camera.saved
    const stored = JSON.parse(window.localStorage.getItem(PHOTOS_KEY) ?? "null");
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toHaveLength(1);
  });

  test("对照（守卫）：归一化不等于画零 —— 完好的一本相册仍然画出最近一张", async () => {
    const p: Photo = { id: "p1", ts: 2, data: "data:image/png;base64,AAAA" };
    window.localStorage.setItem(PHOTOS_KEY, JSON.stringify([p]));
    const host = render(CameraApp);
    await settle();
    expect(host.container.querySelector('img[src^="data:image"]')).toBeTruthy();
  });
});

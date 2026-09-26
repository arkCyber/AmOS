/**
 * files-fav-corrupt-shape.svelte.test.ts — `amos.files.favorites` 的读取侧没有守
 * 卫：文件管理器（`FilesApp`）把这个键当 `string[]` 直读，而它落在**渲染路径**上。
 * REQ-A1422 ∕ FMEA F-SH-680。
 *
 * 核实如下（对工作树，逐字）：
 *
 *   • `FilesApp.svelte:203` 逐字 `const initFavs = readStoreValue<string[]>(FILES_FAV_KEY, []);`
 *     —— 紧接着 `:204` `let favs = $state<string[]>(initFavs);`。**没有任何归一化**：
 *     `lib/files.ts` 对这个键只定义了字面量（`:252` `export const FILES_FAV_KEY = "amos.files.favorites";`）
 *     与 `toggleFav`（`:346`），**没有 `normalizeFavs` 之类的守卫**。
 *   • 读出来的 `favs` 落在渲染路径上：`:408` `list.filter((e) => favs.includes(e.id))`
 *     （`mode === "fav"` 的派生列表）、`:1551` `favs.length === 0`、
 *     `:1582 ∕ :1598-1600` 每个条目的收藏按钮与 `★ ∕ ☆`。
 *   • `readJson` 只隔离**解析不了的**字节：合法 JSON 的 `{}` ∕ `5` ∕ `null` ∕ `"x"`
 *     原样返回，`fallback` 仅在字符串缺席时生效（`lib/amosStore.ts:52`）。于是
 *     `favs = {}` ⇒ `favs.includes is not a function`，**抛在渲染里** ⇒ 不是「星标
 *     没亮」，而是**整个文件管理器打不开**。
 *   • 这个键是**云端备份集合**里的一个（`lib/cloud.ts` `SYNC_STORES` 含 `FILES_FAV_KEY`），
 *     而 `restoreBackup`（`cloud.ts:278-281`）逐字 `if (write(k, env.stores[k])) restored.push(k);`
 *     —— 把备份里的值**原样**写进存储，**没有任何形状校验**；`readEnvelope` 也只要求
 *     `stores` 是非数组对象。于是「从备份恢复」这条正常用户路径就能把一个非数组合法地
 *     放进这个键。
 *
 * 修法：与同族的 `normalizePhotos ∕ normalizeNotes ∕ normalizeTrash` 同形，在
 * `lib/files.ts` 里给这个键补一个 `normalizeFavs`（非数组 ⇒ `[]`；只留字符串），
 * `FilesApp` 那处读取改走它。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import FilesApp from "../src/svelte/FilesApp.svelte";
import { FILES_FAV_KEY } from "../src/lib/files";
import { setLocale } from "../src/svelte/locale.svelte";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { zh } from "../src/i18n/locales/zh";

/** Valid JSON that is **not** an array — the shape `readJson` hands back verbatim. */
const CORRUPT = "{}";

/** Seed the raw *bytes*: `writeStoreValue` would JSON.stringify the string itself. */
const corrupt = () => window.localStorage.setItem(FILES_FAV_KEY, CORRUPT);

const stars = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].filter((b) =>
    (b.textContent ?? "").includes("★"),
  );

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
  resetPropsChannels();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetPropsChannels();
  setLocale("zh");
});

describe("amos.files.favorites 的读取侧必须有守卫（REQ-A1422 ∕ F-SH-680）", () => {
  test("盘上是一个合法的非数组时文件管理器仍然打得开，且一枚星标都不亮", () => {
    corrupt();
    // 修前：`favs.includes` 对 `{}` 抛 TypeError（`favs` 参与渲染）⇒ `render` 直接抛，
    // 整个文件管理器打不开（不是「收藏丢了」）。
    const host = render(FilesApp);
    expect(host.container.textContent ?? "").toContain("文档");
    expect(stars(host)).toHaveLength(0);
    // 归一化 ≠ 把坏值写回：盘上仍然是我们没有覆写的那个非数组。
    expect(window.localStorage.getItem(FILES_FAV_KEY)).toBe(CORRUPT);
  });

  test("对照（守卫）：归一化不等于清空 —— 完好的一份收藏仍然亮着星", () => {
    window.localStorage.setItem(FILES_FAV_KEY, JSON.stringify(["doc"]));
    const host = render(FilesApp);
    const lit = stars(host);
    expect(lit).toHaveLength(1);
    expect(lit[0]?.getAttribute("aria-label")).toBe(zh["a11y.unfavorite"]);
  });
});

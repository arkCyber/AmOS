/**
 * interp-log-corrupt-shape.svelte.test.ts — `amos.interp.log` 的读取侧没有守卫：
 * 同传（`InterpApp`）从 `loadSegs()` 拿到的值**原样**进了 `$state` 与 `{#each}`。
 * REQ-A1422 ∕ FMEA F-SH-680。
 *
 * 核实如下（对工作树，逐字）：
 *
 *   • `src/lib/interp.ts:87` 逐字 `return readStoreValue<InterpSeg[]>(INTERP_LOG_KEY, []);`
 *     —— 这个键**没有任何归一化**：`interp.ts` 只导出 `loadSegs ∕ saveSegs ∕ clearSegs`，
 *     没有 `normalizeSegs` 之类的守卫（同族的 `photos.ts ∕ notes.ts ∕ files.ts` 都有）。
 *   • `InterpApp.svelte:54` `let segs = $state<InterpSeg[]>(loadSegs());` 落在
 *     **组件初始化的 `$state` 初始值**里，随后 `:529-532`
 *     `{#if segs.length === 0 && !partial} … {:else} {#each segs as seg, i (i)}` ——
 *     非数组即 `segs is not iterable`，抛在渲染里 ⇒ **同传整个打不开**（不是「记录空了」）。
 *   • `readJson` 只隔离**解析不了的**字节：合法 JSON 的 `{}` ∕ `5` ∕ `null` ∕ `"x"`
 *     原样返回，`fallback` 仅在字符串缺席时生效（`lib/amosStore.ts:52`）。这个键是
 *     **云端备份集合**里的一个（`lib/cloud.ts:75` `SYNC_STORES` 含 `INTERP_LOG_KEY`，
 *     与旧版 vanilla 同传 App 共享），而 `restoreBackup`（`cloud.ts:278-281`）逐字
 *     `if (write(k, env.stores[k])) restored.push(k);` —— 把备份里的值**原样**写进存储，
 *     **没有任何形状校验**。于是「从备份恢复」这条正常用户路径就能把一个非数组合法地
 *     放进这个键。
 *
 *   • 与另外三处不同，这一处的症状**不是**打不开：Svelte 5 的 `{#each}` 对普通对象
 *     不抛（画零行），所以屏幕看起来只是「记录是空的」。真正坏掉的是**动词的可用
 *     状态**：`:524` `disabled={segs.length === 0}` 对 `{}` 求值为 `undefined` ⇒
 *     「⧉ 复制全部译文」**看起来可用**；按下去 `:395` `transcriptText(segs, bilingual)`
 *     里 `for (const s of segs)` 抛 `segs is not iterable`，而 `copyAll` 是 `async`
 *     （`:523` `onclick={() => void copyAll()}`）⇒ 变成一个没人接的 promise rejection，
 *     **静默什么都不做**。一个亮着却不中用的按钮。
 *
 * 修法：与同族同形，在 `interp.ts` 里补 `normalizeSegs`（非数组 ⇒ `[]`），`loadSegs`
 * 走它。**不设上限**：`SEG_CAP` 是写入侧（`InterpApp` 的 `capTail`）的事，归一化再截
 * 一次会改变「盘上已有一份超长记录」时的既有渲染结果。
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import InterpApp from "../src/svelte/InterpApp.svelte";
import { INTERP_LOG_KEY } from "../src/lib/interp";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

/** Valid JSON that is **not** an array — the shape `readJson` hands back verbatim. */
const CORRUPT = "{}";

/** Seed the raw *bytes*: `writeStoreValue` would JSON.stringify the string itself. */
const corrupt = () => window.localStorage.setItem(INTERP_LOG_KEY, CORRUPT);

const log = (h: { container: HTMLElement }) =>
  h.container.querySelector('[role="log"]') as HTMLElement | null;
const copyAllBtn = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(zh["interp.copyAll"]),
  ) as HTMLButtonElement | undefined;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  setLocale("zh");
});

describe("amos.interp.log 的读取侧必须有守卫（REQ-A1422 ∕ F-SH-680）", () => {
  test("盘上是一个合法的非数组时同传仍然打得开，记录区是空的，且「复制全部」是禁用的", async () => {
    setLocale("zh");
    corrupt();
    const host = render(InterpApp);
    await tick();
    const box = log(host);
    expect(box).toBeTruthy();
    // 空记录区的占位文案：本用例的主体是「读取侧守卫」，这里要的是「记录区是空的」。
    // 该占位句原先是 `"—"`，修 REQ-A1812 后它落在自己成立的那一侧（未开会话），故断言
    // 跟着落在同一句上——测的仍是「没有记录」，而不是某个具体字符。
    expect(box?.textContent ?? "").toContain(zh["interp.notRunning"]);
    // 修前：`segs.length` 对 `{}` 是 `undefined` ⇒ `disabled={undefined}` ⇒
    // 按钮**看起来可用**；按下去 `transcriptText` 抛，`async` 把它吞成一个
    // 没人接的 rejection，静默什么都不做。
    expect(copyAllBtn(host)?.disabled).toBe(true);
    await fireEvent.click(copyAllBtn(host) as HTMLButtonElement);
    // 归一化 ≠ 把坏值写回：盘上仍然是我们没有覆写的那个非数组。
    expect(window.localStorage.getItem(INTERP_LOG_KEY)).toBe(CORRUPT);
  });

  test("对照（守卫）：归一化不等于清空 —— 完好的一份记录仍然画得出来", () => {
    setLocale("zh");
    window.localStorage.setItem(INTERP_LOG_KEY, JSON.stringify([{ src: "hi", target: "你好" }]));
    const host = render(InterpApp);
    expect(log(host)?.textContent ?? "").toContain("你好");
  });
});

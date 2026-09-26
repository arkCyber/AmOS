/**
 * corrupt-recents-guard.svelte.test.ts — `amos.recents` 存着一个 **合法 JSON 但不是数组** 的值
 * （`null` ∕ `{}` ∕ `5` ∕ `"clock"`）时，读它的每一屏都必须照常画出来（REQ-A1438 ∕ FMEA F-SH-696）。
 *
 * 为什么这个形状真的到得了读者手里（逐字，均有出处）：
 *   - `lib/amosStore.ts::readJson` 只隔离**解析不了**的字节 —— `null` ∕ `{}` ∕ `5` 都是合法 JSON，
 *     原样返回，`fallback` 只在键**不存在**时才生效；
 *   - 这个键的值就是 Rust `SharedStore` 的权威字节串，而**两条水合路径都把镜像逐字写进
 *     localStorage**：`hydrateFromSystemStore`（启动的 `store_snapshot`）与
 *     `svelte/store.ts::onStoreUpdated`（跨窗 `store_set` 载荷，`JSON.parse` 后 `set(parsed)`）。
 *     于是旧版本、另一个窗口、或手改过的 `~/.amos/state.json` 都能把一个标量送进这些读者 ——
 *     尽管本仓没有任何写者会造出它。
 *
 * 三个读者在修前都没有这层收窄，而它们的消费者会**迭代**这份列表（`for…of` ∕ `.filter` ∕
 * `.forEach`），所以非数组不是「数字画错了」，是**抛异常**：
 *   - `shellState.open()` 第一行就调 `pushRecent()` → `getRecents().filter(...)` ⇒ 一次坏值让
 *     **每一个 app 都打不开**（`open` 是 async，同步抛出即 reject，调用方无 catch，静默）；
 *   - `AppLibrary` 的 `frequent` `$derived.by` 里 `frequentTools(getRecents(), …)` 的 `for…of` ⇒
 *     资源库整屏画不出来；
 *   - `SpotlightPanel` 的 `recents` 订阅值喂给 `orderByRecency` 的 `recents.forEach` ⇒ sheet 画不出来。
 *
 * 两条**已经**收窄的兄弟（`HomeDock` ∕ `RecentsPanel` 手写的 `Array.isArray`）正是这条规则的
 * 见证：规则早就知道，只是没落在**整条 open 路径都经过的那个取数口**上。本轮把规则命名一次
 * （`lib/amosStore.ts::normalizeRecents`）并让五处共用，所以下一次扫描是 grep 一个名字。
 *
 * 负控：把 `normalizeRecents` 换成恒等（`return v as string[]`）⇒ 本文件的例子应当**红**。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import SpotlightPanel from "../src/svelte/SpotlightPanel.svelte";
import AppLibrary from "../src/svelte/AppLibrary.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { resetShellState } from "../src/svelte/shellState.svelte";
import { RECENTS_KEY, writeStoreValue, getRecents, pushRecent } from "../src/lib/amosStore";

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
});
afterEach(() => {
  resetPropsChannels();
  resetShellState();
  window.localStorage.clear();
});

/** 画出来的 Spotlight 应用行 id，按屏幕顺序。 */
const spotAppRows = (c: HTMLElement): string[] =>
  [...c.querySelectorAll('[data-testid^="spot-app-"]')].map(
    (e) => e.getAttribute("data-testid")!.replace("spot-app-", ""),
  );

const mountSpotlightOpen = async () => {
  propsChannel<{ open: boolean }>("spotlight").set({ open: true });
  const h = render(SpotlightPanel);
  await settle();
  return h;
};

describe("一个非数组的 `amos.recents` 不能弄坏读它的屏幕（REQ-A1438）", () => {
  for (const corrupt of ["null", "{}", "5", '"clock"']) {
    test(`SpotlightPanel：stores ${corrupt} 时照常画应用行`, async () => {
      writeStoreValue(RECENTS_KEY, JSON.parse(corrupt));
      const h = await mountSpotlightOpen();
      // 修前：`orderByRecency` 的 `recents.forEach` 抛 ⇒ 这里一行都画不出来。
      expect(spotAppRows(h.container).length).toBeGreaterThan(0);
    });

    test(`AppLibrary：stores ${corrupt} 时照常画「常用」组`, async () => {
      writeStoreValue(RECENTS_KEY, JSON.parse(corrupt));
      const bus = propsChannel<{ layout: { page: string[]; dock: string[]; hidden: string[] } }>(
        "appLibrary",
      );
      bus.set({ layout: { page: [], dock: [], hidden: [] } });
      const h = render(AppLibrary);
      await settle();
      // 修前：`frequentTools` 的 `for…of` 抛 ⇒ 整屏画不出来。
      expect(h.container.textContent).toBeTruthy();
      expect(h.container.querySelectorAll("button").length).toBeGreaterThan(0);
    });
  }

  test("`pushRecent`（open 路径的第一行）不再抛，且把坏值自愈成一份真正的列表", () => {
    writeStoreValue(RECENTS_KEY, JSON.parse("{}"));
    expect(() => pushRecent("clock")).not.toThrow();
    expect(getRecents()).toEqual(["clock"]);
    // 落盘的那份也已经是数组 —— 下一次启动不会再看到坏形状。
    const raw = window.localStorage.getItem(RECENTS_KEY) as string;
    expect(Array.isArray(JSON.parse(raw))).toBe(true);
  });

  test("对照：一份**好的** recents 仍然照常生效（收窄没有把功能一起吞掉）", async () => {
    writeStoreValue(RECENTS_KEY, ["calculator", "settings"]);
    const h = await mountSpotlightOpen();
    expect(spotAppRows(h.container).slice(0, 2)).toEqual(["calculator", "settings"]);
  });
});

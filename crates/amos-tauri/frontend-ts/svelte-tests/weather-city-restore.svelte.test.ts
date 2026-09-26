/**
 * weather-city-restore.svelte.test.ts — 记住的城市选择必须能恢复（REQ-A1338）
 *
 * 为什么这个文件存在：`WeatherApp.svelte` 在挂载时把存下来的选中城市
 * （`amos.weather.city`）拿去和**默认四城**比对，而不是和**用户真正持有的那份城市表**
 * 比对：
 *
 *   const savedSel = readStoreValue<string>(CITY_KEY, "");
 *   const initialSel = normalizeWeatherCities(undefined).some((c) => c.id === savedSel)
 *     ? savedSel
 *     : "";
 *
 * `normalizeWeatherCities(undefined)` 不读任何持久化 —— `Array.isArray(undefined)` 为假，
 * 它直接返回兜底 `defaultWeatherCities()`（北京 ∕ 东京 ∕ 伦敦 ∕ 纽约 这前四个）。而同一段
 * 代码上一行算出来的 `initialCities` 才是从 `amos.weather.cities` 读回来的、用户真正持有的
 * 那张表。于是：用户把巴黎（第五城）加进来并选中它，重开这个 app —— 存下来的 "paris" 被拿
 * 去问一张**不含巴黎的名单**，答案「不在表里」被读成「这个选择失效了」，`selId` 落成 `""`，
 * `active` 于是回落到 `cities[0]`；更坏的是那两个 `$effect` 立刻把 `""` 写回
 * `amos.weather.city`，把用户记住的选择**抹掉**。屏幕上没有任何痕迹说「你选的城市没了」。
 *
 * 判据：不读组件的内部状态，读两个可观察的面 —— 渲染出来的活动 chip，以及存储里的那条选择。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WeatherApp from "../src/svelte/WeatherApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";

const CITIES_KEY = "amos.weather.cities";
const CITY_KEY = "amos.weather.city";

/** 城市 chip —— `button[aria-pressed]` **减去** ℃/℉ 那一对（它们也带 `aria-pressed`）。 */
function cityChips(host: { container: HTMLElement }): HTMLButtonElement[] {
  return [...host.container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].filter(
    (b) => !/[℃℉]/.test(b.textContent ?? ""),
  );
}

/** 屏幕上**活动**的城市 chip 的文案（`aria-pressed="true"` 的那个）。 */
function activeCity(host: { container: HTMLElement }): string | undefined {
  return cityChips(host)
    .find((b) => b.getAttribute("aria-pressed") === "true")
    ?.textContent?.trim();
}

const city = (id: string) => ({ id, offset: 0 });

beforeEach(() => {
  setLocale("zh");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  setLocale("zh");
});

describe("WeatherApp 记住的城市选择（REQ-A1338）", () => {
  test("用户选中的是一座「加进来的」城市时，重开之后仍然是它", async () => {
    // 用户此前加过巴黎并选中了它：持久化的城市表**含**巴黎，选择就是巴黎。
    writeStoreValue(CITIES_KEY, [
      city("beijing"),
      city("tokyo"),
      city("london"),
      city("newyork"),
      city("paris"),
    ]);
    writeStoreValue(CITY_KEY, "paris");

    const host = render(WeatherApp);
    await tick();

    // 面:用户在重开之后看到的是哪一格城市亮着。
    expect(activeCity(host)).toBe("巴黎");
  });

  test("重开不会把记住的选择写掉（存储里仍是那座城市）", async () => {
    writeStoreValue(CITIES_KEY, [
      city("beijing"),
      city("tokyo"),
      city("london"),
      city("newyork"),
      city("paris"),
    ]);
    writeStoreValue(CITY_KEY, "paris");

    render(WeatherApp);
    await tick();

    // 面:下一次重开时会被读到的那条存储。
    expect(readStoreValue<string>(CITY_KEY, "")).toBe("paris");
  });

  test("确实失效的选择仍回落到第一城（撤销不是空转）", async () => {
    // 存的是悉尼，而用户的表里没有悉尼（比如它被编辑移除了）—— 这份选择确实该失效。
    writeStoreValue(CITIES_KEY, [
      city("beijing"),
      city("tokyo"),
      city("london"),
      city("newyork"),
    ]);
    writeStoreValue(CITY_KEY, "sydney");

    const host = render(WeatherApp);
    await tick();

    expect(activeCity(host)).toBe("北京");
  });
});

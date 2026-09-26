/**
 * DOM tests for the Svelte 5 weather screen (WeatherApp.svelte) — the migrated
 * "second small screen". Pure forecast logic is already unit-tested once in
 * src/__tests__ (lib/weather.ts). Here we verify UI wiring + the reactive i18n
 * singleton (labels switch language in place) and store persistence behaviour.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WeatherApp from "../src/svelte/WeatherApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { readStoreValue } from "../src/lib/amosStore";

afterEach(() => {
  cleanup();
  setLocale("zh"); // reset the shared singleton for the next test
});

const txt = (host: { container: HTMLElement }) => host.container.textContent ?? "";

function buttons(host: { container: HTMLElement }): HTMLButtonElement[] {
  return [...host.container.querySelectorAll("button")];
}
function buttonWithText(host: { container: HTMLElement }, s: string) {
  return buttons(host).find((b) => (b.textContent ?? "").includes(s));
}
/**
 * The city selector chips — `button[aria-pressed]` *minus* the ℃/℉ unit pair.
 * The unit buttons carry `aria-pressed` too (REQ-A970), so a bare
 * `button[aria-pressed]` count is no longer a city counter.
 */
function cityChips(host: { container: HTMLElement }): HTMLButtonElement[] {
  return [...host.container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].filter(
    (b) => !/[℃℉]/.test(b.textContent ?? ""),
  );
}

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

describe("WeatherApp.svelte", () => {
  test("renders the default 4 cities + a Celsius hero", () => {
    const host = render(WeatherApp);
    const out = txt(host);
    expect(out).toContain("北京");
    // default city (Beijing, temp 26°C) shows in the big hero line
    expect(out).toContain("26°");
    expect(cityChips(host).length).toBe(4);
  });

  test("switching unit to Fahrenheit re-renders the hero", async () => {
    const host = render(WeatherApp);
    const f = buttonWithText(host, "℉");
    expect(f).toBeTruthy();
    await fireEvent.click(f as HTMLButtonElement);
    expect(txt(host)).toContain("79°F"); // cToF(26) === 79
  });

  // REQ-A970: the unit pair is a two-option selection whose active option lived only
  // in `chipCls` (a background-colour class) — the accessible name ("℃"/"℉") never
  // changed, so AT could not tell which was selected. The **adjacent city chips in
  // this same file** already use `aria-pressed`.
  test("the ℃/℉ unit pair exposes its selection to AT", async () => {
    const host = render(WeatherApp);
    const c = buttonWithText(host, "℃") as HTMLButtonElement;
    const f = buttonWithText(host, "℉") as HTMLButtonElement;
    expect(c.getAttribute("aria-pressed")).toBe("true"); // Celsius is the default
    expect(f.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(f);
    expect(f.getAttribute("aria-pressed")).toBe("true");
    expect(c.getAttribute("aria-pressed")).toBe("false");
  });

  test("adds the next city from the + button", async () => {
    const host = render(WeatherApp);
    const count = () => cityChips(host).length;
    expect(count()).toBe(4);
    const add = buttons(host).find((b) => (b.textContent ?? "").includes("+"));
    expect(add).toBeTruthy();
    await fireEvent.click(add as HTMLButtonElement);
    expect(count()).toBe(5);
  });

  test("editing removes a city and reselects a valid one", async () => {
    const host = render(WeatherApp);
    const edit = buttons(host).find((b) => (b.textContent ?? "").trim() === "编辑");
    expect(edit).toBeTruthy();
    await fireEvent.click(edit as HTMLButtonElement);
    const removeBeijing = buttons(host).find(
      (b) => (b.textContent ?? "").includes("北京") && !!b.querySelector('[data-icon="x"]'),
    );
    expect(removeBeijing).toBeTruthy();
    await fireEvent.click(removeBeijing as HTMLButtonElement);
    // Beijing gone from selectors; Tokyo becomes active selection
    expect(txt(host)).not.toContain("北京");
    expect(cityChips(host).length).toBe(3);
  });

  test("the + button persists the added city to the shared amos.weather.cities store", async () => {
    // Folded from the retired React weather-dom test: the added city must land in
    // the shared amos.weather.cities store (round-trip via readStoreValue), not just
    // in local component state.
    const host = render(WeatherApp);
    const add = buttons(host).find((b) => (b.textContent ?? "").includes("+"));
    expect(add).toBeTruthy();
    await fireEvent.click(add as HTMLButtonElement);
    const stored = readStoreValue<unknown>("amos.weather.cities", []);
    const ids = (stored as { id: string }[]).map((c) => c.id);
    expect(ids).toContain("paris");
  });

  // The city list is the user's content in exactly the way the world-clock list is: they add and
  // remove cities by hand, and the chips redraw the moment they do. `ClockApp`'s world-clock
  // writer was left `void` and reported nothing until REQ-A1410; the sibling here was left the
  // same way — the same round's sweep was file-local, and `amos.weather.cities` is a *different*
  // key, so a "sweep the writers of this key" pass could not reach it (REQ-A1416 ∕ F-SH-674).
  // A refused write must speak, or the change is lost silently on reload.
  test("a rejected city-list write is reported (the cities are the user's content)", async () => {
    const restore = failWritesFor("amos.weather.cities");
    try {
      const host = render(WeatherApp);
      await tick();
      // The chips still draw (the component state did move) — so the sentence is the only
      // thing that can tell the user the change will not survive a reload.
      expect(cityChips(host).length).toBeGreaterThan(0);
      expect(txt(host)).toContain("本机存储写入失败");
      // …and the disk really holds nothing: that is what the next launch reads.
      expect(window.localStorage.getItem("amos.weather.cities")).toBeNull();
    } finally {
      restore();
    }
  });

  test("adding a city on a refused store shows it and says it did not land", async () => {
    const restore = failWritesFor("amos.weather.cities");
    try {
      const host = render(WeatherApp);
      const add = buttons(host).find((b) => (b.textContent ?? "").includes("+"));
      expect(add).toBeTruthy();
      await fireEvent.click(add as HTMLButtonElement);
      await tick();
      expect(cityChips(host).length).toBe(5); // 巴黎 drawn
      expect(txt(host)).toContain("本机存储写入失败");
      expect(window.localStorage.getItem("amos.weather.cities")).toBeNull();
    } finally {
      restore();
    }
  });

  test("a landed city-list write says nothing (control)", async () => {
    const host = render(WeatherApp);
    const add = buttons(host).find((b) => (b.textContent ?? "").includes("+"));
    expect(add).toBeTruthy();
    await fireEvent.click(add as HTMLButtonElement);
    await tick();
    expect(cityChips(host).length).toBe(5);
    expect(txt(host)).not.toContain("本机存储写入失败");
    expect(window.localStorage.getItem("amos.weather.cities")).not.toBeNull();
  });

  test("reactive i18n: labels switch language in place when the shell changes locale", async () => {
    const host = render(WeatherApp);
    expect(txt(host)).toContain("北京");
    setLocale("en");
    await tick();
    expect(txt(host)).toContain("Beijing");
    expect(txt(host)).toContain("Humidity");
  });
});

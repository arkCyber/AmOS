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

describe("WeatherApp.svelte", () => {
  test("renders the default 4 cities + a Celsius hero", () => {
    const host = render(WeatherApp);
    const out = txt(host);
    expect(out).toContain("北京");
    // default city (Beijing, temp 26°C) shows in the big hero line
    expect(out).toContain("26°");
    expect(host.container.querySelectorAll("button[aria-pressed]").length).toBe(4);
  });

  test("switching unit to Fahrenheit re-renders the hero", async () => {
    const host = render(WeatherApp);
    const f = buttonWithText(host, "℉");
    expect(f).toBeTruthy();
    await fireEvent.click(f as HTMLButtonElement);
    expect(txt(host)).toContain("79°F"); // cToF(26) === 79
  });

  test("adds the next city from the + button", async () => {
    const host = render(WeatherApp);
    const count = () => host.container.querySelectorAll("button[aria-pressed]").length;
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
      (b) => (b.textContent ?? "").includes("北京") && (b.textContent ?? "").includes("✕"),
    );
    expect(removeBeijing).toBeTruthy();
    await fireEvent.click(removeBeijing as HTMLButtonElement);
    // Beijing gone from selectors; Tokyo becomes active selection
    expect(txt(host)).not.toContain("北京");
    expect(host.container.querySelectorAll("button[aria-pressed]").length).toBe(3);
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

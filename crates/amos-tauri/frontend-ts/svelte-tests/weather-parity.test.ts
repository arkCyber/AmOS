/**
 * React ↔ Svelte dual-implementation parity tests for the WEATHER screen.
 *
 * Both the React `Weather` (src/apps.tsx) and the Svelte `WeatherApp`
 * (src/svelte/WeatherApp.svelte) derive everything from lib/weather.ts + the
 * shared amos.weather.* store. Here we mount BOTH real components and assert that
 * the same button-driven interactions (unit toggle, add-city) produce the same
 * visible outcome — locking the second migrated screen in lock-step with React.
 *
 * Only button-driven interactions are used (no text inputs), so both UIs can be
 * driven without the React controlled-input native-setter dance. Each framework
 * is mounted against a freshly-cleared store so they never contaminate each other.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, render } from "@testing-library/svelte";
import WeatherApp from "../src/svelte/WeatherApp.svelte";
import { I18nProvider } from "../src/i18n";
import { AppComponent } from "../src/apps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedReact: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mountedReact.length) {
    const m = mountedReact.pop()!;
    m.root.unmount();
    m.host.remove();
  }
});

function mountReactWeather() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "weather" }),
    ),
  );
  return host;
}
const clearStore = () => window.localStorage.clear();
const cityCount = (root: HTMLElement) => root.querySelectorAll("button[aria-pressed]").length;
const clickText = async (root: HTMLElement, text: string) => {
  const btn = [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));
  expect(btn, `missing button containing "${text}"`).toBeTruthy();
  await fireEvent.click(btn as HTMLButtonElement);
};
const clickTextReact = async (root: HTMLElement, text: string) => {
  const btn = [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));
  expect(btn, `missing button containing "${text}"`).toBeTruthy();
  await act(async () => {
    (btn as HTMLButtonElement).click();
  });
};
const contains = (root: HTMLElement) => root.textContent ?? "";

describe("React ↔ Svelte weather parity", () => {
  test("unit toggle to ℉ shows 79°F in both", async () => {
    clearStore();
    const react = mountReactWeather();
    await act(async () => {});
    expect(contains(react)).toContain("北京");
    await clickTextReact(react, "℉");
    expect(contains(react)).toContain("79°F");

    clearStore();
    const svelte = render(WeatherApp);
    expect(contains(svelte.container)).toContain("北京");
    await clickText(svelte.container, "℉");
    expect(contains(svelte.container)).toContain("79°F");
  });

  test("adding the next city yields 5 city selectors in both", async () => {
    clearStore();
    const react = mountReactWeather();
    await act(async () => {});
    expect(cityCount(react)).toBe(4);
    await clickTextReact(react, "+");
    expect(cityCount(react)).toBe(5);
    expect(contains(react)).toContain("巴黎");

    clearStore();
    const svelte = render(WeatherApp);
    expect(cityCount(svelte.container)).toBe(4);
    await clickText(svelte.container, "+");
    expect(cityCount(svelte.container)).toBe(5);
    expect(contains(svelte.container)).toContain("巴黎");
  });
});

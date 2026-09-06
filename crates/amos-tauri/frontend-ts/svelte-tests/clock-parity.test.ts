/**
 * React ↔ Svelte dual-implementation parity tests for the CLOCK screen.
 *
 * Both the React `Clock` (src/apps.tsx) and the Svelte `ClockApp`
 * (src/svelte/ClockApp.svelte) derive everything from lib/time.ts + the shared
 * amos.worldclock / amos.alarms store. We mount BOTH and assert identical
 * visible outcomes for: default world-clock cities and the stopwatch tab's
 * initial display. (Live-running timers are not compared — covered by the pure
 * reducer tests in lib/time.ts.)
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, render } from "@testing-library/svelte";
import ClockApp from "../src/svelte/ClockApp.svelte";
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

function mountReactClock() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "clock" }),
    ),
  );
  return host;
}
const clearStore = () => window.localStorage.clear();
const contains = (el: HTMLElement) => el.textContent ?? "";
const clickTabReact = async (root: HTMLElement, label: string) => {
  const b = [...root.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim() === label);
  expect(b, `react missing tab "${label}"`).toBeTruthy();
  await act(async () => {
    (b as HTMLButtonElement).click();
  });
};
const clickTabSvelte = async (root: HTMLElement, label: string) => {
  const b = [...root.querySelectorAll('button[role="tab"]')].find(
    (x) => (x.textContent ?? "").trim() === label,
  );
  expect(b, `svelte missing tab "${label}"`).toBeTruthy();
  await fireEvent.click(b as HTMLButtonElement);
};

describe("React ↔ Svelte clock parity", () => {
  test("default world-clock cities match in both", async () => {
    clearStore();
    const react = mountReactClock();
    await act(async () => {});
    expect(contains(react)).toContain("北京");
    expect(contains(react)).toContain("伦敦");

    clearStore();
    const svelte = render(ClockApp);
    expect(contains(svelte.container)).toContain("北京");
    expect(contains(svelte.container)).toContain("伦敦");
  });

  test("stopwatch tab shows the same initial 00:00.00 in both", async () => {
    clearStore();
    const react = mountReactClock();
    await act(async () => {});
    await clickTabReact(react, "秒表");
    expect(contains(react)).toContain("00:00.00");

    clearStore();
    const svelte = render(ClockApp);
    await clickTabSvelte(svelte.container, "秒表");
    expect(contains(svelte.container)).toContain("00:00.00");
  });
});

/**
 * React ↔ Svelte dual-implementation consistency tests.
 *
 * Both the React `Calculator` (src/apps.tsx) and the Svelte `CalculatorApp`
 * (src/svelte/CalculatorApp.svelte) are driven by the SAME pure reducer in
 * lib/calculator.ts — that is the single source of truth. Here we render BOTH
 * real components and assert that an identical sequence of keypad presses
 * yields an identical display, proving the port stays behaviourally in lock-step
 * with the original React implementation.
 *
 * React is mounted without JSX (React.createElement) since vitest here isn't
 * configured with the React plugin; it runs through the same I18nProvider shell.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, render } from "@testing-library/svelte";
import CalculatorApp from "../src/svelte/CalculatorApp.svelte";
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

function displayOf(el: HTMLElement): string {
  return el.querySelector('[role="status"]')?.textContent ?? "";
}

async function driveSvelte(keys: string[]): Promise<string> {
  const host = render(CalculatorApp);
  for (const k of keys) {
    const btn = host.container.querySelector(
      `button[aria-label="${k}"]`,
    ) as HTMLButtonElement | null;
    expect(btn, `svelte missing key "${k}"`).toBeTruthy();
    await fireEvent.click(btn!);
  }
  return displayOf(host.container);
}

async function driveReact(keys: string[]): Promise<string> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "calculator" }),
    ),
  );
  await act(async () => {});
  for (const k of keys) {
    const btn = host.querySelector(`button[aria-label="${k}"]`) as HTMLButtonElement | null;
    expect(btn, `react missing key "${k}"`).toBeTruthy();
    await act(async () => {
      btn!.click();
    });
  }
  return displayOf(host);
}

const SEQUENCES: string[][] = [
  ["9", "+", "3", "="], // 12
  ["2", "×", "3", "="], // 6
  ["5", "%"],
  ["8", "÷", "2", "="], // 4
  ["7", "+", "5", "="],
  ["1", "÷", "0", "="], // division-by-zero → error
  ["AC", "9", "="], // error cleared, then 9=
  ["0", ".", "5", "+", "0", ".", "5", "="], // 0.5+0.5
];

describe("React ↔ Svelte calculator consistency", () => {
  test.each(SEQUENCES)("sequence %# produces identical display", async (...keys) => {
    const svelte = await driveSvelte(keys);
    const react = await driveReact(keys);
    expect(svelte).toBe(react);
    // Sanity: at least one known-good numeric case is verified directly.
    if (keys.join("") === "9+3=") expect(svelte).toBe("12");
  });
});

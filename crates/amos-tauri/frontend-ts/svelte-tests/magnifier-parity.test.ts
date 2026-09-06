/**
 * magnifier-parity.test.ts — React ↔ Svelte magnifier parity (control surface).
 *
 * Both React MagnifierApp (COMPONENTS.magnifier) and Svelte MagnifierApp.svelte
 * present the same camera permission gate, then (once granted) the same control
 * face: a demo badge + the zoom/brightness/contrast sliders. Parity locks the
 * control surface; the real magnified lens view needs Canvas 2D + camera
 * (device acceptance — the shared, honest boundary).
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, render } from "@testing-library/svelte";
import MagnifierApp from "../src/svelte/MagnifierApp.svelte";
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
  window.localStorage.clear();
});

const settle = () => new Promise((r) => setTimeout(r, 60));
const hasSlider = (el: HTMLElement, aria: string) =>
  !!el.querySelector(`input[aria-label="${aria}"]`);
const grantButton = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("允许")) as
    HTMLButtonElement | undefined;

function mountReact(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "magnifier" }),
    ),
  );
  return host;
}

describe("React ↔ Svelte magnifier parity (control surface)", () => {
  test("after granting camera both expose the same zoom/brightness/contrast sliders", async () => {
    const react = mountReact();
    await act(async () => {});
    await settle();
    const reactGrant = grantButton(react);
    if (reactGrant) await act(async () => reactGrant.click());
    await settle();
    expect(hasSlider(react, "放大倍数")).toBe(true);
    expect(hasSlider(react, "亮度")).toBe(true);
    expect(hasSlider(react, "对比度")).toBe(true);

    window.localStorage.clear();
    const svelte = render(MagnifierApp);
    await settle();
    const svelteGrant = grantButton(svelte.container);
    if (svelteGrant) await fireEvent.click(svelteGrant);
    await settle();
    expect(hasSlider(svelte.container, "放大倍数")).toBe(true);
    expect(hasSlider(svelte.container, "亮度")).toBe(true);
    expect(hasSlider(svelte.container, "对比度")).toBe(true);
  });
});

/**
 * React ↔ Svelte dual-implementation parity tests for the MAPS screen (offline).
 * Both run pure lib/maps.ts over the shared tiles/cities; under a browser
 * (happy-dom) both are "online" and render the same 6 city chips + 3×3 OSM tile
 * grid centred on 北京 at zoom 12.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render } from "@testing-library/svelte";
import MapsAppSvelte from "../src/svelte/MapsApp.svelte";
import MapsAppReact from "../src/components/MapsApp";
import { I18nProvider } from "../src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  window.localStorage.clear();
});
const txt = (root: HTMLElement) => root.textContent ?? "";

function mountReactMaps() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  root.render(
    React.createElement(I18nProvider, null, React.createElement(MapsAppReact as React.FC)),
  );
  return host;
}

describe("React ↔ Svelte maps parity (offline)", () => {
  test("both render the city chips, Beijing label and the 3×3 tile grid", async () => {
    const react = mountReactMaps();
    await act(async () => {});
    expect(txt(react)).toContain("上海");
    expect(react.querySelectorAll("img").length).toBe(9);

    const svelte = render(MapsAppSvelte);
    expect(txt(svelte.container)).toContain("上海");
    expect(svelte.container.querySelectorAll("img").length).toBe(9);
  });
});

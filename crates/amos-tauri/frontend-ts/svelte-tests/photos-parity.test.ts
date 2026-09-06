/**
 * photos-parity.test.ts — React ↔ Svelte photos parity (offline seeded gallery).
 *
 * Both React PhotosApp (COMPONENTS.photos) and Svelte PhotosApp.svelte seed the
 * same demo gallery from lib/photos when the store is empty. Parity: offline
 * neither shows the empty state ("暂无照片") — both present a seeded, non-empty
 * gallery. Pure logic is single-sourced in lib/photos.ts.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render } from "@testing-library/svelte";
import PhotosApp from "../src/svelte/PhotosApp.svelte";
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

const settle = () => new Promise((r) => setTimeout(r, 40));
const txt = (el: HTMLElement) => el.textContent ?? "";

function mountReact(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "photos" }),
    ),
  );
  return host;
}

describe("React ↔ Svelte photos parity (offline seeded gallery)", () => {
  test("neither shows the empty state — both seed a non-empty gallery", async () => {
    const react = mountReact();
    await act(async () => {});
    await settle();
    expect(txt(react)).not.toContain("暂无照片");

    window.localStorage.clear();
    const svelte = render(PhotosApp);
    await settle();
    expect(txt(svelte.container)).not.toContain("暂无照片");
  });
});

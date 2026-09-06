/**
 * files-parity.test.ts — React ↔ Svelte files-screen parity (offline, seeded root).
 *
 * Both the React FilesApp (src/components/FilesApp.tsx → COMPONENTS.files) and the
 * Svelte FilesApp (src/svelte/FilesApp.svelte) read/write the SAME amos.files
 * store and seed the same root when empty (文档 folder + 说明.txt). Offline, with
 * an empty store, both must therefore present the same seeded root and the same
 * empty-folder state when navigating in. Pure fs logic is single-sourced in
 * lib/files.ts; this guard locks the two UIs to it.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render } from "@testing-library/svelte";
import FilesApp from "../src/svelte/FilesApp.svelte";
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

function mountReactFiles(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "files" }),
    ),
  );
  return host;
}

describe("React ↔ Svelte files parity (offline seeded root)", () => {
  test("both seed the same root entries when the store is empty", async () => {
    // React, on a fresh empty store, seeds the same root (文档 folder + 说明.txt).
    const react = mountReactFiles();
    await act(async () => {});
    await settle();
    const reactTxt = txt(react);
    expect(reactTxt).toContain("文档");
    expect(reactTxt).toContain("说明.txt");

    // Svelte, on its own fresh empty store, must present the SAME seeded shell.
    window.localStorage.clear();
    const svelte = render(FilesApp);
    await settle();
    const svelteTxt = txt(svelte.container);
    expect(svelteTxt).toContain("文档");
    expect(svelteTxt).toContain("说明.txt");
  });
});


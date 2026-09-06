/**
 * store-parity.test.ts — React ↔ Svelte app-store parity (offline notice).
 *
 * Both React StoreApp (src/components/StoreApp.tsx → COMPONENTS.store) and the
 * Svelte StoreApp (src/svelte/StoreApp.svelte) run the SAME lib/backend
 * appstore_* bridge. Offline (no __TAURI_INTERNALS__) both must present the SAME
 * localized "store unavailable" notice instead of a silently empty page.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render } from "@testing-library/svelte";
import StoreApp from "../src/svelte/StoreApp.svelte";
import { I18nProvider } from "../src/i18n";
import { AppComponent } from "../src/apps";
import { zh } from "../src/i18n/locales/zh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedReact: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mountedReact.length) {
    const m = mountedReact.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  // Ensure we are truly offline for the next case too.
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = () => new Promise((r) => setTimeout(r, 60));
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
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "store" }),
    ),
  );
  return host;
}

describe("React ↔ Svelte store parity (offline notice)", () => {
  test("both show the store-unavailable notice when unbridged", async () => {
    const offlineNotice = zh["store.offline"] as string;

    const react = mountReact();
    await act(async () => {});
    await settle();
    expect(txt(react)).toContain(offlineNotice);

    window.localStorage.clear();
    const svelte = render(StoreApp);
    await settle();
    expect(txt(svelte.container)).toContain(offlineNotice);
  });
});

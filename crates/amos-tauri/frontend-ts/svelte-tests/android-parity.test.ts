/**
 * android-parity.test.ts — React ↔ Svelte Android screen parity (offline shell).
 *
 * Both React AndroidApp (COMPONENTS.android) and Svelte AndroidApp.svelte, when
 * not bridged (no Tauri/daemon), present the SAME localized "not connected"
 * state. Pure logic is single-sourced in lib/android + lib/lmk.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render } from "@testing-library/svelte";
import AndroidApp from "../src/svelte/AndroidApp.svelte";
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
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "android" }),
    ),
  );
  return host;
}

describe("React ↔ Svelte android parity (offline shell)", () => {
  test("both show the not-connected state when unbridged", async () => {
    const notice = "未连接守护进程"; // android offline text

    const react = mountReact();
    await act(async () => {});
    await settle();
    expect(txt(react)).toContain(notice);

    window.localStorage.clear();
    const svelte = render(AndroidApp);
    await settle();
    expect(txt(svelte.container)).toContain(notice);
  });
});

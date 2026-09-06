/**
 * monitor-react-entry.test.ts — React COMPONENTS → SvelteAppHost → MonitorApp path.
 *
 * `monitor` has no React body: apps.tsx `MonitorEntry` always mounts
 * `MonitorApp.svelte` through the shared SvelteAppHost seam — this is the React
 * production shell's entry for the dock「系统监控」app. That coexistence path
 * (React AppComponent → dynamic-import a `.svelte` → mount it) is NOT exercised
 * by app-render.test.tsx (React SSR can't load `.svelte`) nor by the
 * android-parity file (whose entry falls back to the React body). This test
 * closes the gap headlessly: offline, AppComponent("monitor") should end up
 * mounting the Svelte screen → its localized "not connected" empty state.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
  window.localStorage.clear();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const settle = () => new Promise((r) => setTimeout(r, 80));

function mountMonitorEntry(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "monitor" }),
    ),
  );
  return host;
}

describe("React COMPONENTS.monitor → SvelteAppHost → MonitorApp (offline)", () => {
  test("mounts the Svelte System Monitor screen (offline empty state)", async () => {
    const host = mountMonitorEntry();
    await act(async () => {});
    await settle();
    // The Svelte screen mounted inside the React host and resolved offline.
    expect(host.querySelector('[data-testid="monitor-app"]')).toBeTruthy();
    expect(host.textContent ?? "").toContain(zh["monitor.unavailable"]);
  });
});

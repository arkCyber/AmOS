/**
 * phone-parity.test.ts — React ↔ Svelte phone-screen parity (offline shell).
 *
 * Both the React PhoneApp (src/components/PhoneDialer.tsx → COMPONENTS.phone,
 * via apps.tsx) and the Svelte PhoneApp (src/svelte/PhoneApp.svelte) dial through
 * the SAME seam (lib/backend.telephonyDial), which returns null when the Tauri
 * telephony daemon is absent. Offline BOTH must therefore present the SAME
 * degraded shell: a working keypad, and after an attempted dial — a localized
 * dial-failure alert (role=alert), and NEVER a fake in-call UI (no end button).
 *
 * This is the parity guard dock apps like ai/interp/mail already have.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, render } from "@testing-library/svelte";
import PhoneApp from "../src/svelte/PhoneApp.svelte";
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
});

const settle = () => new Promise((r) => setTimeout(r, 60));
const alertText = (el: HTMLElement) =>
  el.querySelector('[role="alert"]')?.textContent?.trim() ?? "";
const hasEndBtn = (el: HTMLElement) => !!el.querySelector('button[aria-label="end"]');

function mountReactPhone(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "phone" }),
    ),
  );
  return host;
}

async function driveOfflineDial(click: (aria: string) => Promise<void>): Promise<void> {
  for (const d of ["1", "3", "8"]) await click(d);
  await click("call");
  await settle();
}

describe("React ↔ Svelte phone parity (offline shell)", () => {
  test("offline dial shows the same localized failure alert, never a fake in-call", async () => {
    const dialFailed = zh["phone.dialFailed"] as string;

    // React
    const react = mountReactPhone();
    await act(async () => {});
    await settle();
    await driveOfflineDial(async (aria) => {
      const btn = react.querySelector(`button[aria-label="${aria}"]`) as HTMLButtonElement | null;
      expect(btn, `react missing key "${aria}"`).toBeTruthy();
      await act(async () => btn!.click());
    });
    const reactAlert = alertText(react);
    expect(reactAlert).toContain(dialFailed);
    expect(hasEndBtn(react)).toBe(false);

    // Svelte
    const svelte = render(PhoneApp);
    await settle();
    await driveOfflineDial(async (aria) => {
      const btn = svelte.container.querySelector(
        `button[aria-label="${aria}"]`,
      ) as HTMLButtonElement | null;
      expect(btn, `svelte missing key "${aria}"`).toBeTruthy();
      await fireEvent.click(btn!);
    });
    const svelteAlert = alertText(svelte.container);
    expect(svelteAlert).toContain(dialFailed);
    expect(hasEndBtn(svelte.container)).toBe(false);

    // The two degraded shells must agree.
    expect(svelteAlert).toBe(reactAlert);
  });
});

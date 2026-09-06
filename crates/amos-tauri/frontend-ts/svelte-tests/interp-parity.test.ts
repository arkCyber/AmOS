/**
 * React ↔ Svelte dual-implementation parity tests for the INTERPRETER screen.
 *
 * The React InterpApp (components/BackendApps.tsx → COMPONENTS.interpreter, via
 * apps.tsx) and the Svelte InterpApp (src/svelte/InterpApp.svelte) share
 * lib/interp + lib/backend interpret RPC. Offline (no Tauri bridge) BOTH must
 * degrade identically: an in-browser banner, default remembered language pair,
 * and tapping 开始 explaining the missing daemon (backend.offline) — no silent
 * no-op. Live mic + daemon streaming need a device → device acceptance.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render } from "@testing-library/svelte";
import InterpApp from "../src/svelte/InterpApp.svelte";
import { I18nProvider } from "../src/i18n";
import { AppComponent } from "../src/apps";

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
const settle = () => new Promise((r) => setTimeout(r, 30));

function mountReactInterp() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "interpreter" }),
    ),
  );
  return host;
}
const txt = (root: HTMLElement) => root.textContent ?? "";
const clickText = async (root: HTMLElement, text: string) => {
  const btn = [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));
  expect(btn, `missing button containing "${text}"`).toBeTruthy();
  (btn as HTMLButtonElement).click();
  await settle();
};

describe("React ↔ Svelte interpreter parity (offline)", () => {
  test("banner + default prefs + offline start note match in both", async () => {
    // --- React (offline) ---
    const react = mountReactInterp();
    await act(async () => {});
    await settle();
    expect(txt(react)).toContain("make run-ui-release"); // backend.inBrowser
    const reactTarget = [...react.querySelectorAll("select")].find(
      (s) => s.getAttribute("aria-label") === "目标语言",
    ) as HTMLSelectElement | undefined;
    expect(reactTarget?.value).toBe("zh"); // default target
    await clickText(react, "开始");
    expect(txt(react)).toContain("未连接守护进程"); // backend.offline

    // --- Svelte (offline) ---
    const svelte = render(InterpApp);
    await settle();
    expect(txt(svelte.container)).toContain("make run-ui-release");
    const svelteTarget = [...svelte.container.querySelectorAll("select")].find(
      (s) => s.getAttribute("aria-label") === "目标语言",
    ) as HTMLSelectElement | undefined;
    expect(svelteTarget?.value).toBe("zh");
    await clickText(svelte.container, "开始");
    expect(txt(svelte.container)).toContain("未连接守护进程");
  });
});

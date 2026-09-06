/**
 * React ↔ Svelte dual-implementation parity tests for the AI ASSISTANT screen.
 *
 * The React AiApp (src/components/BackendApps.tsx → COMPONENTS.ai, via apps.tsx)
 * and the Svelte AiApp (src/svelte/AiApp.svelte) share lib/backend + lib/stream.
 * Offline (no Tauri bridge) both must present the SAME degraded shell: the
 * in-browser banner, the empty-chat placeholder, and the sessions panel's
 * offline empty state. Button-driven only (no controlled text inputs).
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render } from "@testing-library/svelte";
import AiApp from "../src/svelte/AiApp.svelte";
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
const txt = (root: HTMLElement) => root.textContent ?? "";
const settle = () => new Promise((r) => setTimeout(r, 50));

function mountReactAi() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "ai" }),
    ),
  );
  return host;
}
const clickTextReact = async (root: HTMLElement, text: string) => {
  const btn = [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));
  expect(btn, `missing button containing "${text}"`).toBeTruthy();
  await act(async () => (btn as HTMLButtonElement).click());
};

describe("React ↔ Svelte ai parity (offline)", () => {
  test("banner + empty placeholder + sessions empty state match in both", async () => {
    const react = mountReactAi();
    await act(async () => {});
    await settle();
    const reactTxt = txt(react);
    expect(reactTxt).toContain("make run-ui-release"); // backend.inBrowser
    expect(reactTxt).toContain("与 AI 对话"); // ai.placeholder
    await clickTextReact(react, "会话");
    await settle();
    expect(txt(react)).toContain("暂无 daemon 会话"); // ai.sessionEmpty

    const svelte = render(AiApp);
    await settle();
    const svelteTxt = txt(svelte.container);
    expect(svelteTxt).toContain("make run-ui-release");
    expect(svelteTxt).toContain("与 AI 对话");
    const sessionsBtn = [...svelte.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("会话"),
    ) as HTMLButtonElement | undefined;
    expect(sessionsBtn).toBeTruthy();
    (sessionsBtn as HTMLButtonElement).click();
    await settle();
    expect(txt(svelte.container)).toContain("暂无 daemon 会话");
  });
});

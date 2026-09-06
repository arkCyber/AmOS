/**
 * vmemos-parity.test.ts — React ↔ Svelte voice-memos parity (offline seeded list).
 *
 * Both React VoiceMemosApp (src/components/VoiceMemosApp.tsx → COMPONENTS.vmemos)
 * and the Svelte VoiceMemosApp (src/svelte/VoiceMemosApp.svelte) seed the same
 * demo clip list offline (no mic needed) from the shared lib/voiceMemos. Parity:
 * both must present a record control, at least one playable row, and NOT the
 * empty state. Pure logic is single-sourced in lib/voiceMemos.ts.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render } from "@testing-library/svelte";
import VoiceMemosApp from "../src/svelte/VoiceMemosApp.svelte";
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
const countAria = (el: HTMLElement, aria: string) =>
  el.querySelectorAll(`button[aria-label="${aria}"]`).length;

function mountReact(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "vmemos" }),
    ),
  );
  return host;
}

describe("React ↔ Svelte vmemos parity (offline seeded list)", () => {
  test("both seed a demo list with a record control and play rows (not empty)", async () => {
    const react = mountReact();
    await act(async () => {});
    await settle();
    const reactTxt = txt(react);
    expect(countAria(react, "开始录音")).toBe(1);
    expect(countAria(react, "播放")).toBeGreaterThan(0);
    expect(reactTxt).not.toContain("暂无语音备忘录");

    window.localStorage.clear();
    const svelte = render(VoiceMemosApp);
    await settle();
    const svelteTxt = txt(svelte.container);
    expect(countAria(svelte.container, "开始录音")).toBe(1);
    expect(countAria(svelte.container, "播放")).toBeGreaterThan(0);
    expect(svelteTxt).not.toContain("暂无语音备忘录");
  });
});

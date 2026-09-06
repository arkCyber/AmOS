/**
 * React ↔ Svelte dual-implementation parity tests for the MUSIC screen.
 *
 * Both the React `MusicApp` (src/components/CommsApps.tsx) and the Svelte
 * `MusicApp` (src/svelte/MusicApp.svelte) seed from the same deterministic
 * lib/music.ts data. We mount BOTH and assert identical visible outcomes: the
 * current track title and the play↔pause toggle. (Live playback timing is
 * covered by pure lib/music.ts reducer-ish tests.)
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, render } from "@testing-library/svelte";
import MusicApp from "../src/svelte/MusicApp.svelte";
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
});
const clearStore = () => window.localStorage.clear();

function mountReactMusic() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AppComponent as React.FC<{ id: string }>, { id: "music" }),
    ),
  );
  return host;
}
const bigTitle = (el: HTMLElement) =>
  [...el.querySelectorAll("p")].find((p) => p.classList.contains("text-lg"))?.textContent ?? "";
const playPause = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].find((b) => {
    const a = b.getAttribute("aria-label");
    return a === "play" || a === "pause";
  });

describe("React ↔ Svelte music parity", () => {
  test("seeded current track title matches in both", async () => {
    clearStore();
    const react = mountReactMusic();
    await act(async () => {});
    const tReact = bigTitle(react);
    expect(tReact.length).toBeGreaterThan(0);

    clearStore();
    const svelte = render(MusicApp);
    const tSvelte = bigTitle(svelte.container);
    expect(tSvelte).toBe(tReact);
  });

  test("play toggles to pause in both", async () => {
    clearStore();
    const react = mountReactMusic();
    await act(async () => {});
    expect(playPause(react)?.getAttribute("aria-label")).toBe("play");
    await act(async () => {
      playPause(react)!.click();
    });
    expect(playPause(react)?.getAttribute("aria-label")).toBe("pause");

    clearStore();
    const svelte = render(MusicApp);
    expect(playPause(svelte.container)?.getAttribute("aria-label")).toBe("play");
    await fireEvent.click(playPause(svelte.container) as HTMLButtonElement);
    expect(playPause(svelte.container)?.getAttribute("aria-label")).toBe("pause");
  });
});

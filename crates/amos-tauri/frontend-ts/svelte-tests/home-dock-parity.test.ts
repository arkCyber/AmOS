/**
 * home-dock-parity.test.ts — React ↔ Svelte home-screen consistency guard.
 *
 * Both implementations render the SAME home layout from the SAME pure model
 * (lib/amosStore layout + lib/settings unread + lib/appIcon tiles). Here we
 * mount BOTH the React HomeDock and the Svelte HomeDock for an identical layout
 * and assert they surface the same set of launcher tiles (same app titles) —
 * proving the Svelte port stays in lock-step with the React reference.
 *
 * React is mounted without JSX (vitest has no React plugin here), through the
 * same I18nProvider shell used by the other parity suites.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import HomeDockReact from "../src/components/HomeDock";
import HomeDockSvelte from "../src/svelte/HomeDock.svelte";
import { I18nProvider } from "../src/i18n";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { zh } from "../src/i18n/locales/zh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedReact: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mountedReact.length) {
    const m = mountedReact.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  resetPropsChannels();
  window.localStorage.clear();
});
beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
});

interface HomeLayoutLite {
  page: string[];
  dock: string[];
  hidden: string[];
}

const zhLabel = (id: string): string => zh[`app.${id}` as keyof typeof zh] ?? id;

function tileLabels(el: ParentNode): Set<string> {
  const out = new Set<string>();
  for (const b of el.querySelectorAll('button[aria-label]')) {
    const lbl = b.getAttribute("aria-label") ?? "";
    // Ignore chrome buttons (search pill, page dots) — keep only app tiles,
    // whose aria-label is an app title (never "search"/"page N of M").
    if (lbl && lbl !== "search" && !/^page \d+ of \d+$/.test(lbl)) out.add(lbl);
  }
  return out;
}

async function mountReact(l: HomeLayoutLite): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(HomeDockReact, {
        layout: l,
        onOpen: () => {},
        onMove: () => {},
        onSearch: () => {},
        pulseId: null,
        ext: [],
      }),
    ),
  );
  await act(async () => {});
  return host;
}

const LAYOUTS: HomeLayoutLite[] = [
  { page: ["weather", "notes", "files", "photos"], dock: ["phone", "messages", "mail", "ai"] },
  { page: [], dock: ["phone", "messages", "ai", "interpreter", "mail"] },
  { page: ["contacts", "clock", "reminders", "maps"], dock: ["phone"] },
];

describe("React ↔ Svelte HomeDock parity", () => {
  test.each(LAYOUTS.map((l, i) => [i, l] as const))(
    "layout #%i surfaces the same launcher tiles",
    async (_i, l) => {
      // Svelte: seed its external-props channel, then mount.
      propsChannel("home").set({ layout: l, ext: [], pulseId: null });
      const svelteHost = render(HomeDockSvelte);
      await tick(); // let the channel subscription flush before reading DOM
      const reactHost = await mountReact(l);

      const svelteLabels = tileLabels(svelteHost.container);
      const reactLabels = tileLabels(reactHost);
      expect(svelteLabels).toEqual(reactLabels);

      // Every app in the layout must actually be surfaced by both.
      for (const id of [...l.page, ...l.dock]) {
        expect(reactLabels.has(zhLabel(id)), `react missing ${id}`).toBe(true);
        expect(svelteLabels.has(zhLabel(id)), `svelte missing ${id}`).toBe(true);
      }
    },
  );
});

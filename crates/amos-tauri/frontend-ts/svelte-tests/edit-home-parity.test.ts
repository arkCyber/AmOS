/**
 * edit-home-parity.test.ts — React ↔ Svelte layout-editor consistency guard.
 *
 * Both implementations render the SAME home layout and drive it with the SAME
 * pure helpers (hideFromHome/restoreToHome in lib/amosStore). For identical
 * layouts we mount BOTH the React EditHome and the Svelte EditHome and assert
 * they surface the same set of removable tiles and hidden-restore chips —
 * proving the controlled Svelte port stays in lock-step with the React editor.
 *
 * React is mounted without JSX (vitest has no React plugin here), through the
 * same I18nProvider shell used by the other parity suites.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render } from "@testing-library/svelte";
import EditHomeReact from "../src/components/EditHome";
import EditHomeSvelte from "../src/svelte/EditHome.svelte";
import { I18nProvider } from "../src/i18n";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import type { HomeLayout } from "../src/lib/amosStore";
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

// Localised app label (matches both editors' chip text) — reads the SAME zh
// dictionary both frameworks consume, so the expectation is never hardcoded.
function zhLabel(id: string): string {
  return zh[`app.${id}` as keyof typeof zh] ?? id;
}

async function mountReact(layout: HomeLayout): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedReact.push({ root, host });
  root.render(
    React.createElement(I18nProvider, null, React.createElement(EditHomeReact, {
      layout,
      onChange: () => {},
      onDone: () => {},
    })),
  );
  await act(async () => {});
  return host;
}

function removable(el: ParentNode): Set<string> {
  const out = new Set<string>();
  for (const b of el.querySelectorAll('button[aria-label^="remove "]')) {
    out.add(b.getAttribute("aria-label") ?? "");
  }
  return out;
}

function restoreChips(el: ParentNode): Set<string> {
  const out = new Set<string>();
  for (const b of el.querySelectorAll("button")) {
    const txt = (b.textContent ?? "").trim();
    if (txt.startsWith("＋")) out.add(txt);
  }
  return out;
}

const LAYOUTS: HomeLayout[] = [
  { page: ["weather", "notes", "files", "photos"], dock: ["phone", "messages", "mail"], hidden: ["clock", "maps"] },
  { page: [], dock: ["phone", "messages", "ai", "interpreter", "mail"], hidden: [] },
  { page: ["contacts", "clock", "reminders", "calculator"], dock: ["phone"], hidden: ["music", "store"] },
];

describe("React ↔ Svelte EditHome parity", () => {
  test.each(LAYOUTS.map((l, i) => [i, l] as const))(
    "layout #%i surfaces the same removable tiles and hidden-restore chips",
    async (_i, l) => {
      propsChannel("editHome").set({ layout: l });
      const svelteHost = render(EditHomeSvelte);
      const reactHost = await mountReact(l);

      expect(removable(svelteHost.container)).toEqual(removable(reactHost));
      expect(restoreChips(svelteHost.container)).toEqual(restoreChips(reactHost));

      // Every visible page/dock tile is removable in BOTH.
      for (const id of [...l.page, ...l.dock]) {
        expect(removable(reactHost).has(`remove ${id}`), `react missing remove ${id}`).toBe(true);
        expect(removable(svelteHost.container).has(`remove ${id}`), `svelte missing remove ${id}`).toBe(true);
      }
      // Every hidden app appears as a restore chip in BOTH.
      for (const id of l.hidden) {
        const suffix = ` ${zhLabel(id)}`;
        const hasIn = (set: Set<string>) => [...set].some((t) => t.endsWith(suffix));
        expect(hasIn(restoreChips(reactHost)), `react hidden chip for ${id}`).toBe(true);
        expect(hasIn(restoreChips(svelteHost.container)), `svelte hidden chip for ${id}`).toBe(true);
      }
    },
  );
});


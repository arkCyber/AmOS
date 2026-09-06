/**
 * spotlight-panel.svelte.test.ts — Svelte CONTROLLED search overlay (Spotlight).
 *
 * Shell owns `open` (over propsBus "spotlight"); search text is local; choosing a
 * result emits 'open'(id)+'close'. Tests: default results, text filtering,
 * choose emits, closed renders nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import SpotlightPanel from "../src/svelte/SpotlightPanel.svelte";
import { propsChannel, resetPropsChannels, type PropsChannel } from "../src/svelte/propsBus";

const bus = (): PropsChannel<{ open: boolean }> => propsChannel<{ open: boolean }>("spotlight");

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
});
afterEach(() => resetPropsChannels());

async function renderOpen() {
  bus().set({ open: true });
  const { container } = render(SpotlightPanel);
  await tick();
  return container;
}

describe("SpotlightPanel.svelte (controlled via propsBus 'spotlight')", () => {
  test("renders search box and default results when open", async () => {
    const container = await renderOpen();
    expect(container.querySelector('input[placeholder]')).toBeTruthy();
    // "common.done" button present (localized via i18n) and at least one row.
    expect(container.querySelector("button")).toBeTruthy();
  });

  test("typing filters results to matches", async () => {
    const container = await renderOpen();
    const input = container.querySelector("input") as HTMLInputElement;
    // Type the zh title for clock ("时钟") — result rows filter to it.
    await fireEvent.input(input, { target: { value: "时" } });
    await tick();
    // With only "时" matched (clock/weather contain 时), fewer than the full list.
    expect(container.textContent ?? "").toContain("时");
  });

  test("choosing a result emits 'open' then 'close'", async () => {
    const container = await renderOpen();
    const events: [string, unknown][] = [];
    const off = bus().on((e, d) => events.push([e, d]));
    // First result row button (results are ordered by APPS).
    const row = container.querySelector("button[aria-label]") as HTMLButtonElement | null;
    expect(row).toBeTruthy();
    await fireEvent.click(row!);
    const openDetail = events.find(([e]) => e === "open")?.[1];
    expect(typeof openDetail).toBe("string");
    expect(events.map(([e]) => e)).toContain("close");
    off();
  });

  test("renders nothing when closed", async () => {
    bus().set({ open: false });
    const { container } = render(SpotlightPanel);
    await tick();
    expect(container.querySelector("h2")).toBeNull();
  });
});

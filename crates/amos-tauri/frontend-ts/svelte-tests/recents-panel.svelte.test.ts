/**
 * recents-panel.svelte.test.ts — Svelte CONTROLLED chrome overlay (Recents).
 *
 * The React shell owns `open` and pushes it over propsBus "recents"; the panel
 * lists recently-opened built-in apps (reactive over amos.recents) and emits
 * 'open'/'close'. Tests cover: rows render for seeded recents; empty state; and
 * choosing a row emits open(id)+close.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import RecentsPanel from "../src/svelte/RecentsPanel.svelte";
import { propsChannel, resetPropsChannels, type PropsChannel } from "../src/svelte/propsBus";
import { writeStoreValue } from "../src/lib/amosStore";
import { RECENTS_KEY } from "../src/lib/amosStore";
import { zh } from "../src/i18n/locales/zh";

const bus = (): PropsChannel<{ open: boolean }> => propsChannel<{ open: boolean }>("recents");
const label = (id: string): string => zh[`app.${id}` as keyof typeof zh] ?? id;

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
});
afterEach(() => resetPropsChannels());

async function renderOpen() {
  bus().set({ open: true });
  const { container } = render(RecentsPanel);
  await tick();
  return container;
}

describe("RecentsPanel.svelte (controlled via propsBus 'recents')", () => {
  test("renders seeded recent apps as rows", async () => {
    writeStoreValue(RECENTS_KEY, ["notes", "files"]);
    const container = await renderOpen();
    expect(container.querySelector(`button[aria-label="${label("notes")}"]`)).toBeTruthy();
    expect(container.querySelector(`button[aria-label="${label("files")}"]`)).toBeTruthy();
  });

  test("shows the empty state when there are no recents", async () => {
    writeStoreValue(RECENTS_KEY, []);
    const container = await renderOpen();
    expect(container.querySelector('button[aria-label^=""]')).toBeNull();
    expect(container.querySelector("p")).toBeTruthy(); // noRecent empty paragraph
  });

  test("choosing a row emits 'open' then 'close'", async () => {
    writeStoreValue(RECENTS_KEY, ["notes"]);
    const container = await renderOpen();
    const events: [string, unknown][] = [];
    const off = bus().on((e, d) => events.push([e, d]));
    await fireEvent.click(
      container.querySelector(`button[aria-label="${label("notes")}"]`) as HTMLButtonElement,
    );
    expect(events).toEqual([
      ["open", "notes"],
      ["close", undefined],
    ]);
    off();
  });

  test("renders nothing when closed", async () => {
    bus().set({ open: false });
    const { container } = render(RecentsPanel);
    await tick();
    expect(container.textContent ?? "").not.toContain(label("notes"));
    expect(container.querySelector("h2")).toBeNull();
  });

  test("Escape inside the open panel closes it (focus trap)", async () => {
    writeStoreValue(RECENTS_KEY, ["notes"]);
    const container = await renderOpen();
    const events: string[] = [];
    const off = bus().on((e) => events.push(e));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(events).toContain("close");
    off();
    void container;
  });
});

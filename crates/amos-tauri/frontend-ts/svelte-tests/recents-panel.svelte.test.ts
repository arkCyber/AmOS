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
import type { StoreTile } from "../src/lib/storeApps";
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

/**
 * The multi-app picker's second candidate source (REQ-A1137).
 *
 * Recents hold built-ins only — `open()` deliberately keeps third-party ids out of the
 * frequently-used set — but the *picker* answers a different question ("which app may I
 * put in the other pane?"), and every layer behind it already accepts a `store:` id
 * (`open()`'s split retarget, `parseSplit`/`parseSlideOver`'s validation, `AppPane`'s ext
 * host). Offering recents alone made the door narrower than the room: an installed store
 * app could never be chosen as the second pane or the Slide Over panel. So in pick mode
 * the list is recents ∪ installed tiles; in plain recents mode it stays built-ins only.
 */
describe("RecentsPanel.svelte — store apps in the multi-app picker (REQ-A1137)", () => {
  const DEMO: StoreTile = { id: "store:org.amos.demo", mid: "org.amos.demo", name: "Demo", icon: "D" };
  type PickerProps = { open: boolean; pick?: "split" | "slide" | null; exclude?: string | null; ext?: StoreTile[] };
  const picker = (): PropsChannel<PickerProps> => propsChannel<PickerProps>("recents");

  async function renderPick(props: Omit<PickerProps, "open">) {
    picker().set({ open: true, ...props });
    const { container } = render(RecentsPanel);
    await tick();
    await tick();
    return container;
  }
  const rowFor = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("aria-label") === label,
    );

  test("split pick offers an installed store app beside the recents", async () => {
    writeStoreValue(RECENTS_KEY, ["phone", "notes"]);
    const container = await renderPick({ pick: "split", exclude: "notes", ext: [DEMO] });
    const demo = rowFor(container, "Demo");
    expect(demo, "the installed store app must be choosable as the second pane").toBeTruthy();
    // Its own manifest name and glyph — not the raw `store:` id and the 🧩 fallback.
    expect(demo!.textContent ?? "").toContain("Demo");
    expect(demo!.textContent ?? "").not.toContain("store:");
    // The recents are still there, and the excluded primary still is not.
    expect(rowFor(container, label("phone"))).toBeTruthy();
    expect(rowFor(container, label("notes")), "the primary pane is not offered against itself").toBeUndefined();
  });

  test("slide-over pick offers it too (the panel may repeat the app behind it)", async () => {
    writeStoreValue(RECENTS_KEY, ["phone"]);
    const container = await renderPick({ pick: "slide", exclude: null, ext: [DEMO] });
    expect(rowFor(container, "Demo")).toBeTruthy();
  });

  test("choosing the store row emits its `store:` id, not its display name", async () => {
    writeStoreValue(RECENTS_KEY, []);
    const container = await renderPick({ pick: "split", exclude: null, ext: [DEMO] });
    const events: [string, unknown][] = [];
    const off = picker().on((e, d) => events.push([e, d]));
    await fireEvent.click(rowFor(container, "Demo")!);
    expect(events).toEqual([
      ["open", "store:org.amos.demo"],
      ["close", undefined],
    ]);
    off();
  });

  test("a store app already in the primary pane is excluded from the picker", async () => {
    writeStoreValue(RECENTS_KEY, ["phone"]);
    const container = await renderPick({ pick: "split", exclude: DEMO.id, ext: [DEMO] });
    expect(rowFor(container, "Demo")).toBeUndefined();
    expect(rowFor(container, label("phone"))).toBeTruthy();
  });

  test("plain recents (no pick) stays built-ins only — the tap-in list is unmoved", async () => {
    writeStoreValue(RECENTS_KEY, ["phone", "notes"]);
    const container = await renderPick({ pick: null, exclude: null, ext: [DEMO] });
    expect(rowFor(container, "Demo"), "a third-party app must not join the frequently-used list").toBeUndefined();
    expect(rowFor(container, label("phone"))).toBeTruthy();
  });
});

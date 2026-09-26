/**
 * HomeDock.svelte — the tablet Dock's Recents section is not part of the Dock's **order**
 * (REQ-A1079 / FMEA F-SH-394).
 *
 * The iPad Dock's recently-used section is drawn *inside* the dock bar, but it is not a
 * member of `layout.dock` (`lib/formLayout::dockRecents` reads the recents store, and only
 * dedupes against the pinned ids). Those tiles used to be rendered with the pinned tiles'
 * drag/reorder handlers — so they were drop targets and drag sources for a list they are
 * not in:
 *
 *   * drop a **pinned** icon onto a recents icon ⇒ `dockDrop` emits `move {drag: pinned,
 *     over: recent}`, and the shell's `moveBefore` (which looks the target up in `page`
 *     then `dock`, finding it in neither) falls through to `page.push(drag)` — the app
 *     **leaves the Dock** for the home page, from a drop that landed *inside the Dock*;
 *   * drag a **recents** icon ⇒ a tile that looks orderable and drags but does nothing
 *     (`moveBefore` returns its input when the dragged id is in neither list) — an inert
 *     control beside working ones.
 *
 * The fix gives the `tile` snippet the two facts separately: `inDock` ("drawn in the bar",
 * visual) and `orderable` ("is a member of the dock's order", interactive). Only the
 * Recents call site passes the first without the second.
 *
 * Tablet-only by construction: `dockRecent` is empty unless `dockRecentSlots(form) > 0`,
 * i.e. `form === "tablet"` — on a phone the section (and its divider) are not drawn at all
 * (`svelte-tests/home-dock.svelte.test.ts` pins that).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import HomeDock from "../src/svelte/HomeDock.svelte";
import { propsChannel, resetPropsChannels, type PropsChannel } from "../src/svelte/propsBus";
import { RECENTS_KEY, moveBefore, writeStoreValue, type HomeLayout } from "../src/lib/amosStore";
import { zh } from "../src/i18n/locales/zh";

interface HomeProps {
  layout: HomeLayout;
  ext: never[];
  pulseId: string | null;
  form?: "phone" | "tablet" | "desktop" | "robot";
}

const channel = (): PropsChannel<HomeProps> => propsChannel<HomeProps>("home");
const label = (key: string): string => zh[key as keyof typeof zh] ?? key;
const byLabel = (c: HTMLElement, text: string) =>
  c.querySelector(`button[aria-label="${text}"]`) as HTMLButtonElement | null;
const section = (c: HTMLElement) => c.querySelector('[data-testid="dock-recents"]');

/** A tablet with one pinned app (`mail`) and one recently-used app (`notes`). */
function tabletWithRecents(page: string[] = [], dock: string[] = ["mail"], recents = ["notes"]) {
  writeStoreValue(RECENTS_KEY, recents);
  channel().set({ layout: { page, dock, hidden: [] }, ext: [], pulseId: null, form: "tablet" });
}

/** Everything the component emits upward, and a way to stop listening. */
function watch(): { seen: Array<[string, unknown]>; off: () => void } {
  const seen: Array<[string, unknown]> = [];
  const off = channel().on((e: string, d: unknown) => seen.push([e, d]));
  return { seen, off };
}

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
});

afterEach(() => {
  resetPropsChannels();
});

describe("HomeDock.svelte — the Dock's Recents section is not a reorder target", () => {
  test("dropping a pinned dock tile on a RECENT tile emits no 'move'", async () => {
    tabletWithRecents();
    const { container } = render(HomeDock);
    await tick();

    const sec = section(container);
    expect(sec).not.toBeNull();
    const src = byLabel(container, label("app.mail"));
    const dst = sec!.querySelector(`button[aria-label="${label("app.notes")}"]`) as HTMLButtonElement;
    expect(src).not.toBeNull();
    expect(dst).not.toBeNull();

    const { seen, off } = watch();
    await fireEvent.dragStart(src!);
    await fireEvent.drop(dst);
    off();
    // Pre-fix this was [{ drag: "mail", over: "notes" }] — which the shell turns into
    // "mail leaves the Dock and is appended to the home page".
    expect(seen).toEqual([]);
  });

  test("a RECENT tile is not a drag source (no inert orderable-looking control)", async () => {
    tabletWithRecents();
    const { container } = render(HomeDock);
    await tick();

    const recent = section(container)!.querySelector(
      `button[aria-label="${label("app.notes")}"]`,
    ) as HTMLButtonElement;
    const pinned = byLabel(container, label("app.mail"))!;
    // The two facts the snippet now keeps apart: both are dock tiles visually, only the
    // pinned one is orderable.
    expect(recent.getAttribute("draggable")).toBeNull();
    expect(pinned.getAttribute("draggable")).toBe("true");

    // …and the behavioural half: a drag started on it moves nothing, whichever dock tile
    // it is dropped on.
    const { seen, off } = watch();
    await fireEvent.dragStart(recent);
    await fireEvent.drop(pinned);
    await fireEvent.drop(recent);
    off();
    expect(seen).toEqual([]);
  });

  test("the Dock's OWN reorder still works: pinned → pinned emits 'move {drag, over}'", async () => {
    tabletWithRecents(["weather"], ["mail", "phone"], ["notes"]);
    const { container } = render(HomeDock);
    await tick();

    const src = byLabel(container, label("app.mail"))!;
    const dst = byLabel(container, label("app.phone"))!;
    const { seen, off } = watch();
    await fireEvent.dragStart(src);
    await fireEvent.drop(dst);
    off();
    expect(seen).toEqual([["move", { drag: "mail", over: "phone" }]]);
  });
});

describe("HomeDock.svelte — why the target must be an orderable dock member", () => {
  test("moveBefore with a target outside the Dock evicts the dragged app to the home page", () => {
    // The linkage this UI rule protects (the reason a recents tile must never be a drop
    // target): `dockDrop`'s `over` is what the shell feeds to `moveBefore`, and a target
    // that is in neither list falls through to `page.push`. Pinned on the pure helper, so
    // the consequence is stated by a test rather than only by this file's header.
    const layout: HomeLayout = { page: [], dock: ["mail"], hidden: [] };
    expect(moveBefore(layout, "mail", "notes")).toEqual({ page: ["mail"], dock: [], hidden: [] });
    // …and the reverse direction (dragging a non-member) is the silent no-op:
    expect(moveBefore(layout, "notes", "mail")).toEqual(layout);
  });
});

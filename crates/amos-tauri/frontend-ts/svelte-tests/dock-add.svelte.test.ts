/**
 * dock-add.svelte.test.ts — "send a custom group's apps to the home dock".
 * Covers the pure layout helper (lib/amosStore.addAppsToDock) and the AppLibrary
 * button that emits "dockAdd" over the appLibrary channel (hosts apply + persist).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AppLibrary from "../src/svelte/AppLibrary.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { resetShellState } from "../src/svelte/shellState.svelte";
import { addAppsToDock, type HomeLayout } from "../src/lib/amosStore";
import { addCustomGroup, getCustomGroups, setGroupApps } from "../src/lib/customGroups";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
});
afterEach(() => {
  resetPropsChannels();
});

describe("lib/amosStore.addAppsToDock (pure)", () => {
  test("moves ids out of page + hidden into the dock, dedup, in request order", () => {
    const base: HomeLayout = {
      page: ["phone", "clock"],
      dock: ["mail"],
      hidden: ["weather"],
    };
    const next = addAppsToDock(base, ["weather", "phone", "phone"]);
    expect(next).toEqual({
      page: ["clock"],
      dock: ["mail", "weather", "phone"],
      hidden: [],
    });
  });

  test("already-docked ids stay; empty ignored; unknown ids are appended (filtering is upstream)", () => {
    const base: HomeLayout = { page: ["clock"], dock: ["phone"], hidden: [] };
    const next = addAppsToDock(base, ["", "phone", "clock", "not-real"]);
    // phone already docked stays; clock moves page→dock; "" ignored; "not-real"
    // appended (the UI filters to known apps before emitting).
    expect(next).toEqual({ page: [], dock: ["phone", "clock", "not-real"], hidden: [] });
  });
});

describe("AppLibrary.svelte - add group apps to home dock", () => {
  async function openWithMembers() {
    propsChannel<{ layout: { page: string[]; dock: string[]; hidden: string[] }; ext: [] }>(
      "appLibrary",
    ).set({ layout: { page: [], dock: [], hidden: [] }, ext: [] });
    const { created } = addCustomGroup([], "收藏");
    setGroupApps([created], created.id, ["phone", "weather"]);
    return render(AppLibrary);
  }

  test("the dock button emits 'dockAdd' with the group's member ids", async () => {
    const emitted: Array<[string, unknown]> = [];
    const un = propsChannel("appLibrary").on((e, d) => emitted.push([e, d]));

    const { container } = await openWithMembers();
    await tick();
    expect(getCustomGroups()[0].apps).toEqual(["phone", "weather"]);
    const card = container.querySelector(
      '[data-testid="app-library-custom-group"]',
    ) as HTMLButtonElement | null;
    expect(card).toBeTruthy();
    await fireEvent.click(card!);
    await tick();
    // member view opened (rename lives there)
    expect(
      container.querySelector('[data-testid="app-library-rename"]'),
    ).toBeTruthy();

    const btn = container.querySelector(
      '[data-testid="app-library-dock-add"]',
    ) as HTMLButtonElement | null;
    expect(btn).toBeTruthy();
    await fireEvent.click(btn!);
    await tick();

    expect(emitted).toEqual([["dockAdd", ["phone", "weather"]]]);
    un();
  });
});

/**
 * edit-home-store-apps.svelte.test.ts — 「编辑主屏」is the **fifth** surface that has to answer
 * "what does this app id draw as", and the only one the newest round's single-owner table did
 * not reach (REQ-A1182 / FMEA F-SH-474).
 *
 * `lib/appLookup.ts` (REQ-A1179 / F-SH-472) declares itself the owner of the three questions —
 * can this id be drawn at all, what glyph, what name — for the two kinds of id a home screen can
 * hold: a compile-time registry row (`lib/appMeta`) or an installed store app
 * (`store:<manifest.id>`, runtime data in `lib/storeApps`). Four surfaces ask it: `Dock.svelte`,
 * `Launchpad.svelte`, `DesktopStage.svelte`, `SpotlightOverlay.svelte`.
 *
 * `EditHome.svelte` — the home screen's own edit mode, where a tile is removed, restored and
 * reordered — still asks the narrow question `appTitleKey(id) !== null`, which is true only for
 * built-ins, and it is fed `{ layout }` alone by `Shell.svelte` (no `ext`), so it *cannot* draw a
 * store tile even if it wanted to. Two consequences, both visible:
 *   • a store app sitting on the home screen or in the dock has **no tile** in this screen — it
 *     cannot be removed from home or reordered;
 *   • the hidden tray (`restoreToHome`) filters the same way, so a store app that *is* hidden
 *     (Launchpad's own hide does offer it, `Launchpad.svelte:179`, and its tray asks
 *     `isDrawableApp`) can **never be brought back** from here.
 *
 * `Launchpad.svelte:187` states the opposite in prose: "与触屏形态的 `EditHome` 用同一个纯函数，
 * 所以「隐藏 → 还原」在两种形态下不可能给出两种结果". The pure function is shared; the *scope
 * predicate* is not, so the two forms do differ.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import EditHome from "../src/svelte/EditHome.svelte";
import { propsChannel, resetPropsChannels, type PropsChannel } from "../src/svelte/propsBus";
import type { HomeLayout } from "../src/lib/amosStore";
import type { StoreTile } from "../src/lib/storeApps";
import { appTitleKey } from "../src/lib/appMeta";
import { zh } from "../src/i18n/locales/zh";

/** Two installed store apps (the runtime data `lib/storeApps` holds for `store:` ids). */
const POMODORO: StoreTile = {
  id: "store:org.amos.pomodoro",
  mid: "org.amos.pomodoro",
  name: "番茄钟",
  icon: "🍅",
};
const READER: StoreTile = { id: "store:org.amos.reader", mid: "org.amos.reader", name: "书阁", icon: "📖" };
const EXT: StoreTile[] = [POMODORO, READER];

type EditProps = { layout: HomeLayout; ext?: StoreTile[] };
const bus = (): PropsChannel<EditProps> => propsChannel<EditProps>("editHome");

/** One built-in and one store app on the page, a built-in and a store app in `hidden`. */
const L: HomeLayout = {
  page: ["notes", POMODORO.id],
  dock: ["phone"],
  hidden: ["weather", READER.id],
};

const builtinName = (id: string) => zh[appTitleKey(id) as keyof typeof zh];
const removeLabel = (name: string) => zh["edit.remove"].replace("{name}", name);
const moveLabel = (key: "edit.moveEarlier" | "edit.moveLater", name: string) =>
  zh[key].replace("{name}", name);

const byLabel = (c: HTMLElement, label: string) =>
  c.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const hiddenTray = (c: HTMLElement) =>
  c.querySelector('[data-testid="edit-hidden"]') as HTMLElement | null;
const restoreChips = (c: HTMLElement) =>
  [...(hiddenTray(c)?.querySelectorAll("button") ?? [])].filter((b) =>
    (b.textContent ?? "").trim().startsWith("＋"),
  );

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
});
afterEach(() => resetPropsChannels());

async function renderEditor(layout: HomeLayout, ext: StoreTile[]) {
  bus().set({ layout, ext });
  const { container } = render(EditHome);
  await tick();
  return container;
}

describe("EditHome.svelte — an installed store app is drawable here too", () => {
  test("a store app on the home screen has a removable tile, named by its own tile", async () => {
    const container = await renderEditor(L, EXT);
    expect(
      byLabel(container, removeLabel("番茄钟")),
      "the store tile the home screen draws must be removable from 编辑主屏",
    ).toBeTruthy();
    // The built-ins are unchanged by the wider predicate.
    expect(byLabel(container, removeLabel(builtinName("notes")))).toBeTruthy();
    expect(byLabel(container, removeLabel(builtinName("phone")))).toBeTruthy();
  });

  test("a hidden store app is restorable from the tray", async () => {
    const container = await renderEditor(L, EXT);
    const chips = restoreChips(container).map((c) => (c.textContent ?? "").trim());
    expect(chips, "both hidden apps must offer a way back").toContain(`＋ 书阁`);
    expect(chips).toContain(`＋ ${builtinName("weather")}`);
  });

  test("a store app is a member of its list for reordering, not a hole to step over", async () => {
    const container = await renderEditor(L, EXT);
    // `notes` is the first page tile; the store app is second. Its ‹ must be live and swap them.
    const back = byLabel(container, moveLabel("edit.moveEarlier", "番茄钟"));
    expect(back, "the store tile carries the same ‹ › reorder controls").toBeTruthy();
    expect(back!.disabled).toBe(false);

    const events: string[] = [];
    let next: HomeLayout | null = null;
    const off = bus().on((e, d) => {
      events.push(e);
      if (e === "change") next = d as HomeLayout;
    });
    await fireEvent.click(back!);
    off();
    expect(events).toEqual(["change"]);
    expect(next!.page).toEqual([POMODORO.id, "notes"]);
  });

  test("removing a store app emits the same pure hideFromHome the built-ins use", async () => {
    const container = await renderEditor(L, EXT);
    const events: string[] = [];
    let next: HomeLayout | null = null;
    const off = bus().on((e, d) => {
      events.push(e);
      if (e === "change") next = d as HomeLayout;
    });
    await fireEvent.click(byLabel(container, removeLabel("番茄钟"))!);
    off();
    expect(events).toEqual(["change"]);
    expect(next!.page).not.toContain(POMODORO.id);
    expect(next!.hidden).toContain(POMODORO.id);
  });
});

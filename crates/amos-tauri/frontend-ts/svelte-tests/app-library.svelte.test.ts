/**
 * AppLibrary.svelte - DOM tests (vitest + happy-dom).
 * AppLibrary is a CONTROLLED leaf: the host pushes { layout } down over
 * propsChannel("appLibrary") and listens for "open"(id) / "back" up the same
 * channel. Tests seed the channel before each render and assert navigation by
 * capturing the up-channel events. recents come from the amos.recents store.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import AppLibrary from "../src/svelte/AppLibrary.svelte";
import { propsChannel, resetPropsChannels, type PropsChannel } from "../src/svelte/propsBus";
import { resetShellState } from "../src/svelte/shellState.svelte";
import { pushRecent } from "../src/lib/amosStore";
import type { StoreTile } from "../src/lib/storeApps";
import { zh } from "../src/i18n/locales/zh";

interface LibraryProps {
  layout: { page: string[]; dock: string[]; hidden: string[] };
  ext?: StoreTile[];
}

let upEvents: Array<[string, unknown]> = [];
let bus: PropsChannel<LibraryProps>;

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
  upEvents = [];
  bus = propsChannel<LibraryProps>("appLibrary");
  bus.on((e, d) => upEvents.push([e, d]));
});
afterEach(() => {
  resetPropsChannels();
});

const zhLabel = (key: string): string => zh[key as keyof typeof zh] ?? key;
const layout = (page: string[], dock: string[], hidden: string[] = []) => ({
  page,
  dock,
  hidden,
});

function inArea(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`);
}
function buttonIn(area: ParentNode, ariaLabel: string): HTMLElement | null {
  return area.querySelector(`button[aria-label="${ariaLabel}"]`);
}
function renderLibrary(l?: LibraryProps["layout"], ext?: StoreTile[]) {
  // Always a full layout: default has empty page/dock/hidden.
  bus.set({ layout: l ?? { page: [], dock: [], hidden: [] }, ext: ext ?? [] });
  return render(AppLibrary);
}

describe("AppLibrary.svelte - Frequently Used top group", () => {
  test("shows recents as tappable tools (live from amos.recents)", async () => {
    pushRecent("phone");
    pushRecent("clock"); // most recent first
    const { container } = renderLibrary();
    await tick();
    const area = inArea(container, "app-library-frequent");
    expect(area).toBeTruthy();
    expect(buttonIn(area!, zhLabel("app.phone"))).toBeTruthy();
    expect(buttonIn(area!, zhLabel("app.clock"))).toBeTruthy();
  });

  test("falls back to the dock when nothing has been opened yet", async () => {
    const { container } = renderLibrary(layout(["notes"], ["phone", "messages"]));
    await tick();
    const area = inArea(container, "app-library-frequent");
    expect(area).toBeTruthy();
    expect(buttonIn(area!, zhLabel("app.phone"))).toBeTruthy();
    expect(buttonIn(area!, zhLabel("app.messages"))).toBeTruthy();
  });
});

describe("AppLibrary.svelte - category folder grid", () => {
  test("renders every non-empty category folder with a localized name", async () => {
    const { container } = renderLibrary();
    await tick();
    const foldersArea = inArea(container, "app-library-folders");
    expect(foldersArea).toBeTruthy();
    const folderLabels = new Set(
      Array.from(container.querySelectorAll('[data-testid="app-library-folder"]')).map(
        (b) => b.getAttribute("aria-label"),
      ),
    );
    for (const key of [
      "group.communication",
      "group.media",
      "group.productivity",
      "group.utilities",
      "group.system",
    ]) {
      expect(folderLabels.has(zhLabel(key)), `missing folder ${key}`).toBe(true);
    }
  });

  test("opening a category lists its apps; tapping one emits 'open' with that id", async () => {
    const { container } = renderLibrary();
    await tick();
    const folder = buttonIn(container, zhLabel("group.productivity"));
    expect(folder).toBeTruthy();
    await fireEvent.click(folder as HTMLButtonElement);
    await tick();
    const notesBtn = buttonIn(container, zhLabel("app.notes"));
    expect(notesBtn).toBeTruthy();
    await fireEvent.click(notesBtn as HTMLButtonElement);
    await tick();
    expect(upEvents.filter(([e]) => e === "open")).toEqual([["open", "notes"]]);
  });
});


describe("AppLibrary.svelte - home indicator returns to the home surface", () => {
  test("home pill emits 'back'", async () => {
    const { container } = renderLibrary();
    await tick();
    const pill = container.querySelector('[data-testid="library-home-indicator"]');
    expect(pill).toBeTruthy();
    await fireEvent.click(pill as HTMLButtonElement);
    await tick();
    expect(upEvents.some(([e]) => e === "back")).toBe(true);
  });
});


describe("AppLibrary.svelte - iOS-style live search", () => {
  const type = async (container: HTMLElement, value: string) => {
    const input = container.querySelector(
      '[data-testid="app-library-search"]',
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();
    await fireEvent.input(input!, { target: { value } });
    await tick();
  };

  test("typing filters apps into grouped results and highlights the match", async () => {
    const { container } = renderLibrary();
    await tick();
    await type(container, "天气");
    const results = inArea(container, "app-library-results");
    expect(results).toBeTruthy();
    expect(buttonIn(results!, zhLabel("app.weather"))).toBeTruthy();
    expect(buttonIn(results!, zhLabel("app.settings"))).toBeNull();
    const mark = results!.querySelector("mark");
    expect(mark).toBeTruthy();
    expect(mark!.textContent).toBe("天气");
    const summary = results!.querySelector('[data-testid="app-library-matches"]');
    expect(summary).toBeTruthy();
    expect(summary!.textContent).toBe("1 个应用");
    expect(summary!.getAttribute("aria-live")).toBe("polite");
  });

  test("a query with no matches shows the no-results message", async () => {
    const { container } = renderLibrary();
    await tick();
    await type(container, "zzz-not-an-app");
    expect(inArea(container, "app-library-results")).toBeNull();
    expect(container.textContent).toContain(zhLabel("appLibrary.noResults"));
  });

  test("clearing the search restores the folder grid", async () => {
    const { container } = renderLibrary();
    await tick();
    await type(container, "天气");
    expect(inArea(container, "app-library-results")).toBeTruthy();
    await type(container, "");
    expect(inArea(container, "app-library-folders")).toBeTruthy();
    expect(inArea(container, "app-library-results")).toBeNull();
  });

  test("Esc while searching clears the query back to the folder grid", async () => {
    const { container } = renderLibrary();
    await tick();
    await type(container, "天气");
    expect(inArea(container, "app-library-results")).toBeTruthy();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(inArea(container, "app-library-folders")).toBeTruthy();
    expect(inArea(container, "app-library-results")).toBeNull();
  });

  test("the clear (x) button resets the query", async () => {
    const { container } = renderLibrary();
    await tick();
    await type(container, "天气");
    const clear = container.querySelector('button[aria-label="clear search"]');
    expect(clear).toBeTruthy();
    await fireEvent.click(clear as HTMLButtonElement);
    await tick();
    expect(inArea(container, "app-library-folders")).toBeTruthy();
    expect(inArea(container, "app-library-results")).toBeNull();
  });

  test("opening a highlighted search result emits 'open' for that app", async () => {
    const { container } = renderLibrary();
    await tick();
    await type(container, "天气");
    const results = inArea(container, "app-library-results");
    expect(results).toBeTruthy();
    const weather = buttonIn(results!, zhLabel("app.weather"));
    expect(weather).toBeTruthy();
    await fireEvent.click(weather as HTMLButtonElement);
    await tick();
    expect(upEvents.some(([e, d]) => e === "open" && d === "weather")).toBe(true);
  });
});


describe("AppLibrary.svelte - third-party (store) apps", () => {
  const POMODORO: StoreTile = {
    id: "store:org.amos.pomodoro",
    mid: "org.amos.pomodoro",
    name: "Pomodoro",
    icon: "P",
  };

  test("store-installed tiles appear in an 'other' folder and are searchable by name", async () => {
    const { container } = renderLibrary(undefined, [POMODORO]);
    await tick();

    // Third-party apps group under the catch-all "other" folder (group.other).
    expect(buttonIn(container, zhLabel("group.other"))).toBeTruthy();

    // Searching by the ext display name surfaces it, using its own name/icon.
    const input = container.querySelector(
      '[data-testid="app-library-search"]',
    ) as HTMLInputElement | null;
    await fireEvent.input(input!, { target: { value: "Pomodoro" } });
    await tick();
    const results = inArea(container, "app-library-results");
    expect(results).toBeTruthy();
    expect(buttonIn(results!, "Pomodoro")).toBeTruthy();
    expect(buttonIn(results!, zhLabel("group.other"))).toBeNull(); // headers not buttons
  });

  test("opening a third-party search result emits 'open' with its store id", async () => {
    const { container } = renderLibrary(undefined, [POMODORO]);
    await tick();
    const input = container.querySelector(
      '[data-testid="app-library-search"]',
    ) as HTMLInputElement | null;
    await fireEvent.input(input!, { target: { value: "Pomodoro" } });
    await tick();
    const results = inArea(container, "app-library-results");
    const tile = buttonIn(results!, "Pomodoro");
    expect(tile).toBeTruthy();
    await fireEvent.click(tile as HTMLButtonElement);
    await tick();
    expect(upEvents.some(([e, d]) => e === "open" && d === POMODORO.id)).toBe(true);
  });
});


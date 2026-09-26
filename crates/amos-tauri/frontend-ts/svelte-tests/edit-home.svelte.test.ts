/**
 * EditHome.svelte — interaction tests for the second CONTROLLED screen.
 *
 * The React shell owns the layout and pushes it over propsBus "editHome"; the
 * Svelte editor never mutates local state — it computes the NEXT layout via the
 * shared pure hideFromHome/restoreToHome and emits it back ('change') for the
 * shell to persist, and 'done' to leave edit mode. These tests assert that
 * controlled contract end to end.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import EditHome from "../src/svelte/EditHome.svelte";
import { propsChannel, resetPropsChannels, type PropsChannel } from "../src/svelte/propsBus";
import type { HomeLayout } from "../src/lib/amosStore";
import { hideFromHome, moveWithinHome, restoreToHome } from "../src/lib/amosStore";
import { appTitleKey } from "../src/lib/appMeta";
import { zh } from "../src/i18n/locales/zh";

/**
 * The accessible name of a tile's remove button, **computed from the dictionary**.
 *
 * REQ-A461: this used to be the literal English `remove <id>` and the tests pinned it —
 * an English accessible name (plus a raw app id) inside a zh+en OS, while the key
 * `edit.remove` sat unused in the dictionary. Reading the expected value out of `zh`
 * keeps the assertion meaningful without freezing the language.
 */
const removeLabel = (id: string): string =>
  zh["edit.remove"].replace("{name}", zh[appTitleKey(id) as keyof typeof zh]);

const bus = (): PropsChannel<{ layout: HomeLayout }> => propsChannel<{ layout: HomeLayout }>("editHome");

/**
 * The hidden-apps tray. Scoped lookups of its `＋` restore chips must NOT count the widget
 * editor's own `＋` buttons (added later), which live in their own section — a global "any
 * button starting with ＋" query silently stopped meaning "a restore chip" the moment the
 * widget gallery landed.
 */
const hiddenTray = (container: HTMLElement) =>
  container.querySelector('[data-testid="edit-hidden"]') as HTMLElement | null;
const restoreChips = (container: HTMLElement) =>
  [...(hiddenTray(container)?.querySelectorAll("button") ?? [])].filter((b) =>
    (b.textContent ?? "").trim().startsWith("＋"),
  );

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
});
afterEach(() => resetPropsChannels());

const L: HomeLayout = { page: ["notes", "files"], dock: ["phone"], hidden: ["weather"] };

async function renderEditor(layout: HomeLayout) {
  bus().set({ layout });
  const { container } = render(EditHome);
  await tick();
  return container;
}

const collect = (events: string[]) => {
  const out: Record<string, unknown> = {};
  const off = bus().on((event, detail) => {
    events.push(event);
    out[event] = detail;
  });
  return { out, off };
};

describe("EditHome.svelte (controlled via propsBus 'editHome')", () => {
  test("renders page+dock tiles and any hidden restore chips", async () => {
    const container = await renderEditor(L);
    expect(container.querySelector(`button[aria-label="${removeLabel("notes")}"]`)).toBeTruthy();
    expect(container.querySelector(`button[aria-label="${removeLabel("phone")}"]`)).toBeTruthy();
    // weather is hidden → rendered as a "＋" restore chip, not a removable tile.
    expect(container.querySelector(`button[aria-label="${removeLabel("weather")}"]`)).toBeNull();
    expect(restoreChips(container).length).toBe(1);
  });

  test("removing a page app emits 'change' that hides it (pure hideFromHome parity)", async () => {
    const container = await renderEditor(L);
    const events: string[] = [];
    const { out, off } = collect(events);
    await fireEvent.click(container.querySelector(`button[aria-label="${removeLabel("notes")}"]`) as HTMLButtonElement);
    expect(events).toEqual(["change"]);
    const next = out["change"] as HomeLayout;
    const expected = hideFromHome(L, "notes");
    expect(next).toEqual(expected);
    expect(next.hidden).toContain("notes");
    expect(next.page).not.toContain("notes");
    off();
  });

  test("removing a DOCK app moves it back onto the page (iOS-like), not hidden", async () => {
    const container = await renderEditor(L);
    const events: string[] = [];
    const { out, off } = collect(events);
    await fireEvent.click(container.querySelector(`button[aria-label="${removeLabel("phone")}"]`) as HTMLButtonElement);
    const next = out["change"] as HomeLayout;
    expect(next).toEqual(hideFromHome(L, "phone"));
    expect(next.dock).not.toContain("phone");
    expect(next.page).toContain("phone");
    off();
  });

  test("restoring a hidden app emits 'change' that returns it to the page", async () => {
    const container = await renderEditor(L);
    const events: string[] = [];
    const { out, off } = collect(events);
    const restore = restoreChips(container)[0] as HTMLButtonElement;
    await fireEvent.click(restore);
    const next = out["change"] as HomeLayout;
    expect(next).toEqual(restoreToHome(L, "weather"));
    expect(next.hidden).not.toContain("weather");
    expect(next.page).toContain("weather");
    off();
  });

  test("the Done button emits 'done'", async () => {
    const container = await renderEditor(L);
    const events: string[] = [];
    const { out, off } = collect(events);
    const done = [...container.querySelectorAll("button")].find((b) =>
      (b.className ?? "").includes("bg-accent"),
    ) as HTMLButtonElement;
    expect(done).toBeTruthy();
    await fireEvent.click(done);
    expect(events).toEqual(["done"]);
    off();
  });
});

describe("EditHome.svelte — controlled round-trip (shell persist + in-place push-back)", () => {
  test("after 'change', pushing the new layout back updates the UI in place (no remount)", async () => {
    // L.hidden has one app → one restore chip initially.
    const container = await renderEditor(L);
    const chips = () => restoreChips(container).length;
    expect(chips()).toBe(1);

    // User removes a PAGE app (notes) → EditHome emits the computed next layout.
    const events: string[] = [];
    const { out, off } = collect(events);
    await fireEvent.click(container.querySelector(`button[aria-label="${removeLabel("notes")}"]`) as HTMLButtonElement);
    const next = out["change"] as HomeLayout;
    off();
    expect(next.hidden).toContain("notes");

    // The shell persists it and pushes the authoritative layout back in place.
    bus().set({ layout: next });
    await tick();

    // Notes is now hidden: no removable tile remains for it, and it became a
    // second restore chip — all without remounting the editor.
    expect(container.querySelector(`button[aria-label="${removeLabel("notes")}"]`)).toBeNull();
    expect(container.querySelector(`button[aria-label="${removeLabel("phone")}"]`)).toBeTruthy();
    expect(chips()).toBe(2);
  });
});

/**
 * REQ-A462 — the hint (`edit.hint`) has said "tap ‹ › to reorder" since it was written,
 * while neither button existed and both dictionary keys sat allow-listed as "reserved".
 * These tests are the other half of that promise: the controls exist, they carry localized
 * names, they are `disabled` at the ends instead of doing nothing, and a click emits the
 * same layout the shared pure function computes.
 */
describe("EditHome.svelte — ‹ › reorder (the hint describes real controls)", () => {
  const moveLabel = (key: "edit.moveEarlier" | "edit.moveLater", id: string) =>
    zh[key].replace("{name}", zh[appTitleKey(id) as keyof typeof zh]);
  const byLabel = (container: HTMLElement, label: string) =>
    container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

  test("every tile carries both arrows, named for the localized app", async () => {
    const container = await renderEditor(L);
    for (const id of ["notes", "files", "phone"]) {
      expect(byLabel(container, moveLabel("edit.moveEarlier", id))).toBeTruthy();
      expect(byLabel(container, moveLabel("edit.moveLater", id))).toBeTruthy();
    }
    // A hidden app is a restore chip (`＋`), not a tile — it has no arrows until restored.
    expect(byLabel(container, moveLabel("edit.moveEarlier", "weather"))).toBeNull();
  });

  test("the ends are disabled, and a cross-list step is an end", async () => {
    const container = await renderEditor(L);
    // "notes" is the first page tile…
    expect(byLabel(container, moveLabel("edit.moveEarlier", "notes"))!.disabled).toBe(true);
    expect(byLabel(container, moveLabel("edit.moveLater", "notes"))!.disabled).toBe(false);
    // …and "phone" is the *only* dock app: on screen it has neighbours, but moving it
    // into them would pin/unpin it (membership), which a reorder button must not do.
    expect(byLabel(container, moveLabel("edit.moveEarlier", "phone"))!.disabled).toBe(true);
    expect(byLabel(container, moveLabel("edit.moveLater", "phone"))!.disabled).toBe(true);
  });

  test("clicking › emits the next layout (pure-function parity)", async () => {
    const container = await renderEditor(L);
    const events: string[] = [];
    const { out, off } = collect(events);
    await fireEvent.click(byLabel(container, moveLabel("edit.moveLater", "notes")) as HTMLButtonElement);
    expect(events).toEqual(["change"]);
    const next = out["change"] as HomeLayout;
    expect(next).toEqual(moveWithinHome(L, "notes", 1, (id) => appTitleKey(id) !== null));
    expect(next.page).toEqual(["files", "notes"]);
    expect(next.dock).toEqual(["phone"]); // membership untouched
    off();
  });

  test("clicking ‹ on the second tile puts it back in front", async () => {
    const container = await renderEditor(L);
    const events: string[] = [];
    const { out, off } = collect(events);
    await fireEvent.click(
      byLabel(container, moveLabel("edit.moveEarlier", "files")) as HTMLButtonElement,
    );
    const next = out["change"] as HomeLayout;
    expect(next.page).toEqual(["files", "notes"]);
    off();
  });
});


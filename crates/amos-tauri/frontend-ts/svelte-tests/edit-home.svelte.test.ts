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
import { hideFromHome, restoreToHome } from "../src/lib/amosStore";

const bus = (): PropsChannel<{ layout: HomeLayout }> => propsChannel<{ layout: HomeLayout }>("editHome");

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
    expect(container.querySelector('button[aria-label="remove notes"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="remove phone"]')).toBeTruthy();
    // weather is hidden → rendered as a "＋" restore chip, not a removable tile.
    expect(container.querySelector('button[aria-label="remove weather"]')).toBeNull();
    const restore = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.trim().startsWith("＋"),
    );
    expect(restore).toBeTruthy();
  });

  test("removing a page app emits 'change' that hides it (pure hideFromHome parity)", async () => {
    const container = await renderEditor(L);
    const events: string[] = [];
    const { out, off } = collect(events);
    await fireEvent.click(container.querySelector('button[aria-label="remove notes"]') as HTMLButtonElement);
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
    await fireEvent.click(container.querySelector('button[aria-label="remove phone"]') as HTMLButtonElement);
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
    const restore = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.trim().startsWith("＋"),
    ) as HTMLButtonElement;
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
    const chips = () =>
      [...container.querySelectorAll("button")].filter((b) =>
        (b.textContent ?? "").trim().startsWith("＋"),
      ).length;
    expect(chips()).toBe(1);

    // User removes a PAGE app (notes) → EditHome emits the computed next layout.
    const events: string[] = [];
    const { out, off } = collect(events);
    await fireEvent.click(container.querySelector('button[aria-label="remove notes"]') as HTMLButtonElement);
    const next = out["change"] as HomeLayout;
    off();
    expect(next.hidden).toContain("notes");

    // The shell persists it and pushes the authoritative layout back in place.
    bus().set({ layout: next });
    await tick();

    // Notes is now hidden: no removable tile remains for it, and it became a
    // second restore chip — all without remounting the editor.
    expect(container.querySelector('button[aria-label="remove notes"]')).toBeNull();
    expect(container.querySelector('button[aria-label="remove phone"]')).toBeTruthy();
    expect(chips()).toBe(2);
  });
});


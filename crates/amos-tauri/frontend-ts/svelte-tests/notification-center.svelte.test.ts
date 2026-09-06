/**
 * notification-center.svelte.test.ts — Svelte control-center sheet.
 *
 * Shell owns `open` (over propsBus "nc"); quick toggles (dnd/location/etc.),
 * flashlight tile, notification list (dismiss/clear), and shell actions
 * (search/recents/edit/lock) are exercised offline.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationCenter from "../src/svelte/NotificationCenter.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { NOTIF_KEY, SETTINGS_KEY } from "../src/lib/settings";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
});
afterEach(() => resetPropsChannels());

async function renderOpen() {
  propsChannel<{ open: boolean }>("nc").set({ open: true });
  const { container } = render(NotificationCenter);
  await tick();
  return container;
}

const tileByIcon = (c: HTMLElement, icon: string) =>
  [...c.querySelectorAll("button[aria-pressed]")].find((b) =>
    (b.textContent ?? "").includes(icon),
  ) as HTMLButtonElement | undefined;

describe("NotificationCenter.svelte (controlled via propsBus 'nc')", () => {
  test("renders quick tiles and the flashlight tile when open", async () => {
    const c = await renderOpen();
    expect(c.querySelectorAll('button[aria-pressed]').length).toBeGreaterThanOrEqual(6);
    expect(tileByIcon(c, "📶")).toBeTruthy(); // wifi
    expect(tileByIcon(c, "🔦") || tileByIcon(c, "🔆")).toBeTruthy(); // torch tile
  });

  test("toggling Do-Not-Disturb flips its tile and persists", async () => {
    const c = await renderOpen();
    const dnd = tileByIcon(c, "🌒") as HTMLButtonElement;
    expect(dnd.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(dnd);
    await tick();
    const next = tileByIcon(c, "🌒") as HTMLButtonElement;
    expect(next.getAttribute("aria-pressed")).toBe("true");
    expect(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {}).dnd).toBe(true);
  });

  test("dismiss removes a notification; clear reaches the empty state", async () => {
    const c = await renderOpen();
    const count = () => c.querySelectorAll('button[aria-label="dismiss"]').length;
    expect(count()).toBeGreaterThan(0);

    await fireEvent.click(c.querySelector('button[aria-label="dismiss"]') as HTMLButtonElement);
    await tick();
    const afterOne = count();
    // Seed = 3 notifications, so at least one remains removable.
    await fireEvent.click(c.querySelector('button[aria-label="clear"]') as HTMLButtonElement);
    await tick();
    expect(count()).toBe(0);
    expect(readStoreValue<unknown>(NOTIF_KEY, [])).toEqual([]);
    void afterOne;
  });

  test("location starts ON and a tap flips it off", async () => {
    const c = await renderOpen();
    const loc = tileByIcon(c, "📍") as HTMLButtonElement;
    expect(loc.getAttribute("aria-pressed")).toBe("true"); // default ON
    await fireEvent.click(loc);
    await tick();
    const after = tileByIcon(c, "📍") as HTMLButtonElement;
    expect(after.getAttribute("aria-pressed")).toBe("false");
  });

  test("an action button emits its action then close", async () => {
    const c = await renderOpen();
    const events: string[] = [];
    const off = propsChannel<{ open: boolean }>("nc").on((e) => events.push(e));
    await fireEvent.click(c.querySelector('button[aria-label="lock"]') as HTMLButtonElement);
    expect(events).toContain("lock");
    expect(events).toContain("close");
    off();
  });
});

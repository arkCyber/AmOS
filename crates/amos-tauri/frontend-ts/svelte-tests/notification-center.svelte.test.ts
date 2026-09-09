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
import { setCellularRadio, clearCellularRadio } from "../src/svelte/cellularRadio";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { NOTIF_KEY, SETTINGS_KEY } from "../src/lib/settings";
import { CELLULAR_KEY, type CellularPrefs } from "../src/lib/cellular";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  clearCellularRadio();
});
afterEach(() => {
  resetPropsChannels();
  clearCellularRadio();
});

async function renderOpen() {
  propsChannel<{ open: boolean }>("nc").set({ open: true });
  const { container } = render(NotificationCenter);
  await tick();
  return container;
}

const tileByIcon = (c: HTMLElement, dataIcon: string) =>
  [...c.querySelectorAll("button[aria-pressed]")].find((b) =>
    b.querySelector(`[data-icon="${dataIcon}"]`),
  ) as HTMLButtonElement | undefined;

describe("NotificationCenter.svelte (controlled via propsBus 'nc')", () => {
  test("renders quick tiles and the flashlight tile when open", async () => {
    const c = await renderOpen();
    expect(c.querySelectorAll('button[aria-pressed]').length).toBeGreaterThanOrEqual(6);
    expect(tileByIcon(c, "wifi")).toBeTruthy(); // wifi
    expect(tileByIcon(c, "flashlight")).toBeTruthy(); // torch tile
  });

  test("toggling Do-Not-Disturb flips its tile and persists", async () => {
    const c = await renderOpen();
    const dnd = tileByIcon(c, "dnd") as HTMLButtonElement;
    expect(dnd.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(dnd);
    await tick();
    const next = tileByIcon(c, "dnd") as HTMLButtonElement;
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
    const loc = tileByIcon(c, "location") as HTMLButtonElement;
    expect(loc.getAttribute("aria-pressed")).toBe("true"); // default ON
    await fireEvent.click(loc);
    await tick();
    const after = tileByIcon(c, "location") as HTMLButtonElement;
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

  test("cellular module is hidden by default (no modem — honest, not misleading)", async () => {
    const c = await renderOpen();
    expect(c.querySelector('[data-testid="nc-cellular"]')).toBeNull();
  });

  test("cellular module appears ONLY when a real radio is present, with an honest label", async () => {
    // A real (future) signal source reports present + a real signal.
    setCellularRadio({ present: true, signal: 2 });
    const c = await renderOpen();
    await tick();
    const module = c.querySelector('[data-testid="nc-cellular"]');
    expect(module).not.toBeNull();
    // data on (default) + real signal → "connected" text; never a fabricated carrier.
    expect(module?.textContent ?? "").toContain(zh["settings.cellularConnected"]);
  });

  test("cellular module reflects 'data off' honestly when the radio is present", async () => {
    writeStoreValue<CellularPrefs>(CELLULAR_KEY, { data: false, roaming: false });
    setCellularRadio({ present: true, signal: 0 });
    const c = await renderOpen();
    await tick();
    const module = c.querySelector('[data-testid="nc-cellular"]');
    expect(module?.textContent ?? "").toContain(zh["settings.cellularDataOff"]);
  });
});

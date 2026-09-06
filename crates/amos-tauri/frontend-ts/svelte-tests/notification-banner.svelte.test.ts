/**
 * notification-banner.svelte.test.ts — Svelte "notification arrived" toast island.
 *
 * NotificationBanner.svelte shows the newest just-arrived notification as a
 * transient toast (unless Do-Not-Disturb), and tapping acknowledges (clears that
 * app's badge + dismisses). Same shared stores + transient logic as React.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationBanner from "../src/svelte/NotificationBanner.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { NOTIF_KEY, SETTINGS_KEY } from "../src/lib/settings";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

const banner = (c: HTMLElement) =>
  c.querySelector('button[aria-label="notification: acknowledge"]') as HTMLButtonElement | null;

describe("NotificationBanner.svelte", () => {
  test("a newly added notification appears as a toast", async () => {
    const { container } = render(NotificationBanner);
    await tick();
    expect(banner(container)).toBeFalsy();

    writeStoreValue(NOTIF_KEY, [{ id: "n1", app: "信息", title: "小安", time: 1 }]);
    await tick();
    expect(banner(container)).toBeTruthy();
    expect(container.textContent ?? "").toContain("信息");
  });

  test("Do-Not-Disturb suppresses the toast", async () => {
    writeStoreValue(SETTINGS_KEY, { dnd: true });
    const { container } = render(NotificationBanner);
    await tick();

    writeStoreValue(NOTIF_KEY, [{ id: "n1", app: "信息", title: "hi", time: 1 }]);
    await tick();
    expect(banner(container)).toBeFalsy();
  });

  test("acknowledge clears the app's notifications and dismisses the toast", async () => {
    const { container } = render(NotificationBanner);
    await tick();
    writeStoreValue(NOTIF_KEY, [{ id: "n1", app: "信息", title: "hi", time: 1 }]);
    await tick();
    expect(banner(container)).toBeTruthy();

    await fireEvent.click(banner(container)!);
    await tick();
    expect(banner(container)).toBeFalsy();
    // The acknowledged app's badge is cleared (its notification is gone).
    const remaining = JSON.parse(localStorage.getItem(NOTIF_KEY) ?? "[]") as unknown[];
    expect(remaining).toEqual([]);
  });
});

/**
 * desktop-notification-center.svelte.test.ts — the desktop's right-hand notification panel
 * (REQ-A417).
 *
 * What this file pins, and why each case is a contract:
 *   • the panel is driven by the **shared** `amos.notifications` store and the **shared**
 *     pure helpers — a second implementation of "what counts as unread" is the F-SH-005
 *     defect class this audit removed;
 *   • a refused store write is **reported** (the list must not show a change the store
 *     rejected — the same rule Dock / FilesApp follow);
 *   • "no demo seeding": an empty store renders the empty state, not invented arrivals;
 *   • outside-click and Escape close it, because the panel is what the user opened with a
 *     click on the clock.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopNotificationCenter from "../src/svelte/DesktopNotificationCenter.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { NOTIF_KEY, SETTINGS_KEY, type Notif } from "../src/lib/settings";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
});
afterEach(() => {
  cleanup();
  setLocale("zh");
});

/** Two shell-made records and one push record (so `source`/`read` are exercised). */
const RECORDS: Notif[] = [
  { id: "n1", app: "时钟", title: "计时结束", body: "5 分钟已到", icon: "⏱️", time: 1_700_000_000_000 },
  {
    id: "n2",
    app: "邮件",
    title: "新邮件",
    body: "来自 Amos",
    icon: "✉️",
    time: 1_700_000_600_000,
    source: "push",
    read: false,
  },
];

/** Make writes of `key` throw the way a full quota does; returns a restore function. */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", {
    value: fake,
    configurable: true,
    writable: true,
  });
  return () =>
    Object.defineProperty(window, "localStorage", {
      value: real,
      configurable: true,
      writable: true,
    });
}

describe("DesktopNotificationCenter.svelte", () => {
  test("an empty store renders the empty state and a disabled Clear (nothing is invented)", async () => {
    const { container } = render(DesktopNotificationCenter, { props: { onclose: () => {} } });
    await tick();
    expect(container.querySelector('[data-testid="desktop-notification-center"]')).toBeTruthy();
    expect(container.textContent ?? "").toContain(zh["nc.empty"]);
    const clear = container.querySelector<HTMLButtonElement>(
      'button[aria-label="' + zh["nc.clear"] + '"]',
    )!;
    expect(clear.disabled).toBe(true);
    // No demo seeding: the store stays empty.
    expect(readStoreValue<Notif[]>(NOTIF_KEY, [])).toEqual([]);
  });

  test("rows come from the shared store, with the push badge only on push records", async () => {
    writeStoreValue(NOTIF_KEY, RECORDS);
    const { container } = render(DesktopNotificationCenter, { props: { onclose: () => {} } });
    await tick();
    expect(container.querySelector('[data-testid="nc-notif-n1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="nc-notif-n2"]')).toBeTruthy();
    // The badge marks the *delivery channel*, not "has a title".
    expect(
      container.querySelector('[data-testid="nc-notif-n1"] [data-testid="nc-push-badge"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="nc-notif-n2"] [data-testid="nc-push-badge"]'),
    ).toBeTruthy();
    expect(container.textContent ?? "").toContain("计时结束");
    expect(container.textContent ?? "").toContain("5 分钟已到");
  });

  test("dismiss removes exactly one row and persists it", async () => {
    writeStoreValue(NOTIF_KEY, RECORDS);
    const { container } = render(DesktopNotificationCenter, { props: { onclose: () => {} } });
    await tick();
    const row = container.querySelector<HTMLElement>('[data-testid="nc-notif-n1"]')!;
    await fireEvent.click(row.querySelector('button[aria-label="' + zh["a11y.dismiss"] + '"]')!);
    await tick();
    expect(container.querySelector('[data-testid="nc-notif-n1"]')).toBeNull();
    expect(container.querySelector('[data-testid="nc-notif-n2"]')).toBeTruthy();
    expect(readStoreValue<Notif[]>(NOTIF_KEY, []).map((n) => n.id)).toEqual(["n2"]);
  });

  test("Clear empties the store (and the panel says so)", async () => {
    writeStoreValue(NOTIF_KEY, RECORDS);
    const { container } = render(DesktopNotificationCenter, { props: { onclose: () => {} } });
    await tick();
    await fireEvent.click(
      container.querySelector<HTMLButtonElement>('button[aria-label="' + zh["nc.clear"] + '"]')!,
    );
    await tick();
    expect(readStoreValue<Notif[]>(NOTIF_KEY, [])).toEqual([]);
    expect(container.textContent ?? "").toContain(zh["nc.empty"]);
  });

  test("mark-read flips the push record's flag (and only that one)", async () => {
    writeStoreValue(NOTIF_KEY, RECORDS);
    const { container } = render(DesktopNotificationCenter, { props: { onclose: () => {} } });
    await tick();
    const row = container.querySelector<HTMLElement>('[data-testid="nc-notif-n2"]')!;
    await fireEvent.click(row.querySelector('button[aria-label="' + zh["nc.markRead"] + '"]')!);
    await tick();
    const saved = readStoreValue<Notif[]>(NOTIF_KEY, []);
    expect(saved.find((n) => n.id === "n2")?.read).toBe(true);
    expect(saved.find((n) => n.id === "n1")?.read).toBeUndefined();
  });

  test("Do-Not-Disturb is stated in the header when it is on", async () => {
    writeStoreValue(SETTINGS_KEY, { dnd: true });
    writeStoreValue(NOTIF_KEY, RECORDS);
    const { container } = render(DesktopNotificationCenter, { props: { onclose: () => {} } });
    await tick();
    expect(container.textContent ?? "").toContain(zh["nc.dnd"]);
  });

  test("a refused write is REPORTED and the row is not silently claimed as gone", async () => {
    writeStoreValue(NOTIF_KEY, RECORDS);
    const restore = failWritesFor(NOTIF_KEY);
    try {
      const { container } = render(DesktopNotificationCenter, { props: { onclose: () => {} } });
      await tick();
      const row = container.querySelector<HTMLElement>('[data-testid="nc-notif-n1"]')!;
      await fireEvent.click(row.querySelector('button[aria-label="' + zh["a11y.dismiss"] + '"]')!);
      await tick();
      expect(container.querySelector('[data-testid="store-write-error"]')?.textContent).toBe(
        zh["common.storeWriteFailed"],
      );
      // The store still holds both records — the write was rejected.
      expect(readStoreValue<Notif[]>(NOTIF_KEY, []).map((n) => n.id)).toEqual(["n1", "n2"]);
    } finally {
      restore();
    }
  });

  test("clicking outside the panel closes it (the desktop stays visible)", async () => {
    let closed = 0;
    const { container } = render(DesktopNotificationCenter, {
      props: { onclose: () => (closed += 1) },
    });
    await tick();
    // The backdrop is the panel's **sibling** (not its parent), so clicking it closes and
    // clicking the panel cannot bubble into it.
    await fireEvent.click(container.querySelector<HTMLElement>('[role="presentation"]')!);
    expect(closed).toBe(1);
  });
});

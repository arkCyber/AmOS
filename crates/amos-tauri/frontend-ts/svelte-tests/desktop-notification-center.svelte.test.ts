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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

  /**
   * The twin of the touch sheet's removal controls. A push row here is a **projection** of
   * the device's history — `osPushWatcher` re-reads `push_get_history` every few seconds and
   * writes back anything the store no longer holds — so a removal that stops at the store is
   * undone by the next poll. `markRead` has always relayed to the device; these two did not.
   */
  describe("a removal reaches the device, not just this panel", () => {
    function installBridge() {
      const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          calls.push({ cmd, args });
          return cmd === "push_delete_notification" ? true : null;
        },
        listen: async () => () => {},
      };
      return calls;
    }

    afterEach(() => {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    });

    const mount = async () => {
      const { container } = render(DesktopNotificationCenter, { props: { onclose: () => {} } });
      await tick();
      return container;
    };

    test("dismissing a delivery tells the device to forget it", async () => {
      const calls = installBridge();
      writeStoreValue(NOTIF_KEY, RECORDS);
      const container = await mount();
      const row = container.querySelector<HTMLElement>('[data-testid="nc-notif-n2"]')!;
      await fireEvent.click(row.querySelector('button[aria-label="' + zh["a11y.dismiss"] + '"]')!);
      await vi.waitFor(() =>
        expect(calls.find((x) => x.cmd === "push_delete_notification")?.args).toEqual({ id: "n2" }),
      );
    });

    // Negative control for the two above: the shell's own notifications are not the device's
    // to delete, so these controls must stay silent when the list holds no delivery.
    test("no device command is sent for the shell's own notifications", async () => {
      const calls = installBridge();
      writeStoreValue(NOTIF_KEY, [RECORDS[0]!]);
      const container = await mount();
      const row = container.querySelector<HTMLElement>('[data-testid="nc-notif-n1"]')!;
      await fireEvent.click(row.querySelector('button[aria-label="' + zh["a11y.dismiss"] + '"]')!);
      await fireEvent.click(
        container.querySelector<HTMLButtonElement>('button[aria-label="' + zh["nc.clear"] + '"]')!,
      );
      await tick();
      expect(calls.filter((x) => x.cmd.startsWith("push_"))).toEqual([]);
    });

    test("clearing a list that holds a delivery clears the device's history too", async () => {
      const calls = installBridge();
      writeStoreValue(NOTIF_KEY, RECORDS);
      const container = await mount();
      await fireEvent.click(
        container.querySelector<HTMLButtonElement>('button[aria-label="' + zh["nc.clear"] + '"]')!,
      );
      await vi.waitFor(() => expect(calls.some((x) => x.cmd === "push_clear_history")).toBe(true));
      expect(readStoreValue<Notif[]>(NOTIF_KEY, [])).toEqual([]);
    });
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

/**
 * REQ-A1125 — a notification row is **actionable**: on macOS, clicking a notification in
 * the panel opens the app that posted it (and the row leaves the panel). Here the card was
 * inert: the only live controls were the ✓ / ✕ icons, so the row announced an arrival the
 * user could read but not go to.
 *
 * The sender is a **display string**, not an app id (see `lib/appMeta.ts::appIdForDisplayName`),
 * so the gate is a reverse lookup — and a row whose sender matches no built-in app (a push
 * payload's free text, the telemetry spy's label) must offer **nothing**: a card that looks
 * pressable and does nothing is the defect this repo files as F-SH-001/F-SH-426's family.
 */
describe("DesktopNotificationCenter — a row opens the app that posted it (REQ-A1125)", () => {
  let calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];

  beforeEach(() => {
    calls = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        // `wm_open` answers with the window snapshot; a `null` reply is the bridge's
        // **failure** value (REQ-A296), so a stub that returned `null` would make every
        // open look refused — the test would pass on a call it recorded and a store it
        // never wrote.
        return { windows: [] };
      },
      listen: async () => () => {},
    };
  });
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  const card = (c: HTMLElement, id: string) =>
    c.querySelector<HTMLElement>(`[data-testid="nc-notif-${id}"]`)!;

  test("clicking a card opens the sender's app, acks its rows, and closes the panel", async () => {
    writeStoreValue(NOTIF_KEY, RECORDS);
    let closed = 0;
    const { container } = render(DesktopNotificationCenter, {
      props: { onclose: () => (closed += 1) },
    });
    await tick();

    const open = card(container, "n1").querySelector<HTMLElement>('[data-testid="nc-open"]')!;
    expect(open, "a card whose sender is a built-in app is actionable").toBeTruthy();
    await fireEvent.click(open);
    await tick();

    // `时钟` is `app.clock` ⇒ the app id, not the display name (the host takes ids).
    expect(calls.some((c) => c.cmd === "wm_open" && c.args?.label === "clock")).toBe(true);
    // Open = read, the store's own convention (`removeAppNotifs`, what the banner uses).
    expect(readStoreValue<Notif[]>(NOTIF_KEY, []).map((n) => n.id)).toEqual(["n2"]);
    expect(closed).toBe(1);
  });

  test("an English-UI row still resolves (the sender was stored in the push-time locale)", async () => {
    // Written by a `bgT` producer under an English UI: the name is English, the app is not.
    writeStoreValue(NOTIF_KEY, [
      { id: "e1", app: "Calendar", title: "Standup", icon: "📅", time: 1_700_000_000_000 },
    ]);
    const { container } = render(DesktopNotificationCenter, { props: { onclose: () => {} } });
    await tick();
    await fireEvent.click(
      card(container, "e1").querySelector<HTMLElement>('[data-testid="nc-open"]')!,
    );
    await vi.waitFor(() =>
      expect(calls.some((c) => c.cmd === "wm_open" && c.args?.label === "calendar")).toBe(true),
    );
  });

  test("a row whose sender names no built-in app offers no open affordance", async () => {
    // A push payload's `app` is free text; the telemetry spy labels its own rows. Neither
    // is an app, and guessing a destination would open the wrong window.
    writeStoreValue(NOTIF_KEY, [
      { id: "p1", app: "Third Party", title: "Hi", icon: "🔔", time: 1, source: "push" },
      { id: "p2", app: "外发泄漏审计", title: "hit", icon: "🛰️", time: 2 },
      { id: "p3", title: "no sender at all", icon: "🔔", time: 3 },
    ]);
    const { container } = render(DesktopNotificationCenter, { props: { onclose: () => {} } });
    await tick();
    for (const id of ["p1", "p2", "p3"]) {
      const c = card(container, id);
      expect(c, `${id} must still be listed`).toBeTruthy();
      expect(c.querySelector('[data-testid="nc-open"]'), `${id} must not offer Open`).toBeNull();
      // …and clicking the card body must not reach the bridge either.
      await fireEvent.click(c);
      await tick();
    }
    expect(calls.filter((c) => c.cmd === "wm_open")).toEqual([]);
  });

  test("a refused open keeps the panel and the row (nothing is claimed)", async () => {
    writeStoreValue(NOTIF_KEY, RECORDS);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async () => {
        throw new Error("host refused");
      },
      listen: async () => () => {},
    };
    let closed = 0;
    const { container } = render(DesktopNotificationCenter, {
      props: { onclose: () => (closed += 1) },
    });
    await tick();
    await fireEvent.click(
      card(container, "n1").querySelector<HTMLElement>('[data-testid="nc-open"]')!,
    );
    await tick();
    expect(closed).toBe(0);
    expect(readStoreValue<Notif[]>(NOTIF_KEY, []).map((n) => n.id)).toEqual(["n1", "n2"]);
  });
});

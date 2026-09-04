import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { FIRED_KEY, REMINDERS_APP_ID, useDueReminderAlerts } from "../lib/reminderNotify";
import { REMINDERS_KEY, type Reminder } from "../lib/reminders";
import { NOTIF_KEY, type Notif } from "../lib/settings";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ active = null }: { active?: string | null }) {
  useDueReminderAlerts(active);
  return null;
}

/** A pending reminder whose due instant is the given (already reached) time. */
const reminder = (dueAt: number, over: Partial<Reminder> = {}): Reminder => ({
  id: "r1",
  title: "去开会",
  listId: "inbox",
  priority: 1,
  flagged: false,
  createdAt: dueAt,
  dueAt,
  ...over,
});

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  window.localStorage.removeItem(REMINDERS_KEY);
  window.localStorage.removeItem(FIRED_KEY);
  window.localStorage.removeItem(NOTIF_KEY);
});

async function mountProbe(active?: string | null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Probe active={active} />);
    await new Promise((r) => setTimeout(r, 0));
  });
  mounted.push({ root, host });
}

describe("useDueReminderAlerts — OS wiring", () => {
  test("fires an alert when a reminder store change reveals a due item", async () => {
    await mountProbe();
    const dueAt = Date.now() - 5_000; // reached already (uses the real clock)
    // A store write for reminders triggers the Shell-level reconcile.
    await act(async () => {
      writeStoreValue(REMINDERS_KEY, [reminder(dueAt)]);
      await new Promise((r) => setTimeout(r, 0));
    });
    const notifs = readStoreValue<Notif[]>(NOTIF_KEY, []);
    expect(notifs.some((n) => n.id === "rem:r1")).toBe(true);
    // Marker recorded so the same reminder won't be alerted again.
    const fired = readStoreValue<Record<string, number>>(FIRED_KEY, {});
    expect(fired["r1"]).toBe(dueAt);
  });

  test("does not re-fire after the app is opened (badge cleared) at the same dueAt", async () => {
    await mountProbe();
    const dueAt = Date.now() - 5_000;
    await act(async () => {
      writeStoreValue(REMINDERS_KEY, [reminder(dueAt)]);
      await new Promise((r) => setTimeout(r, 0));
    });
    // Opening the Reminders app clears its notifications (like any app's).
    await act(async () => {
      writeStoreValue(NOTIF_KEY, []);
      await new Promise((r) => setTimeout(r, 0));
    });
    // A later store change (e.g. editing the title) must NOT resurrect the alert.
    await act(async () => {
      writeStoreValue(REMINDERS_KEY, [reminder(dueAt, { title: "去开会（改）" })]);
      await new Promise((r) => setTimeout(r, 0));
    });
    const notifs = readStoreValue<Notif[]>(NOTIF_KEY, []);
    expect(notifs.filter((n) => n.id === "rem:r1")).toHaveLength(0);
  });

  test("alerts again when the same reminder gets a new, reached dueAt", async () => {
    await mountProbe();
    await act(async () => {
      writeStoreValue(REMINDERS_KEY, [reminder(Date.now() - 5_000)]);
      await new Promise((r) => setTimeout(r, 0));
    });
    // Clear (as if opened), then reschedule to a different reached instant.
    await act(async () => {
      writeStoreValue(NOTIF_KEY, []);
      await new Promise((r) => setTimeout(r, 0));
    });
    const moved = Date.now() - 60_000;
    await act(async () => {
      writeStoreValue(REMINDERS_KEY, [reminder(moved)]);
      await new Promise((r) => setTimeout(r, 0));
    });
    const notifs = readStoreValue<Notif[]>(NOTIF_KEY, []);
    expect(notifs.some((n) => n.id === "rem:r1")).toBe(true); // new due instant re-alerts
    const fired = readStoreValue<Record<string, number>>(FIRED_KEY, {});
    expect(fired["r1"]).toBe(moved);
  });

  test("does not alert while the Reminders app itself is focused", async () => {
    await mountProbe(REMINDERS_APP_ID); // user is inside the Reminders app
    const dueAt = Date.now() - 5_000;
    await act(async () => {
      writeStoreValue(REMINDERS_KEY, [reminder(dueAt)]);
      await new Promise((r) => setTimeout(r, 0));
    });
    // Suppressed: no banner/badge, and no marker (so leaving fires it later).
    const notifs = readStoreValue<Notif[]>(NOTIF_KEY, []);
    expect(notifs.some((n) => n.id === "rem:r1")).toBe(false);
    const fired = readStoreValue<Record<string, number>>(FIRED_KEY, {});
    expect(fired["r1"]).toBeUndefined();
  });
});


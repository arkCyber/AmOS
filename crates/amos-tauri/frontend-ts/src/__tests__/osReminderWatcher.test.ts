import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { NOTIF_KEY } from "../lib/settings";
import { reminderWatcherTick } from "../svelte/osReminderWatcher";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

const REMINDERS_KEY = "amos.reminders";
const FIRED_KEY = "amos.reminderFired";

afterEach(() => {
  window.localStorage.removeItem(REMINDERS_KEY);
  window.localStorage.removeItem(FIRED_KEY);
  window.localStorage.removeItem(NOTIF_KEY);
});

describe("osReminderWatcher — pure-Svelte host reminder reconcile", () => {
  test("runs the reminder sync when not in the Reminders app", () => {
    expect(reminderWatcherTick(null)).toBe(true);
    expect(reminderWatcherTick("notes")).toBe(true);
  });

  test("suppressed while the Reminders app is the focused surface", () => {
    expect(reminderWatcherTick("reminders")).toBe(false);
  });

  test("tolerates a corrupt store without throwing", () => {
    window.localStorage.setItem(REMINDERS_KEY, JSON.stringify("nope"));
    expect(reminderWatcherTick(null)).toBe(true);
  });
});

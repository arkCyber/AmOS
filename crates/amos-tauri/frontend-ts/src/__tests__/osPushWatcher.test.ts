import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { NOTIF_KEY, type Notif } from "../lib/settings";
import { PUSH_HISTORY_LIMIT, pushWatcherTick, startPushWatcher } from "../svelte/osPushWatcher";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

const NOW = 1_700_000_000_000;

/** A push history record exactly as `push_get_history` returns one. */
function record(id: string, receivedAt: string, alert: string) {
  return { id, payload: { aps: { alert } }, received_at: receivedAt, read: false };
}

type Internals = { __TAURI_INTERNALS__?: unknown };
const win = window as unknown as Internals;

/** Install a host that answers `push_get_history` with `history`. */
function bridgeWith(history: unknown[], opts: { fail?: boolean } = {}): void {
  win.__TAURI_INTERNALS__ = {
    invoke: async (command: string) => {
      if (command !== "push_get_history") throw new Error(`unexpected command ${command}`);
      if (opts.fail) throw new Error("host refused");
      return history;
    },
  };
}

const stored = (): Notif[] => JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as Notif[];

afterEach(() => {
  delete win.__TAURI_INTERNALS__;
  window.localStorage.removeItem(NOTIF_KEY);
});

describe("osPushWatcher — remote deliveries land in the shell's notification store", () => {
  test("a visible delivery is merged into the store, once", async () => {
    bridgeWith([record("notif_1", new Date(NOW - 60_000).toISOString(), "build finished")]);

    expect(await pushWatcherTick(NOW)).toBe(1);
    const after = stored();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe("notif_1");
    expect(after[0]?.source).toBe("push");
    expect(after[0]?.body).toBe("build finished");
    // The delivery instant comes from the record's ISO timestamp, not from `now`.
    expect(after[0]?.time).toBe(NOW - 60_000);

    // Second poll: the same history is re-read, and nothing is re-added.
    expect(await pushWatcherTick(NOW)).toBe(0);
    expect(stored()).toHaveLength(1);
  });

  test("a poll that adds nothing does not rewrite the store", async () => {
    window.localStorage.setItem(
      NOTIF_KEY,
      JSON.stringify([{ id: "system_1", time: 1, title: "shell made" }]),
    );
    bridgeWith([record("notif_1", new Date(NOW).toISOString(), "hi")]);
    await pushWatcherTick(NOW);
    const firstWrite = window.localStorage.getItem(NOTIF_KEY);
    // Drop the delivery from the answered history: the poll now has nothing new.
    bridgeWith([]);
    expect(await pushWatcherTick(NOW + 1000)).toBe(0);
    expect(window.localStorage.getItem(NOTIF_KEY)).toBe(firstWrite);
    expect(stored().map((n) => n.id)).toEqual(["notif_1", "system_1"]);
  });

  test("a delivery with nothing to show is not put on screen", async () => {
    bridgeWith([
      { id: "notif_silent", payload: { aps: { "content-available": 1 } }, received_at: new Date(NOW).toISOString(), read: false },
    ]);
    expect(await pushWatcherTick(NOW)).toBe(0);
    expect(stored()).toHaveLength(0);
  });

  test("a failed fetch changes nothing", async () => {
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify([{ id: "keep_me", time: 1 }]));
    bridgeWith([], { fail: true });
    expect(await pushWatcherTick(NOW)).toBe(0);
    expect(stored().map((n) => n.id)).toEqual(["keep_me"]);
  });

  test("without a host bridge nothing is asked and nothing is written", async () => {
    expect(await pushWatcherTick(NOW)).toBe(0);
    expect(stored()).toHaveLength(0);
  });

  test("the poller asks for a bounded history and its stop function is usable", async () => {
    const asked: Array<Record<string, unknown> | undefined> = [];
    win.__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command !== "push_get_history") throw new Error(`unexpected command ${command}`);
        asked.push(args);
        return [];
      },
    };
    const stop = startPushWatcher();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked[0]).toEqual({ limit: PUSH_HISTORY_LIMIT });
    expect(() => stop()).not.toThrow();
  });
});

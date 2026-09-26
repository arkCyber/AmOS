import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { NOTIF_CAP, NOTIF_KEY, type Notif } from "../lib/settings";
import { PUSH_HISTORY_LIMIT, PUSH_POLL_MS, pushWatcherTick, startPushWatcher } from "../svelte/osPushWatcher";

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
  // Each case below stubs `visibilityState` with an **own** property. Dropping it puts the
  // prototype's getter back (happy-dom's real state) for the next test — in this file *or in
  // another one*: without this the dockBadge suite, which runs in the same process, read a
  // permanently "hidden" document and failed only when the two files ran together (REQ-A589).
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
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

/**
 * The Dock bounce (REQ-A589): `dock_request_attention` was a registered command with **no
 * caller** — the allow-list entry said to wire it "when a background delivery that the user
 * might miss exists". A push that lands while the shell window is hidden is exactly that.
 */
describe("osPushWatcher — a delivery the user can miss bounces the Dock", () => {
  /** A host that answers the history **and** records the attention requests. */
  function bridgeWithAttention(history: unknown[]) {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    win.__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "push_get_history") return history;
        if (command === "dock_request_attention") return null; // `()` ⇒ null, even on success
        if (command === "store_set") return null; // the store write also mirrors to the host
        throw new Error(`unexpected command ${command}`);
      },
    };
    return calls;
  }

  const setVisibility = (value: string) =>
    Object.defineProperty(document, "visibilityState", { value, configurable: true });

  test("隐藏的窗口收到投递 ⇒ 跳一次（level: info），通知照样入库", async () => {
    setVisibility("hidden");
    const calls = bridgeWithAttention([
      record("notif_hidden", new Date(NOW - 5_000).toISOString(), "build finished"),
    ]);
    expect(await pushWatcherTick(NOW)).toBe(1);
    await new Promise((r) => setTimeout(r, 0)); // the bounce is fire-and-forget
    expect(stored().map((n) => n.id)).toEqual(["notif_hidden"]);
    expect(calls.filter((c) => c.command === "dock_request_attention")).toEqual([
      { command: "dock_request_attention", args: { level: "info" } },
    ]);
  });

  test("窗口在前台 ⇒ 不跳（横幅已经在眼前）", async () => {
    setVisibility("visible");
    const calls = bridgeWithAttention([
      record("notif_visible", new Date(NOW - 5_000).toISOString(), "build finished"),
    ]);
    expect(await pushWatcherTick(NOW)).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((c) => c.command === "dock_request_attention")).toBe(false);
  });

  test("没有新投递 ⇒ 不跳（后台窗口也不该为旧消息抖动）", async () => {
    setVisibility("hidden");
    window.localStorage.setItem(
      NOTIF_KEY,
      JSON.stringify([{ id: "notif_hidden", time: NOW, source: "push" }]),
    );
    const calls = bridgeWithAttention([
      record("notif_hidden", new Date(NOW - 5_000).toISOString(), "build finished"),
    ]);
    expect(await pushWatcherTick(NOW)).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((c) => c.command === "dock_request_attention")).toBe(false);
  });

  test("列表已到顶时，新投递**仍**算\"新增一条\"，仍然跳（旧算式在此时会报 0）", async () => {
    setVisibility("hidden");
    // Fill the store to its cap, then let one more delivery land.
    const full = Array.from({ length: NOTIF_CAP }, (_, i) => ({
      id: `old_${i}`,
      time: NOW - i,
      source: "push",
    }));
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify(full));
    const calls = bridgeWithAttention([
      record("notif_at_cap", new Date(NOW - 1_000).toISOString(), "one more"),
    ]);
    expect(await pushWatcherTick(NOW)).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.command === "dock_request_attention")).toHaveLength(1);
    expect(stored().map((n) => n.id)).toContain("notif_at_cap");
  });
});

/**
 * REQ-A1277 — a store that refuses the write recorded nothing, so there is no arrival to
 * announce. `writeStoreValue` is `void` (`writeJson` answers `false` and logs), and the tick
 * dropped that verdict: the Dock was bounced for a delivery that never landed — and, because
 * `held` is re-read from the same store on the next poll, the merge re-added the same record and
 * the bounce **repeated every `PUSH_POLL_MS`** for as long as the refusal lasted. Every case in
 * the suite above either has a writable `localStorage` or fails at the *fetch* (which returns
 * before the write), so the refused-write path was never executed.
 */
describe("osPushWatcher — a refused store write is not an arrival (REQ-A1277)", () => {
  /** Make `setItem` throw for `key` only, the shape of a full / unavailable store. */
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

  /** A host that answers the history **and** records the attention requests. */
  function bridgeWithAttention(history: unknown[]) {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    win.__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "push_get_history") return history;
        if (command === "dock_request_attention") return null; // `()` ⇒ null, even on success
        if (command === "store_set") return null; // the store write also mirrors to the host
        throw new Error(`unexpected command ${command}`);
      },
    };
    return calls;
  }

  const setVisibility = (value: string) =>
    Object.defineProperty(document, "visibilityState", { value, configurable: true });

  test("存储拒写 ⇒ 不跳（这次投递没有落地）", async () => {
    setVisibility("hidden");
    const calls = bridgeWithAttention([
      record("notif_refused", new Date(NOW - 5_000).toISOString(), "build finished"),
    ]);
    const restore = failWritesFor(NOTIF_KEY);
    try {
      expect(await pushWatcherTick(NOW)).toBe(0);
      await new Promise((r) => setTimeout(r, 0));
      expect(stored()).toHaveLength(0);
      expect(calls.some((c) => c.command === "dock_request_attention")).toBe(false);
    } finally {
      restore();
    }
  });

  test("存储一直拒写 ⇒ 不会每轮都跳一次（同一条投递不得反复宣告）", async () => {
    setVisibility("hidden");
    const calls = bridgeWithAttention([
      record("notif_refused", new Date(NOW - 5_000).toISOString(), "build finished"),
    ]);
    const restore = failWritesFor(NOTIF_KEY);
    try {
      expect(await pushWatcherTick(NOW)).toBe(0);
      expect(await pushWatcherTick(NOW + PUSH_POLL_MS)).toBe(0);
      expect(await pushWatcherTick(NOW + 2 * PUSH_POLL_MS)).toBe(0);
      await new Promise((r) => setTimeout(r, 0));
      expect(calls.some((c) => c.command === "dock_request_attention")).toBe(false);
    } finally {
      restore();
    }
  });

  test("存储恢复后，同一条投递照样落地并**只**跳一次（闸不是「永不宣告」）", async () => {
    setVisibility("hidden");
    const calls = bridgeWithAttention([
      record("notif_refused", new Date(NOW - 5_000).toISOString(), "build finished"),
    ]);
    const restore = failWritesFor(NOTIF_KEY);
    try {
      expect(await pushWatcherTick(NOW)).toBe(0);
    } finally {
      restore();
    }
    // The store is writable again: the host's history is re-read anyway, so the delivery is
    // surfaced now — the refusal postponed it, it did not lose it.
    expect(await pushWatcherTick(NOW + PUSH_POLL_MS)).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(stored().map((n) => n.id)).toEqual(["notif_refused"]);
    expect(calls.filter((c) => c.command === "dock_request_attention")).toHaveLength(1);
    // And it is announced once, not once per poll.
    expect(await pushWatcherTick(NOW + 2 * PUSH_POLL_MS)).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.command === "dock_request_attention")).toHaveLength(1);
  });
});

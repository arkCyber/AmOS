/**
 * wmWindowsPoll.test.ts — the shared `wm_windows` heartbeat (REQ-A535).
 *
 * `DesktopShell` and `Dock` each used to own a `setInterval(…, 5000)` reading the same
 * `wm_windows`, while the shell's comment claimed they "share one heartbeat". They did not:
 * the desktop asked the host twice per 5 s for one answer. `lib/wmWindowsPoll.ts` is that one
 * heartbeat, reference-counted.
 *
 * These cases pin the two properties the refcount is *for* — not the implementation:
 *   • N subscribers ⇒ **one** poll, not N (the fan-out is the point);
 *   • the last unsubscribe stops the timer **and** drops the cached snapshot, so nothing
 *     outlives its owner and no test bleeds a snapshot into the next.
 *
 * REQ-A717 added the host's `wm-changed` push as the fast path (the timer became a slow
 * reconciliation backstop), so the cases below also pin that: a push reaches the listener with
 * no timer tick, a payload with no window list is dropped rather than read as "zero windows",
 * and the host subscription is torn down with the timer.
 */
import { describe, test as it, expect, beforeEach, afterEach } from "bun:test";
import {
  subscribeWmWindows,
  WM_WINDOWS_POLL_MS,
} from "../wmWindowsPoll";

let calls: string[] = [];
/** Channels the module subscribed to, and the handler it registered on each. */
let subscriptions: Array<{ channel: string; handler: (e: { payload: unknown }) => void }> = [];

/** Fire a host event at the module's registered listener (the push path). */
function push(channel: string, payload: unknown): void {
  for (const s of subscriptions) {
    if (s.channel === channel) s.handler({ payload });
  }
}

function installInternals(): void {
  calls = [];
  subscriptions = [];
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === "wm_windows") {
          return { windows: [{ label: "notes", kind: "App", state: "Focused", focused: true }] };
        }
        return null;
      },
      listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
        subscriptions.push({ channel, handler });
        return () => {
          subscriptions = subscriptions.filter((s) => s.handler !== handler);
        };
      },
    },
  };
}

beforeEach(installInternals);
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("subscribeWmWindows", () => {
  it("keeps the poll as a slow reconciliation backstop, not the user-visible cadence", () => {
    // REQ-A717: the push is the fast path, so the timer is deliberately slow — it only
    // bounds how long a *missed* event can leave the chrome stale.
    expect(WM_WINDOWS_POLL_MS).toBe(30000);
  });

  it("pulls once for the first subscriber and fans the snapshot out to every listener", async () => {
    const a: Array<unknown> = [];
    const b: Array<unknown> = [];
    const unsubA = subscribeWmWindows((s) => a.push(s));
    const unsubB = subscribeWmWindows((s) => b.push(s));
    await flush();

    // One `wm_windows` for two subscribers — the whole reason this module exists. Before it,
    // each surface's own interval produced two.
    expect(calls.filter((c) => c === "wm_windows").length).toBe(1);
    // Both got the answer (the late subscriber is served the cache, not a blank frame).
    expect(a[a.length - 1]).not.toBeNull();
    expect(b[b.length - 1]).not.toBeNull();

    unsubA();
    unsubB();
  });

  it("stops polling when the last listener leaves (refcount, not a leak)", async () => {
    const unsubA = subscribeWmWindows(() => {});
    const unsubB = subscribeWmWindows(() => {});
    await flush();
    const afterSubscribe = calls.filter((c) => c === "wm_windows").length;

    unsubA();
    await flush();
    // One listener remains: still polling (no early stop).
    expect(calls.filter((c) => c === "wm_windows").length).toBe(afterSubscribe);

    unsubB(); // last one out
    // A fresh subscriber must start a **new** session and pull again — if the timer had
    // leaked, the count would already have advanced past this pull.
    const unsubC = subscribeWmWindows(() => {});
    await flush();
    expect(calls.filter((c) => c === "wm_windows").length).toBe(afterSubscribe + 1);
    unsubC();
  });

  it("does not serve a read that lands AFTER the last listener left (session guard)", async () => {
    // The window the cases above never open: unsubscribe happens *while the host read is
    // still in flight*. The teardown drops the cache, but the late reply then lands and (with
    // no session guard) repopulates it — so the next owner is handed the previous owner's
    // snapshot, which may be arbitrarily old (the timer stopped when that owner left). The
    // inline contract says the cache "can only serve the current session's own read"; this
    // makes that true under the race.
    let release: (v: unknown) => void = () => {};
    (globalThis as unknown as { window: unknown }).window = {
      __TAURI_INTERNALS__: {
        invoke: () =>
          new Promise((r) => {
            release = r;
          }),
        listen: async () => () => {},
      },
    };

    const a: Array<unknown> = [];
    const unsubA = subscribeWmWindows((s) => a.push(s));
    unsubA(); // last listener out — timer stops, cache drops, read still in flight
    release({ windows: [{ label: "notes", kind: "App", state: "Focused", focused: true }] });
    await flush();

    // A new owner must start clean: nothing until its OWN read lands.
    const b: Array<unknown> = [];
    const unsubB = subscribeWmWindows((s) => b.push(s));
    expect(b.length).toBe(0);
    unsubB();
  });

  it("drops the cached snapshot when the last listener leaves (no cross-owner bleed)", async () => {
    const first: Array<unknown> = [];
    const unsubA = subscribeWmWindows((s) => first.push(s));
    await flush();
    expect(first[first.length - 1]).not.toBeNull();
    unsubA();

    // A new owner must NOT be handed the previous owner's snapshot before its own read
    // lands — this is the "one test bleeding into the next" shape the module clears for.
    const second: Array<unknown> = [];
    const unsubB = subscribeWmWindows((s) => second.push(s));
    expect(second.length).toBe(0);
    await flush();
    expect(second[second.length - 1]).not.toBeNull();
    unsubB();
  });
});

describe("the host push (REQ-A717)", () => {
  it("delivers a `wm-changed` snapshot the moment the host pushes it, with no timer involved", async () => {
    const seen: Array<unknown> = [];
    const unsub = subscribeWmWindows((s) => seen.push(s));
    await flush();
    const afterInitialRead = seen.length;

    push("wm-changed", {
      focused: 7,
      windows: [{ id: 7, label: "notes", app: "notes", kind: "App", state: "Shown", focused: true }],
    });

    // The push reached the listener **synchronously** — no timer tick was needed, which is
    // the whole point: the dock no longer waits up to WM_WINDOWS_POLL_MS to drop a dot.
    expect(seen.length).toBe(afterInitialRead + 1);
    expect(seen[seen.length - 1]).toEqual({
      focused: 7,
      windows: [
        {
          id: 7,
          label: "notes",
          app: "notes",
          instance: 1,
          kind: "App",
          state: "Shown",
          focused: true,
          external: false,
        },
      ],
    });
    unsub();
  });

  it("ignores a `wm-changed` payload that carries no window list (never blanks the chrome)", async () => {
    const seen: Array<unknown> = [];
    const unsub = subscribeWmWindows((s) => seen.push(s));
    await flush();
    const before = seen.length;

    // A push with a missing/garbled payload must NOT normalize into "zero windows" — that
    // would read as "every app closed" and clear the Dock's dots.
    push("wm-changed", null);
    push("wm-changed", "not a snapshot");

    expect(seen.length).toBe(before);
    unsub();
  });

  it("tears the host subscription down when the last listener leaves", async () => {
    const unsubA = subscribeWmWindows(() => {});
    const unsubB = subscribeWmWindows(() => {});
    await flush();
    expect(subscriptions.some((s) => s.channel === "wm-changed")).toBe(true);

    unsubA();
    unsubB(); // last one out: the push must go with the timer
    await flush();
    expect(subscriptions.some((s) => s.channel === "wm-changed")).toBe(false);
  });
});

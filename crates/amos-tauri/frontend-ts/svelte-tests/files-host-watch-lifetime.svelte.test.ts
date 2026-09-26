/**
 * files-host-watch-lifetime.svelte.test.ts — the host watch is a real OS-level resource, so a
 * subscription that lands after teardown must still be released (REQ-A1177 / FMEA F-SH-470).
 *
 * `host_fs_watch_subscribe` builds a `notify` debouncer (its own thread + OS watch descriptors on
 * the fenced directory) and stores it in the host's `slots` map under a fresh id; only
 * `host_fs_watch_unsubscribe` drops it. `FilesApp` starts it fire-and-forget from an `$effect`
 * (`startHostFs()` — probe → list → subscribe), and its cleanup releases `hostSubId` **if it is
 * already set**. The subscribe resolves a few async hops after mount, so when the screen unmounts
 * inside that window the cleanup sees `hostSubId === null`, and the id that lands afterwards is
 * written onto a dead component and never released — the host keeps the watcher for the life of
 * the process, and every app-switch into Files adds another.
 *
 * `WebManApp.svelte` already guards its twin subscription exactly this way (`destroyed` flag:
 * `if (destroyed) un(); else unlistenProgress = un;`). This file pins the host-watch half.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import FilesApp from "../src/svelte/FilesApp.svelte";

type Call = { cmd: string; subscriptionId?: number };

/**
 * A bridge whose `host_fs_watch_subscribe` **does not resolve until the test says so** — the
 * window in which the screen can be unmounted before the id exists.
 */
function installDeferredWatchBridge() {
  const calls: Call[] = [];
  const diagnostics: string[] = [];
  let releaseSubscribe: ((id: number) => void) | null = null;

  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "host_fs_root_status") {
        return Promise.resolve({ root: "/tmp/fence", exists: true, reason: null });
      }
      if (cmd === "host_fs_read_dir") return Promise.resolve([]);
      if (cmd === "host_fs_watch_subscribe") {
        return new Promise((resolve) => {
          releaseSubscribe = (id: number) => resolve({ subscriptionId: id });
        });
      }
      if (cmd === "host_fs_watch_unsubscribe") {
        // Unsubscribe passes `subscriptionId` at the **top level**, not under `args`
        // (the Rust command takes it as a plain parameter) — read it the same way the
        // wire layer sends it.
        const id = (args as { subscriptionId?: number } | undefined)?.subscriptionId;
        calls.push({ cmd, subscriptionId: id });
        return Promise.resolve({ removed: true });
      }
      diagnostics.push(cmd);
      return Promise.resolve(null);
    },
    listen: async () => () => {},
  };

  return {
    calls,
    /** Resolve the pending subscribe with `id` (after teardown, in the failing case). */
    release: (id: number) => releaseSubscribe?.(id),
    sawSubscribe: () => releaseSubscribe !== null,
  };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

describe("FilesApp — host watch subscription lifetime", () => {
  test("a subscription that lands after unmount is still released", async () => {
    const bridge = installDeferredWatchBridge();
    const host = render(FilesApp);

    // Wait until the screen reached the host-fs surface and issued the subscribe.
    await vi.waitFor(() => expect(bridge.sawSubscribe()).toBe(true));

    // The screen goes away while the host has not yet answered with an id.
    host.unmount();
    await settle();

    // Now the answer arrives — with the component already destroyed.
    bridge.release(7);
    await settle();

    expect(
      bridge.calls.map((c) => c.subscriptionId),
      "the watch the host built must be released, not left running on a dead screen",
    ).toContain(7);
  });

  test("a subscription that lands before unmount is released on teardown (the ordinary path)", async () => {
    const bridge = installDeferredWatchBridge();
    const host = render(FilesApp);
    await vi.waitFor(() => expect(bridge.sawSubscribe()).toBe(true));

    bridge.release(9);
    await settle();
    expect(bridge.calls, "still mounted — nothing to release yet").toHaveLength(0);

    host.unmount();
    await settle();
    expect(bridge.calls.map((c) => c.subscriptionId)).toContain(9);
  });
});

/**
 * files-host-watch-refused.svelte.test.ts — a file watch the host **refused to install** must not
 * read as "listening; nothing changed" (REQ-A1595 / FMEA F-SH-810).
 *
 * `FilesApp` starts its watch fire-and-forget from `startHostFs()` (probe → list → subscribe).
 * When the subscribe was refused the branch was `if (!r.ok) { refreshHostWatches(); return; }` —
 * three lines that drop the refusal on the floor with no state and no sentence. Nothing on screen
 * said so, and nothing *could*: the only watch-related thing drawn is the header count chip, and it
 * is hidden at zero on purpose ("0 watchers" is the ordinary state of a host nobody is watching,
 * REQ-A1177). So a refused watch and a quiet working watch rendered byte-identically — the exact
 * conflation `hostFs.ts::onHostFsEvent`'s own doc names for the sibling seam ("'/tmp/…'-style
 * 'nothing changed' and 'we are not listening' must not read alike", REQ-A838).
 *
 * The consequence is not cosmetic: with no watcher, an edit made outside AmOS never refreshes the
 * listing, and the user has no way to tell a stale listing from a current one.
 *
 * The fix keeps the sentence in its **own** state rather than folding it into `hostErr`. `hostErr`
 * is the *last listing's* verdict and `loadHostDir`'s success branch clears it, so a perfectly
 * ordinary refresh would erase a standing fact about the screen's own wiring — the same reason
 * `hostListFailed` was split off from `hostErr` (REQ-A542's rule). The third test below pins that
 * choice: the sentence must survive a later successful listing.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import FilesApp from "../src/svelte/FilesApp.svelte";

/** A realistic refusal: `HostFsState::subscribe` answers `path_is_not_a_dir` for a non-dir path. */
const REFUSED_CODE = "amos.host_fs.path_is_not_a_dir";

function installWatchBridge(opts: { refused: boolean; watchList?: number[] }) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];

  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "host_fs_root_status") {
        return Promise.resolve({ root: "/tmp/fence", exists: true, reason: null });
      }
      if (cmd === "host_fs_read_dir") return Promise.resolve([]);
      if (cmd === "host_fs_watch_subscribe") {
        if (opts.refused) {
          // Tauri throws the Rust `AmosError` envelope as a plain object; `backend.invoke` catches
          // it and records it in the per-command ledger, which `hostFs.ts::call` reads back.
          return Promise.reject({ code: REFUSED_CODE, message: "host_fs: not a dir", cause: ["ENOTDIR"] });
        }
        return Promise.resolve({ subscriptionId: 7 });
      }
      if (cmd === "host_fs_watch_list") return Promise.resolve(opts.watchList ?? []);
      if (cmd === "host_fs_watch_unsubscribe") return Promise.resolve({ removed: true });
      return Promise.resolve(null);
    },
    listen: async () => () => {},
  };

  return { calls };
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

describe("FilesApp — a refused host file watch", () => {
  test("the refusal is said out loud (with the host's own reason), not folded into a quiet zero", async () => {
    const bridge = installWatchBridge({ refused: true });
    const host = render(FilesApp);

    await vi.waitFor(() =>
      expect(bridge.calls.some((c) => c.cmd === "host_fs_watch_subscribe")).toBe(true),
    );
    await settle();

    const said = host.queryByTestId("host-watch-refused");
    expect(
      said,
      "the host refused the watch — the screen must say so instead of looking like a quiet watcher",
    ).not.toBeNull();
    // The host's own stable code rides along: the panel may not invent a second reason for it.
    expect(said?.textContent ?? "").toContain(REFUSED_CODE);
    // And the count chip, which cannot carry this fact, stays hidden at zero.
    expect(host.queryByTestId("host-watch-count")).toBeNull();
  });

  test("the ordinary path says nothing (a working watch is not a refusal)", async () => {
    const bridge = installWatchBridge({ refused: false, watchList: [7] });
    const host = render(FilesApp);

    await vi.waitFor(() => expect(host.queryByTestId("host-watch-count")).not.toBeNull());
    await settle();

    expect(host.queryByTestId("host-watch-refused")).toBeNull();
    expect(bridge.calls.some((c) => c.cmd === "host_fs_watch_subscribe")).toBe(true);
  });

  test("a later successful listing does not erase the standing fact", async () => {
    const bridge = installWatchBridge({ refused: true });
    const host = render(FilesApp);
    await vi.waitFor(() => expect(host.queryByTestId("host-watch-refused")).not.toBeNull());

    // Open the surface and force another *successful* listing (`host_fs_read_dir` answers `[]`).
    // A `hostErr`-folded implementation would have the success branch's `hostErr = ""` wipe it.
    const toggle = host.getByRole("button", { name: /主机文件系统|Host filesystem/ });
    await toggle.click();
    await settle();
    const readsBefore = bridge.calls.filter((c) => c.cmd === "host_fs_read_dir").length;
    const up = host.getByRole("button", { name: /上一级|^Up$/ });
    await up.click();
    await vi.waitFor(() =>
      expect(bridge.calls.filter((c) => c.cmd === "host_fs_read_dir").length).toBeGreaterThan(readsBefore),
    );
    await settle();

    expect(
      host.queryByTestId("host-watch-refused"),
      "a listing refresh is not evidence about the watch — it must not retract the sentence",
    ).not.toBeNull();
  });
});

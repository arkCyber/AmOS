/**
 * link-page.svelte.test.ts — DOM tests for the Settings「机器人链路 / Robot Link」 page,
 * the System UI's read-only view of the daemon's AmOS-Link control plane.
 *
 * What is asserted is the **claim**, not the pixels (mirroring
 * `settings-untested-screens.svelte.test.ts`):
 *   • an unreachable daemon reads as "not connected" and is never dressed up as a link;
 *   • the daemon's own verdict is shown *with its reasons* — no bare "OK";
 *   • **"no evidence yet" (`unknown`) never renders as healthy** — the one place a
 *     quiet link could be mistaken for a working one;
 *   • an uncalibrated clock is called out, because it makes every latency a bound.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import LinkPage from "../src/svelte/settings/LinkPage.svelte";

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** Install a fake bridge whose `link_status` answers with `reply`. */
function bridgeReturning(reply: unknown) {
  const calls: string[] = [];
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      calls.push(cmd);
      return cmd === "link_status" ? reply : null;
    },
    listen: async () => () => {},
  };
  return calls;
}

const STATUS = {
  peer: "amos-daemon",
  kind: "brain",
  version: "0.1.0",
  uptime_ms: 125_000,
  clock_synced: false,
  health: "degraded",
  health_reasons: ["no_peers", "clock_unsynced"],
  metrics: {
    published: 12,
    delivered: 12,
    dropped: 0,
    blocked: 0,
    decode_errors: 0,
    encode_errors: 0,
  },
  peers: [{ id: "dog1", kind: "robot", endpoint: null, last_seen_ms: 300, beacons: 7 }],
};

describe("LinkPage (never dresses a quiet link up as a working one)", () => {
  test("an unreachable daemon reads as not connected", async () => {
    // No `__TAURI_INTERNALS__` ⇒ bridged() is false ⇒ linkStatus() is null.
    const host = render(LinkPage);
    await settle();
    const verdict = host.container.querySelector('[data-testid="link-verdict"]')?.textContent ?? "";
    expect(verdict).toContain("守护进程未连接");
    // The verdict itself never claims health — and the page says *why* it is empty.
    expect(verdict).not.toContain("健康");
    // Nothing is invented: no counter readout and no peer list without an answer.
    expect(host.container.querySelector('[data-testid="link-counters"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="link-peers"]')).toBeNull();
    expect(host.container.textContent ?? "").toContain("守护进程没有在共享套接字上应答");
  });

  test("the daemon's verdict is shown with its reasons and its real counters", async () => {
    const calls = bridgeReturning(STATUS);
    const host = render(LinkPage);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="link-counters"]')).toBeTruthy(),
    );
    expect(calls).toContain("link_status");
    const text = host.container.textContent ?? "";
    // The verdict, its reasons, the identity and the clock caveat all come from the daemon.
    expect(text).toContain("可用，但有可测的问题");
    expect(text).toContain("no_peers");
    expect(text).toContain("clock_unsynced");
    expect(text).toContain("amos-daemon");
    expect(text).toContain("时钟未校准");
    // Uptime is scaled, not printed as raw milliseconds.
    expect(text).toContain("2m 05s");
    // Counters are the daemon's numbers verbatim.
    expect(host.container.querySelector('[data-testid="link-counters"]')?.textContent).toContain(
      "published=12",
    );
    // The peer table names who is on the link.
    expect(host.container.querySelector('[data-testid="link-peers"]')?.textContent).toContain(
      "dog1 (robot)",
    );
  });

  test("no evidence yet is never rendered as healthy", async () => {
    bridgeReturning({ ...STATUS, health: "unknown", health_reasons: [], peers: [] });
    const host = render(LinkPage);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="link-counters"]')).toBeTruthy(),
    );
    const verdict = host.container.querySelector('[data-testid="link-verdict"]')?.textContent ?? "";
    expect(verdict).toContain("暂无证据");
    expect(verdict).not.toContain("健康");
    // A lone node still says so instead of showing an empty table.
    expect(host.container.textContent ?? "").toContain("还没有对端宣告自己");
  });

  test("refresh re-reads the daemon instead of flipping state locally", async () => {
    const calls = bridgeReturning(STATUS);
    const host = render(LinkPage);
    // Wait for the first read to *finish* (the counters only render once it has), so
    // the refresh button is out of its disabled state before we click it.
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="link-counters"]')).toBeTruthy(),
    );
    const before = calls.filter((c) => c === "link_status").length;
    await fireEvent.click(
      host.container.querySelector('[aria-label="刷新"]') as HTMLButtonElement,
    );
    await vi.waitFor(() =>
      expect(calls.filter((c) => c === "link_status").length).toBeGreaterThan(before),
    );
  });

  test("robot rows show what each robot reports about itself", async () => {
    bridgeReturning({
      ...STATUS,
      actuations: [
        {
          robot: "dog1",
          seq: 12,
          gait: "trot",
          frames: 13,
          armed: true,
          estopped: false,
          estop_reason: null,
          watchdog_ms: 1000,
          last_refusal: null,
          stamp_ms: 1,
        },
        {
          robot: "dog2",
          seq: 13,
          gait: "estop",
          frames: 12,
          armed: false,
          estopped: true,
          estop_reason: "watchdog",
          watchdog_ms: 1000,
          last_refusal: {
            seq: 14,
            reason: 'e-stop latched: send {"action":"arm"} to re-arm',
          },
          stamp_ms: 2,
        },
      ],
    });
    const host = render(LinkPage);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="link-robots"]')).toBeTruthy(),
    );
    const rows = host.container.querySelector('[data-testid="link-robots"]')?.textContent ?? "";
    expect(rows).toContain("dog1 · trot · #12");
    expect(rows).toContain("已上电");
    expect(rows).toContain("dog2 · estop · #13");
    // The watchdog cut is the headline fact for that row, not "armed".
    expect(rows).toContain("已切扭矩");
    // The refusal carries the robot's own words (how to recover), not a UI paraphrase.
    const refusal =
      host.container.querySelector('[data-testid="link-robot-refusal"]')?.textContent ?? "";
    expect(refusal).toContain("#14");
    expect(refusal).toContain("re-arm");
  });

  test("no reports is stated as such, never as 'all robots idle'", async () => {
    bridgeReturning({ ...STATUS, actuations: [] });
    const host = render(LinkPage);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="link-robots-none"]')).toBeTruthy(),
    );
    expect(host.container.textContent ?? "").toContain("还没有机器人上报自身状态");
    expect(host.container.querySelector('[data-testid="link-robots"]')).toBeNull();
  });

  test("a daemon older than the RPC does not break the panel", async () => {
    // Version skew: an older daemon simply omits `actuations`. The panel must show less,
    // never throw — and the rest of the status still renders.
    const older: Record<string, unknown> = { ...STATUS };
    delete older.actuations;
    bridgeReturning(older);
    const host = render(LinkPage);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="link-counters"]')).toBeTruthy(),
    );
    expect(
      host.container.querySelector('[data-testid="link-robots-none"]'),
    ).toBeTruthy();
    expect(host.container.querySelector('[data-testid="link-robots"]')).toBeNull();
  });
});

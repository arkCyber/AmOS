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
  peers: [
    { id: "dog1", kind: "robot", endpoint: "tcp/10.0.0.7:7447", last_seen_ms: 300, beacons: 7 },
    // A peer whose beacon carried no endpoint: absent, never `""` or `"null"`.
    { id: "mini-brain", kind: "brain", endpoint: null, last_seen_ms: 40, beacons: 3 },
  ],
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
    // The peer table names who is on the link, and how to reach them when the beacon said so.
    const peers = host.container.querySelector('[data-testid="link-peers"]')?.textContent ?? "";
    expect(peers).toContain("dog1 (robot)");
    expect(peers).toContain("mini-brain (brain)");
    const rows = host.container.querySelector('[data-testid="link-peer-rows"]')?.textContent ?? "";
    expect(rows).toContain("tcp/10.0.0.7:7447");
    // …and a peer that advertised no endpoint shows none (no fabricated address, no "null").
    expect(host.container.textContent ?? "").not.toContain("null");

    // Every number on screen is a *dated* reading: the panel says when it was taken
    // (`link.probe`), which is what makes an old readout distinguishable from a fresh one.
    const stamp = host.container.querySelector('[data-testid="link-read-at"]')?.textContent ?? "";
    expect(stamp).toMatch(/最近读数：\d\d:\d\d:\d\d（每 10 秒重读）/);
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

  test("re-reads the daemon while the page is open — the readout cannot sit there frozen", async () => {
    // The defect this pins: the panel read *once* on mount, so a page left open showed a
    // three-minute-old `last_seen_ms` (and old counters) as if it were current — nothing on
    // screen told the operator the reading had stopped moving.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let calls = 0;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd !== "link_status") return null;
        calls += 1;
        return { ...STATUS, metrics: { ...STATUS.metrics, published: 12 + calls } };
      },
      listen: async () => () => {},
    };
    const host = render(LinkPage);
    await tick();
    await vi.advanceTimersByTimeAsync(0); // flush the initial read
    expect(calls).toBe(1);
    expect(host.container.querySelector('[data-testid="link-counters"]')?.textContent).toContain(
      "published=13",
    );
    expect(host.container.querySelector('[data-testid="link-read-at"]')).toBeTruthy();

    // One interval later the panel asks the *daemon* again, and the new number is rendered.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(2);
    expect(host.container.querySelector('[data-testid="link-counters"]')?.textContent).toContain(
      "published=14",
    );
  });

  test("a re-read that gets no answer drops the numbers instead of freezing them", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let online = true;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => (cmd === "link_status" && online ? STATUS : null),
      listen: async () => () => {},
    };
    const host = render(LinkPage);
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.container.querySelector('[data-testid="link-counters"]')).toBeTruthy();

    // The daemon goes away between reads: the stale counters/peers must not stay on screen
    // looking like a live link (the verdict is the daemon's, and there is no daemon).
    online = false;
    await vi.advanceTimersByTimeAsync(10_000);
    const verdict = host.container.querySelector('[data-testid="link-verdict"]')?.textContent ?? "";
    expect(verdict).toContain("守护进程未连接");
    expect(verdict).not.toContain("可用，但有可测的问题");
    expect(host.container.querySelector('[data-testid="link-counters"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="link-peers"]')).toBeNull();
    // …and no reading is dated, because there is no reading.
    expect(host.container.querySelector('[data-testid="link-read-at"]')).toBeNull();
    expect(host.container.textContent ?? "").toContain("守护进程没有在共享套接字上应答");
  });

  test("robot rows show what each robot reports about itself", async () => {
    // The stamps are what the *robots* reported; the fixture gives one a fresh report and one a
    // three-hour-old one, because the row must say which is which (see the age assertions below).
    const now = Date.now();
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
          stamp_ms: now - 2_500,
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
          stamp_ms: now - 3 * 3_600_000,
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
    // Each report carries **its own age**: a fresh one and a three-hour-old one are not the same
    // claim about the world, and `armed` from three hours ago is not "armed now".
    const ages = host.container.querySelectorAll('[data-testid="link-robot-age"]');
    expect(ages.length).toBe(2);
    expect(ages[0]?.textContent ?? "").toContain("2s 前上报");
    expect(ages[1]?.textContent ?? "").toContain("3h 00m 前上报");
    // The refusal carries the robot's own words (how to recover), not a UI paraphrase.
    const refusal =
      host.container.querySelector('[data-testid="link-robot-refusal"]')?.textContent ?? "";
    expect(refusal).toContain("#14");
    expect(refusal).toContain("re-arm");
  });

  test("a report whose stamp is unusable says so instead of guessing an age", async () => {
    // Two ways a robot's report cannot be dated: no stamp at all (`0` is the proto's sentinel,
    // not 1970 — which would render as a 56-year-old report), and a stamp *from the future*
    // (two clocks that disagree). Neither may be shown as a number.
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
          watchdog_ms: null,
          last_refusal: null,
          stamp_ms: 0,
        },
        {
          robot: "dog2",
          seq: 13,
          gait: "trot",
          frames: 13,
          armed: true,
          estopped: false,
          estop_reason: null,
          watchdog_ms: null,
          last_refusal: null,
          stamp_ms: Date.now() + 60_000,
        },
      ],
    });
    const host = render(LinkPage);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="link-robots"]')).toBeTruthy(),
    );
    const ages = [...host.container.querySelectorAll('[data-testid="link-robot-age"]')];
    expect(ages.length).toBe(2);
    for (const age of ages) {
      expect(age.textContent ?? "").toContain("上报时间未知");
      // …and no invented figure sneaks in beside it.
      expect(age.textContent ?? "").not.toContain("前上报");
    }
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

  test("a daemon that does not answer the return path says so — never 'nobody reported'", async () => {
    // Version skew, the case `docs/amos-link.md` §6.5 promises the panel survives: an older
    // daemon has no `ListActuations`, so the bridge reports `actuations: null`. The panel must
    // show less, never throw — **and never render the absence of an answer as 「nobody
    // reported」**: "we were not told" is not a fact about the fleet.
    //
    // This test replaced one that pinned the opposite (it asserted `link-robots-none` for an
    // older daemon, i.e. it had the conflation built in).
    const older: Record<string, unknown> = { ...STATUS, actuations: null };
    bridgeReturning(older);
    const host = render(LinkPage);
    await vi.waitFor(() =>
      expect(host.container.querySelector('[data-testid="link-counters"]')).toBeTruthy(),
    );
    expect(
      host.container.querySelector('[data-testid="link-robots-unavailable"]'),
    ).toBeTruthy();
    expect(host.container.textContent ?? "").toContain("这个守护进程不上报回程");
    expect(host.container.querySelector('[data-testid="link-robots-none"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="link-robots"]')).toBeNull();
    // Everything the daemon *did* answer is still on screen.
    expect(host.container.textContent ?? "").toContain("published=12");

    // An **older bridge** (the field simply absent) is the same version skew in the other
    // direction: `undefined` must read as 「not answered」 too.
    const omitted: Record<string, unknown> = { ...STATUS };
    delete omitted.actuations;
    bridgeReturning(omitted);
    const second = render(LinkPage);
    await vi.waitFor(() =>
      expect(
        second.container.querySelector('[data-testid="link-robots-unavailable"]'),
      ).toBeTruthy(),
    );
    expect(second.container.querySelector('[data-testid="link-robots-none"]')).toBeNull();
  });
});

/**
 * robot-app.svelte.test.ts — DOM tests for the robot command console (`RobotApp.svelte`),
 * the System UI's **write** side of AmOS-Link.
 *
 * What is asserted is the **claim**, not the pixels:
 *   • an unreachable daemon reads as "not connected" and the console does not pretend a
 *     command could be sent;
 *   • **E-Stop is never gated** — with a target known, the button is enabled and a press
 *     invokes `link_publish` with the bare `{"action":"estop"}`;
 *   • a gait press carries the slider's speed;
 *   • **a receipt is shown as a receipt, not as proof** — the copy says the effect is read
 *     back on the return path, and a failed send is called out as not delivered;
 *   • **a heartbeat row is dated** — a peer that stopped beating keeps its row but reads as
 *     silent, because a bare counter cannot tell a live peer from one that died an hour ago.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import RobotApp from "../src/svelte/RobotApp.svelte";

beforeEach(() => {
  window.localStorage.clear();
  releaseListen = null;
});
afterEach(() => {
  cleanup();
  listeners.clear();
  releaseListen = null;
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const STATUS = {
  peer: "amos-daemon",
  kind: "brain",
  version: "0.1.0",
  uptime_ms: 125_000,
  clock_synced: false,
  health: "degraded",
  health_reasons: ["clock_unsynced"],
  metrics: {
    published: 12,
    delivered: 12,
    dropped: 0,
    blocked: 0,
    decode_errors: 0,
    encode_errors: 0,
  },
  peers: [
    { id: "patrol-01", kind: "robot", endpoint: null, last_seen_ms: 20, beacons: 4 },
  ],
  actuations: [
    {
      robot: "patrol-01",
      seq: 2,
      gait: "trot",
      frames: 13,
      armed: true,
      estopped: false,
      estop_reason: null,
      watchdog_ms: 300,
      last_refusal: null,
      stamp_ms: 0,
    },
  ],
};

const TOPICS = { topics: ["amos/patrol-01/control/action"], complete: true };

/** Host event handlers registered by the console, so a test can deliver a heartbeat. */
const listeners = new Map<string, Array<(e: { payload: unknown }) => void>>();

/** Resolver for a `listenHangs` subscription; `null` when the helper is not holding one. */
let releaseListen: (() => void) | null = null;

/** Deliver one event on `channel`, as the Rust `app.emit` would. */
function emit(channel: string, payload: unknown) {
  for (const h of listeners.get(channel) ?? []) h({ payload });
}

/** Install a fake bridge; returns the command log `[command, args]`. */
function bridgeReturning(
  opts: {
    publish?: unknown;
    status?: unknown;
    /** Handed the publish's own args, so a fleet test can make one *robot* unreachable. */
    publishReply?: (args: { robot?: string }) => Promise<unknown>;
    /** Override the `link_topics` reply — `null` means "the command failed", which must be
     *  requestable, so the presence of the key (not `??`) decides. */
    topics?: unknown;
    /** Refuse the host's event subscription (`listen` answers `null`) — the REQ-A838 path. */
    listenRefused?: boolean;
    /** Hold the event subscription open, as a host that has not answered `listen` yet. Release it
     *  with `releaseListen()` to watch the heartbeat channel's `pending` state resolve. */
    listenHangs?: boolean;
    /** Refuse `link_watch_heartbeats`. A function is consulted **per attempt**, so a test can
     *  refuse the first attempt and accept a later one (the retry path). */
    watchRefused?: boolean | (() => boolean);
  } = {},
) {
  const calls: Array<[string, unknown]> = [];
  const refusing = () =>
    typeof opts.watchRefused === "function" ? opts.watchRefused() : opts.watchRefused === true;
  listeners.clear();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "link_status") return opts.status ?? STATUS;
      if (cmd === "link_topics") return "topics" in opts ? opts.topics : TOPICS;
      if (cmd === "link_publish") {
        if (opts.publishReply) return opts.publishReply((args ?? {}) as { robot?: string });
        return opts.publish ?? { seq: 5, matched: 1, delivered: 1, dropped: 0 };
      }
      // A refused stream start is a *rejected* promise: `backend.invoke` folds it into `null`
      // and records it in the ledger, which is exactly what `startHeartbeats` reads back.
      if (cmd === "link_watch_heartbeats" && refusing()) throw new Error("daemon unreachable");
      return null;
    },
    listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
      if (opts.listenRefused) return null;
      if (opts.listenHangs) await new Promise<void>((r) => { releaseListen = r; });
      const list = listeners.get(channel) ?? [];
      list.push(handler);
      listeners.set(channel, list);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== handler));
    },
  };
  return calls;
}

describe("RobotApp (commands go out; a receipt is not proof)", () => {
  test("an unreachable daemon reads as not connected and nothing is invented", async () => {
    const host = render(RobotApp);
    await settle();
    const verdict = host.container.querySelector('[data-testid="robot-verdict"]')?.textContent ?? "";
    expect(verdict).toContain("守护进程未连接");
    expect(host.container.querySelector('[data-testid="robot-counters"]')).toBeNull();
    expect(host.container.textContent ?? "").toContain("守护进程没有在共享套接字上应答");
  });

  test("with the daemon gone, the picker does not claim there is no known robot", async () => {
    // The defect this pins: `targets` is derived from `status` (`robotTargets(status)`), so an
    // unanswered read makes it empty — and the picker rendered that emptiness as
    // 「当前没有已知机器人 —— 可以手动填一个 id，或等对端宣告」, the *same* sentence it shows when
    // the daemon answered and its registry is genuinely empty. Both halves of that advice assume a
    // live link: the peer will never announce itself to a console that is not reading the peer
    // table, and there may well be robots. Every sibling section on this page keeps the two facts
    // apart (`topicsUnavailable`, `heartbeatsUnavailable`, `returnPathKey("unavailable")`), and
    // the tip at the bottom of the same screen states the daemon is not answering — so this panel
    // contradicted its own page while being the only operator surface for a headless robot.
    const host = render(RobotApp);
    await settle();
    expect(host.container.querySelector('[data-testid="robot-target-none"]')).toBeNull();
    const gone = host.container.querySelector('[data-testid="robot-target-unavailable"]');
    expect(gone?.textContent ?? "").toContain("没有回答对端表");
  });

  test("E-Stop is enabled for a known robot and sends the bare estop action", async () => {
    const calls = bridgeReturning();
    const host = render(RobotApp);
    // The target auto-fills to the first known robot once the status arrives.
    await vi.waitFor(() => {
      const input = host.container.querySelector<HTMLInputElement>('[data-testid="robot-target"]');
      expect(input?.value).toBe("patrol-01");
    });
    const estop = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-estop"]');
    expect(estop).toBeTruthy();
    expect(estop!.disabled).toBe(false);
    await fireEvent.click(estop!);
    await vi.waitFor(() => {
      expect(calls.some(([c]) => c === "link_publish")).toBe(true);
    });
    const publish = calls.find(([c]) => c === "link_publish");
    expect(publish?.[1]).toEqual({ robot: "patrol-01", action: '{"action":"estop"}' });
  });

  test("E-Stop is never gated behind an in-flight command", async () => {
    // The defect this pins: `send()` set `sending = true` for the whole publish round-trip and
    // *both* command rows were `disabled={!target || sending}`, so a command already in flight —
    // exactly the situation an operator e-stops *from* — silently took the e-stop button away,
    // and the `if (!target || sending) return` early-out dropped the press. The header declares
    // the opposite ("E-Stop is never gated … no disabled state beyond a target being chosen"), so
    // the rule was stated and unenforced: an e-stop press during a slow/hung publish did nothing.
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    const calls = bridgeReturning({
      publishReply: async () => {
        await answered;
        return { seq: 1, matched: 1, delivered: 1, dropped: 0 };
      },
    });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      const input = host.container.querySelector<HTMLInputElement>('[data-testid="robot-target"]');
      expect(input?.value).toBe("patrol-01");
    });

    // A gait is in flight (its publish has not answered): the gait button is correctly held.
    const trot = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-trot"]');
    await fireEvent.click(trot!);
    await vi.waitFor(() => {
      expect(trot!.disabled).toBe(true);
    });

    // …and the e-stop is still pressable, and a press really sends the bare estop.
    const estop = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-estop"]');
    expect(estop!.disabled).toBe(false);
    await fireEvent.click(estop!);
    await vi.waitFor(() => {
      expect(calls.filter(([c]) => c === "link_publish").length).toBe(2);
    });
    const publishes = calls.filter(([c]) => c === "link_publish").map(([, a]) => a);
    expect(publishes[1]).toEqual({ robot: "patrol-01", action: '{"action":"estop"}' });
    release();
  });

  test("the fleet E-Stop includes a robot aimed at by hand, though the registry never heard of it", async () => {
    // The gap this pins: the console invites an operator to type an id the registry does not have
    // yet (`robot.targetNone` — 「可以手动填一个 id」) because a robot that has not announced itself
    // can still be commanded by name. A fleet stop scoped to the *registry* then skips the very
    // robot the operator was aiming at — while its button says 「全部」 — and it is *disabled*
    // outright when the registry is empty, even though the single e-stop beside it is pressable for
    // that same robot. 「全部」 has to mean 「every robot I can address」, or the count on the button
    // is not the count the press covers.
    const calls = bridgeReturning({
      status: {
        ...STATUS,
        peers: [{ id: "patrol-01", kind: "robot", endpoint: null, last_seen_ms: 20, beacons: 4 }],
        actuations: [{ ...STATUS.actuations[0], robot: "patrol-01" }],
      },
    });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      const input = host.container.querySelector<HTMLInputElement>('[data-testid="robot-target"]');
      expect(input?.value).toBe("patrol-01");
    });

    // Aim at a robot the registry has never heard of.
    const input = host.container.querySelector<HTMLInputElement>('[data-testid="robot-target"]');
    await fireEvent.input(input!, { target: { value: "rig-hand" } });
    await settle();

    const all = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-estop-all"]');
    expect(all!.disabled).toBe(false);
    // The count on the button must be the count the press covers.
    expect(all!.textContent ?? "").toContain("2");

    await fireEvent.click(all!);
    await vi.waitFor(() => {
      expect(calls.filter(([c]) => c === "link_publish").length).toBe(2);
    });
    const robots = calls
      .filter(([c]) => c === "link_publish")
      .map(([, a]) => (a as { robot: string }).robot);
    expect(robots.sort()).toEqual(["patrol-01", "rig-hand"]);
  });

  test("with only a hand-aimed robot, the fleet stop is pressable — the single e-stop already was", async () => {
    // The coherence half of the same axis: `robotTargets` is empty here, so the *single* e-stop is
    // enabled (`disabled={!target}`) while a registry-scoped fleet button is not. Two buttons for
    // the same robot, disagreeing about whether it can be stopped, on the screen an operator uses
    // to stop things.
    const calls = bridgeReturning({
      status: { ...STATUS, peers: [], actuations: [] },
    });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-target-none"]')).toBeTruthy();
    });
    const input = host.container.querySelector<HTMLInputElement>('[data-testid="robot-target"]');
    await fireEvent.input(input!, { target: { value: "rig-hand" } });
    await settle();

    const single = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-estop"]');
    const all = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-estop-all"]');
    expect(single!.disabled).toBe(false);
    expect(all!.disabled).toBe(false);
    await fireEvent.click(all!);
    await vi.waitFor(() => {
      expect(calls.filter(([c]) => c === "link_publish").length).toBe(1);
    });
    expect(calls.find(([c]) => c === "link_publish")?.[1]).toEqual({
      robot: "rig-hand",
      action: '{"action":"estop"}',
    });
  });

  test("a receipt belongs to the command it names, not to the publish that answered last", async () => {
    // The defect this pins: the e-stop may now be sent while a gait is still in flight (REQ-A834),
    // so two publishes overlap — yet `lastSent` was written at *press* time and `receipt` at
    // *answer* time. The gait's answer landing after the e-stop's therefore wrote the gait's
    // numbers (or its failure) beneath the 「E-Stop」 label: the operator, having just hit e-stop,
    // reads a transport result that belongs to a different command. The receipt must be the one
    // for the command the panel names.
    let releaseTrot!: () => void;
    const trotAnswered = new Promise<void>((r) => (releaseTrot = r));
    let publishes = 0;
    const calls = bridgeReturning({
      publishReply: async () => {
        publishes += 1;
        if (publishes === 1) {
          // The gait: in flight until released, and it will *fail* — the sharpest form, since a
          // misattributed failure reads as 「the e-stop did not go out」.
          await trotAnswered;
          return null;
        }
        return { seq: 222, matched: 1, delivered: 1, dropped: 0 };
      },
    });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      const input = host.container.querySelector<HTMLInputElement>('[data-testid="robot-target"]');
      expect(input?.value).toBe("patrol-01");
    });

    const trot = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-trot"]');
    await fireEvent.click(trot!);
    const estop = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-estop"]');
    await fireEvent.click(estop!);
    await vi.waitFor(() => {
      expect(calls.filter(([c]) => c === "link_publish").length).toBe(2);
    });
    // The e-stop's own receipt is on the panel, under the e-stop's label.
    await vi.waitFor(() => {
      const body = host.container.querySelector('[data-testid="robot-receipt"]')?.textContent ?? "";
      expect(body).toContain("seq=222");
    });
    expect(host.container.querySelector('[data-testid="robot-receipt-failed"]')).toBeNull();

    // The gait answers *last*, and fails. It must not overwrite the e-stop's receipt.
    releaseTrot();
    await settle();
    await settle();
    const label = host.container.querySelector('[data-testid="robot-receipt-action"]')?.textContent ?? "";
    expect(label).toContain("紧急停止");
    const body = host.container.querySelector('[data-testid="robot-receipt"]')?.textContent ?? "";
    expect(body).toContain("seq=222");
    expect(host.container.querySelector('[data-testid="robot-receipt-failed"]')).toBeNull();
  });

  test("a gait press carries the slider's speed, and the receipt is not shown as proof", async () => {
    const calls = bridgeReturning();
    const host = render(RobotApp);
    await vi.waitFor(() => {
      const input = host.container.querySelector<HTMLInputElement>('[data-testid="robot-target"]');
      expect(input?.value).toBe("patrol-01");
    });
    const slider = host.container.querySelector<HTMLInputElement>('[data-testid="robot-speed"]');
    expect(slider).toBeTruthy();
    await fireEvent.input(slider!, { target: { value: "0.8" } });
    const trot = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-trot"]');
    await fireEvent.click(trot!);
    await vi.waitFor(() => {
      expect(calls.some(([c]) => c === "link_publish")).toBe(true);
    });
    const publish = calls.find(([c]) => c === "link_publish");
    expect(publish?.[1]).toEqual({ robot: "patrol-01", action: '{"action":"trot","speed":0.8}' });
    // The receipt is labelled as a receipt, and the copy explicitly denies it is the effect.
    const text = host.container.textContent ?? "";
    expect(text).toContain("seq=5 matched=1 delivered=1 dropped=0");
    expect(text).toContain("不说明指令生效");
  });

  test("a frame the transport DROPPED is not reported as 「could not count」", async () => {
    // The defect this pins (REQ-A1541): `receiptLevel` read only `delivered`, so a receipt of
    // `{ matched: 1, delivered: 0, dropped: 1 }` fell into 「unknown」 and the note told the
    // operator the transport 「数不到订阅者」 — while the mono line directly above it printed
    // `delivered=0 dropped=1`. The transport *did* count: it counted a QoS drop, so it reached no
    // subscriber. Asserting 「could not count」 contradicts the receipt on the same panel.
    const calls = bridgeReturning({ publish: { seq: 9, matched: 1, delivered: 0, dropped: 1 } });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      const input = host.container.querySelector<HTMLInputElement>('[data-testid="robot-target"]');
      expect(input?.value).toBe("patrol-01");
    });
    await fireEvent.click(
      host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-estop"]')!,
    );
    await vi.waitFor(() => {
      expect(calls.some(([c]) => c === "link_publish")).toBe(true);
    });
    await vi.waitFor(() => {
      expect(
        host.container.querySelector('[data-testid="robot-receipt-note"]')?.textContent ?? "",
      ).toContain("QoS");
    });
    const note =
      host.container.querySelector('[data-testid="robot-receipt-note"]')?.textContent ?? "";
    // The unknown sentence's own distinctive tail — the dropped sentence may *name* 「数不到订阅者」
    // to contrast with it, but must not BE that sentence.
    expect(note).not.toContain("网络传输上永远是 0");
    // The count the sentence is *about* stays on the raw line — the two must agree.
    expect(
      host.container.querySelector('[data-testid="robot-receipt"]')?.textContent ?? "",
    ).toContain("delivered=0 dropped=1");
  });

  test("正控 · a receipt nobody could count still says 「could not count」 (dropped is 0 too)", async () => {
    // The other half: with `dropped: 0` there really is no counted outcome, so the honest note
    // must stay the 「could not count」 one — the fix must not turn every delivered=0 into 「dropped」.
    bridgeReturning({ publish: { seq: 9, matched: 0, delivered: 0, dropped: 0 } });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      const input = host.container.querySelector<HTMLInputElement>('[data-testid="robot-target"]');
      expect(input?.value).toBe("patrol-01");
    });
    await fireEvent.click(
      host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-estop"]')!,
    );
    await vi.waitFor(() => {
      expect(
        host.container.querySelector('[data-testid="robot-receipt-note"]')?.textContent ?? "",
      ).toContain("网络传输上永远是 0");
    });
    expect(
      host.container.querySelector('[data-testid="robot-receipt-note"]')?.textContent ?? "",
    ).not.toContain("QoS");
  });

  test("a heartbeat row is dated, so a peer that stopped beating reads as silent", async () => {
    // The defect this pins: the console listed a peer on its first beat and never dated it, so a
    // robot that powered off mid-session kept a row that looked exactly like a live one (the same
    // shape the return path fixed for `armed`/`estopped`). With the age on the row, "still alive"
    // is a statement the operator can make from the data rather than assume from a number.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    bridgeReturning();
    const host = render(RobotApp);
    await tick();
    await vi.advanceTimersByTimeAsync(0); // the first read + the stream subscription
    await tick();

    emit("link-heartbeat", { peer: "patrol-01", seq: 3, uptime_ms: 1_000, stamp_ms: 0 });
    await tick();
    const rows = host.container.querySelector('[data-testid="robot-heartbeats"]')?.textContent ?? "";
    expect(rows).toContain("patrol-01");
    expect(rows).toContain("#3");
    expect(rows).toContain("刚刚收到心跳");

    // No further beats: the peer stays listed (absent ≠ silent) but the age grows with the 2 s
    // re-read, so the frozen counter is visibly a *stale* one — one re-read later it is 2 s old.
    await vi.advanceTimersByTimeAsync(2_000);
    const later = host.container.querySelector('[data-testid="robot-heartbeats"]')?.textContent ?? "";
    expect(later).toContain("#3");
    expect(later).toContain("最后收到心跳：2s 前");
    expect(later).not.toContain("刚刚收到心跳");
  });

  test("a beat row says what its peer is — the daemon's own beat is not a robot", async () => {
    // The defect this pins: every other list on this screen says *what* a peer is — the peer table
    // prints `id · kind`, and the target picker filters to `kind === "robot"` — but the heartbeat
    // panel printed a bare id. The one row that is ALWAYS there is the daemon's own beat: the
    // mounted node runs `with_heartbeat` and the stream watches `amos/*/telemetry/beat`, so the
    // daemon's beat comes back to the console — while `LinkNode::observe` refuses a node as its own
    // peer, leaving it in `status.peers` never (and out of `robotTargets`, since its kind is not
    // `robot`). So an operator's first liveness row in a *robot* console read as a live robot, and
    // no other list on the screen could say otherwise.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    bridgeReturning();
    const host = render(RobotApp);
    await tick();
    await vi.advanceTimersByTimeAsync(0); // the first read + the stream subscription
    await tick();

    emit("link-heartbeat", { peer: "amos-daemon", seq: 9, uptime_ms: 1_000, stamp_ms: 0 });
    emit("link-heartbeat", { peer: "patrol-01", seq: 3, uptime_ms: 1_000, stamp_ms: 0 });
    // A peer the table cannot place: no role may be invented for it.
    emit("link-heartbeat", { peer: "ghost-9", seq: 1, uptime_ms: 1_000, stamp_ms: 0 });
    await tick();

    const row = (origin: string) =>
      host.container.querySelector(`[data-testid="robot-heartbeats"] li[data-origin="${origin}"]`)
        ?.textContent ?? "";
    expect(row("self")).toContain("amos-daemon");
    expect(row("self")).toContain("本节点自身");
    expect(row("self")).not.toContain("robot");
    expect(row("peer")).toContain("patrol-01");
    expect(row("peer")).toContain("robot");
    expect(row("unknown")).toContain("ghost-9");
    expect(row("unknown")).toContain("未知对端");
    expect(row("unknown")).not.toContain("robot");
  });

  test("a stream the host refused is not rendered as a quiet bus", async () => {
    // The defect this pins: `watchHeartbeats` answers `null` when the host will not start the
    // stream (`link_watch_heartbeats` refused, or the event subscription rejected — REQ-A838), and
    // the console **discarded** that `null` and fell through to the same 「no beats yet」 sentence it
    // uses for a running-but-quiet bus. So the panel that exists to answer 「is the bus alive」
    // answered 「nothing is beating」 when the truth was 「this console is not listening at all」.
    // The topic inventory one section below already keeps those two apart (`topics-unavailable`
    // vs `topics-none`); this is the sibling that never got the third state.
    bridgeReturning({ watchRefused: true });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-heartbeats-unavailable"]')).toBeTruthy();
    });
    expect(host.container.textContent ?? "").toContain("心跳流没有启动");
    // 「we are not listening」 must never borrow the sentence that claims we listened and heard
    // nothing — the whole doctrine of this panel.
    expect(host.container.querySelector('[data-testid="robot-heartbeats-none"]')).toBeNull();
  });

  test("a stream still being set up is not rendered as a bus that is merely quiet", async () => {
    // `beatStream` has **three** states and its own declaration says why: two of them are
    // indistinguishable on a bare 「no beats」 row. `pending` is the subscription not having
    // resolved; the renderer kept `refused` apart with its own sentence but painted the *quiet*
    // sentence for everything that was not refused — so `pending`, the state in which this console
    // has not yet established whether it is listening at all, borrowed the sentence that means
    // 「we are listening and heard nothing」. The comment above that sentence says it is for 「a stream
    // is running and nothing has come over it」; the condition admitted two states. On a host that
    // answers `link_status` but is slow — or hung — on the subscription, that reads as a quiet bus
    // for as long as the hang lasts, which is the false-liveness the three states exist to refuse.
    bridgeReturning({ listenHangs: true });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-peers"]')).toBeTruthy();
    });
    // The status read has landed; the heartbeat channel has not resolved.
    expect(host.container.querySelector('[data-testid="robot-heartbeats-none"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="robot-heartbeats-unavailable"]')).toBeNull();
    expect(
      host.container.querySelector('[data-testid="robot-heartbeats-pending"]')?.textContent ?? "",
    ).toContain("正在建立心跳流");
    // …and once the subscription resolves, a genuinely quiet bus *does* get the quiet sentence —
    // the fix must not silence the panel into never answering.
    releaseListen?.();
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-heartbeats-none"]')).toBeTruthy();
    });
    expect(host.container.querySelector('[data-testid="robot-heartbeats-pending"]')).toBeNull();
  });

  test("a refused heartbeat stream is retried, so a link that comes back is readable", async () => {
    // The host gives this reader's claim **back** on the failure path (`link_watch_heartbeats`:
    // "so the next window tries again instead of attaching to a stream that does not exist"), so a
    // retry is sanctioned by the bridge's own contract. Without one, a daemon that was down when
    // the console opened stayed unreadable for the life of the window — the console polls
    // `link_status` every 2 s and would show the daemon as back while the liveness panel remained
    // permanently refused.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    let refuse = true;
    bridgeReturning({ watchRefused: () => refuse });
    const host = render(RobotApp);
    await tick();
    await vi.advanceTimersByTimeAsync(0); // the first read + the first (refused) attempt
    await tick();
    expect(host.container.querySelector('[data-testid="robot-heartbeats-unavailable"]')).toBeTruthy();

    // The daemon comes back; only a *later* poll may notice, and no second stream may be minted.
    refuse = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await tick();
    emit("link-heartbeat", { peer: "patrol-01", seq: 4, uptime_ms: 1_000, stamp_ms: 0 });
    await tick();
    const rows = host.container.querySelector('[data-testid="robot-heartbeats"]')?.textContent ?? "";
    expect(rows).toContain("patrol-01");
    expect(rows).toContain("#4");
    expect(host.container.querySelector('[data-testid="robot-heartbeats-unavailable"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="robot-heartbeats-none"]')).toBeNull();
  });

  test("a stream that ended is re-asked, so a daemon that comes back is readable again", async () => {
    // The defect this pins: the console asked for the stream **once**, at mount, and returned early
    // while it believed a stream was live. But the stream is not this window's to keep — the host
    // ends it when the daemon goes away and clears only its own `running` flag, keeping every open
    // window counted so the *next ask* starts a fresh one. Nothing tells this window its stream
    // died (there is no event for it), so after a daemon restart the panel kept a dead stream for
    // the rest of the window's life: rows ageing without bound, and — before a first beat —
    // 「还没有收到心跳。」 claiming a quiet bus while the 2 s status poll showed the daemon back.
    //
    // Asking again is the whole mechanism, and it is free on the host's side (the reader accounting
    // is keyed by window: an ask against a live stream shares it), so it belongs on the poll.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const calls = bridgeReturning();
    const host = render(RobotApp);
    await tick();
    await vi.advanceTimersByTimeAsync(0); // the first read + the listener + the first ask
    await tick();
    const asks = () => calls.filter(([c]) => c === "link_watch_heartbeats").length;
    expect(asks()).toBe(1);
    const rows = () => host.container.querySelector('[data-testid="robot-heartbeats"]')?.textContent ?? "";
    emit("link-heartbeat", { peer: "patrol-01", seq: 4, uptime_ms: 1_000, stamp_ms: 0 });
    await tick();
    expect(rows()).toContain("#4");

    // The daemon goes away and comes back between two polls. The host silently ended the stream;
    // this window cannot tell, so the only thing that restores it is asking again.
    await vi.advanceTimersByTimeAsync(2_000);
    await tick();
    expect(asks()).toBe(2);
    // …and the re-ask is about the *stream*: the event channel is not registered a second time
    // (a second listener would receive every beat twice, and its cleanup would fight the first).
    expect(listeners.get("link-heartbeat")?.length).toBe(1);
    // The restarted stream feeds the same row: the panel is reading again, not frozen at #4.
    emit("link-heartbeat", { peer: "patrol-01", seq: 9, uptime_ms: 2_000, stamp_ms: 0 });
    await tick();
    expect(rows()).toContain("#9");
  });

  test("a refusal is announced even when rows from an earlier stream are still on screen", async () => {
    // The defect this pins: the heartbeat panel branched `{#if rows} … {:else if refused} …`, so a
    // refusal was only ever rendered on an **empty** panel. Once a beat had been heard, a stream
    // that then died (and would not restart) rendered as bare rows — whose ages keep growing while
    // nothing refreshes them — and an age cannot say 「the robot went silent」 from 「we stopped
    // listening」. That is the one question this panel exists to answer, so the notice is said
    // *before* the rows and not instead of them: both facts are true and both belong on screen.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    let refuse = false;
    bridgeReturning({ watchRefused: () => refuse });
    const host = render(RobotApp);
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    emit("link-heartbeat", { peer: "patrol-01", seq: 4, uptime_ms: 1_000, stamp_ms: 0 });
    await tick();
    expect(host.container.querySelector('[data-testid="robot-heartbeats"]')?.textContent ?? "").toContain("#4");

    // The daemon goes away *and* the host will not start a fresh stream.
    refuse = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await tick();
    expect(host.container.querySelector('[data-testid="robot-heartbeats-unavailable"]')).toBeTruthy();
    // The row stays — it is still a true statement about when patrol-01 was last heard — but it no
    // longer stands alone, and the sentence that claims we listened and heard nothing is not shown.
    expect(host.container.querySelector('[data-testid="robot-heartbeats"]')?.textContent ?? "").toContain("#4");
    expect(host.container.querySelector('[data-testid="robot-heartbeats-none"]')).toBeNull();
  });

  test("a peer row dates the evidence, and a hand-declared peer says it was never heard", async () => {
    // The defect this pins: the console rendered `id (kind)` for the whole peer table — the very
    // table the target picker is built from — while the bridge carried `endpoint`/`last_seen_ms`/
    // `beacons` per peer (`link.rs::peer_out`). So an operator choosing what to command could not
    // tell a live robot from one declared in a static list (`beacons: 0`, never TTL-expired) or one
    // whose last evidence was hours old. The bridge's work reaching the wire and dying at the
    // render point is the whole defect; feeding *only* a live peer would not pin the branch.
    bridgeReturning({
      status: {
        ...STATUS,
        peers: [
          { id: "patrol-01", kind: "robot", endpoint: "tcp/10.0.0.4:7447", last_seen_ms: 1_000, beacons: 4 },
          { id: "rig-hand", kind: "robot", endpoint: null, last_seen_ms: 0, beacons: 0 },
        ],
      },
    });
    const host = render(RobotApp);
    await settle();
    const rows = host.container.querySelector('[data-testid="robot-peers"]')?.textContent ?? "";
    // A heard peer: its endpoint and the age of its last evidence, not a bare id.
    expect(rows).toContain("patrol-01");
    expect(rows).toContain("tcp/10.0.0.4:7447");
    expect(rows).toContain("1s");
    // A peer with no beacon at all: the one count that means "configured, not heard".
    expect(rows).toContain("rig-hand");
    expect(rows).toContain("手工声明 · 从未广播");
    expect(rows).not.toContain("0ms");
  });

  test("the fleet E-Stop goes to every known robot, and names the ones it could not reach", async () => {
    // The gap this pins: the console had exactly **one** command path — `robotCommand(target, …)` —
    // so an operator facing a fleet stopped it one robot at a time, and nothing on screen said how
    // many robots there were or which one a press had left out. A stop is the command that must not
    // depend on picking the right target first: the fleet is what an operator reaches for exactly
    // when the screen is confusing.
    const calls = bridgeReturning({
      status: {
        ...STATUS,
        peers: [
          { id: "patrol-01", kind: "robot", endpoint: null, last_seen_ms: 20, beacons: 4 },
          { id: "patrol-02", kind: "robot", endpoint: null, last_seen_ms: 20, beacons: 4 },
        ],
        // Known only by its report, so the fleet must merge the two sources.
        actuations: [{ ...STATUS.actuations[0], robot: "patrol-03" }],
      },
      // patrol-02 is unreachable — `invoke` folds the bridge's `Err` into a `null` reply.
      publishReply: async (args) =>
        args.robot === "patrol-02" ? null : { seq: 9, matched: 1, delivered: 1, dropped: 0 },
    });
    const host = render(RobotApp);
    // The label carries the size of the fleet, so a press states what it covers.
    await vi.waitFor(() => {
      const label = host.container.querySelector('[data-testid="robot-cmd-estop-all"]')?.textContent ?? "";
      expect(label).toContain("3");
    });

    const all = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-estop-all"]');
    expect(all!.disabled).toBe(false);
    await fireEvent.click(all!);

    await vi.waitFor(() => {
      expect(calls.filter(([c]) => c === "link_publish").length).toBe(3);
    });
    const publishes = calls.filter(([c]) => c === "link_publish").map(([, a]) => a as { robot: string });
    // Every known robot — both peers and the one only its report names — not just `target`.
    expect(publishes.map((p) => p.robot).sort()).toEqual(["patrol-01", "patrol-02", "patrol-03"]);
    // …and each carries the bare estop: a speed on a safety action would imply it matters.
    for (const p of publishes) expect(p).toEqual({ robot: p.robot, action: '{"action":"estop"}' });

    // The receipt names both halves, because the operator's next move is per robot: the un-reached
    // one is the only actionable half, and a summary that listed only successes would hide it.
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-fleet-receipt"]')).toBeTruthy();
    });
    const summary = host.container.querySelector('[data-testid="robot-fleet-receipt"]')?.textContent ?? "";
    expect(summary).toContain("sent=2 not-sent=1");
    const sent = host.container.querySelector('[data-testid="robot-fleet-sent"]')?.textContent ?? "";
    expect(sent).toContain("patrol-01");
    expect(sent).toContain("patrol-03");
    expect(sent).not.toContain("patrol-02");
    const failed = host.container.querySelector('[data-testid="robot-fleet-failed"]')?.textContent ?? "";
    expect(failed).toContain("patrol-02");
    // The same caveat the single receipt carries: reaching a robot is not stopping it.
    expect(host.container.textContent ?? "").toContain("不说明指令生效");
  });

  test("the fleet E-Stop is never gated behind an in-flight command either", async () => {
    // The single e-stop's rule (REQ-A834) binds the fleet one for the same reason, and harder: the
    // command in flight during a fleet emergency may be the very one that needs stopping, and a
    // fleet button that went grey while a gait was publishing would be the worst possible moment
    // to take it away.
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    const calls = bridgeReturning({
      publishReply: async () => {
        await answered;
        return { seq: 1, matched: 1, delivered: 1, dropped: 0 };
      },
    });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      const input = host.container.querySelector<HTMLInputElement>('[data-testid="robot-target"]');
      expect(input?.value).toBe("patrol-01");
    });

    // A gait is in flight — its publish has not answered.
    const trot = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-trot"]');
    await fireEvent.click(trot!);
    await vi.waitFor(() => {
      expect(trot!.disabled).toBe(true);
    });

    // …and the fleet stop is still pressable, and a press really goes out.
    const all = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-estop-all"]');
    expect(all!.disabled).toBe(false);
    await fireEvent.click(all!);
    await vi.waitFor(() => {
      expect(calls.filter(([c]) => c === "link_publish").length).toBe(2);
    });
    release();
  });

  test("with no known robot there is nothing to stop, and the button says so", async () => {
    // The other direction of `sendFleet`'s only precondition. Rendering this enabled would hand the
    // operator a stop that reports `sent=0 not-sent=0` — a press that changes nothing and reads
    // like a press that did nothing. This is a fact about the fleet (there is none), not a
    // validation of the command: the press is never gated on *which* robot, only on *any*.
    const host = render(RobotApp); // no bridge: no status, so no targets
    await settle();
    const all = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-estop-all"]');
    expect(all).toBeTruthy();
    expect(all!.disabled).toBe(true);
    expect(all!.textContent ?? "").toContain("0");
    // And no receipt is invented for a stop nobody sent.
    expect(host.container.querySelector('[data-testid="robot-fleet-receipt"]')).toBeNull();
  });

  test("a latching e-stop names *why* torque was cut, and the deadman period it ran under", async () => {
    // `estopped: true` alone cannot answer the operator's first question — *who* cut torque. The
    // bridge already folds the robot's own reason token (`EstopReason::key()`) and the watchdog
    // period into `link_status.actuations`; without these rows the console dropped both on the
    // floor, so a watchdog cut and a commanded one read identically (the CLI prints the same
    // fact as `estopped=true(watchdog) watchdog=1000ms`).
    bridgeReturning({
      status: {
        ...STATUS,
        actuations: [
          { ...STATUS.actuations[0], estopped: true, estop_reason: "watchdog", watchdog_ms: 1_000 },
        ],
      },
    });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-estop-reason"]')).toBeTruthy();
    });
    const reason = host.container.querySelector('[data-testid="robot-estop-reason"]')?.textContent ?? "";
    expect(reason).toContain("急停原因");
    expect(reason).toContain("看门狗");
    const watchdog = host.container.querySelector('[data-testid="robot-watchdog"]')?.textContent ?? "";
    expect(watchdog).toContain("1000ms");
  });

  test("a bus fault is labelled as its own cause, not folded into the watchdog's", async () => {
    // The bridge latches `EstopReason::BusFault` when the bus refuses a batch mid-write
    // (`robot_hal.rs`). A panel that did not know the token would render no reason row at all,
    // so a bus that just refused a batch would read exactly like a commanded stop — the reason
    // the row exists. The label must name the bus, and must not borrow the watchdog's copy.
    bridgeReturning({
      status: {
        ...STATUS,
        actuations: [{ ...STATUS.actuations[0], estopped: true, estop_reason: "bus-fault" }],
      },
    });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-estop-reason"]')).toBeTruthy();
    });
    const reason = host.container.querySelector('[data-testid="robot-estop-reason"]')?.textContent ?? "";
    expect(reason).toContain("总线故障");
    expect(reason).not.toContain("看门狗");
  });

  test("a robot with no e-stop reason gets no reason row — a blank is not a guessed cause", async () => {
    bridgeReturning(); // the default fixture: estopped false, estop_reason null, watchdog 300 ms
    const host = render(RobotApp);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-robots"]')).toBeTruthy();
    });
    expect(host.container.querySelector('[data-testid="robot-estop-reason"]')).toBeNull();
    // The watchdog period is a config, not a consequence of the cut, so it stands on its own.
    expect(host.container.querySelector('[data-testid="robot-watchdog"]')?.textContent ?? "").toContain("300ms");
  });

  test("the row says how many frames the last action put on the bus", async () => {
    // `frames` is the count the HAL **measured** (`RobotHal::apply`/`estop` return how many the
    // bus accepted — `docs/amos-link.md` §3), carried over the proto (`robot_link.proto`,
    // "frames written to the bus for that action"), mapped by the bridge and printed by the CLI
    // (`render_actuation`: `… gait={} frames={} …`). It is the one fact that separates
    // 「commanded」 from 「wrote nothing to the bus」 — and for a profile machine, which reports
    // `gait` **empty** by design (`docs/robot-domains.md` §6.4 lists frames among the safety
    // facts it still reports), it is the *only* such fact: `robot · - · #seq` plus an age says
    // nothing about whether the action reached the bus. Two robots, two counts, so the row is
    // shown to carry *its own* number and not a shared constant.
    bridgeReturning({
      status: {
        ...STATUS,
        actuations: [
          { ...STATUS.actuations[0], robot: "patrol-01", seq: 2, frames: 13 },
          { ...STATUS.actuations[0], robot: "hexapod-3", seq: 7, gait: null, frames: 0 },
        ],
      },
    });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      expect(host.container.querySelectorAll('[data-testid="robot-frames"]').length).toBe(2);
    });
    const rows = [...host.container.querySelectorAll('[data-testid="robot-frames"]')].map(
      (n) => n.textContent ?? "",
    );
    expect(rows[0]).toContain("13");
    // A gait-less profile machine that reported an action which wrote nothing is stated as 0 —
    // not omitted (which would read the same as a report that never carried the field).
    expect(rows[1]).toContain("0");
    expect(rows[1]).toContain("写入总线的帧数");
  });

  test("a failed send is called out as not delivered", async () => {
    // No bridge ⇒ robotCommand() is null ⇒ the console must say the command did not go out.
    const host = render(RobotApp);
    await settle();
    // With no bridge there is no status, so no target and the button is disabled: the failure
    // is surfaced by the offline state, not by a fake receipt.
    const estop = host.container.querySelector<HTMLButtonElement>('[data-testid="robot-cmd-estop"]');
    expect(estop?.disabled).toBe(true);
    expect(host.container.querySelector('[data-testid="robot-receipt"]')).toBeNull();
  });

  test("the console states *why* the verdict is what it is, not just the verdict", async () => {
    // The defect this pins: the first section rendered the verdict word (`healthKey`) and dropped
    // `status.health_reasons` — the very tokens the bridge carries "so the UI never shows a bare
    // OK" and the Settings panel renders (`link.reasonsHeading`). This is the surface an operator
    // *commands* from, so a bare 「链路降级」 left the reason for it one app away: a lost peer and
    // an uncalibrated clock call for different responses.
    bridgeReturning(); // the default fixture is degraded with health_reasons: ["clock_unsynced"]
    const host = render(RobotApp);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-reasons"]')).toBeTruthy();
    });
    const reasons = host.container.querySelector('[data-testid="robot-reasons"]')?.textContent ?? "";
    expect(reasons).toContain("clock_unsynced");
    // The heading is the Settings panel's own copy — one surface, one spelling.
    expect(host.container.textContent ?? "").toContain("判定原因");
  });

  test("a link with no reason tokens renders no reasons section — absence is not a reason", async () => {
    // The other half of the same axis: a healthy link (or a build with no reasons) must not show
    // an empty "why" box. Without this, `{#if}` on the wrong field would paint a blank section
    // that reads like a missing diagnosis.
    bridgeReturning({ status: { ...STATUS, health: "healthy", health_reasons: [] } });
    const host = render(RobotApp);
    // `robot-read-at` only renders once a status answer has arrived, so this waits on the real
    // precondition (a status is on screen) rather than on a node that is drawn before it.
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-read-at"]')).toBeTruthy();
    });
    expect(host.container.querySelector('[data-testid="robot-reasons"]')).toBeNull();
  });

  test("a complete inventory lists its topics and calls itself complete", async () => {
    bridgeReturning({ topics: { topics: ["amos/patrol-01/control/action"], complete: true } });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-topics-complete"]')).toBeTruthy();
    });
    const inventory = host.container.querySelector('[data-testid="robot-topics"]')?.textContent ?? "";
    expect(inventory).toContain("amos/patrol-01/control/action");
    expect(host.container.textContent ?? "").toContain("完整清单");
    // A non-empty list is never the "empty" arm, and the command was answered.
    expect(host.container.querySelector('[data-testid="robot-topics-none"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="robot-topics-unavailable"]')).toBeNull();
  });

  test("an empty inventory claims emptiness only when the transport says it is complete", async () => {
    // An empty list is evidence of an empty bus **only** when `TopicList.complete` is true: the
    // transport promises the list is the whole truth (`Transport::topics_complete`). This is the
    // half that lets the sentence be read as a fact at all.
    bridgeReturning({ topics: { topics: [], complete: true } });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-topics-none"]')).toBeTruthy();
    });
    expect(host.container.textContent ?? "").toContain("本总线还没有见到任何发布");
    // The complete caveat, and no "cannot enumerate" line.
    expect(host.container.textContent ?? "").toContain("完整清单");
  });

  test("an *incomplete* empty inventory never claims the bus has no traffic", async () => {
    // The defect this pins: the empty arm rendered 「no topic has carried traffic」 for **any**
    // empty list — including the one `zenoh::ZenohTransport::topics`/`topics_complete` documents
    // for a network transport (empty + `complete: false`, i.e. "I cannot enumerate what other
    // nodes publish"). The console then asserted an idle bus **directly beneath** the caveat line
    // that says it cannot tell — the operator reads a fact the instrument does not have, which is
    // the same 「absence read as evidence of absence」 the return path (`returnPathLevel`) exists
    // to refuse.
    bridgeReturning({ topics: { topics: [], complete: false } });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-topics-complete"]')).toBeTruthy();
    });
    const text = host.container.textContent ?? "";
    expect(text).toContain("不完整");
    // The caveat stands alone: no emptiness claim, and no list.
    expect(host.container.querySelector('[data-testid="robot-topics-none"]')).toBeNull();
    expect(text).not.toContain("本总线还没有见到任何发布");
    expect(host.container.querySelector('[data-testid="robot-topics"]')).toBeNull();
  });

  test("a read that was never answered is not rendered as an empty inventory", async () => {
    // The third state, and the reason the testids have to stay distinct: `null` is 「the daemon
    // did not answer」, which must never borrow the empty-inventory sentence (「we were not told」
    // and 「nobody spoke」 are different facts — the panel's whole doctrine).
    bridgeReturning({ topics: null });
    const host = render(RobotApp);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[data-testid="robot-topics-unavailable"]')).toBeTruthy();
    });
    expect(host.container.textContent ?? "").toContain("守护进程没有回答话题清单");
    expect(host.container.querySelector('[data-testid="robot-topics-none"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="robot-topics-complete"]')).toBeNull();
  });

  test("the operator can clear the target field — a poll does not fill it back", async () => {
    // The defect this pins: the target picker auto-fills from a `$effect` whose own comment names
    // the condition it must obey — *「When the fleet first becomes known and no target has been
    // chosen」* — but the code carried no 「first」: `targets` is a `$derived` over `status`, so it
    // is a **new array every 2 s poll**, and the effect re-ran on each one. The guard was only
    // `if (!target …)`, so the moment the operator emptied the field the next poll wrote the
    // default straight back.
    //
    // That matters on a console where 「no target」 is a state the UI encodes (`disabled={!target}`,
    // and `robot.targetNone` tells the operator 「可以手动填一个 id」 so a robot that has not
    // announced itself can still be commanded by name — the `fleetTargets` doc builds a whole
    // affordance on that sentence). With the field un-clearable the operator cannot reach that
    // state at all: every backspace is undone within one poll, and the single E-Stop stays aimed at
    // whichever robot sorts first.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    bridgeReturning();
    const host = render(RobotApp);
    await tick();
    await vi.advanceTimersByTimeAsync(0); // the first read lands and the picker fills
    await tick();
    const input = host.container.querySelector<HTMLInputElement>('[data-testid="robot-target"]');
    expect(input?.value).toBe("patrol-01");

    // The operator clears the field, aiming to type a robot the registry has not heard of yet.
    await fireEvent.input(input!, { target: { value: "" } });
    await tick();
    // Not even the next poll may fill it back.
    await vi.advanceTimersByTimeAsync(2_000);
    await tick();
    expect(input!.value).toBe("");
  });

  test("a target the operator typed is not overwritten by a later poll", async () => {
    // The other half of the same effect's contract, and the reason the fix is a 「fills once」 latch
    // rather than 「never fill」: the auto-fill still has to happen (the button row is otherwise dead
    // on first open), and a value the operator put there must survive every poll that follows.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    bridgeReturning();
    const host = render(RobotApp);
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    const input = host.container.querySelector<HTMLInputElement>('[data-testid="robot-target"]');
    await fireEvent.input(input!, { target: { value: "rig-hand" } });
    await tick();
    await vi.advanceTimersByTimeAsync(2_000);
    await tick();
    expect(input!.value).toBe("rig-hand");
  });
});

/**
 * sandboxCapabilityHost.test.ts — the live half of the sandbox capability seam (REQ-A721).
 *
 * The pure decision (`sandboxBridge`, pinned by `sandbox-bridge.test.ts`) was never the
 * defect: the defect is that **nothing called it**, so a bundle's frame was denied by
 * absence rather than by policy. These cases pin the three rules that make the listener a
 * real gate — and the two failure shapes that must stay *silent*:
 *
 *   • a message from a window that is not our frame is dropped with no reply;
 *   • our frame's malformed frame is dropped with no reply (reason kept for the log);
 *   • a grant happens **only** on the daemon's literal `true` (offline is a denial);
 *   • the answer goes back to the *same* window that asked, even if it changed mid-flight.
 */
import { describe, expect, test } from "bun:test";
import type { Capability } from "../lib/permissions";
import {
  installSandboxCapabilityHost,
  type SandboxFrameWindow,
  type SandboxHostSeam,
} from "../lib/sandboxCapabilityHost";

/** A window object that records what was posted into it. */
function fakeWindow(): SandboxFrameWindow & { posted: unknown[] } {
  const posted: unknown[] = [];
  return { posted, postMessage: (msg: unknown) => posted.push(msg) };
}

/** A `message` event carrying a `source`, built without a DOM. */
function message(source: unknown, data: unknown): MessageEvent {
  return { source, data } as MessageEvent;
}

interface Harness {
  seam: SandboxHostSeam;
  /** Fire a `message` at the installed handler(s), exactly as `window` would. */
  dispatch(event: MessageEvent): void;
  authorizeCalls: Array<{ appId: string; capability: Capability }>;
  /** Swap the frame the seam returns (a navigation / unmount). */
  setFrame(frame: SandboxFrameWindow | null): void;
  /** How many times the seam's unsubscribe has run. */
  unsubscribes(): number;
}

function harness(
  initialFrame: SandboxFrameWindow | null,
  granted: () => boolean | null,
): Harness {
  const handlers: Array<(e: MessageEvent) => void> = [];
  const authorizeCalls: Array<{ appId: string; capability: Capability }> = [];
  let frame = initialFrame;
  let unsubs = 0;
  const seam: SandboxHostSeam = {
    onMessage: (handler) => {
      handlers.push(handler);
      return () => {
        unsubs += 1;
      };
    },
    frameWindow: () => frame,
    authorize: async (appId, capability) => {
      authorizeCalls.push({ appId, capability });
      return granted();
    },
  };
  return {
    seam,
    dispatch: (event) => handlers.forEach((h) => h(event)),
    authorizeCalls,
    setFrame: (f) => {
      frame = f;
    },
    unsubscribes: () => unsubs,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const request = (resource = "camera", requestId = "r1") => ({
  type: "capability.request",
  resource,
  requestId,
});

describe("a message from a window we do not own is dropped, silently", () => {
  test("a foreign source is never answered and never reaches the daemon", async () => {
    const ours = fakeWindow();
    const h = harness(ours, () => true);
    const refused: unknown[] = [];
    installSandboxCapabilityHost(h.seam, { appId: "org.amos.demo", onRefused: (r) => refused.push(r) });

    h.dispatch(message(fakeWindow(), request()));
    await flush();

    expect(h.authorizeCalls.length).toBe(0);
    expect(ours.posted.length).toBe(0);
    // Not our frame ⇒ not even the "refused" breadcrumb: the log is about *our* traffic.
    expect(refused.length).toBe(0);
  });

  test("with no frame mounted the listener answers nothing", async () => {
    const h = harness(null, () => true);
    installSandboxCapabilityHost(h.seam, { appId: "org.amos.demo" });

    h.dispatch(message(fakeWindow(), request()));
    await flush();

    expect(h.authorizeCalls.length).toBe(0);
  });
});

describe("our frame's malformed traffic is refused with no reply", () => {
  test("an unknown resource is dropped and named in the log, not answered", async () => {
    const ours = fakeWindow();
    const h = harness(ours, () => true);
    const refused: string[] = [];
    installSandboxCapabilityHost(h.seam, {
      appId: "org.amos.demo",
      onRefused: (reason) => refused.push(reason),
    });

    h.dispatch(message(ours, request("barometer")));
    await flush();

    expect(h.authorizeCalls.length).toBe(0);
    expect(ours.posted.length).toBe(0);
    expect(refused).toEqual(["unknown-resource"]);
  });

  test("a non-object frame is dropped without a reply", async () => {
    const ours = fakeWindow();
    const h = harness(ours, () => true);
    installSandboxCapabilityHost(h.seam, { appId: "org.amos.demo" });

    h.dispatch(message(ours, "not-even-an-object"));
    await flush();

    expect(h.authorizeCalls.length).toBe(0);
    expect(ours.posted.length).toBe(0);
  });
});

describe("the daemon is the sole authority", () => {
  test("a literal true grants, echoing the asker's requestId", async () => {
    const ours = fakeWindow();
    const h = harness(ours, () => true);
    installSandboxCapabilityHost(h.seam, { appId: "org.amos.demo" });

    h.dispatch(message(ours, request("microphone", "abc-123")));
    await flush();

    expect(h.authorizeCalls).toEqual([{ appId: "org.amos.demo", capability: "microphone" }]);
    expect(ours.posted).toEqual([
      { type: "capability.reply", requestId: "abc-123", resource: "microphone", granted: true },
    ]);
  });

  test("offline (null) is a denial, never a default-grant", async () => {
    const ours = fakeWindow();
    const h = harness(ours, () => null);
    installSandboxCapabilityHost(h.seam, { appId: "org.amos.demo" });

    h.dispatch(message(ours, request()));
    await flush();

    expect((ours.posted[0] as { granted: boolean }).granted).toBe(false);
  });

  test("an explicit daemon denial is reported as denied", async () => {
    const ours = fakeWindow();
    const h = harness(ours, () => false);
    installSandboxCapabilityHost(h.seam, { appId: "org.amos.demo" });

    h.dispatch(message(ours, request()));
    await flush();

    expect((ours.posted[0] as { granted: boolean }).granted).toBe(false);
  });
});

describe("the answer goes to the window that asked", () => {
  test("a frame that changed while the daemon was thinking receives nothing", async () => {
    const ours = fakeWindow();
    const replacement = fakeWindow();
    const h = harness(ours, () => true);
    installSandboxCapabilityHost(h.seam, { appId: "org.amos.demo" });

    h.dispatch(message(ours, request()));
    h.setFrame(replacement); // the bundle navigated / the app closed mid-flight
    await flush();

    expect(ours.posted.length).toBe(0);
    expect(replacement.posted.length).toBe(0);
  });

  test("the installed listener is the seam's own unsubscribe", () => {
    const h = harness(fakeWindow(), () => true);
    const uninstall = installSandboxCapabilityHost(h.seam, { appId: "org.amos.demo" });
    uninstall();
    expect(h.unsubscribes()).toBe(1);
  });
});

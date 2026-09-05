import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  assertHold,
  clearAllHolds,
  releaseHold,
  screenHeld,
  useCallKeepAwake,
  useScreenHold,
} from "../lib/keepAwake";
import type { TelephonyCall } from "../lib/backend";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
const listeners = new Map<string, (e: { payload: unknown }) => void>();

afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  listeners.clear();
  clearAllHolds();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

function installBridge() {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: async () => ({}),
    listen: async (ch: string, handler: (e: { payload: unknown }) => void) => {
      listeners.set(ch, handler);
      return () => listeners.delete(ch);
    },
  };
}

function emit(call: TelephonyCall) {
  listeners.get("telephony-event")?.({ payload: call });
}

function mountProbe() {
  function Probe() {
    useCallKeepAwake();
    const held = useScreenHold();
    return <div data-hold={held ? "held" : "free"}>{held ? "held" : "free"}</div>;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<Probe />);
  mounted.push({ root, host });
  return host;
}

const hold = (host: HTMLElement) =>
  host.querySelector("[data-hold]")?.getAttribute("data-hold");

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("keep-awake reason bus", () => {
  test("assert/release of one reason flips the aggregate", async () => {
    installBridge();
    const host = mountProbe();
    await flush();
    expect(hold(host)).toBe("free");
    expect(screenHeld()).toBe(false);

    await act(async () => {
      assertHold("nav");
    });
    await flush();
    expect(screenHeld()).toBe(true);
    expect(hold(host)).toBe("held");

    await act(async () => {
      releaseHold("nav");
    });
    await flush();
    expect(screenHeld()).toBe(false);
    expect(hold(host)).toBe("free");
  });

  test("an active call asserts a hold via the bus; end releases it", async () => {
    installBridge();
    const host = mountProbe();
    await flush();
    expect(hold(host)).toBe("free");

    await act(async () => {
      emit({ id: "c1", peer: "13800138000", state: "Active", direction: "Incoming", emergency: false, recording: "Off" });
    });
    await flush();
    expect(screenHeld()).toBe(true);
    expect(hold(host)).toBe("held");

    await act(async () => {
      emit({ id: "c1", peer: "13800138000", state: "Ended", direction: "Incoming", emergency: false, recording: "Off" });
    });
    await flush();
    expect(screenHeld()).toBe(false);
    expect(hold(host)).toBe("free");
  });

  test("unmounting a mid-hold subscriber releases its reason", async () => {
    installBridge();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    function Probe() {
      useCallKeepAwake();
      const held = useScreenHold();
      return <div data-hold={held ? "held" : "free"} />;
    }
    root.render(<Probe />);
    await flush();
    // A call goes active → the bus is held.
    await act(async () => {
      emit({ id: "c1", peer: "1", state: "Active", direction: "Incoming", emergency: false, recording: "Off" });
    });
    await flush();
    expect(screenHeld()).toBe(true);
    // Subscriber unmounts mid-call → its "call" assertion is released (no stale hold).
    await act(async () => {
      root.unmount();
      host.remove();
    });
    await flush();
    expect(screenHeld()).toBe(false);
  });

  test("overlapping reasons each need their own release", async () => {
    installBridge();
    const host = mountProbe();
    await flush();
    await act(async () => {
      assertHold("call");
      assertHold("nav");
    });
    await flush();
    expect(screenHeld()).toBe(true);
    // Releasing one reason still leaves the other holding.
    await act(async () => {
      releaseHold("call");
    });
    await flush();
    expect(screenHeld()).toBe(true);
    expect(hold(host)).toBe("held");
    await act(async () => {
      releaseHold("nav");
    });
    await flush();
    expect(screenHeld()).toBe(false);
  });
});

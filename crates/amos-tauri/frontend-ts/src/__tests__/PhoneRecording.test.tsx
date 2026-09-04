import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { PhoneApp } from "../components/CommsApps";
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
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

function mount() {
  window.localStorage.setItem("amos-ui.locale", "en");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <I18nProvider>
      <PhoneApp />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

/** Install a fake Tauri bridge; callers then use `emit` to deliver events. */
function installBridge(handlers: {
  dial?: () => unknown;
  start?: () => unknown;
  stop?: () => unknown;
  end?: () => unknown;
  sim?: () => unknown;
}): void {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      const table: Record<string, () => unknown> = {
        telephony_dial: handlers.dial ?? (() => ({ id: "c1" })),
        telephony_simulate_incoming: handlers.sim ?? (() => "in1"),
        telephony_start_recording: handlers.start ?? (() => ({
          id: "c1", peer: "13800138000", state: "Active", direction: "Outgoing",
          emergency: false, recording: "On",
        })),
        telephony_stop_recording: handlers.stop ?? (() => ({
          id: "c1", peer: "13800138000", state: "Active", direction: "Outgoing",
          emergency: false, recording: "Off",
        })),
        telephony_end: handlers.end ?? (() => ({})),
      };
      const h = table[cmd];
      if (!h) throw new Error(`unexpected invoke ${cmd}`);
      return h();
    },
    listen: async (ch: string, handler: (e: { payload: unknown }) => void) => {
      listeners.set(ch, handler);
      return () => listeners.delete(ch);
    },
  };
}

function emit(channel: string, payload: unknown) {
  listeners.get(channel)?.({ payload });
}

function activeCall(over: Partial<TelephonyCall> = {}): TelephonyCall {
  return {
    id: "c1", peer: "13800138000", state: "Active", direction: "Outgoing",
    emergency: false, recording: "Off", ...over,
  };
}

async function tick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function buttons(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll("button"));
}
function findButton(host: HTMLElement, text: string): HTMLButtonElement | null {
  return buttons(host).find((b) => b.textContent === text) ?? null;
}
function byAria(host: HTMLElement, label: string): HTMLButtonElement | null {
  return buttons(host).find((b) => b.getAttribute("aria-label") === label) ?? null;
}

/** Dial "1" and let the subscription settle; the call stays Dialing. */
async function placeCall(host: HTMLElement) {
  await tick(); // flush initial render so the keypad + event subscription exist
  const one = findButton(host, "1");
  expect(one).toBeTruthy();
  await act(async () => {
    one!.click();
  });
  const call = byAria(host, "call");
  expect(call).toBeTruthy();
  await act(async () => {
    call!.click();
  });
  await tick();
}

describe("PhoneApp call recording", () => {
  test("no daemon-backed call => dial fails and we return to the keypad (never stuck)", async () => {
    const host = mount();
    await tick();
    const one = findButton(host, "1");
    expect(one).toBeTruthy();
    await act(async () => {
      one!.click();
    });
    await act(async () => {
      byAria(host, "call")!.click();
    });
    await tick();
    // Nothing was placed: we must not linger on a phantom "calling…" screen with no
    // call id. Instead a localized error is shown and the keypad is usable again.
    expect(host.textContent).toContain("Could not dial");
    expect(findButton(host, "1")).toBeTruthy(); // keypad restored
    expect(byAria(host, "Record")).toBeNull(); // and no recording toggle is offered
    expect(byAria(host, "end")).toBeNull(); // no dead "hang up" for a call we never made
  });

  test("an outgoing call reaching Active enables the record toggle", async () => {
    installBridge({});
    const host = mount();
    await placeCall(host);

    // Still dialing -> no record toggle yet.
    expect(byAria(host, "Record")).toBeNull();

    // The daemon Watch stream says the call connected.
    await act(async () => {
      emit("telephony-event", activeCall());
    });
    await tick();
    expect(host.textContent).toContain("In call");
    const start = byAria(host, "Record");
    expect(start).toBeTruthy();

    // Start recording -> daemon answers On -> live indicator appears.
    await act(async () => {
      start!.click();
    });
    await tick();
    expect(host.textContent).toContain("Recording");
    expect(byAria(host, "Stop recording")).toBeTruthy();

    // Stop recording -> indicator clears.
    await act(async () => {
      byAria(host, "Stop recording")!.click();
    });
    await tick();
    expect(host.textContent).not.toContain("Recording");
    expect(byAria(host, "Record")).toBeTruthy();
  });

  test("recording start denial keeps the toggle honest (Off)", async () => {
    installBridge({ start: () => null }); // daemon declines (e.g. consent/jurisdiction)
    const host = mount();
    await placeCall(host);
    await act(async () => {
      emit("telephony-event", activeCall());
    });
    await tick();

    const start = byAria(host, "Record");
    expect(start).toBeTruthy();
    await act(async () => {
      start!.click();
    });
    await tick();
    // No false "Recording" indicator and no fake stop button.
    expect(host.textContent).not.toContain("Recording");
    expect(byAria(host, "Record")).toBeTruthy();
    expect(byAria(host, "Stop recording")).toBeNull();
  });

  test("demo 'simulate incoming' trigger calls the OS service", async () => {
    let simmed = "";
    installBridge({ sim: () => {
      simmed = "called";
      return "in1";
    } });
    const host = mount();
    await tick();

    const btn = byAria(host, "Simulate incoming");
    expect(btn).toBeTruthy();
    await act(async () => {
      btn!.click();
    });
    await tick();
    expect(simmed).toBe("called");
  });
});


import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { PhoneApp } from "../components/PhoneDialer";
import type { TelephonyCall } from "../lib/backend";
import { EMERGENCY_QUICK_NUMBER } from "../lib/emergency";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
const listeners = new Map<string, (e: { payload: unknown }) => void>();
let lastDial: { number: string; emergency: boolean } | null = null;

afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  listeners.clear();
  lastDial = null;
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

function installBridge(dialId = "c1") {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "telephony_dial") {
        lastDial = { number: String(args?.number), emergency: Boolean(args?.emergency) };
        return { id: dialId };
      }
      if (cmd === "telephony_end") return {};
      throw new Error(`unexpected invoke ${cmd}`);
    },
    listen: async (ch: string, h: (e: { payload: unknown }) => void) => {
      listeners.set(ch, h);
      return () => listeners.delete(ch);
    },
  };
}

function emitActive(call: Partial<TelephonyCall> = {}) {
  listeners.get("telephony-event")?.({
    payload: {
      id: "c1", peer: "13800138000", state: "Active", direction: "Outgoing",
      emergency: false, recording: "Off", ...call,
    },
  });
}

const buttons = (host: HTMLElement) => Array.from(host.querySelectorAll("button"));
const byAria = (host: HTMLElement, label: string) =>
  buttons(host).find((b) => b.getAttribute("aria-label") === label) ?? null;
const tab = (host: HTMLElement, label: string) =>
  buttons(host).find((b) => b.getAttribute("role") === "tab" && b.textContent === label);

async function tick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function placeCall(host: HTMLElement) {
  await tick();
  await act(async () => {
    buttons(host).find((b) => b.textContent === "1")!.click();
  });
  await act(async () => {
    byAria(host, "call")!.click();
  });
  await tick();
}

describe("PhoneApp emergency page", () => {
  test("Emergency tab dials a code through the privileged path", async () => {
    installBridge();
    const host = mount();
    await tick();
    await act(async () => {
      tab(host, "Emergency")!.click();
    });
    // Page lists the recognized codes.
    expect(host.textContent).toContain(EMERGENCY_QUICK_NUMBER);
    const btn = byAria(host, `Emergency call ${EMERGENCY_QUICK_NUMBER}`);
    expect(btn).toBeTruthy();
    await act(async () => {
      btn!.click();
    });
    await tick();
    expect(lastDial).toEqual({ number: EMERGENCY_QUICK_NUMBER, emergency: true });
    // Enters the in-call screen (can hang up).
    expect(byAria(host, "end")).toBeTruthy();
  });
});

describe("PhoneApp in-call controls", () => {
  test("mute toggles once the call is connected (talking)", async () => {
    installBridge();
    const host = mount();
    await placeCall(host);
    // Dialing only — no mute control yet.
    expect(byAria(host, "Mute")).toBeNull();
    await act(async () => {
      emitActive();
    });
    await tick();
    expect(host.textContent).toContain("In call");
    const mute = byAria(host, "Mute");
    expect(mute).toBeTruthy();
    await act(async () => {
      mute!.click();
    });
    await tick();
    expect(byAria(host, "Unmute")).toBeTruthy();
    expect(host.textContent).toContain("Muted");
  });

  test("DTMF keypad opens and closes in-call", async () => {
    installBridge();
    const host = mount();
    await placeCall(host);
    await act(async () => {
      emitActive();
    });
    await tick();
    // No DTMF pad until asked.
    expect(byAria(host, "Send key 5")).toBeNull();
    await act(async () => {
      byAria(host, "Keypad (DTMF)")!.click();
    });
    await tick();
    expect(byAria(host, "Send key 5")).toBeTruthy();
    // Toggle closes it again.
    await act(async () => {
      byAria(host, "Keypad (DTMF)")!.click();
    });
    await tick();
    expect(byAria(host, "Send key 5")).toBeNull();
  });
});

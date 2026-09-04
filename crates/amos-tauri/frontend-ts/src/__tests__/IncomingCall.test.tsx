import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "../i18n";
import IncomingCall from "../components/IncomingCall";
import type { TelephonyCall } from "../lib/backend";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
const listeners = new Map<string, (e: { payload: unknown }) => void>();
const calls: string[] = [];

afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  listeners.clear();
  calls.length = 0;
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
      <IncomingCall />
    </I18nProvider>,
  );
  mounted.push({ root, host });
  return host;
}

function installBridge() {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "telephony_answer" || cmd === "telephony_end") {
        calls.push(`${cmd}:${String(args?.callId ?? "")}`);
        return {};
      }
      if (cmd === "telephony_start_recording") {
        return { id: "in1", peer: "138", state: "Active", direction: "Incoming", emergency: false, recording: "On" };
      }
      throw new Error(`unexpected invoke ${cmd}`);
    },
    listen: async (ch: string, handler: (e: { payload: unknown }) => void) => {
      listeners.set(ch, handler);
      return () => listeners.delete(ch);
    },
  };
}

function emit(call: TelephonyCall) {
  listeners.get("telephony-event")?.({ payload: call });
}

async function tick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function byAria(host: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(host.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === label,
  ) ?? null;
}

describe("IncomingCall overlay", () => {
  test("ringing shows Answer/Decline; answering enters a recordable in-call banner", async () => {
    installBridge();
    const host = mount();
    await tick();

    emit({ id: "in1", peer: "13800138000", state: "Ringing", direction: "Incoming", emergency: false, recording: "Off" });
    await tick();
    expect(host.textContent).toContain("Incoming call");
    expect(byAria(host, "Answer")).toBeTruthy();
    expect(byAria(host, "Decline")).toBeTruthy();

    await act(async () => {
      byAria(host, "Answer")!.click();
    });
    await tick();
    expect(calls).toContain("telephony_answer:in1");
    // Answered → in-call banner with a record toggle (domain-legal while Active).
    expect(host.textContent).toContain("In call");
    expect(byAria(host, "Record")).toBeTruthy();

    // Recording toggles on via the service.
    await act(async () => {
      byAria(host, "Record")!.click();
    });
    await tick();
    expect(host.textContent).toContain("Recording");
    expect(byAria(host, "Stop recording")).toBeTruthy();
  });

  test("declining ends the call and clears the overlay", async () => {
    installBridge();
    const host = mount();
    await tick();

    emit({ id: "in1", peer: "13800138000", state: "Ringing", direction: "Incoming", emergency: false, recording: "Off" });
    await tick();
    expect(host.textContent).toContain("Incoming call");

    await act(async () => {
      byAria(host, "Decline")!.click();
    });
    await tick();
    expect(calls).toContain("telephony_end:in1");
    expect(host.textContent).not.toContain("Incoming call");

    // A remote "Ended" event for that call keeps the overlay clear.
    emit({ id: "in1", peer: "13800138000", state: "Ended", direction: "Incoming", emergency: false, recording: "Off" });
    await tick();
    expect(host.textContent).not.toContain("Incoming call");
  });
});

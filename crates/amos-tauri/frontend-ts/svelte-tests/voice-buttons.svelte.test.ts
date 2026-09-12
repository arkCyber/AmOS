/**
 * DOM tests for the Svelte 5 AI voice buttons (VoiceMicButton / StreamVoiceButton)
 * — OFFLINE state only. Offline (no bridge) both must be disabled with an
 * offline tooltip; real mic capture + ASR/streaming need a device + daemon.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import VoiceMicButton from "../src/svelte/VoiceMicButton.svelte";
import StreamVoiceButton from "../src/svelte/StreamVoiceButton.svelte";
import DeviceMicButton from "../src/svelte/DeviceMicButton.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { PERMISSIONS_KEY } from "../src/lib/permissions";

afterEach(cleanup);

const buttonByAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === aria,
  ) as HTMLButtonElement | undefined;

describe("Ai voice buttons (offline)", () => {
  test("ASR mic button is disabled + offline title when not bridged", () => {
    const host = render(VoiceMicButton, { props: { online: false, onTranscript: () => {} } });
    const b = buttonByAria(host, "voice input");
    expect(b?.disabled).toBe(true);
    expect(b?.title).toContain("离线"); // ai.streamVoiceOffline
  });

  test("streaming voice button is disabled + offline title when not bridged", () => {
    const host = render(StreamVoiceButton, {
      props: { online: false, session: () => "s" },
    });
    const b = buttonByAria(host, "streaming voice input");
    expect(b?.disabled).toBe(true);
    expect(b?.title).toContain("离线"); // ai.streamVoiceOffline
  });

  test("native always-on mic button is disabled + offline title when not bridged", () => {
    const host = render(DeviceMicButton, {
      props: { online: false, session: () => "s" },
    });
    const b = buttonByAria(host, "device voice input");
    expect(b?.disabled).toBe(true);
    expect(b?.title).toContain("离线"); // ai.deviceMicOffline
  });
});

describe("StreamVoiceButton — resident listener teardown", () => {
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    window.localStorage.clear();
  });

  test("a started session is cancelled when the button unmounts", async () => {
    const calls: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        return null;
      },
      listen: async () => () => {},
    };
    writeStoreValue(PERMISSIONS_KEY, { ai: ["microphone"] });
    // The host listener opens *before* local capture: a device with no usable
    // stream still leaves a resident daemon session behind.
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [] }) },
      configurable: true,
      writable: true,
    });

    const host = render(StreamVoiceButton, { props: { online: true, session: () => "s" } });
    await fireEvent.click(buttonByAria(host, "streaming voice input")!);
    await settle();
    expect(calls).toContain("assistant_voice_start");

    // Leaving the screen must cancel the resident listener — nothing else ever did.
    host.unmount();
    await settle();
    expect(calls).toContain("assistant_voice_stop");
  });

  test("unmounting without ever starting one sends no cancel", async () => {
    const calls: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(StreamVoiceButton, { props: { online: true, session: () => "s" } });
    host.unmount();
    await settle();
    expect(calls).toEqual([]);
  });
});

describe("DeviceMicButton — OS mic grant (dialog-free read)", () => {
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    window.localStorage.clear();
  });

  test("a denied OS grant is surfaced before pressing, without prompting", async () => {
    const calls: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === "mic_permission_state") return { native: true, granted: false };
        if (cmd === "device_mic_status") return { running: false, backend: "none", submitted: 0 };
        return null;
      },
      listen: async () => () => {},
    };
    // The LOCAL ledger says granted; the OS says otherwise — the OS truth is shown.
    writeStoreValue(PERMISSIONS_KEY, { ai: ["microphone"] });
    const host = render(DeviceMicButton, { props: { online: true, session: () => "s" } });
    await settle();
    const b = buttonByAria(host, "device voice input");
    expect(b?.title).toContain("RECORD_AUDIO");
    expect(calls).toContain("mic_permission_state");
    // The read must never prompt — only a user press asks for the grant.
    expect(calls).not.toContain("mic_permission_request");
  });

  test("an OS-granted mic keeps the normal title", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "mic_permission_state") return { native: true, granted: true };
        if (cmd === "device_mic_status") return { running: false, backend: "none", submitted: 0 };
        return null;
      },
      listen: async () => () => {},
    };
    writeStoreValue(PERMISSIONS_KEY, { ai: ["microphone"] });
    const host = render(DeviceMicButton, { props: { online: true, session: () => "s" } });
    await settle();
    const b = buttonByAria(host, "device voice input");
    expect(b?.title).toContain("AAudio"); // ai.deviceMicTitle
  });
});

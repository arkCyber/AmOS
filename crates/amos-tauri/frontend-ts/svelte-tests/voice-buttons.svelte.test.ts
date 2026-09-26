/**
 * DOM tests for the Svelte 5 AI voice buttons (VoiceMicButton / StreamVoiceButton)
 * — OFFLINE state only. Offline (no bridge) both must be disabled with an
 * offline tooltip; real mic capture + ASR/streaming need a device + daemon.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import VoiceMicButton from "../src/svelte/VoiceMicButton.svelte";
import StreamVoiceButton from "../src/svelte/StreamVoiceButton.svelte";
import DeviceMicButton from "../src/svelte/DeviceMicButton.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { PERMISSIONS_KEY } from "../src/lib/permissions";
import { zh } from "../src/i18n/locales/zh";

afterEach(cleanup);

const buttonByAria = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === aria,
  ) as HTMLButtonElement | undefined;

describe("Ai voice buttons (offline)", () => {
  test("ASR mic button is disabled + offline title when not bridged", () => {
    const host = render(VoiceMicButton, { props: { online: false, onTranscript: () => {} } });
    const b = buttonByAria(host, zh["a11y.voiceInput"]);
    expect(b?.disabled).toBe(true);
    expect(b?.title).toContain("离线"); // ai.streamVoiceOffline
  });

  test("streaming voice button is disabled + offline title when not bridged", () => {
    const host = render(StreamVoiceButton, {
      props: { online: false, session: () => "s" },
    });
    const b = buttonByAria(host, zh["a11y.streamingVoiceInput"]);
    expect(b?.disabled).toBe(true);
    expect(b?.title).toContain("离线"); // ai.streamVoiceOffline
  });

  test("native always-on mic button is disabled + offline title when not bridged", () => {
    const host = render(DeviceMicButton, {
      props: { online: false, session: () => "s" },
    });
    const b = buttonByAria(host, zh["a11y.deviceVoiceInput"]);
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
    await fireEvent.click(buttonByAria(host, zh["a11y.streamingVoiceInput"])!);
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
        if (cmd === "mic_permission_state") return { native: true, granted: false, state: "denied" };
        if (cmd === "device_mic_status") return { running: false, backend: "none", submitted: 0 };
        return null;
      },
      listen: async () => () => {},
    };
    // The LOCAL ledger says granted; the OS says otherwise — the OS truth is shown.
    writeStoreValue(PERMISSIONS_KEY, { ai: ["microphone"] });
    const host = render(DeviceMicButton, { props: { online: true, session: () => "s" } });
    await settle();
    const b = buttonByAria(host, zh["a11y.deviceVoiceInput"]);
    expect(b?.title).toContain("RECORD_AUDIO");
    expect(calls).toContain("mic_permission_state");
    // The read must never prompt — only a user press asks for the grant.
    expect(calls).not.toContain("mic_permission_request");
  });

  // REQ-A787 / F-AND-010: a read that *failed* is not the user's settings. The old
  // shape (`granted: false` for every failure) made these two states print
  // 「系统未授予麦克风权限（RECORD_AUDIO）」 — a claim about the user — whenever the
  // JNI read threw or the dialog went unanswered.
  test("a failed OS read says so, and never claims the grant was denied", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "mic_permission_state")
          return { native: true, granted: false, state: "unreadable", detail: "glue threw in isGranted" };
        if (cmd === "device_mic_status") return { running: false, backend: "none", submitted: 0 };
        return null;
      },
      listen: async () => () => {},
    };
    writeStoreValue(PERMISSIONS_KEY, { ai: ["microphone"] });
    const host = render(DeviceMicButton, { props: { online: true, session: () => "s" } });
    await settle();
    const b = buttonByAria(host, zh["a11y.deviceVoiceInput"]);
    // The host's own words survive to the screen…
    expect(b?.title).toContain("glue threw in isGranted");
    expect(b?.title).toContain(zh["ai.deviceMicUnreadable"].split("{")[0]);
    // …and the denial sentence — a fact about the user — is NOT what a failed read shows.
    expect(b?.title).not.toContain(zh["ai.deviceMicDenied"]);
  });

  test("a dialog the OS never answered is not a denial either", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "mic_permission_state")
          return { native: true, granted: false, state: "timed-out" };
        if (cmd === "device_mic_status") return { running: false, backend: "none", submitted: 0 };
        return null;
      },
      listen: async () => () => {},
    };
    writeStoreValue(PERMISSIONS_KEY, { ai: ["microphone"] });
    const host = render(DeviceMicButton, { props: { online: true, session: () => "s" } });
    await settle();
    const b = buttonByAria(host, zh["a11y.deviceVoiceInput"]);
    expect(b?.title).toContain(zh["ai.deviceMicTimedOut"]);
    expect(b?.title).not.toContain(zh["ai.deviceMicDenied"]);
  });

  test("pressing when the request read throws reports the throw, not a denial", async () => {
    const calls: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === "mic_permission_state") return { native: true, granted: true, state: "granted" };
        if (cmd === "mic_permission_request")
          return { native: true, granted: false, state: "unreadable", detail: "request threw" };
        if (cmd === "device_mic_status") return { running: false, backend: "none", submitted: 0 };
        return null;
      },
      listen: async () => () => {},
    };
    writeStoreValue(PERMISSIONS_KEY, { ai: ["microphone"] });
    const host = render(DeviceMicButton, { props: { online: true, session: () => "s" } });
    await settle();
    const b = buttonByAria(host, zh["a11y.deviceVoiceInput"]);
    await fireEvent.click(b!);
    await settle();
    expect(calls).toContain("mic_permission_request");
    const after = buttonByAria(host, zh["a11y.deviceVoiceInput"]);
    expect(after?.title).toContain("request threw");
    expect(after?.title).not.toContain(zh["ai.deviceMicDenied"]);
    // The mic never opened — the throw is not a session that started.
    expect(calls).not.toContain("device_mic_start");
  });

  test("an OS-granted mic keeps the normal title", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "mic_permission_state") return { native: true, granted: true, state: "granted" };
        if (cmd === "device_mic_status") return { running: false, backend: "none", submitted: 0 };
        return null;
      },
      listen: async () => () => {},
    };
    writeStoreValue(PERMISSIONS_KEY, { ai: ["microphone"] });
    const host = render(DeviceMicButton, { props: { online: true, session: () => "s" } });
    await settle();
    const b = buttonByAria(host, zh["a11y.deviceVoiceInput"]);
    expect(b?.title).toContain("AAudio"); // ai.deviceMicTitle
  });
});

/**
 * The **stop verdict** (REQ-A826 / F-SH-261).
 *
 * `device_mic_stop` is a `void` command, so its success value is `null` — and `invoke`
 * answers `null` for a call that *failed* too (it never rejects; it records the reason in
 * the per-command diagnosis). The two realities therefore arrive as the same value, and
 * the old `finally { running = false }` turned the indicator off on a stop nobody had
 * confirmed. These tests pin the rule: **the indicator may only go dark when the host
 * confirms it**, because it is the user's only evidence that an always-on mic is live.
 */
describe("DeviceMicButton — the stop verdict", () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    window.localStorage.clear();
  });

  /** A bridge whose poller reports a live native capture, with a scripted `stop`. */
  const bridge = (live: { value: boolean }, onStop: () => void) => {
    const calls: string[] = [];
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === "device_mic_status") {
          return live.value
            ? { running: true, backend: "aaudio", submitted: 3 }
            : { running: false, backend: "none", submitted: 3 };
        }
        if (cmd === "device_mic_stop") {
          onStop();
          return null;
        }
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  };

  const liveButton = async (host: { container: HTMLElement }) => {
    const b = buttonByAria(host, zh["a11y.deviceVoiceInput"]);
    // The glyph *is* the indicator: `●` = the mic is live, `🎧` = it is not.
    await vi.waitFor(() => expect(b?.textContent).toBe("●"));
    return b!;
  };

  test("a stop whose reply cannot prove it happened is not worded as 'the mic is off'", async () => {
    const live = { value: true };
    const calls = bridge(live, () => {
      throw new Error("ipc hiccup");
    });
    const host = render(DeviceMicButton, { props: { online: true, session: () => "s" } });
    const b = await liveButton(host);

    await fireEvent.click(b);

    await vi.waitFor(() => expect(b.title).toBe(zh["ai.deviceMicStopUnconfirmed"]));
    // The host never confirmed: the capture is still up, and the button still says so.
    expect(live.value).toBe(true);
    expect(b.textContent).toBe("●");
    expect(calls).toContain("device_mic_stop");
  });

  test("a stop the host confirms turns the indicator off", async () => {
    const live = { value: true };
    bridge(live, () => {
      live.value = false;
    });
    const host = render(DeviceMicButton, { props: { online: true, session: () => "s" } });
    const b = await liveButton(host);

    await fireEvent.click(b);

    await vi.waitFor(() => expect(b.textContent).toBe("🎧"));
    expect(b.title).not.toBe(zh["ai.deviceMicStopUnconfirmed"]);
  });

  test("a failed stop whose re-read shows the capture really ended is shown as off", async () => {
    const live = { value: true };
    bridge(live, () => {
      // The IPC failed, but the capture really did stop — the host's own status says so.
      live.value = false;
      throw new Error("ipc hiccup");
    });
    const host = render(DeviceMicButton, { props: { online: true, session: () => "s" } });
    const b = await liveButton(host);

    await fireEvent.click(b);

    await vi.waitFor(() => expect(b.textContent).toBe("🎧"));
    expect(b.title).not.toBe(zh["ai.deviceMicStopUnconfirmed"]);
  });
});

/**
 * REQ-A1055 / F-SH-370 — a refused unit-returning voice command is not a success.
 *
 * `assistant_voice_start` is `Result<(), AmosError>` and `assistant_voice_end` is
 * `Result<(), String>`: the host's `Ok(())` reaches `lib/backend.invoke` as the same `null` a
 * refusal does (REQ-A297), so the return value cannot separate them. Before this the button
 * read neither: a listener the host never opened (daemon absent though Tauri is present) looked
 * exactly like one it had — local capture started, every frame was dropped, no reply ever came,
 * and `onStart` had ALREADY pushed a "you spoke" bubble into the chat. The glyph claimed it was
 * capturing (`aria-pressed`) the whole time.
 *
 * The bridge's `invoke` throwing is what makes the real `lib/backend.invoke` note a
 * `command-failed` diagnosis, so `bridgeDiag(command)` answers `ok:false` — the same ledger the
 * screen reads in production.
 */
describe("StreamVoiceButton — a refused voice command is reported, not swallowed", () => {
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    window.localStorage.clear();
  });

  /** Minimal Web Audio doubles: enough for the capture path to reach `recording = true`. */
  function installAudio(): void {
    class FakeProc {
      onaudioprocess: ((e: unknown) => void) | null = null;
      connect(): void {}
      disconnect(): void {}
    }
    class FakeSource {
      connect(): void {}
      disconnect(): void {}
    }
    class FakeCtx {
      sampleRate = 16000;
      destination = {};
      createMediaStreamSource(): FakeSource {
        return new FakeSource();
      }
      createScriptProcessor(): FakeProc {
        return new FakeProc();
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    }
    (window as unknown as { AudioContext?: unknown }).AudioContext = FakeCtx;
  }

  function installBridge(calls: string[], throwFor: () => string | null): void {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === throwFor()) throw new Error(`${cmd} refused`);
        return null;
      },
      listen: async () => () => {},
    };
    writeStoreValue(PERMISSIONS_KEY, { ai: ["microphone"] });
    installAudio();
    // The host listener opens *before* local capture, so the refusal must be visible with a
    // usable stream present — otherwise the test could pass for the wrong reason. The track list
    // must be NON-empty or `start()` tears the capture down itself and `recording` never holds.
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
      configurable: true,
      writable: true,
    });
  }

  test("a refused start is reported, does not claim the user spoke, and drops the capture state", async () => {
    const calls: string[] = [];
    const starts: number[] = [];
    const errors: string[] = [];
    installBridge(calls, () => "assistant_voice_start");

    const host = render(StreamVoiceButton, {
      props: {
        online: true,
        session: () => "s",
        onStart: () => starts.push(1),
        onError: (cmd: string) => errors.push(cmd),
      },
    });
    const b = buttonByAria(host, zh["a11y.streamingVoiceInput"])!;
    await fireEvent.click(b);
    await settle();

    expect(calls).toContain("assistant_voice_start");
    expect(errors).toEqual(["assistant_voice_start"]);
    // The false bubble: the parent must not be told the user spoke for a listener never opened.
    expect(starts).toEqual([]);
    // And the glyph must not claim it is capturing.
    expect(buttonByAria(host, zh["a11y.streamingVoiceInput"])?.getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  test("an accepted start still tells the parent the user spoke (regression)", async () => {
    const calls: string[] = [];
    const starts: number[] = [];
    const errors: string[] = [];
    installBridge(calls, () => null);

    const host = render(StreamVoiceButton, {
      props: {
        online: true,
        session: () => "s",
        onStart: () => starts.push(1),
        onError: (cmd: string) => errors.push(cmd),
      },
    });
    await fireEvent.click(buttonByAria(host, zh["a11y.streamingVoiceInput"])!);
    await settle();

    expect(starts).toEqual([1]);
    expect(errors).toEqual([]);
    expect(buttonByAria(host, zh["a11y.streamingVoiceInput"])?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  test("an end the host refused is reported (no reply is coming)", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    let refuseEnd = false;
    installBridge(calls, () => (refuseEnd ? "assistant_voice_end" : null));

    const host = render(StreamVoiceButton, {
      props: {
        online: true,
        session: () => "s",
        onError: (cmd: string) => errors.push(cmd),
      },
    });
    const b = buttonByAria(host, zh["a11y.streamingVoiceInput"])!;
    await fireEvent.click(b); // start (accepted)
    await settle();
    expect(errors).toEqual([]);

    refuseEnd = true;
    await fireEvent.click(buttonByAria(host, zh["a11y.streamingVoiceInput"])!); // release → end
    await settle();

    expect(calls).toContain("assistant_voice_end");
    expect(errors).toEqual(["assistant_voice_end"]);
  });
});

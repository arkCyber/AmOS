/**
 * DOM tests for the Svelte 5 phone screen (PhoneApp.svelte) — offline UI parts.
 * Pure dial logic is in lib/phone (shared); dialing/record paths need the OS
 * telephony daemon and are verified on-device (ON_DEVICE_ACCEPTANCE.md). Here we
 * test keypad entry/backspace/clear, tab switching, the emergency page, and that
 * dialing WITHOUT a daemon shows a localized error (never a phantom "calling").
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import PhoneApp from "../src/svelte/PhoneApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import {
  CALLLOG_KEY,
  resetPendingCallsForTest,
  pendingCallCount,
  queuePendingCall,
  type CallRecord,
} from "../src/lib/calllog";
import { CONTACTS_KEY } from "../src/lib/contacts";
import { zh } from "../src/i18n/locales/zh";
import { messagesChannel, phoneChannel } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { resetShellState, surface } from "../src/svelte/shellState.svelte";

beforeEach(() => {
  // The pending-call queue is module state: start every case from a known state.
  resetPendingCallsForTest();
});

afterEach(() => {
  cleanup();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
  resetPendingCallsForTest();
  resetPropsChannels();
  resetShellState();
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const key = (h: { container: HTMLElement }, aria: string) =>
  h.container.querySelector(`button[aria-label="${aria}"]`) as HTMLButtonElement | null;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return
 * a restore function. (`window.localStorage` is a per-access proxy, so the prototype
 * cannot be patched — the window property itself is replaced.)
 */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}

/** Open the 「拦截」 tab (matched by its label, not by index). */
const openBlockTab = (h: { container: HTMLElement }) => {
  const tab = [...h.container.querySelectorAll('button[role="tab"]')].find((b) =>
    (b.textContent ?? "").includes("拦截"),
  ) as HTMLButtonElement;
  return fireEvent.click(tab);
};

/** Open the 「最近」 tab (the call-history page). */
const openHistoryTab = (h: { container: HTMLElement }) => {
  const tab = [...h.container.querySelectorAll('button[role="tab"]')].find((b) =>
    (b.textContent ?? "").includes("最近"),
  ) as HTMLButtonElement;
  return fireEvent.click(tab);
};

/** Open the 「常用」 tab (the frequent-numbers page). */
const openFrequentTab = (h: { container: HTMLElement }) => {
  const tab = [...h.container.querySelectorAll('button[role="tab"]')].find((b) =>
    (b.textContent ?? "").includes("常用"),
  ) as HTMLButtonElement;
  return fireEvent.click(tab);
};

/** Install a fake Tauri bridge; returns the captured invoke calls. */
const fakeBridge = (handler: (cmd: string, args?: Record<string, unknown>) => unknown) => {
  const calls: Record<string, unknown>[] = [];
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, ...(args ?? {}) });
      return handler(cmd, args);
    },
    listen: async () => () => {},
  };
  return calls;
};

/**
 * Like [`fakeBridge`], but the `listen` handler is captured so the test can push a
 * `telephony-event` payload — the push channel the daemon `Watch` stream and the real
 * in-call bridge both use (`crates/amos-tauri/src/telephony.rs` `watch_round`, and
 * `incall.rs` `nativeState`, which `app.emit`s the same event).
 */
const fakeBridgeWithEvents = (
  handler: (cmd: string, args?: Record<string, unknown>) => unknown,
) => {
  const calls: Record<string, unknown>[] = [];
  const listeners = new Map<string, (e: { payload: unknown }) => void>();
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, ...(args ?? {}) });
      return handler(cmd, args);
    },
    listen: async (channel: string, cb: (e: { payload: unknown }) => void) => {
      listeners.set(channel, cb);
      return () => listeners.delete(channel);
    },
  };
  return {
    calls,
    emit: (payload: unknown) => listeners.get("telephony-event")?.({ payload }),
  };
};

/** The seconds shown by the in-call `role="timer"` (`fmtCallDuration` → `m:ss` / `h:mm:ss`). */
const timerSec = (h: { container: HTMLElement }): number | null => {
  const el = h.container.querySelector('[role="timer"]');
  if (!el) return null;
  const parts = (el.textContent ?? "").trim().split(":").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};

const NO_STATUS = {
  has_call_rules: false,
  filters_calls: false,
  has_sms_rules: false,
  role_supported: false,
  role_held: false,
  role_requestable: false,
};

describe("PhoneApp.svelte (offline UI)", () => {
  test("a rejected history-clear is reported and the log stays", async () => {
    // A real entry so the two-step clear affordance is on screen.
    window.localStorage.setItem(
      "amos.calllog",
      JSON.stringify([{ number: "10086", name: "客服热线", ts: Date.now(), count: 1 }]),
    );
    const restore = failWritesFor("amos.calllog");
    try {
      const host = render(PhoneApp);
      await openHistoryTab(host);
      await flush();
      expect(txt(host)).toContain("客服热线");

      await fireEvent.click(host.container.querySelector('button[data-testid="history-clear"]')!);
      await fireEvent.click(host.container.querySelector('button[data-testid="history-clear-confirm"]')!);
      await flush();

      // Wiping the log was rejected: the banner shows and the entry is still there.
      expect(
        host.container.querySelector('[data-testid="store-write-error"]')?.textContent ?? "",
      ).toContain("本机存储写入失败");
      expect(txt(host)).toContain("客服热线");
    } finally {
      restore();
    }
  });

  test("keypad digits append; backspace and clear work", async () => {
    const host = render(PhoneApp);
    await fireEvent.click(key(host, "1")!);
    await fireEvent.click(key(host, "2")!);
    await fireEvent.click(key(host, "3")!);
    expect(txt(host)).toContain("123");
    await fireEvent.click(key(host, zh["a11y.backspace"])!);
    expect(txt(host)).toContain("12");
    await fireEvent.click(key(host, zh["phone.clear"])!);
    expect(txt(host)).not.toContain("12");
  });

  test("the dialer shows the name the call log knows for the typed number", async () => {
    // No address book entry → the hint must come from the call log's own history
    // (`lib/calllog.logNameFor`), so a number you called before is named again.
    writeStoreValue(CALLLOG_KEY, [{ number: "10086", name: "客服热线", ts: Date.now() }]);
    const host = render(PhoneApp);
    for (const d of ["1", "0", "0", "8", "6"]) await fireEvent.click(key(host, d)!);
    const known = host.container.querySelector('[data-testid="dial-known-name"]');
    expect(known).toBeTruthy();
    expect(known?.textContent ?? "").toContain("客服热线");
  });

  test("a contact added while the screen is mounted names the typed number", async () => {
    // The address book is read **live**, not snapshotted at init: a split pane keeps
    // this screen mounted beside Contacts, so a contact added in the other pane must
    // reach the dialer's known-name line without a remount.
    const host = render(PhoneApp); // mounts against an empty address book
    writeStoreValue(CONTACTS_KEY, [
      { id: "k1", name: "王五", phones: ["95588"], fav: false, ts: Date.now() },
    ]);
    for (const d of ["9", "5", "5", "8", "8"]) await fireEvent.click(key(host, d)!);
    const known = host.container.querySelector('[data-testid="dial-known-name"]');
    expect(known).toBeTruthy();
    expect(known?.textContent ?? "").toContain("王五");
  });

  test("tabs switch between pages", async () => {
    const host = render(PhoneApp);
    const tab = (label: string) =>
      [...host.container.querySelectorAll('button[role="tab"]')].find((b) =>
        (b.textContent ?? "").trim() === label,
      ) as HTMLButtonElement | undefined;
    // emergency page lists the quick numbers
    await fireEvent.click(tab("紧急")!);
    expect(txt(host)).toContain("110");
    expect(txt(host)).toContain("119");
    // recent page (empty offline → localized empty text is non-whitespace)
    await fireEvent.click(tab("最近")!);
    expect(txt(host)).toContain("最近");
  });

  /**
   * An emergency number takes the **real platform path** (`ACTION_CALL`), like every other
   * number. This is the inverse of what this file used to assert ("emergency numbers never
   * take the plain ACTION_CALL"): `ACTION_CALL` is where `docs/telephony.md` §5 puts the
   * emergency guarantee (Telecom + the EmergencyNumber DB + RIL), so routing emergency
   * calls to the daemon instead kept them off the only path that reaches that stack.
   *
   * Which number is an emergency number is a property of the **number**, not of the button
   * pressed, so a keypad-typed `110` is treated exactly like the emergency page's `110`.
   */
  const typeAndCall = async (host: { container: HTMLElement }, digits: string) => {
    for (const d of digits) await fireEvent.click(key(host, d)!);
    await fireEvent.click(
      host.container.querySelector(`button[aria-label="${zh["phone.call"]}"]`) as HTMLButtonElement,
    );
    await flush();
    await flush();
  };

  test("a keypad-typed emergency number takes the real ACTION_CALL path", async () => {
    const calls = fakeBridge((cmd) => (cmd === "real_dial" ? "ok" : null));
    const host = render(PhoneApp);
    await typeAndCall(host, "110");

    // The platform path was asked with the number — not the daemon's simulation…
    expect(calls.find((c) => c.cmd === "real_dial")?.number).toBe("110");
    expect(calls.some((c) => c.cmd === "telephony_dial")).toBe(false);
    // …and a hand-off the role probe cannot classify as ours is reported as such.
    expect(txt(host)).toContain(zh["phone.handedToSystem"]);
  });

  // The emergency page's own button is the path a panicking user takes, and it must reach
  // the same real path as the keypad.
  test("the emergency page's own button takes the real ACTION_CALL path too", async () => {
    const calls = fakeBridge((cmd) => (cmd === "real_dial" ? "ok" : null));
    const host = render(PhoneApp);
    const tab = [...host.container.querySelectorAll('button[role="tab"]')].find(
      (b) => (b.textContent ?? "").trim() === "紧急",
    ) as HTMLButtonElement;
    await fireEvent.click(tab);
    await fireEvent.click(
      host.container.querySelector(`button[aria-label="${zh["phone.emergencyCall"]} 110"]`) as HTMLButtonElement,
    );
    await flush();
    await flush();

    expect(calls.find((c) => c.cmd === "real_dial")?.number).toBe("110");
    expect(calls.some((c) => c.cmd === "telephony_dial")).toBe(false);
  });

  /**
   * The emergency *classification* must be at least as broad as the daemon's own table:
   * `911`/`000`/`999` are the emergency numbers of the US/AU/GB, and the daemon recognizes them
   * (`EmergencyMap::common_global()`). The classification still reaches the daemon whenever the
   * daemon **is** the transport — the desktop/demo host below — and there it decides whether the
   * dial takes the privileged emergency route instead of being refused as a regular number.
   */
  test("a keypad-typed regional emergency number (911) is classified as one for the daemon", async () => {
    // A desktop host: no platform path, the daemon is the mock — the one place `emergency`
    // is read as a dial argument.
    const calls = fakeBridge((cmd) => {
      if (cmd === "telephony_real_dial_status") {
        return { on_device: false, available: false, reason: "desktop" };
      }
      if (cmd === "telephony_dial") return { id: "demo-1" };
      return null;
    });
    const host = render(PhoneApp);
    await typeAndCall(host, "911");

    const dial = calls.find((c) => c.cmd === "telephony_dial");
    expect(dial?.emergency).toBe(true);
    // The platform path was attempted first and declined (this host has no telephony
    // stack), so the daemon's simulation is what placed it — and the screen says so.
    expect(txt(host)).not.toContain(zh["phone.handedToSystem"]);
    expect(txt(host)).toContain(zh["phone.simulatedCall"]);
  });

  // The two-sided control for the classification: the same desktop host, an ordinary
  // number — the flag must reach the daemon as `false`, or every call would be routed
  // onto the privileged emergency path.
  test("a regular number reaches the daemon classified as an ordinary dial", async () => {
    const calls = fakeBridge((cmd) => {
      if (cmd === "telephony_real_dial_status") {
        return { on_device: false, available: false, reason: "desktop" };
      }
      if (cmd === "telephony_dial") return { id: "demo-1" };
      return null;
    });
    const host = render(PhoneApp);
    await typeAndCall(host, "13800000001");

    expect(calls.find((c) => c.cmd === "telephony_dial")?.emergency).toBe(false);
  });

  // And on a host where the platform path works, an ordinary number takes **it** — the
  // daemon must not be reached just because it would answer.
  test("a regular number takes the real system path when it is available", async () => {
    const calls = fakeBridge((cmd) => (cmd === "real_dial" ? "ok" : null));
    const host = render(PhoneApp);
    await typeAndCall(host, "13800000001");

    expect(calls.find((c) => c.cmd === "real_dial")?.number).toBe("13800000001");
    expect(calls.some((c) => c.cmd === "telephony_dial")).toBe(false);
    expect(txt(host)).toContain(zh["phone.handedToSystem"]);
  });

  test("dialing without a daemon shows a localized error, not a fake calling screen", async () => {
    const host = render(PhoneApp);
    await fireEvent.click(key(host, "1")!);
    await fireEvent.click(key(host, "3")!);
    await fireEvent.click(key(host, "8")!);
    const callBtn = host.container.querySelector(`button[aria-label="${zh["phone.call"]}"]`);
    expect(callBtn).toBeTruthy();
    await fireEvent.click(callBtn as HTMLButtonElement);
    await new Promise((r) => setTimeout(r, 10)); // let realDial/telephonyDial settle
    // offline: no in-call UI, but a role=alert with the localized dial error
    expect(host.container.querySelector(`button[aria-label="${zh["a11y.end"]}"]`)).toBeFalsy();
    expect(host.container.querySelector('[role="alert"]')).toBeTruthy();
  });

  test("reopening the app mid-call adopts the live call (telephony_status)", async () => {
    const calls = fakeBridge((cmd) => {
      if (cmd === "telephony_status") {
        return [
          {
            id: "call-77",
            peer: "13800000001",
            state: "Active",
            direction: "Outgoing",
            emergency: false,
            recording: "Off",
          },
        ];
      }
      return null;
    });
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));
    // The live call is adopted → the peer is named and the user can hang up,
    // instead of a bare keypad over a call they cannot end.
    expect(calls.some((c) => c.cmd === "telephony_status")).toBe(true);
    expect(host.container.querySelector(`button[aria-label="${zh["a11y.end"]}"]`)).toBeTruthy();
    expect(txt(host)).toContain("13800000001");
  });

  /**
   * The in-call 拨号盘 toggle is a **disclosure**: its click reveals/hides the DTMF pad,
   * and its accessible name (「拨号盘」) is the same in both states — the pad's presence
   * is the only other signal. Without `aria-expanded` a screen-reader user pressing it a
   * second time has no way to know they are closing it (REQ-A1060).
   */
  test("the DTMF pad toggle announces whether the pad is open (REQ-A1060)", async () => {
    fakeBridge((cmd) =>
      cmd === "telephony_status"
        ? [
            {
              id: "call-dtmf",
              peer: "13800000002",
              state: "Active",
              direction: "Outgoing",
              emergency: false,
              recording: "Off",
            },
          ]
        : null,
    );
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));
    const pad = host.container.querySelector(
      `button[aria-label="${zh["phone.dtmf"]}"]`,
    ) as HTMLButtonElement | null;
    expect(pad).toBeTruthy();
    expect(pad!.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(pad!);
    expect(pad!.getAttribute("aria-expanded")).toBe("true");
    // …and the keypad it revealed is really there, so the state is not a lie.
    expect(txt(host)).toContain("1");
  });

  /**
   * REQ-A1067 — `docs/telephony.md` §5 books the DTMF pad as a *local UI state* and,
   * in the same sentence, promises the screen will say so: 「DTMF 仍为本地 UI 态（按键音
   * 属音频管线）… 界面照旧如实说明、绝不假称音频已变」. The screen did neither. Nothing
   * in the pad told the user the tones stop at the glass, and every key's accessible
   * name was 「**发送**按键 {key}」 — an active claim that the key was transmitted to a
   * call that never receives it (a real caller navigating an IVR presses 1, the IVR
   * never hears it, and the UI blamed neither itself nor the pipeline).
   */
  test("the DTMF pad says the keys are local-only, and its keys do not claim to be sent (REQ-A1067)", async () => {
    fakeBridge((cmd) =>
      cmd === "telephony_status"
        ? [
            {
              id: "call-dtmf-local",
              peer: "13800000003",
              state: "Active",
              direction: "Outgoing",
              emergency: false,
              recording: "Off",
            },
          ]
        : null,
    );
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));
    await fireEvent.click(
      host.container.querySelector(`button[aria-label="${zh["phone.dtmf"]}"]`)!,
    );
    // The pad must carry the honesty notice the doc already claims it carries.
    expect(txt(host)).toContain(zh["phone.dtmfLocal"]);
    // …and a key must not be announced as something it does not do.
    const one = host.container.querySelector(
      `button[aria-label="${zh["phone.dtmfKey"].replace("{key}", "1")}"]`,
    ) as HTMLButtonElement | null;
    expect(one).toBeTruthy();
    expect(one!.getAttribute("aria-label")).not.toContain("发送");
  });

  /**
   * REQ-A1146 / F-SH-453 — the DTMF pad, the speaker route and hold were all reachable
   * from the host and from nowhere else. `telephony_play_dtmf` / `telephony_set_speaker`
   * / `telephony_set_hold` were registered, implemented against Android Telecom and
   * carried typed refusals, but **no screen called them** (`tauri-command-scan`). So the
   * pad's 「仅本机显示（…尚未送到通话）」 was not merely stale — it was the reverse of the
   * truth on a device where AmOS is the default phone app, where the host *could* have
   * delivered the tone and the screen never asked; and speaker/hold had no control at all.
   */
  const LIVE_DTMF = {
    id: "call-dtmf-send",
    peer: "13800000009",
    state: "Active",
    direction: "Outgoing",
    emergency: false,
    recording: "Off",
    muted: false,
  };

  test("a DTMF key is handed to the call, and the pad stops disclaiming the far end", async () => {
    const calls = fakeBridge((cmd) =>
      cmd === "telephony_status" ? [LIVE_DTMF] : cmd === "telephony_play_dtmf" ? true : null,
    );
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));
    await fireEvent.click(key(host, zh["phone.dtmf"])!);
    await fireEvent.click(key(host, zh["phone.dtmfKey"].replace("{key}", "1"))!);

    await vi.waitFor(() => {
      expect(calls.some((c) => c.cmd === "telephony_play_dtmf")).toBe(true);
    });
    // The tone went out **for this call** (the daemon has no audio route, so the request
    // is addressed by call id and nothing else).
    expect(calls.find((c) => c.cmd === "telephony_play_dtmf")).toMatchObject({
      callId: "call-dtmf-send",
      tone: "1",
    });
    // A confirmed delivery retires the local-only sentence — the note now says what the
    // host actually did.
    await vi.waitFor(() => {
      expect(txt(host)).toContain(zh["phone.dtmfSent"]);
    });
    expect(txt(host)).not.toContain(zh["phone.dtmfLocal"]);
  });

  test("a tone the host did not deliver keeps the pad's local-only note", async () => {
    // `Ok(false)` is the host's honest "the tone did not reach the call" (no in-call
    // service is bound) — deliberately not an error, and it must not be reported as one.
    const calls = fakeBridge((cmd) =>
      cmd === "telephony_status" ? [LIVE_DTMF] : cmd === "telephony_play_dtmf" ? false : null,
    );
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));
    await fireEvent.click(key(host, zh["phone.dtmf"])!);
    await fireEvent.click(key(host, zh["phone.dtmfKey"].replace("{key}", "2"))!);
    await vi.waitFor(() => {
      expect(calls.some((c) => c.cmd === "telephony_play_dtmf")).toBe(true);
    });
    expect(txt(host)).toContain(zh["phone.dtmfLocal"]);
    expect(txt(host)).not.toContain(zh["phone.dtmfSent"]);
    expect(host.container.querySelector('[role="alert"]')).toBeNull();
  });

  test("a refused DTMF tone says so rather than failing silently", async () => {
    fakeBridge((cmd) => {
      if (cmd === "telephony_status") return [LIVE_DTMF];
      if (cmd === "telephony_play_dtmf") {
        throw {
          code: "amos.telephony.dtmf_refused",
          message: "telephony DTMF: \"x\" is not a single DTMF tone character",
        };
      }
      return null;
    });
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));
    await fireEvent.click(key(host, zh["phone.dtmf"])!);
    await fireEvent.click(key(host, zh["phone.dtmfKey"].replace("{key}", "3"))!);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[role="alert"]')).toBeTruthy();
    });
    const alert = host.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("not a single DTMF tone character");
    expect(alert.textContent).toContain(zh["phone.dtmfFailed"].split("{detail}")[0]);
  });

  test("the in-call speaker toggle goes through the host and only moves on its answer", async () => {
    const live = { ...LIVE_DTMF, id: "call-spk" };
    const calls = fakeBridge((cmd, args) => {
      if (cmd === "telephony_status") return [live];
      if (cmd === "telephony_set_speaker") return { ...live, speaker: args?.speaker === true };
      return null;
    });
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));

    expect(key(host, zh["phone.speaker"])).toBeTruthy();
    await fireEvent.click(key(host, zh["phone.speaker"])!);
    await vi.waitFor(() => {
      expect(key(host, zh["phone.speakerOff"])).toBeTruthy();
    });
    // The desired state travels, not a toggle — a retried command cannot flip a route
    // the user did not touch.
    expect(calls.find((c) => c.cmd === "telephony_set_speaker")).toMatchObject({
      callId: "call-spk",
      speaker: true,
    });
    expect(key(host, zh["phone.speakerOff"])!.getAttribute("aria-pressed")).toBe("true");

    await fireEvent.click(key(host, zh["phone.speakerOff"])!);
    await vi.waitFor(() => {
      expect(key(host, zh["phone.speaker"])).toBeTruthy();
    });
    expect(calls.filter((c) => c.cmd === "telephony_set_speaker")).toHaveLength(2);
  });

  test("a refused speaker switch says so and leaves the button alone", async () => {
    fakeBridge((cmd) => {
      if (cmd === "telephony_status") return [{ ...LIVE_DTMF, id: "call-spk2" }];
      if (cmd === "telephony_set_speaker") {
        throw {
          code: "amos.telephony.speaker_refused",
          message:
            "telephony speaker: no in-call service is bound (AmOS is not the default phone app)",
        };
      }
      return null;
    });
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));
    await fireEvent.click(key(host, zh["phone.speaker"])!);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[role="alert"]')).toBeTruthy();
    });
    const alert = host.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("no in-call service is bound");
    expect(alert.textContent).toContain(zh["phone.speakerFailed"].split("{detail}")[0]);
    // A fabricated `Ok` would have lit the button over a call still on the earpiece.
    expect(key(host, zh["phone.speaker"])).toBeTruthy();
    expect(key(host, zh["phone.speakerOff"])).toBeNull();
  });

  test("the in-call hold toggle goes through the host and shows the held caption", async () => {
    const live = { ...LIVE_DTMF, id: "call-hold" };
    const calls = fakeBridge((cmd, args) => {
      if (cmd === "telephony_status") return [live];
      if (cmd === "telephony_set_hold") return { ...live, hold: args?.hold === true };
      return null;
    });
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));

    await fireEvent.click(key(host, zh["phone.hold"])!);
    await vi.waitFor(() => {
      expect(key(host, zh["phone.holdOff"])).toBeTruthy();
    });
    expect(calls.find((c) => c.cmd === "telephony_set_hold")).toMatchObject({
      callId: "call-hold",
      hold: true,
    });
    expect(txt(host)).toContain(zh["phone.onHold"]);
  });

  /**
   * The elapsed-call clock is *the call's* duration, not "how long since the last
   * `Active` event I happened to receive".
   *
   * `PhoneApp`'s event handler re-stamped `activeAtRef = Date.now()` on **every**
   * `state === "Active"` event, and `Active` is not a one-shot transition: the daemon
   * re-broadcasts the call's *current* state on a mute / recording toggle
   * (`crates/amos-telephony/src/service.rs` `event_to_state_event` → `proto_state(state)`,
   * so a `MutedChanged`/`RecordingChanged` reaches the WebView as `state: "Active"` for
   * the same id), and the real in-call bridge re-emits on every toggle too
   * (`incall.rs`: "`hold`/`speaker`/`mute` all call `onCallStateChanged`"). So pressing
   * 静音 / 扬声器 / 保持 / 录音 during a live call restarted the on-screen duration at
   * `0:00` — a clock that measures the user's last button press and is titled as the
   * call's length.
   *
   * This runs on real timers (the component's ticker is a real `setInterval`), so the
   * verdict is stated as a **property** — after a repeat `Active` the value must still
   * be advancing — with a wide margin, never as an exact reading.
   */
  test("a repeat Active event does not restart the call's elapsed clock", async () => {
    const live = { ...LIVE_DTMF, id: "call-timer" };
    const { emit } = fakeBridgeWithEvents((cmd) => (cmd === "telephony_status" ? [live] : null));
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));

    // Wait (polling) until the call's own clock has been running for ≥ 2 s, so a later
    // restart is unmistakable.
    await vi.waitFor(
      () => {
        expect(timerSec(host)).not.toBeNull();
        expect(timerSec(host)!).toBeGreaterThanOrEqual(2);
      },
      { timeout: 8000 },
    );
    const before = timerSec(host)!;

    // The repeated `Active` the daemon broadcasts on a mute / record toggle.
    emit({ id: "call-timer", state: "Active", direction: "Outgoing", peer: "13800000009" });

    // One full tick plus a generous margin: with the reset this reads ~1 s; without it,
    // ≥ `before` + 1 s.
    await new Promise((r) => setTimeout(r, 1200));
    expect(timerSec(host)!).toBeGreaterThanOrEqual(before + 1);
  });

  /**
   * The clock must still *start* on the edge into talking — the other leaf of the same
   * guard. A call the app adopts while it is still `Dialing` is not yet talking, so its
   * timer is not on screen and `activeAtRef` is null; the `Active` event that answers it
   * is the moment the duration begins. Without this case, folding the edge test to
   * "never stamp" would leave the clock dead at `0:00` forever and every test above
   * would still pass (the adopted-active call stamps its clock on the `telephony_status`
   * path instead).
   */
  test("the elapsed clock starts when the dialling call is answered", async () => {
    const live = { ...LIVE_DTMF, id: "call-dial", state: "Dialing" };
    const { emit } = fakeBridgeWithEvents((cmd) => (cmd === "telephony_status" ? [live] : null));
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));

    // Still dialling: no in-call clock yet.
    expect(host.container.querySelector('[role="timer"]')).toBeNull();

    emit({ id: "call-dial", state: "Active", direction: "Outgoing", peer: "13800000009" });

    await vi.waitFor(() => {
      expect(host.container.querySelector('[role="timer"]')).not.toBeNull();
    });
    // …and it runs from that moment, not from some frozen value.
    await vi.waitFor(
      () => {
        expect(timerSec(host)!).toBeGreaterThanOrEqual(1);
      },
      { timeout: 8000 },
    );
  });

  /**
   * REQ-A997 — the in-call recording toggle discarded its own refusal.
   *
   * `telephony_start_recording` answers a typed `AmosError` when the device refuses,
   * and `invoke` folds that into `null` — the same value a `void` success has, so
   * `if (res) …` read a refusal as "nothing to say": the button kept its old label and
   * no words appeared. `dialError`/`notice` (`{#if !calling}`) have no slot while a
   * call is up, so this action had **no** render point at all — the same F-SH-236
   * family the sibling `IncomingCall.svelte` already closed on its own toggle.
   */
  test("an in-call recording refusal says so instead of leaving the button unchanged", async () => {
    fakeBridge((cmd) => {
      if (cmd === "telephony_status") {
        return [
          {
            id: "call-99",
            peer: "13700000003",
            state: "Active",
            direction: "Outgoing",
            emergency: false,
            recording: "Off",
          },
        ];
      }
      if (cmd === "telephony_start_recording") {
        throw {
          code: "amos.telephony.recording_refused",
          message: "telephony recording start refused by the in-call service (Failed)",
        };
      }
      return null;
    });
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));

    const rec = host.container.querySelector(
      `button[aria-label="${zh["phone.recordStart"]}"]`,
    ) as HTMLButtonElement | null;
    expect(rec).toBeTruthy();
    await fireEvent.click(rec!);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[role="alert"]')).toBeTruthy();
    });

    const alert = host.container.querySelector('[role="alert"]')!;
    // The host's own words, plus the fold that says which control refused.
    expect(alert.textContent).toContain("refused by the in-call service");
    expect(alert.textContent).toContain(zh["phone.recordFailed"].split("{detail}")[0]);
    // The call is still up — a refused toggle must not end it.
    expect(host.container.querySelector(`button[aria-label="${zh["a11y.end"]}"]`)).toBeTruthy();
  });

  /**
   * The in-call Mute button used to be a purely local flag: `muted = !muted` moved a
   * component variable that no other part of the system could see, so the button's
   * label, its glyph and the「已静音」caption were the *only* place the user was muted —
   * while `lib/phone.ts` states the daemon-managed call binds "recording, mute,
   * ringback" and `recording` really is daemon-owned. This pins the wiring: the toggle
   * must ask the daemon and show the daemon's own answer.
   */
  test("the in-call mute toggle goes through the daemon and shows its answer", async () => {
    const live = {
      id: "call-m1",
      peer: "13800000005",
      state: "Active",
      direction: "Outgoing",
      emergency: false,
      recording: "Off",
      muted: false,
    };
    const calls = fakeBridge((cmd, args) => {
      if (cmd === "telephony_status") return [live];
      if (cmd === "telephony_set_muted") return { ...live, muted: args?.muted === true };
      return null;
    });
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));

    const muteBtn = () =>
      host.container.querySelector(`button[aria-label="${zh["phone.mute"]}"]`) as
        | HTMLButtonElement
        | null;
    expect(muteBtn()).toBeTruthy();
    await fireEvent.click(muteBtn()!);
    await vi.waitFor(() => {
      expect(
        host.container.querySelector(`button[aria-label="${zh["phone.unmute"]}"]`),
      ).toBeTruthy();
    });

    // The request carried the **desired state** (not a toggle) for this call id…
    const sent = calls.find((c) => c.cmd === "telephony_set_muted");
    expect(sent).toMatchObject({ callId: "call-m1", muted: true });
    // …and the caption is the daemon's confirmation, not a local assumption.
    expect(txt(host)).toContain(zh["phone.muted"].split("（")[0]);

    // Unmuting is the same request with the other value — and comes back off.
    await fireEvent.click(
      host.container.querySelector(`button[aria-label="${zh["phone.unmute"]}"]`)!,
    );
    await vi.waitFor(() => {
      expect(muteBtn()).toBeTruthy();
    });
    expect(calls.filter((c) => c.cmd === "telephony_set_muted")).toHaveLength(2);
    expect(txt(host)).not.toContain(zh["phone.muted"].split("（")[0]);
  });

  /**
   * The mute toggle's *refusal* must not read as success. `telephony_set_muted`
   * answers a typed `AmosError` (a real Telecom call has no in-call mute bridge yet),
   * which `invoke` folds into `null` — the same value an empty success has. Flipping
   * the label optimistically would show the user a mute that never reached anything.
   */
  test("a refused mute says so and leaves the button alone", async () => {
    fakeBridge((cmd) => {
      if (cmd === "telephony_status") {
        return [
          {
            id: "call-m2",
            peer: "13800000006",
            state: "Active",
            direction: "Outgoing",
            emergency: false,
            recording: "Off",
            muted: false,
          },
        ];
      }
      if (cmd === "telephony_set_muted") {
        throw {
          code: "amos.telephony.mute_refused",
          message:
            "telephony mute requires an InCallService bridge (P3, device-validated); " +
            "the daemon does not own a real Telecom call",
        };
      }
      return null;
    });
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));

    await fireEvent.click(
      host.container.querySelector(`button[aria-label="${zh["phone.mute"]}"]`)!,
    );
    await vi.waitFor(() => {
      expect(host.container.querySelector('[role="alert"]')).toBeTruthy();
    });

    const alert = host.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("InCallService bridge");
    expect(alert.textContent).toContain(zh["phone.muteFailed"].split("{detail}")[0]);
    // The button did NOT move: the daemon never confirmed the mute.
    expect(
      host.container.querySelector(`button[aria-label="${zh["phone.mute"]}"]`),
    ).toBeTruthy();
    // …and the call is still up.
    expect(host.container.querySelector(`button[aria-label="${zh["a11y.end"]}"]`)).toBeTruthy();
  });

  test("a call ended locally is never re-adopted by a resume recheck", async () => {
    fakeBridge((cmd) => {
      if (cmd === "telephony_status") {
        // The daemon keeps reporting it for a beat after `telephony_end`.
        return [
          {
            id: "call-88",
            peer: "13900000002",
            state: "Active",
            direction: "Outgoing",
            emergency: false,
            recording: "Off",
          },
        ];
      }
      return null;
    });
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));
    await fireEvent.click(host.container.querySelector(`button[aria-label="${zh["a11y.end"]}"]`)!);
    await new Promise((r) => setTimeout(r, 10));
    expect(host.container.querySelector(`button[aria-label="${zh["a11y.end"]}"]`)).toBeFalsy();

    // A resume recheck must not resurrect the call the user just hung up.
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 10));
    expect(host.container.querySelector(`button[aria-label="${zh["a11y.end"]}"]`)).toBeFalsy();
  });

  /**
   * A hang-up the device refuses must not read as done.
   *
   * `telephony_end` answers a typed `AmosError` when the in-call service refuses the
   * hang-up or the daemon is unreachable, and `invoke` folds that into `null` — the
   * same value its `void` success has. `endCall` never read the verdict, so it tore
   * the in-call surface down either way: a call the device never let go of looked
   * hung up, and the key to try again was gone. The sibling `IncomingCall.svelte::leave`
   * already refuses to hide its surface for exactly this reason.
   */
  test("a refused hang-up says so and keeps the call surface", async () => {
    fakeBridge((cmd) => {
      if (cmd === "telephony_status") {
        return [
          {
            id: "call-77",
            peer: "13800000004",
            state: "Active",
            direction: "Outgoing",
            emergency: false,
            recording: "Off",
          },
        ];
      }
      if (cmd === "telephony_end") {
        throw {
          code: "amos.telephony.rpc_failed",
          message: "telephony end: the in-call service refused to hang up",
        };
      }
      return null;
    });
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));

    await fireEvent.click(host.container.querySelector(`button[aria-label="${zh["a11y.end"]}"]`)!);
    await vi.waitFor(() => {
      expect(host.container.querySelector('[role="alert"]')).toBeTruthy();
    });

    const alert = host.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("refused to hang up");
    expect(alert.textContent).toContain(zh["phone.hangupFailed"].split("{detail}")[0]);
    // The call is still up — the surface must stay so the user can try again.
    expect(host.container.querySelector(`button[aria-label="${zh["a11y.end"]}"]`)).toBeTruthy();
  });

  /**
   * REQ-A1096 — the demo 「模拟来电」 button discarded its own refusal.
   *
   * `telephony_simulate_incoming` answers a typed `AmosError` when the daemon is
   * unreachable or refuses the ring, and `invoke` folds that into `null`. `simIncoming`
   * awaited it and read nothing, so a refusal and a granted ring looked identical: the
   * keypad went on saying 「模拟来电」 and no words explained that nothing was coming.
   * Worse, it bounced the Dock **before** the await, so the one acknowledgement it did
   * make claimed a call that never arrived. `dialError` — rendered under `{#if !calling}`,
   * the keypad's own slot — is the render point; `inCallError` lives inside `{#if calling}`
   * and has none here.
   */
  test("a refused simulate-incoming says so and does not bounce the Dock", async () => {
    fakeBridge((cmd) => {
      if (cmd === "telephony_simulate_incoming") {
        throw {
          code: "amos.telephony.rpc_failed",
          message: "telephony simulate-incoming failed: the daemon is unreachable",
        };
      }
      return null;
    });
    const bounces: string[] = [];
    const onBounce = (e: Event) => bounces.push((e as CustomEvent).detail.appId);
    window.addEventListener("dock-bounce", onBounce);
    try {
      const host = render(PhoneApp);
      await new Promise((r) => setTimeout(r, 10));
      await fireEvent.click(key(host, zh["phone.simIncoming"])!);
      await vi.waitFor(() => {
        expect(host.container.querySelector('[role="alert"]')).toBeTruthy();
      });

      const alert = host.container.querySelector('[role="alert"]')!;
      // The host's own words, plus the fold that says which control refused.
      expect(alert.textContent).toContain("the daemon is unreachable");
      expect(alert.textContent).toContain(zh["phone.simIncomingFailed"].split("{detail}")[0]);
      // The Dock must not bounce: a bounce is a claim that a call is arriving.
      expect(bounces).not.toContain("phone");
    } finally {
      window.removeEventListener("dock-bounce", onBounce);
    }
  });

  /**
   * The sibling above, from the other side: a **granted** ring must still bounce the Dock
   * when the phone app is not in front (the demo's whole point) and must say nothing — the
   * alert slot stays empty. Without this, "always refuse" would pass the case above.
   */
  test("a granted simulate-incoming bounces the Dock and reports nothing", async () => {
    fakeBridge((cmd) => {
      if (cmd === "telephony_simulate_incoming") return "call-sim-1";
      return null;
    });
    const bounces: string[] = [];
    const onBounce = (e: Event) => bounces.push((e as CustomEvent).detail.appId);
    window.addEventListener("dock-bounce", onBounce);
    try {
      const host = render(PhoneApp);
      await new Promise((r) => setTimeout(r, 10));
      await fireEvent.click(key(host, zh["phone.simIncoming"])!);
      await vi.waitFor(() => {
        expect(bounces).toContain("phone");
      });
      expect(host.container.querySelector('[role="alert"]')).toBeFalsy();
    } finally {
      window.removeEventListener("dock-bounce", onBounce);
    }
  });

  test("no live call on the daemon → the keypad shows (nothing invented)", async () => {
    fakeBridge(() => null);
    const host = render(PhoneApp);
    await new Promise((r) => setTimeout(r, 10));
    expect(host.container.querySelector(`button[aria-label="${zh["a11y.end"]}"]`)).toBeFalsy();
    expect(host.container.querySelector(`button[aria-label="${zh["phone.call"]}"]`)).toBeTruthy();
  });

  test("blocklist tab adds, lists and removes rules through the bridge", async () => {
    let rules: Record<string, unknown>[] = [];
    let unknown = false;
    const calls = fakeBridge((cmd, args) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: unknown, rules };
      if (cmd === "blocklist_status") return NO_STATUS;
      if (cmd === "blocklist_add") {
        const r = {
          id: `${String(args?.pattern)}|exact|both`,
          pattern: String(args?.pattern),
          kind: String(args?.kind),
          channel: String(args?.channel),
          label: String(args?.label ?? ""),
          created_ms: 1,
        };
        rules = [...rules, r];
        return r;
      }
      if (cmd === "blocklist_remove") {
        rules = rules.filter((r) => r.id !== args?.id);
        return true;
      }
      if (cmd === "blocklist_set_unknown") {
        unknown = args?.on === true;
        return null;
      }
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    await fireEvent.input(host.container.querySelector('input[data-testid="block-number"]') as HTMLInputElement, {
      target: { value: "1069" },
    });
    await fireEvent.click(host.container.querySelector('button[data-testid="block-add"]') as HTMLButtonElement);
    await flush();
    const added = calls.find((c) => c.cmd === "blocklist_add");
    expect(added?.pattern).toBe("1069");
    expect(added?.kind).toBe("exact");
    expect(added?.channel).toBe("both");
    expect(txt(host)).toContain("1069");
    // The unknown-number switch reaches the same rule store.
    await fireEvent.click(host.container.querySelector('button[data-testid="block-unknown"]') as HTMLButtonElement);
    await flush();
    expect(calls.find((c) => c.cmd === "blocklist_set_unknown")?.on).toBe(true);
    // Removing the rule drops it from the list.
    await fireEvent.click(host.container.querySelector('button[data-testid="block-remove-1069"]') as HTMLButtonElement);
    await flush();
    expect(rules.length).toBe(0);
  });

  test("an unrelated failure cannot roll back the unknown-number switch (REQ-A296)", async () => {
    // Property guard, not a proof of misattribution: the switch asks about **its own**
    // command now, so an accepted save stands even while other commands fail. (Measured:
    // every production read sits immediately after its own `await`, so the pre-REQ-A296
    // global slot also answered correctly here — the discriminating cases live in
    // `__tests__/backend.test.ts` and `__tests__/nativeApps.test.ts`.)
    let snapshotsFail = false;
    fakeBridge((cmd) => {
      if (cmd === "blocklist_set_unknown") return null; // answered ⇒ saved
      if (cmd === "blocklist_snapshot") {
        if (snapshotsFail) throw new Error("snapshot failed");
        return { block_unknown: false, rules: [] };
      }
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    const sw = () =>
      host.container.querySelector('button[data-testid="block-unknown"]') as HTMLButtonElement;
    expect(sw().getAttribute("aria-pressed")).toBe("false");

    snapshotsFail = true; // every re-read from here on fails
    await fireEvent.click(sw());
    await flush();
    expect(sw().getAttribute("aria-pressed")).toBe("true");
    expect(txt(host)).not.toContain(zh["phone.blockSaveFailed"]);
  });

  // `blocklist_clear` is a `void` command (REQ-A835 / F-SH-265): `invoke` never rejects, so
  // the reply cannot say whether the rules were dropped. `refreshBlock()` re-reads, so the
  // failure was never *drawn* as success — the rules stayed on screen — but nothing said
  // why, so "clear every rule" was a silent no-op the user could only re-click blindly.
  // The direction is the safe one (the blocklist stays in force), which is exactly why it
  // went unnoticed.
  test("a clear the daemon never confirmed is reported, not silently ignored (REQ-A835)", async () => {
    const rules = [
      { id: "1069|exact|both", pattern: "1069", kind: "exact", channel: "both", label: "", created_ms: 1 },
    ];
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules };
      if (cmd === "blocklist_status") return NO_STATUS;
      if (cmd === "blocklist_clear") throw new Error("daemon unreachable");
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    const clear = () =>
      host.container.querySelector('button[data-testid="block-clear"]') as HTMLButtonElement;
    await fireEvent.click(clear()); // arm the two-step confirm
    await fireEvent.click(clear()); // fire
    await vi.waitFor(() => expect(txt(host)).toContain(zh["phone.blockSaveFailed"]));
    // The failure is not drawn as success: the rule the daemon kept is still listed.
    expect(calls.some((c) => c.cmd === "blocklist_clear")).toBe(true);
    expect(txt(host)).toContain("1069");
  });

  test("a clear the daemon confirms reports nothing", async () => {
    let rules = [
      { id: "1069|exact|both", pattern: "1069", kind: "exact", channel: "both", label: "", created_ms: 1 },
    ];
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules };
      if (cmd === "blocklist_status") return NO_STATUS;
      if (cmd === "blocklist_clear") {
        rules = []; // the daemon really dropped them
        return null;
      }
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    const clear = () =>
      host.container.querySelector('button[data-testid="block-clear"]') as HTMLButtonElement;
    await fireEvent.click(clear());
    await fireEvent.click(clear());
    await vi.waitFor(() => expect(txt(host)).toContain(zh["phone.blockEmpty"]));
    expect(txt(host)).not.toContain(zh["phone.blockSaveFailed"]);
  });

  test("the block field previews a match the daemon already covers (blocklist_check)", async () => {
    const calls = fakeBridge((cmd, args) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      if (cmd === "blocklist_check") {
        return String(args?.address).startsWith("10086")
          ? { kind: "rule", id: "r1", pattern: "10086*", label: "", channel: "both" }
          : null;
      }
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    await fireEvent.input(
      host.container.querySelector('input[data-testid="block-number"]') as HTMLInputElement,
      { target: { value: "1008611" } },
    );
    await new Promise((r) => setTimeout(r, 300)); // preview is debounced (250 ms)
    expect(calls.some((c) => c.cmd === "blocklist_check")).toBe(true);
    const preview = host.container.querySelector('[data-testid="block-preview"]');
    expect(preview).toBeTruthy();
    expect(preview?.textContent ?? "").toContain("10086*");
  });

  test("no match → no preview (a null reply is never shown as \"safe\")", async () => {
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null; // blocklist_check → null (allowed OR unavailable — claim nothing)
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    await fireEvent.input(
      host.container.querySelector('input[data-testid="block-number"]') as HTMLInputElement,
      { target: { value: "12345678" } },
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(host.container.querySelector('[data-testid="block-preview"]')).toBeNull();
  });

  test("a preview reply landing after the field is cleared is dropped, not drawn (REQ-A1077)", async () => {
    // The debounce cleanup only clears the *pending timer*, never the in-flight
    // `blocklistCheck` promise. A reply that lands after the input was emptied still
    // writes `blockPreview`, resurrecting a match for a number the user abandoned.
    let resolveCheck: (v: unknown) => void = () => {};
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      if (cmd === "blocklist_check") return new Promise((res) => (resolveCheck = res));
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    const field = () =>
      host.container.querySelector('input[data-testid="block-number"]') as HTMLInputElement;
    await fireEvent.input(field(), { target: { value: "1008611" } });
    await new Promise((r) => setTimeout(r, 300)); // the 250 ms debounce fires; the check is in flight
    expect(calls.some((c) => c.cmd === "blocklist_check")).toBe(true);
    // The user abandons the number before the daemon answers.
    await fireEvent.input(field(), { target: { value: "" } });
    await flush();
    expect(host.container.querySelector('[data-testid="block-preview"]')).toBeNull();
    resolveCheck({ kind: "rule", id: "r1", pattern: "10086*", label: "", channel: "both" });
    await flush();
    await flush();
    expect(host.container.querySelector('[data-testid="block-preview"]')).toBeNull();
  });

  test("clear-all wipes every rule after a confirm tap (blocklist_clear)", async () => {
    let rules: Record<string, unknown>[] = [
      { id: "r1", pattern: "10086", kind: "exact", channel: "both", label: "", created_ms: 1 },
    ];
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules };
      if (cmd === "blocklist_status") return NO_STATUS;
      if (cmd === "blocklist_clear") {
        rules = [];
        return null;
      }
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    const clearBtn = () =>
      host.container.querySelector('button[data-testid="block-clear"]') as HTMLButtonElement | null;
    expect(clearBtn()).toBeTruthy();
    await fireEvent.click(clearBtn()!); // arms the confirm
    expect(calls.some((c) => c.cmd === "blocklist_clear")).toBe(false);
    await fireEvent.click(clearBtn()!); // confirms
    await flush();
    expect(calls.some((c) => c.cmd === "blocklist_clear")).toBe(true);
    expect(rules.length).toBe(0);
    expect(txt(host)).toContain("黑名单为空");
  });

  test("the 拦截 tab shows ONLY the block panel (never the emergency page)", async () => {
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    // Regression: the tab chain used to end in a bare `{:else}` (the emergency
    // page), so the 拦截 tab rendered the whole emergency list *above* the block
    // panel — the "拦截页面不正常" the user reported. Guard both directions.
    await openBlockTab(host);
    await flush();
    expect(host.container.querySelector('[data-testid="blocklist-panel"]')).toBeTruthy();
    expect(host.container.querySelector('button[aria-label="紧急呼叫 110"]')).toBeNull();
    expect(txt(host)).not.toContain("紧急号码");
    // …and the emergency tab still renders its own page (and no block panel).
    const emTab = [...host.container.querySelectorAll('button[role="tab"]')].find((b) =>
      (b.textContent ?? "").includes("紧急"),
    ) as HTMLButtonElement;
    await fireEvent.click(emTab);
    await flush();
    expect(host.container.querySelector('button[aria-label="紧急呼叫 110"]')).toBeTruthy();
    expect(host.container.querySelector('[data-testid="blocklist-panel"]')).toBeNull();
  });

  test("a rejected rule surfaces the honest error instead of silently doing nothing", async () => {
    // Tauri *rejects* the command promise on a domain rejection; without a catch
    // this used to leave the screen unchanged with no explanation.
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      if (cmd === "blocklist_add") throw new Error("invalid number");
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    await fireEvent.input(host.container.querySelector('input[data-testid="block-number"]') as HTMLInputElement, {
      target: { value: "abc" },
    });
    await fireEvent.click(host.container.querySelector('button[data-testid="block-add"]') as HTMLButtonElement);
    await flush();
    const alert = host.container.querySelector('[role="alert"]');
    expect(alert?.textContent ?? "").toContain("号码无效");
    expect(calls.some((c) => c.cmd === "blocklist_add")).toBe(true);
  });

  test("a call rule without the Call Screening role shows a grant prompt that requests it", async () => {
    let roleHeld = false;
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") {
        return {
          block_unknown: false,
          rules: [{ id: "r", pattern: "10086", kind: "exact", channel: "call", label: "", created_ms: 1 }],
        };
      }
      if (cmd === "blocklist_status") {
        return {
          has_call_rules: true,
          filters_calls: true,
          has_sms_rules: false,
          role_supported: true,
          role_held: roleHeld,
          role_requestable: true,
        };
      }
      if (cmd === "blocklist_request_role") {
        roleHeld = true;
        return true;
      }
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    expect(host.container.querySelector('[data-testid="block-role-needed"]')).toBeTruthy();
    await fireEvent.click(
      host.container.querySelector('button[data-testid="block-grant-role"]') as HTMLButtonElement,
    );
    await flush();
    expect(calls.some((c) => c.cmd === "blocklist_request_role")).toBe(true);
    // After the role is granted the UI says blocking is actually live.
    expect(host.container.querySelector('[data-testid="block-role-held"]')).toBeTruthy();
  });

  test("re-probes the Call Screening role when the app resumes", async () => {
    // The grant happens in the system's own Activity, so the answer arrives after
    // `blocklist_request_role` already returned. Coming back to the foreground
    // must re-read the status instead of showing a stale "needs granting" banner.
    let roleHeld = false;
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") {
        return {
          block_unknown: false,
          rules: [{ id: "r", pattern: "10086", kind: "exact", channel: "call", label: "", created_ms: 1 }],
        };
      }
      if (cmd === "blocklist_status") {
        return {
          has_call_rules: true,
          filters_calls: true,
          has_sms_rules: false,
          role_supported: true,
          role_held: roleHeld,
          role_requestable: true,
        };
      }
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    expect(host.container.querySelector('[data-testid="block-role-needed"]')).toBeTruthy();
    const before = calls.filter((c) => c.cmd === "blocklist_status").length;
    // User answers the system dialog (granted) → our WebView becomes visible again.
    roleHeld = true;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(calls.filter((c) => c.cmd === "blocklist_status").length).toBeGreaterThan(before);
    expect(host.container.querySelector('[data-testid="block-role-held"]')).toBeTruthy();
    // A revoke outside the app is reflected the same way (honest both directions).
    roleHeld = false;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(host.container.querySelector('[data-testid="block-role-needed"]')).toBeTruthy();
  });

  test("call rules nobody enforces say so instead of rendering nothing", async () => {
    // Desktop / Android-without-the-role: `role_supported` is false and the glue is
    // not requestable, so no grant can be offered. Rules alone reject nothing, and
    // an empty banner would read as "all good" — the state must be rendered.
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot")
        return {
          block_unknown: false,
          rules: [{ id: "r", pattern: "10086", kind: "exact", channel: "call", label: "", created_ms: 1 }],
        };
      if (cmd === "blocklist_status")
        return {
          has_call_rules: true,
          filters_calls: true,
          has_sms_rules: false,
          role_supported: false,
          role_held: false,
          role_requestable: false,
        };
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    expect(host.container.querySelector('[data-testid="block-role-unavailable"]')).toBeTruthy();
    // Nothing can be asked for here → no dead grant button, and no false "held".
    expect(host.container.querySelector('button[data-testid="block-grant-role"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="block-role-held"]')).toBeNull();
  });

  test("a refused enforcement probe says so instead of rendering nothing (REQ-A1513)", async () => {
    // `blocklistStatus()` is `BlocklistStatusOut | null`, and `invoke` resolves `null`
    // for a refused command. `null` is NOT desktop: `blocklist_status` is registered
    // unconditionally and the desktop `role_probe()` Err is *answered* as
    // `role_supported:false` (`blocklist.rs` `role_status_from`). So a `null` here only
    // ever means "we never got an answer" — and `!!blockStatus?.filters_calls` folded
    // that into `false`, drawing the whole banner as **nothing**: the very 「(or like
    // nothing at all)」 the panel's own comment promises can never happen, hiding the
    // grant remedy for a screen whose rules *did* load.
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot")
        return {
          block_unknown: false,
          rules: [{ id: "r", pattern: "10086", kind: "exact", channel: "call", label: "", created_ms: 1 }],
        };
      if (cmd === "blocklist_status") return null; // the probe was refused
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    // The rules list is fine — only the enforcement probe was refused.
    expect(txt(host)).toContain("10086");
    // Pre-fix there was not one word here: a silent blank where an enforcement
    // verdict belongs.
    expect(host.container.querySelector('[data-testid="block-status-unanswered"]')).toBeTruthy();
  });

  test("an answered «not filtering calls» draws no unanswered sentence (REQ-A1513)", async () => {
    // The paired arm: kills a "just always draw the sentence" implementation. The host
    // answered `filters_calls:false` — that is a verdict, not a refusal, so the banner
    // stays legitimately empty.
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    expect(host.container.querySelector('[data-testid="block-status-unanswered"]')).toBeNull();
    expect(txt(host)).not.toContain(zh["phone.blockStatusUnanswered"]);
  });

  // ---- default phone app (ROLE_DIALER), REQ-A1180 -------------------------------

  test("a phone that is not the default dialer offers the role grant, and the app asks for it", async () => {
    // The precondition for the whole real in-call seam: answer / hang-up / mute /
    // speaker / hold / DTMF / recording all refuse until this role is held, so the
    // screen must both say so and offer the way to fix it.
    let held = false;
    const calls = fakeBridge((cmd) => {
      if (cmd === "telephony_default_dialer_status") {
        return { role_supported: true, role_held: held, role_requestable: true };
      }
      if (cmd === "telephony_request_default_dialer") {
        held = true;
        return true;
      }
      return null;
    });
    const host = render(PhoneApp);
    await flush();
    expect(host.container.querySelector('[data-testid="dialer-role-needed"]')).toBeTruthy();
    await fireEvent.click(
      host.container.querySelector('button[data-testid="dialer-grant-role"]') as HTMLButtonElement,
    );
    await flush();
    expect(calls.some((c) => c.cmd === "telephony_request_default_dialer")).toBe(true);
    // The verdict comes from the re-read status, not from the command's answer.
    expect(host.container.querySelector('[data-testid="dialer-role-needed"]')).toBeNull();
  });

  test("a role request that cannot be delivered says so instead of rendering nothing", async () => {
    // `supported` but the glue is not bound: the role is real, the button would be a
    // dead end. The honest state must still be rendered.
    fakeBridge((cmd) =>
      cmd === "telephony_default_dialer_status"
        ? { role_supported: true, role_held: false, role_requestable: false }
        : null,
    );
    const host = render(PhoneApp);
    await flush();
    expect(host.container.querySelector('[data-testid="dialer-role-unavailable"]')).toBeTruthy();
    expect(host.container.querySelector('button[data-testid="dialer-grant-role"]')).toBeNull();
  });

  test("a refused role request is reported rather than leaving a silent button", async () => {
    // `invoke` folds a rejection into `null` (no throw), so a bare `if (ok)` would call
    // this a success-with-nothing-to-say. The diagnosis slot decides.
    fakeBridge((cmd) => {
      if (cmd === "telephony_default_dialer_status") {
        return { role_supported: true, role_held: false, role_requestable: true };
      }
      if (cmd === "telephony_request_default_dialer") throw new Error("no activity");
      return null;
    });
    const host = render(PhoneApp);
    await flush();
    await fireEvent.click(
      host.container.querySelector('button[data-testid="dialer-grant-role"]') as HTMLButtonElement,
    );
    await flush();
    expect(host.container.querySelector('[data-testid="dialer-role-error"]')).toBeTruthy();
    // The prompt stays: nothing was granted.
    expect(host.container.querySelector('[data-testid="dialer-role-needed"]')).toBeTruthy();
  });

  test("a refused default-phone-app probe says so instead of rendering nothing (REQ-A1531)", async () => {
    // `telephony_default_dialer_status` answers a `DialerRoleStatus` (non-`Result`,
    // registered unconditionally), and the desktop `role_supported:false` is an
    // **answered** value — so a `null` here can only mean the command was refused.
    // Folding it into `!!dialerRole?.role_supported` made the whole prompt render as
    // nothing at all — the very state its own comment promised could not happen.
    fakeBridge((cmd) => (cmd === "telephony_default_dialer_status" ? null : null));
    const host = render(PhoneApp);
    await flush();
    const unanswered = host.container.querySelector('[data-testid="dialer-role-unanswered"]');
    expect(unanswered).toBeTruthy();
    expect(txt(host)).toContain(zh["phone.dialerRoleStatusUnanswered"]);
    expect(host.container.querySelector('[data-testid="dialer-role-needed"]')).toBeNull();
  });

  test("the default-phone-app prompt stays hidden where the role does not exist", async () => {
    // Desktop / a device with no telephony: there is no role to hold and nothing to
    // grant, so neither the prompt nor the "cannot ask" line belongs on the keypad.
    // The host **answered** this — so the "we could not ask" sentence must not appear
    // (the paired arm that kills a "just always draw the sentence" implementation).
    fakeBridge((cmd) =>
      cmd === "telephony_default_dialer_status"
        ? { role_supported: false, role_held: false, role_requestable: false }
        : null,
    );
    const host = render(PhoneApp);
    await flush();
    expect(host.container.querySelector('[data-testid="dialer-role-needed"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="dialer-role-unavailable"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="dialer-role-unanswered"]')).toBeNull();
    expect(txt(host)).not.toContain(zh["phone.dialerRoleStatusUnanswered"]);
  });

  test("re-probes the default-phone-app role when the app resumes", async () => {
    // The grant dialog is a separate system Activity, so the answer arrives after
    // `telephony_request_default_dialer` returned. Coming back to the foreground must
    // re-read the status instead of keeping a stale prompt (or a stale "all good").
    let held = false;
    const calls = fakeBridge((cmd) => {
      if (cmd === "telephony_default_dialer_status") {
        return { role_supported: true, role_held: held, role_requestable: true };
      }
      return null;
    });
    const host = render(PhoneApp);
    await flush();
    expect(host.container.querySelector('[data-testid="dialer-role-needed"]')).toBeTruthy();
    const before = calls.filter((c) => c.cmd === "telephony_default_dialer_status").length;
    held = true;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(calls.filter((c) => c.cmd === "telephony_default_dialer_status").length).toBeGreaterThan(
      before,
    );
    expect(host.container.querySelector('[data-testid="dialer-role-needed"]')).toBeNull();
    // A revoke outside the app is reflected the same way (honest in both directions).
    held = false;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(host.container.querySelector('[data-testid="dialer-role-needed"]')).toBeTruthy();
  });

  test("the unknown-number switch alone warrants the Call Screening role prompt", async () => {
    // REQ-A1132 / F-SH-440. `Blocklist::check(address, Channel::Call)` returns
    // `Unknown` for an unparseable/withheld address when the 「屏蔽未知/隐藏号码」
    // switch is on, and `block_unknown` is the *only* thing that rejects it. So with
    // the switch on and **zero** explicit call rules the call path still rejects
    // calls — the banner (and, in Kotlin, the role request) must be armed by the
    // switch too. This is the call-side twin of `filters_sms`, which exists for
    // exactly this reason on the SMS path.
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: true, rules: [] };
      if (cmd === "blocklist_status")
        return {
          // The daemon's answer to "can the call path reject anything?" (a rule OR
          // the switch) — NOT `has_call_rules`, which is false here by construction.
          filters_calls: true,
          has_call_rules: false,
          has_sms_rules: false,
          role_supported: true,
          role_held: false,
          role_requestable: true,
        };
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    expect(host.container.querySelector('[data-testid="block-role-needed"]')).toBeTruthy();
  });

  test("flipping the unknown-number switch re-probes the enforcement banner", async () => {
    // REQ-A1136 / F-SH-442. `filters_calls` is recomputed by the host from *rules OR
    // the unknown-number switch*, so the switch is an input to the banner this very
    // panel draws. Every other mutator re-reads the status after it writes
    // (`addBlockRule`, `removeBlockRule`, `clearAllRules`, `requestBlockRole`), but
    // `toggleBlockUnknown` did not — so the moment `filters_calls` began to depend on
    // the switch, turning 「屏蔽未知/隐藏号码」 on left the panel silent about whether
    // anything enforces it, until the tab was left and re-entered.
    let on = false;
    const calls = fakeBridge((cmd, args) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: on, rules: [] };
      if (cmd === "blocklist_status") {
        // The daemon recomputes this from rules + the switch, exactly as
        // `BlocklistState::filters_calls` does (`blocklist.rs`).
        return {
          filters_calls: on,
          has_call_rules: false,
          has_sms_rules: false,
          role_supported: true,
          role_held: false,
          role_requestable: true,
        };
      }
      if (cmd === "blocklist_set_unknown") {
        on = args?.on as boolean;
        return null;
      }
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    // Nothing is armed yet: no rule covers calls and the switch is off.
    expect(host.container.querySelector('[data-testid="block-role-needed"]')).toBeNull();
    await fireEvent.click(
      host.container.querySelector('button[data-testid="block-unknown"]') as HTMLButtonElement,
    );
    await flush();
    expect(calls.some((c) => c.cmd === "blocklist_set_unknown")).toBe(true);
    // The switch now arms call rejection — the banner must appear without a tab switch.
    expect(host.container.querySelector('[data-testid="block-role-needed"]')).toBeTruthy();
  });

  test("a supported role on a glue that never bound reads 'cannot ask', not 'not granted'", async () => {
    // REQ-A800 / F-DEV-099. `screeningRoleSupported()` is a bare `SDK_INT >= 29`
    // check — it succeeds even when `BlocklistGlue.bind` never ran — while
    // `screeningRoleHeldBound()` returns its `appContext ?: return false` default.
    // So this triple is "we could not ask", not "the role is off". Rendering it as
    // `block-role-needed` tells the user 「AmOS 未获系统「来电筛选」权限——来电不会被拒接」
    // (a device fact nobody learned) and offers a grant button that
    // `requestScreeningRoleBound()` answers `false` to without doing anything.
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot")
        return {
          block_unknown: false,
          rules: [{ id: "r", pattern: "10086", kind: "exact", channel: "call", label: "", created_ms: 1 }],
        };
      if (cmd === "blocklist_status")
        return {
          has_call_rules: true,
          filters_calls: true,
          has_sms_rules: false,
          role_supported: true,
          role_held: false,
          role_requestable: false,
        };
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    // The honest sentence already exists and names this exact state (「…原生桥未就绪」).
    expect(host.container.querySelector('[data-testid="block-role-unavailable"]')).toBeTruthy();
    expect(host.container.querySelector('[data-testid="block-role-needed"]')).toBeNull();
    expect(host.container.querySelector('button[data-testid="block-grant-role"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="block-role-held"]')).toBeNull();
  });

  test("a held role reports active and never offers the grant button", async () => {
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot")
        return {
          block_unknown: false,
          rules: [{ id: "r", pattern: "10086", kind: "exact", channel: "call", label: "", created_ms: 1 }],
        };
      if (cmd === "blocklist_status")
        return {
          has_call_rules: true,
          filters_calls: true,
          has_sms_rules: false,
          role_supported: true,
          role_held: true,
          role_requestable: true,
        };
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    expect(host.container.querySelector('[data-testid="block-role-held"]')).toBeTruthy();
    expect(host.container.querySelector('button[data-testid="block-grant-role"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="block-role-needed"]')).toBeNull();
  });

  test("recents offers a one-tap block that adds an exact/both rule", async () => {
    writeStoreValue(CALLLOG_KEY, [{ number: "18616091470", ts: 1 }]);
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      if (cmd === "blocklist_add") {
        return { id: "x", pattern: "18616091470", kind: "exact", channel: "both", label: "", created_ms: 1 };
      }
      return null;
    });
    const host = render(PhoneApp);
    const recent = [...host.container.querySelectorAll('button[role="tab"]')].find((b) =>
      (b.textContent ?? "").includes("最近"),
    ) as HTMLButtonElement;
    await fireEvent.click(recent);
    await flush();
    const blockBtn = host.container.querySelector(
      'button[data-testid="block-caller-18616091470"]',
    ) as HTMLButtonElement;
    expect(blockBtn).toBeTruthy();
    // the hook id lives in data-testid; what a screen reader announces is real copy (REQ-A1080)
    expect(blockBtn.getAttribute("aria-label")).toBe(zh["phone.blockThisNumber"]);
    await fireEvent.click(blockBtn);
    await flush();
    const added = calls.find((c) => c.cmd === "blocklist_add");
    expect(added?.pattern).toBe("18616091470");
    expect(added?.kind).toBe("exact");
    expect(added?.channel).toBe("both");
  });

  test("the history page lists calls with direction/time and can call back", async () => {
    const now = Date.now();
    writeStoreValue(CALLLOG_KEY, [
      { number: "18616091470", ts: now, direction: "missed" },
      { number: "10086", ts: now - 5000, direction: "outgoing" },
    ]);
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      // A desktop demo host: the real platform path cannot fire, so the daemon's
      // simulated call is what places this one.
      if (cmd === "telephony_real_dial_status") {
        return { on_device: false, available: false, reason: "desktop" };
      }
      if (cmd === "telephony_dial") return { id: "c1", state: "Dialing" };
      return null;
    });
    const host = render(PhoneApp);
    await openHistoryTab(host);
    await flush();
    const rows = host.container.querySelectorAll('[data-testid="history-row"]');
    expect(rows.length).toBe(2);
    // newest first + direction is carried through (no guessing for legacy rows)
    expect(rows[0]!.getAttribute("data-direction")).toBe("missed");
    expect(rows[1]!.getAttribute("data-direction")).toBe("outgoing");
    // the missed summary is shown (1 missed)
    expect(host.container.querySelector('[data-testid="missed-count"]')).toBeTruthy();
    // call back places a real call for that row's number
    const callBack = host.container.querySelector(
      'button[data-testid="call-back-18616091470"]',
    ) as HTMLButtonElement;
    // the hook id lives in data-testid; the announced name is real copy (REQ-A1080)
    expect(callBack.getAttribute("aria-label")).toBe(zh["phone.callBack"]);
    await fireEvent.click(callBack);
    await flush();
    const dial = calls.find((c) => c.cmd === "telephony_dial");
    expect(dial?.number).toBe("18616091470");
  });

  test("the frequent page does not print a contactless number twice (REQ-A1085)", async () => {
    // No contact for this number, so its name IS its number (same rule as the
    // history page, docs/telephony.md §13): the row must not render it once as
    // the label and again as the trailing number.
    writeStoreValue(CALLLOG_KEY, [
      { number: "10086", ts: Date.now() },
      { number: "10086", ts: Date.now() - 1000 },
    ]);
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    await openFrequentTab(host);
    await flush();
    const rows = host.container.querySelectorAll('[data-testid="frequent-row"]');
    expect(rows.length).toBe(1);
    const text = rows[0]!.textContent ?? "";
    const hits = text.split("10086").length - 1;
    expect(hits).toBe(1);
  });

  test("the frequent page still shows a name alongside the number when a contact matches", async () => {
    writeStoreValue(CALLLOG_KEY, [
      { number: "10086", ts: Date.now(), name: "客服热线" },
      { number: "10086", ts: Date.now() - 1000, name: "客服热线" },
    ]);
    writeStoreValue(CONTACTS_KEY, [{ id: "c", name: "客服热线", phones: ["10086"] }]);
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    await openFrequentTab(host);
    await flush();
    const row = host.container.querySelector('[data-testid="frequent-row"]') as HTMLButtonElement;
    expect(row.textContent ?? "").toContain("客服热线");
    expect(row.textContent ?? "").toContain("10086");
  });

  test("history direction filters narrow the rows and tell an empty filter apart", async () => {
    const now = Date.now();
    writeStoreValue(CALLLOG_KEY, [
      { number: "18616091470", ts: now, direction: "missed" },
      { number: "10086", ts: now - 5000, direction: "outgoing" },
      { number: "13800138000", ts: now - 9000, direction: "incoming" },
    ]);
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    await openHistoryTab(host);
    await flush();
    const rows = () => host.container.querySelectorAll('[data-testid="history-row"]');
    const chip = (f: string) =>
      host.container.querySelector(`button[data-filter="${f}"]`) as HTMLButtonElement;
    expect(rows().length).toBe(3);
    expect(host.container.querySelector('[data-testid="history-filters"]')).toBeTruthy();
    await fireEvent.click(chip("missed"));
    await flush();
    expect(rows().length).toBe(1);
    expect(rows()[0]!.getAttribute("data-direction")).toBe("missed");
    await fireEvent.click(chip("incoming"));
    await flush();
    expect(rows().length).toBe(1);
    expect(rows()[0]!.getAttribute("data-direction")).toBe("incoming");
    // back to everything
    await fireEvent.click(chip("all"));
    await flush();
    expect(rows().length).toBe(3);
  });

  test("an empty direction filter is honest (not 'no recent calls')", async () => {
    writeStoreValue(CALLLOG_KEY, [{ number: "10086", ts: Date.now(), direction: "outgoing" }]);
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    await openHistoryTab(host);
    await flush();
    await fireEvent.click(
      host.container.querySelector('button[data-filter="missed"]') as HTMLButtonElement,
    );
    await flush();
    const empty = host.container.querySelector('[data-testid="history-empty"]')!;
    expect(empty.textContent).toContain("该筛选下暂无记录");
    expect(empty.textContent).not.toContain("暂无最近通话");
  });

  test("clearing the history is two-step, cancellable, and really empties the log", async () => {
    writeStoreValue(CALLLOG_KEY, [{ number: "10086", ts: Date.now(), direction: "outgoing" }]);
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    await openHistoryTab(host);
    await flush();
    const el = (id: string) =>
      host.container.querySelector(`button[data-testid="${id}"]`) as HTMLButtonElement;
    // First tap only arms the confirm — nothing is cleared yet.
    await fireEvent.click(el("history-clear"));
    await flush();
    expect(host.container.querySelectorAll('[data-testid="history-row"]').length).toBe(1);
    // Cancel keeps the log.
    await fireEvent.click(el("history-clear-cancel"));
    await flush();
    expect(host.container.querySelectorAll('[data-testid="history-row"]').length).toBe(1);
    // Arm again and confirm → the log is gone and the persisted value is empty.
    await fireEvent.click(el("history-clear"));
    await flush();
    await fireEvent.click(el("history-clear-confirm"));
    await flush();
    expect(host.container.querySelectorAll('[data-testid="history-row"]').length).toBe(0);
    expect(txt(host)).toContain("暂无最近通话");
    expect(readStoreValue<unknown[]>(CALLLOG_KEY, [null])).toEqual([]);
    // An empty log hides the filter chips too (there is nothing to filter).
    expect(host.container.querySelector('[data-testid="history-filters"]')).toBeNull();
  });

  test("回短信 deep-links to Messages addressed to that number", async () => {
    writeStoreValue(CALLLOG_KEY, [{ number: "18616091470", ts: Date.now(), direction: "incoming" }]);
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    await openHistoryTab(host);
    await flush();
    const smsBack = host.container.querySelector(
      'button[data-testid="sms-back-18616091470"]',
    ) as HTMLButtonElement;
    // the hook id lives in data-testid; the announced name is real copy (REQ-A1080)
    expect(smsBack.getAttribute("aria-label")).toBe(zh["phone.smsBack"]);
    await fireEvent.click(smsBack);
    await flush();
    // Messages is asked for that address and the shell switches to it.
    expect(messagesChannel().get()?.composeTo).toBe("18616091470");
    const s = surface();
    expect(s.kind).toBe("app");
    if (s.kind === "app") expect(s.id).toBe("messages");
  });

  test("a dial link prefills the dialler — it never places the call itself", async () => {
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    await flush();
    // Start elsewhere so the prefill has to switch the tab back to the dialler.
    await openHistoryTab(host);
    await flush();

    phoneChannel().set({ number: "10086", nonce: 42 });
    await flush();
    expect(txt(host)).toContain("10086");
    // The link is consumed once: a remount starts clean (nothing pending).
    expect(phoneChannel().get()?.number).toBe("");
    // ...and no call was started: a prefill is a request, not a call the user never placed.
    expect(calls.map((c) => c.cmd)).not.toContain("telephony_dial");
  });

  /**
   * REQ-A150 — the Phone screen's history is where a call that could not be written is
   * retried (it is the screen that can both write and speak). Two cases: the retry lands,
   * and the retry still cannot land.
   */
  test("the history screen flushes a pending call, which then really appears", async () => {
    queuePendingCall({
      number: "13900000000",
      ts: Date.now(),
      direction: "incoming",
    });

    const host = render(PhoneApp);
    await flush();
    await flush();

    expect(pendingCallCount()).toBe(0);
    const log = readStoreValue<CallRecord[]>(CALLLOG_KEY, []);
    expect(log.some((r) => r.number === "13900000000")).toBe(true);
  });

  test("while storage still rejects, the screen admits the call is not recorded yet", async () => {
    queuePendingCall({
      number: "13900000001",
      ts: Date.now(),
      direction: "missed",
    });
    const original = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, "setItem").mockImplementation((k: string, v: string) => {
      if (k === CALLLOG_KEY) throw new Error("QuotaExceededError");
      original(k, v);
    });

    const host = render(PhoneApp);
    await flush();
    await flush();

    expect(pendingCallCount()).toBe(1); // still waiting — nothing was dropped
    expect(txt(host)).toContain(zh["phone.pendingCalls"].replace("{n}", "1"));
    // …and no phantom row was drawn for a call the store does not have.
    const log = readStoreValue<CallRecord[]>(CALLLOG_KEY, []);
    expect(log).toEqual([]);
  });
});

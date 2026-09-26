/**
 * phone-outgoing.svelte.test.ts — Svelte OUTGOING happy path (offline via a fake
 * telephony bridge). Complementary to phone.svelte.test.ts (which covers dial
 * WITHOUT a daemon → localized error) and to the pure lib mirror useOutgoingCalls.
 * Here the daemon answers telephony_dial with a call id, so we verify the real
 * component wiring: Dial → in-call UI + outgoing call-log entry → Active ⇒
 * "talking" (ringback/connected) → Ended ⇒ reset back to the keypad.
 */
import { afterEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import PhoneApp from "../src/svelte/PhoneApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { CALLLOG_KEY } from "../src/lib/calllog";
import { TELEPHONY_EVENT } from "../src/lib/backend";
import { zh } from "../src/i18n/locales/zh";

type AnyWin = Record<string, unknown>;
type Cb = (e: { payload: unknown }) => void;

const cleanBridge = () => delete (window as AnyWin).__TAURI_INTERNALS__;

/**
 * Bridge: a **desktop demo host**. There is no telephony stack, so the real platform
 * path refuses and `telephony_real_dial_status` says so (`on_device: false`), while the
 * daemon's provider is the **mock** (`telephony_backend_kind`). `telephony_dial`
 * succeeds with a fixed call id — this is the one host where the daemon's simulated call
 * is the only thing there is, and the screen must label it as one.
 */
function installBridge(): (payload: unknown) => void {
  const listeners = new Map<string, Cb>();
  (window as AnyWin).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "telephony_dial") return { id: "out-1", state: "Dialing" };
      if (cmd === "telephony_backend_kind") return { kind: "mock", detail: "", real: false };
      if (cmd === "telephony_real_dial_status") {
        return {
          on_device: false,
          available: false,
          reason: "real dial is only available in the on-device (Android) System UI build",
        };
      }
      return null;
    },
    listen: async (channel: string, cb: Cb) => {
      listeners.set(channel, cb);
      return () => {
        listeners.delete(channel);
      };
    },
  };
  return (payload) => listeners.get(TELEPHONY_EVENT)?.({ payload: payload as unknown });
}

/**
 * Bridge with **no daemon**: `telephony_dial` answers null, but `real_dial` (the host
 * `ACTION_CALL` path) accepts. The real path is tried **first**, so this bridge also
 * models the ordinary device case.
 */
function installNoDaemonBridge(): { dialed: string[] } {
  const dialed: string[] = [];
  (window as AnyWin).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: { number?: string }) => {
      if (cmd === "telephony_dial") return null;
      if (cmd === "real_dial") {
        dialed.push(args?.number ?? "");
        return "dialing via Android Telecom";
      }
      return null;
    },
    listen: async () => () => {},
  };
  return { dialed };
}

/**
 * Bridge with **no daemon** on a device where AmOS **is** the default phone app: the
 * `ACTION_CALL` path fires, and Telecom resolves that call back into this app's own
 * `AmosInCallService`, which reports it under the fixed id `real`. `dialerRoleStatus`
 * lets a caller flip the role so the same bridge can also model "another dialer owns it".
 */
function installNoDaemonDefaultDialerBridge(roleHeld: boolean): {
  dialed: string[];
  emit: (payload: unknown) => void;
} {
  const dialed: string[] = [];
  const listeners = new Map<string, Cb>();
  (window as AnyWin).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: { number?: string }) => {
      if (cmd === "telephony_dial") return null;
      if (cmd === "real_dial") {
        dialed.push(args?.number ?? "");
        return "dialing via Android Telecom";
      }
      if (cmd === "telephony_default_dialer_status") {
        return { role_supported: true, role_held: roleHeld, role_requestable: true };
      }
      return null;
    },
    listen: async (channel: string, cb: Cb) => {
      listeners.set(channel, cb);
      return () => {
        listeners.delete(channel);
      };
    },
  };
  return {
    dialed,
    emit: (payload) => listeners.get(TELEPHONY_EVENT)?.({ payload: payload as unknown }),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const key = (h: { container: HTMLElement }, aria: string) =>
  h.container.querySelector(`button[aria-label="${aria}"]`) as HTMLButtonElement | null;

afterEach(cleanBridge);

describe("PhoneApp.svelte outgoing (fake telephony bridge)", () => {
  test("dial → in-call UI + log entry; Active ⇒ talking; Ended ⇒ reset", async () => {
    const emit = installBridge();
    const host = render(PhoneApp);
    await settle();

    // key in a number and press call
    for (const d of "13800000000") await fireEvent.click(key(host, d)!);
    const callBtn = key(host, zh["phone.call"]);
    expect(callBtn).toBeTruthy();
    await fireEvent.click(callBtn as HTMLButtonElement);
    await tick();
    await settle();

    // daemon accepted → in-call UI with a hang-up control, number visible
    expect(key(host, zh["a11y.end"])).toBeTruthy();
    expect(txt(host)).toContain("13800000000");
    // …and labelled as a simulation, because nothing left this host: the in-call header
    // reads "呼叫/通话中" either way, so without the label the screen would claim a call
    // the device never placed (REQ-A311).
    expect(txt(host)).toContain(zh["phone.simulatedCall"]);

    // outgoing call was written to the shared log at dial time
    const log = readStoreValue<unknown[]>(CALLLOG_KEY, []);
    expect(log.length).toBeGreaterThan(0);

    // connected → "talking" state shows the duration/timer UI
    emit({ id: "out-1", peer: "13800000000", state: "Active", direction: "Outgoing" });
    await tick();
    await settle();
    expect(txt(host)).toContain(zh["phone.talking"]);
    // The duration is a readout that changes on its own once a second, so it has to be
    // *queryable* the way the four clock surfaces are (REQ-A284): `role="timer"` plus a
    // stable `aria-label`. An `aria-label` on a role-less `<div>` names nothing — assistive
    // tech ignores it — so a screen-reader user in a call could never ask how long it has run.
    const duration = host.container.querySelector(`[aria-label="${zh["a11y.callDuration"]}"]`);
    expect(duration).toBeTruthy();
    expect(duration?.getAttribute("role")).toBe("timer");
    expect(duration?.textContent?.trim()).toMatch(/^\d{1,2}:\d{2}(:\d{2})?$/);

    // hang-up / remote end → back to the idle keypad, no phantom call
    emit({ id: "out-1", peer: "13800000000", state: "Ended", direction: "Outgoing" });
    await tick();
    await settle();
    expect(key(host, zh["a11y.end"])).toBeFalsy();
    expect(txt(host)).not.toContain(zh["phone.talking"]);
    // the outgoing log entry survives the reset
    expect(readStoreValue<unknown[]>(CALLLOG_KEY, []).length).toBeGreaterThan(0);
  });

  /**
   * A call now has **two** independent mutable flags (`recording`, `muted`) and the
   * `Watch` events are applied as *snapshots*. So an event that carried only the flag
   * it is about would silently clear the other: muting a recorded call would drop the
   * red "Recording" line, and starting a recording would un-mute. The daemon sends both
   * flags on every change event (see `ProviderEvent::RecordingChanged`), and this pins
   * the component half of that contract in the direction that used to be a lie —
   * an event with **no** `muted` field is "no claim", not "unmuted".
   */
  test("a recording event never clears the mute flag (nor a mute event the recording)", async () => {
    const emit = installBridge(); // telephony_dial → out-1
    const host = render(PhoneApp);
    await settle();

    for (const d of "13800000000") await fireEvent.click(key(host, d)!);
    await fireEvent.click(key(host, zh["phone.call"]) as HTMLButtonElement);
    await tick();
    await settle();
    emit({ id: "out-1", peer: "13800000000", state: "Active", direction: "Outgoing" });
    await tick();
    await settle();

    // The user mutes, and the daemon's next snapshot says muted.
    await fireEvent.click(key(host, zh["phone.mute"]) as HTMLButtonElement);
    await tick();
    await settle();
    emit({
      id: "out-1",
      peer: "13800000000",
      state: "Active",
      direction: "Outgoing",
      recording: "Off",
      muted: true,
    });
    await tick();
    await settle();
    expect(key(host, zh["phone.unmute"])).toBeTruthy();

    // Now a recording change arrives carrying the current mute flag…
    emit({
      id: "out-1",
      peer: "13800000000",
      state: "Active",
      direction: "Outgoing",
      recording: "On",
      muted: true,
    });
    await tick();
    await settle();
    expect(key(host, zh["phone.unmute"])).toBeTruthy();
    expect(txt(host)).toContain(zh["phone.recording"]);

    // …and the mirror direction: a mute change must not clear the recording.
    emit({
      id: "out-1",
      peer: "13800000000",
      state: "Active",
      direction: "Outgoing",
      recording: "On",
      muted: false,
    });
    await tick();
    await settle();
    expect(key(host, zh["phone.mute"])).toBeTruthy();
    expect(txt(host)).toContain(zh["phone.recording"]);

    // An event from a host that predates the field makes NO mute claim, so the state
    // the user chose must survive it rather than being reset to "unmuted".
    emit({
      id: "out-1",
      peer: "13800000000",
      state: "Active",
      direction: "Outgoing",
      recording: "Off",
      muted: true,
    });
    await tick();
    await settle();
    emit({
      id: "out-1",
      peer: "13800000000",
      state: "Active",
      direction: "Outgoing",
      recording: "Off",
    });
    await tick();
    await settle();
    expect(key(host, zh["phone.unmute"])).toBeTruthy();
  });

  test("no daemon → a regular call goes out through the real system path (real_dial)", async () => {
    const { dialed } = installNoDaemonBridge();
    const host = render(PhoneApp);
    await settle();

    for (const d of "13800000000") await fireEvent.click(key(host, d)!);
    await fireEvent.click(key(host, zh["phone.call"]) as HTMLButtonElement);
    await tick();
    await settle();

    // the host's ACTION_CALL path was asked to place it…
    expect(dialed).toEqual(["13800000000"]);
    // …and the screen honestly says the call left the app, not that it is in-call.
    expect(txt(host)).toContain(zh["phone.handedToSystem"]);
    expect(key(host, zh["a11y.end"])).toBeFalsy();
    // it is still a real outgoing call: it lands in the log
    expect(readStoreValue<unknown[]>(CALLLOG_KEY, []).length).toBeGreaterThan(0);
  });

  /**
   * The **order** pinned at the component level, not just in the pure function. Here both
   * real paths are ready at once — the host's `ACTION_CALL` accepts *and* the daemon's
   * provider is a genuine stack (`telephony_backend_kind.real`) — and the dial must still
   * go to the platform. The shipped defect asked the daemon first, so this is exactly the
   * configuration in which a real dial became a daemon-managed (simulated) one without the
   * screen being able to tell.
   */
  test("a device where both real paths are ready still gives the dial to ACTION_CALL", async () => {
    const seen: string[] = [];
    (window as AnyWin).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: { number?: string }) => {
        seen.push(cmd);
        if (cmd === "real_dial") {
          seen.push(`real_dial:${args?.number ?? ""}`);
          return "dialing via Android Telecom";
        }
        if (cmd === "telephony_backend_kind") return { kind: "android", detail: "", real: true };
        if (cmd === "telephony_dial") return { id: "out-9", state: "Dialing" };
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(PhoneApp);
    await settle();

    for (const d of "13800000000") await fireEvent.click(key(host, d)!);
    await fireEvent.click(key(host, zh["phone.call"]) as HTMLButtonElement);
    await tick();
    await settle();

    expect(seen).toContain("real_dial:13800000000");
    // …and the screen says the call left the app rather than drawing an in-call surface.
    expect(txt(host)).toContain(zh["phone.handedToSystem"]);
    expect(key(host, zh["a11y.end"])).toBeFalsy();
    // The daemon was never consulted: not for its backend kind, not for the dial itself.
    expect(seen).not.toContain("telephony_backend_kind");
    expect(seen).not.toContain("telephony_dial");
  });

  /**
   * The dial-out that used to vanish. On a device where AmOS holds ROLE_DIALER the
   * "system dialer" `ACTION_CALL` resolves to is **this app's own** `AmosInCallService`,
   * so stepping back to the keypad with a "handed to the system" note left a live call
   * with no hang-up key anywhere on screen. The call arrives on the bridge under the
   * fixed id `real`, so the Phone page must adopt it and let the real state events drive
   * a surface the user can end.
   */
  test("no daemon + AmOS is the default phone app → the hand-off comes back to our own in-call service, which we adopt", async () => {
    const { dialed, emit } = installNoDaemonDefaultDialerBridge(true);
    const host = render(PhoneApp);
    await settle();

    for (const d of "13800000000") await fireEvent.click(key(host, d)!);
    await fireEvent.click(key(host, zh["phone.call"]) as HTMLButtonElement);
    await tick();
    await settle();

    // The real ACTION_CALL path placed it…
    expect(dialed).toEqual(["13800000000"]);
    // …but the screen must NOT claim the call left the app: it is ours to drive.
    expect(txt(host)).not.toContain(zh["phone.handedToSystem"]);
    expect(key(host, zh["a11y.end"])).toBeTruthy();
    expect(txt(host)).toContain("13800000000");

    // The real in-call bridge reports under the fixed id `real`; its Active edge takes
    // the screen into the talking state (elapsed clock + in-call controls).
    emit({ id: "real", peer: "13800000000", state: "Active", direction: "Outgoing" });
    await tick();
    await settle();
    expect(txt(host)).toContain(zh["phone.talking"]);
    expect(key(host, zh["phone.mute"])).toBeTruthy();

    // The remote end → the real Ended edge tears the surface down, not a phantom call.
    emit({ id: "real", peer: "13800000000", state: "Ended", direction: "Outgoing" });
    await tick();
    await settle();
    expect(key(host, zh["a11y.end"])).toBeFalsy();
    expect(txt(host)).not.toContain(zh["phone.talking"]);
  });

  /**
   * The twin of the test above, and its negative control at the component level: the
   * *same* no-daemon hand-off, but AmOS does **not** hold the role. Now another dialer
   * really does own the call, so there is no screen here to drive and the keypad +
   * notice is the honest view — adopting the id `real` unconditionally would redden this.
   */
  test("no daemon + AmOS is NOT the default phone app → the hand-off is still another dialer's call", async () => {
    const { dialed } = installNoDaemonDefaultDialerBridge(false);
    const host = render(PhoneApp);
    await settle();

    for (const d of "13800000000") await fireEvent.click(key(host, d)!);
    await fireEvent.click(key(host, zh["phone.call"]) as HTMLButtonElement);
    await tick();
    await settle();

    expect(dialed).toEqual(["13800000000"]);
    expect(txt(host)).toContain(zh["phone.handedToSystem"]);
    expect(key(host, zh["a11y.end"])).toBeFalsy();
  });

  /**
   * The one-tap emergency dial reaches the **real platform path**. This is the inverse of
   * what this file used to assert ("an emergency number never downgrades to a plain
   * ACTION_CALL"): `ACTION_CALL` is not a downgrade, it is the *only* path that reaches
   * the platform's emergency stack, and `docs/telephony.md` §5 puts the guarantee there
   * (Telecom + the EmergencyNumber DB + RIL), not in user space. Routing emergency calls
   * to the daemon's simulation instead was the defect.
   */
  test("no daemon → the one-tap emergency number takes the real ACTION_CALL path", async () => {
    const { dialed } = installNoDaemonBridge();
    const host = render(PhoneApp);
    await settle();

    // Emergency tab → one-tap dial of the shared primary number.
    const tabs = Array.from(host.container.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
    const emergTab = tabs.find((b) => b.textContent?.trim() === zh["phone.tabEmergency"]);
    expect(emergTab).toBeTruthy();
    await fireEvent.click(emergTab as HTMLButtonElement);
    await tick();
    await settle();
    const oneTap = host.container.querySelector(
      `button[aria-label="${zh["phone.emergencyCall"]} 110"]`,
    ) as HTMLButtonElement;
    expect(oneTap).toBeTruthy();
    await fireEvent.click(oneTap);
    await tick();
    await settle();

    expect(dialed).toEqual(["110"]);
    expect(txt(host)).toContain(zh["phone.handedToSystem"]);
  });

  /**
   * The honesty rule at the component level: an **on-device** build whose real dial path
   * cannot fire must report the failure, not let the daemon's mock stand in — least of all
   * for an emergency number. The daemon here answers every dial, so this is the negative
   * control for "the mock is never reached once we know we are on a phone".
   */
  test("a device with no usable real path → an emergency number fails, it is not simulated", async () => {
    const dialed: string[] = [];
    (window as AnyWin).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "telephony_dial") return { id: "mock-1", state: "Dialing" };
        if (cmd === "telephony_backend_kind") return { kind: "mock", detail: "", real: false };
        if (cmd === "telephony_real_dial_status") {
          return {
            on_device: true,
            available: false,
            reason: "real dial context not bound — grant CALL_PHONE and re-open the app",
          };
        }
        if (cmd === "real_dial") {
          dialed.push("asked");
          return null;
        }
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(PhoneApp);
    await settle();

    for (const d of "110") await fireEvent.click(key(host, d)!);
    await fireEvent.click(key(host, zh["phone.call"]) as HTMLButtonElement);
    await tick();
    await settle();

    // No in-call surface, no simulation — and the host's own words, which carry the remedy.
    expect(key(host, zh["a11y.end"])).toBeFalsy();
    expect(txt(host)).not.toContain(zh["phone.simulatedCall"]);
    expect(txt(host)).toContain(
      zh["phone.dialFailedDetail"].replace(
        "{detail}",
        "real dial context not bound — grant CALL_PHONE and re-open the app",
      ),
    );
  });
});

/**
 * A platform-owned call this page never dialled reaches it as a **stream event**.
 *
 * `ContactsApp` routes a handed-off call here (`wm_open("phone")`), but `real_dial`'s
 * `ACTION_CALL` returns before Telecom adds the call, so the page mounts with nothing to
 * find in `adoptLiveCall` and the call's first event lands afterwards. Adopting it is what
 * makes the routed in-call surface appear; the *state* whitelist is what keeps the tail
 * event of a finished call — `AmosInCallService.onCallRemoved` re-reports with no active
 * call, which the bridge maps to `state: "Unknown"`, `direction: "Outgoing"` — from
 * resurrecting a live call screen nobody can end.
 */
describe("PhoneApp.svelte adopts an un-owned platform call from the event stream", () => {
  test("an outgoing `real` call that arrives after mount brings up the in-call UI", async () => {
    const { emit } = installNoDaemonDefaultDialerBridge(true);
    const host = render(PhoneApp);
    await settle();
    expect(key(host, zh["a11y.end"])).toBeFalsy(); // nothing adopted yet

    emit({ id: "real", peer: "13800000000", state: "Dialing", direction: "Outgoing" });
    await tick();
    await settle();
    expect(key(host, zh["a11y.end"])).toBeTruthy();
    expect(txt(host)).toContain("13800000000");

    emit({ id: "real", peer: "13800000000", state: "Active", direction: "Outgoing" });
    await tick();
    await settle();
    expect(txt(host)).toContain(zh["phone.talking"]);
  });

  /**
   * Negative control at the same seam: the bridge's "no call any more" tail must not be
   * read as a live call. Without the state whitelist, `Unknown` is "not `Ended`" and the
   * phantom arrives.
   */
  test("the removal tail (`Unknown` / `Outgoing`) is not adopted as a live call", async () => {
    const { emit } = installNoDaemonDefaultDialerBridge(true);
    const host = render(PhoneApp);
    await settle();

    emit({ id: "real", peer: "", state: "Unknown", direction: "Outgoing" });
    await tick();
    await settle();
    expect(key(host, zh["a11y.end"])).toBeFalsy();
    expect(txt(host)).not.toContain(zh["phone.talking"]);

    // Same for a call that has genuinely ended.
    emit({ id: "real", peer: "13800000000", state: "Ended", direction: "Outgoing" });
    await tick();
    await settle();
    expect(key(host, zh["a11y.end"])).toBeFalsy();
  });

  /**
   * The mirror image, so the whitelist is not read as "the page adopts anything": an
   * *incoming* `real` call is `IncomingCall`'s to draw on its own overlay, and hijacking it
   * here would put a second, contradictory in-call surface under it.
   */
  test("an incoming `real` call is left to the incoming-call overlay", async () => {
    const { emit } = installNoDaemonDefaultDialerBridge(true);
    const host = render(PhoneApp);
    await settle();

    emit({ id: "real", peer: "13800000000", state: "Ringing", direction: "Incoming" });
    await tick();
    await settle();
    expect(key(host, zh["a11y.end"])).toBeFalsy();
  });
});

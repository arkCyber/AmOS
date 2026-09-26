/**
 * incoming-call.svelte.test.ts — Svelte incoming-call island (offline via a fake
 * Tauri telephony bridge). The state machine: Ringing→Answer/Decline; answering
 * →talking (mute/record/hangup); Ended persists the incoming call to the shared
 * call log then hides. No call ⇒ nothing renders (offline parity with React).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import IncomingCall from "../src/svelte/IncomingCall.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { CONTACTS_KEY } from "../src/lib/contacts";
import {
  CALLLOG_KEY,
  resetPendingCallsForTest,
  pendingCallCount,
} from "../src/lib/calllog";
import { zh } from "../src/i18n/locales/zh";

type AnyWin = Record<string, unknown>;
const TELEPHONY_EVENT = "telephony-event";

const cleanBridge = () =>
  delete (window as AnyWin).__TAURI_INTERNALS__;

function installBridge(
  /**
   * Per-command outcome. Defaults to `null` — the bridge's **success** value for a
   * `void` command, and (this is the point) also its failure value: a rejecting
   * `invoke` is how a *refused* answer looks to the caller (F-SH-236).
   */
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> = async () => null,
): (payload: unknown) => void {
  const listeners = new Map<string, (e: { payload: unknown }) => void>();
  (window as AnyWin).__TAURI_INTERNALS__ = {
    invoke,
    listen: async (channel: string, cb: (e: { payload: unknown }) => void) => {
      listeners.set(channel, cb);
      return () => {
        listeners.delete(channel);
      };
    },
  };
  return (payload) =>
    listeners.get(TELEPHONY_EVENT)?.({ payload: payload as unknown });
}

beforeEach(() => {
  window.localStorage.clear();
  resetPendingCallsForTest(); // the pending queue is module state, shared inside this file
  cleanBridge();
});
afterEach(() => cleanBridge());

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("IncomingCall.svelte (fake telephony bridge)", () => {
  test("renders nothing with no call", async () => {
    installBridge();
    const { container } = render(IncomingCall);
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("Ringing shows Answer/Decline; answering enters talking; Ended logs + hides", async () => {
    const emit = installBridge();
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "c1", direction: "Incoming", state: "Ringing", peer: "13800000000" });
    await tick();
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    const answer = container.querySelector(
      `button[aria-label="${zh["phone.answer"]}"]`,
    ) as HTMLButtonElement | null;
    expect(answer).toBeTruthy();

    await fireEvent.click(answer!); // → talking
    await tick();
    expect(container.querySelector(`button[aria-label="${zh["phone.hangup"]}"]`)).toBeTruthy();

    emit({ id: "c1", direction: "Incoming", state: "Ended", peer: "13800000000" });
    await tick();
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const log = readStoreValue<unknown[]>(CALLLOG_KEY, []);
    expect(log.length).toBeGreaterThan(0); // finished incoming call logged
  });

  test("Decline hides and does not enter talking", async () => {
    const emit = installBridge();
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "c2", direction: "Incoming", state: "Ringing", peer: "13900000000" });
    await tick();
    await settle();
    const decline = container.querySelector(
      `button[aria-label="${zh["phone.decline"]}"]`,
    ) as HTMLButtonElement | null;
    expect(decline).toBeTruthy();
    await fireEvent.click(decline!);
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("blank/hidden caller id shows the localized unknown label", async () => {
    const emit = installBridge();
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "c3", direction: "Incoming", state: "Ringing", peer: "" });
    await tick();
    await settle();
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    // headline falls back to the localized "unknown" text, no number sub-row
    expect((dialog?.textContent ?? "")).toContain(zh["phone.unknown"]);
  });

  test("a contact added after the shell mounted still names the caller", async () => {
    const emit = installBridge();
    const { container } = render(IncomingCall); // mounts against an empty address book
    await settle();

    // The user adds a contact while the shell is up; Contacts persists `amos.contacts`.
    writeStoreValue(CONTACTS_KEY, [
      { id: "k1", name: "王五", phones: ["13611112222"], fav: false, ts: Date.now() },
    ]);

    emit({ id: "c5", direction: "Incoming", state: "Ringing", peer: "13611112222" });
    await tick();
    await settle();
    expect(container.querySelector('[role="dialog"]')?.textContent ?? "").toContain("王五");
  });

  /**
   * F-SH-236 — the answer action's *verdict* is not its return value.
   *
   * `invoke` answers a failed command with `null`, which is also what a `void`
   * command returns on success, so the optimistic `phase = "talking"` used to stand
   * for both: a real incoming call the platform refused to answer rendered as a live
   * in-call screen with the ringtone stopped. The surface now reads the diagnosis
   * and rolls back to the screen that tells the truth.
   */
  test("an answer the platform refused is not rendered as a connected call", async () => {
    const emit = installBridge(async (command) => {
      if (command === "telephony_answer") {
        throw {
          code: "amos.telephony.rpc_failed",
          message: "telephony answer failed: status: NotFound",
        };
      }
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "c4", direction: "Incoming", state: "Ringing", peer: "13700000000" });
    await tick();
    await settle();
    await fireEvent.click(
      container.querySelector(`button[aria-label="${zh["phone.answer"]}"]`)!,
    );
    await tick();
    await settle();

    // Back to ringing: the call was never answered, so nothing about it changed.
    expect(
      container.querySelector(`button[aria-label="${zh["phone.answer"]}"]`),
    ).toBeTruthy();
    expect(container.querySelector(`button[aria-label="${zh["phone.hangup"]}"]`)).toBeNull();
    // …and the host's own words are on screen, not a fabricated "talking".
    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert!.textContent).toContain("status: NotFound");
    expect(alert!.textContent).toContain(zh["phone.answerFailed"].split("{detail}")[0]);
    expect(container.textContent).not.toContain(zh["phone.talking"]);
  });

  test("a refused hang-up keeps the call on screen instead of pretending it ended", async () => {
    const emit = installBridge(async (command) => {
      if (command === "telephony_end") throw new Error("telephony end failed: unavailable");
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "c5", direction: "Incoming", state: "Ringing", peer: "13600000000" });
    await tick();
    await settle();
    await fireEvent.click(
      container.querySelector(`button[aria-label="${zh["phone.decline"]}"]`)!,
    );
    await tick();
    await settle();

    expect(container.querySelector('[role="dialog"]')).toBeTruthy(); // still there to retry
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("unavailable");
  });

  test("a refused action with no reason still says so in words, not as `null`", async () => {
    const emit = installBridge(async (command) => {
      if (command === "telephony_answer") throw { code: "amos.telephony.rpc_failed" };
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "c6", direction: "Incoming", state: "Ringing", peer: "13500000000" });
    await tick();
    await settle();
    await fireEvent.click(
      container.querySelector(`button[aria-label="${zh["phone.answer"]}"]`)!,
    );
    await tick();
    await settle();

    // Nothing to quote from the host → the fold's own code is the fallback, and the
    // strip never shows the raw failure value.
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      zh["phone.actionNoReason"],
    );
  });

  /**
   * REQ-A150 — this is the one write in the app with no screen left to report a failure
   * (the overlay is closing), which is why it used to be allow-listed as a *residual gap*:
   * a rejected append cost that history row silently. Now it is queued in memory for the
   * Phone screen's history to flush, and that screen admits it while it is still pending.
   */
  test("a rejected call-log write keeps the row pending instead of losing it", async () => {
    const emit = installBridge();
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "c9", direction: "Incoming", state: "Ringing", peer: "13900000000" });
    await tick();
    await settle();

    // Exactly this key now rejects (a full/unavailable store), everything else works.
    const original = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, "setItem").mockImplementation((k: string, v: string) => {
      if (k === CALLLOG_KEY) throw new Error("QuotaExceededError");
      original(k, v);
    });

    emit({ id: "c9", direction: "Incoming", state: "Ended", peer: "13900000000" });
    await tick();
    await settle();

    expect(container.querySelector('[role="dialog"]')).toBeNull(); // the call still closed
    expect(readStoreValue<unknown[]>(CALLLOG_KEY, [])).toEqual([]); // nothing landed…
    expect(pendingCallCount()).toBe(1); // …but nothing was lost
  });

  /**
   * REQ-A992 — the recording state is **three**-valued and this surface rendered two.
   *
   * `telephony.rs::call_payload` maps `ProtoRecording::RecordingFailed` → `"Failed"`, the
   * event handler assigns it verbatim, and the template drew only `"On"` — so a call whose
   * device-side recording *failed* looked byte-for-byte like a call that is not recording.
   * The absence of the badge was read as "nothing happened". The sibling in-call surface
   * (`PhoneApp.svelte`) proves the idiom: it renders the same value as 「录音不可用」.
   */
  test("a device-reported recording failure is rendered, not read as 'not recording'", async () => {
    const emit = installBridge();
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "c7", direction: "Incoming", state: "Ringing", peer: "13400000000" });
    await tick();
    await settle();
    await fireEvent.click(
      container.querySelector(`button[aria-label="${zh["phone.answer"]}"]`)!,
    );
    await tick();
    await settle();

    emit({
      id: "c7",
      direction: "Incoming",
      state: "Active",
      peer: "13400000000",
      recording: "Failed",
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain(zh["phone.recordUnavailable"]);
    });
    // …and it is not dressed up as the healthy "recording" state either.
    expect(container.textContent).not.toContain(zh["phone.recording"]);
  });

  /**
   * REQ-A992 (second half) — the recording **toggle** is the one in-call action on this
   * surface that swallowed its refusal.
   *
   * `telephony_start_recording` answers a typed `AmosError` when the device refuses, and
   * `invoke` folds that into `null` — the same value a `void` success has. `if (res) …`
   * therefore read a refusal as "nothing to say": the button kept its old label and no
   * words appeared. `answer`/`leave` on this same surface already read the diagnosis slot
   * (F-SH-236); the toggle now does too.
   */
  test("a refused recording toggle says so instead of leaving the button unchanged", async () => {
    const emit = installBridge(async (command) => {
      if (command === "telephony_start_recording") {
        throw {
          code: "amos.telephony.recording_refused",
          message: "telephony recording start refused by the in-call service (Failed)",
        };
      }
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "c8", direction: "Incoming", state: "Ringing", peer: "13300000000" });
    await tick();
    await settle();
    await fireEvent.click(
      container.querySelector(`button[aria-label="${zh["phone.answer"]}"]`)!,
    );
    await tick();
    await settle();

    await fireEvent.click(
      container.querySelector(`button[aria-label="${zh["phone.recordStart"]}"]`)!,
    );
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
    const alert = container.querySelector('[role="alert"]')!;
    // The host's own words, plus the fold that says which control refused.
    expect(alert.textContent).toContain("refused by the in-call service");
    expect(alert.textContent).toContain(zh["phone.recordFailed"].split("{detail}")[0]);
    // The call is still up — a refused toggle must not close the surface.
    expect(container.querySelector(`button[aria-label="${zh["phone.hangup"]}"]`)).toBeTruthy();
  });

  const muteBtn = (container: HTMLElement, label: string) =>
    container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

  /** Ring, answer, and land on the talking surface (mute/record/hangup). */
  async function answerCall(
    emit: (payload: unknown) => void,
    container: HTMLElement,
    id: string,
  ): Promise<void> {
    emit({ id, direction: "Incoming", state: "Ringing", peer: "13800000000" });
    await tick();
    await settle();
    await fireEvent.click(
      container.querySelector(`button[aria-label="${zh["phone.answer"]}"]`)!,
    );
    await tick();
    await settle();
  }

  /**
   * The in-call Mute button on **this** surface used to be a purely local flag too:
   * `onclick={() => (muted = !muted)}` moved a component variable no other part of the
   * system could see, so the button's label, its glyph and its colour were the *only*
   * place the user was muted — while the record toggle **directly beside it** is
   * daemon-owned (REQ-A992) and the Phone screen's own mute was wired in REQ-A1032.
   * The asymmetry of a fully-wired neighbour is what hid it. This pins the wiring: the
   * toggle must ask the daemon and show the daemon's own answer.
   */
  test("the in-call mute toggle asks the daemon and shows its answer", async () => {
    const sent: { callId?: string; muted?: boolean }[] = [];
    const emit = installBridge(async (command, args) => {
      if (command === "telephony_set_muted") {
        sent.push({ callId: args?.callId as string, muted: args?.muted as boolean });
        return {
          id: "c10",
          peer: "13800000000",
          state: "Active",
          direction: "Incoming",
          recording: "Off",
          muted: args?.muted === true,
        };
      }
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();
    await answerCall(emit, container, "c10");

    expect(muteBtn(container, zh["phone.mute"])).toBeTruthy();
    await fireEvent.click(muteBtn(container, zh["phone.mute"])!);
    await vi.waitFor(() => {
      expect(muteBtn(container, zh["phone.unmute"])).toBeTruthy();
    });

    // The request carried the **desired state** (not a toggle) for this call id.
    expect(sent).toEqual([{ callId: "c10", muted: true }]);

    // Unmuting is the same request with the other value — and comes back off.
    await fireEvent.click(muteBtn(container, zh["phone.unmute"])!);
    await vi.waitFor(() => {
      expect(muteBtn(container, zh["phone.mute"])).toBeTruthy();
    });
    expect(sent).toEqual([
      { callId: "c10", muted: true },
      { callId: "c10", muted: false },
    ]);
  });

  /**
   * The mute toggle's *refusal* must not read as success — same family as the record
   * toggle above. `telephony_set_muted` answers a typed `AmosError` which `invoke`
   * folds into `null`, the same value an empty success has, so flipping the label
   * without reading the diagnosis would show a mute that never reached anything.
   */
  test("a refused mute says so and leaves the button alone", async () => {
    const emit = installBridge(async (command) => {
      if (command === "telephony_set_muted") {
        throw {
          code: "amos.telephony.mute_refused",
          message: "telephony mute requires an InCallService bridge (P3, device-validated)",
        };
      }
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();
    await answerCall(emit, container, "c11");

    await fireEvent.click(muteBtn(container, zh["phone.mute"])!);
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("InCallService bridge");
    expect(alert.textContent).toContain(zh["phone.muteFailed"].split("{detail}")[0]);
    // The button did NOT move: the daemon never confirmed the mute.
    expect(muteBtn(container, zh["phone.mute"])).toBeTruthy();
    // …and the call is still up.
    expect(muteBtn(container, zh["phone.hangup"])).toBeTruthy();
  });

  /**
   * REQ-A1088 / F-SH-402 — `leave()` backs **two** different buttons (拒绝 while the call
   * is still ringing and 挂断 once it is talking) but a refusal of either used to report
   * one sentence that named the *wrong* action and asserted a state false for one of them:
   * declining a ringing call said 「挂断失败…这通电话仍在通话中」 (hang-up, and "still
   * live", while the call was still **ringing**). The two paths must name the action
   * pressed and the state the user actually sees.
   */
  test("a refused decline names the decline and the state the user sees (still ringing)", async () => {
    const emit = installBridge(async (command) => {
      if (command === "telephony_end") throw new Error("telephony end failed: unavailable");
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "d1", direction: "Incoming", state: "Ringing", peer: "13100000000" });
    await tick();
    await settle();
    await fireEvent.click(
      container.querySelector(`button[aria-label="${zh["phone.decline"]}"]`)!,
    );
    await tick();
    await settle();

    const alert = container.querySelector('[role="alert"]')!;
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain("unavailable");
    // The action pressed was 拒绝 (decline), and the call is still **ringing** — asserting
    // a literal phrase (not the locale's own key) so a broken copy cannot pass this test.
    expect(alert.textContent).toContain("拒绝失败");
    expect(alert.textContent).toContain("仍在振铃");
    expect(alert.textContent).not.toContain("仍在通话中");
  });

  test("a refused hang-up on a talking call says the call was not ended", async () => {
    const emit = installBridge(async (command) => {
      if (command === "telephony_end") throw new Error("telephony end failed: unavailable");
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();
    await answerCall(emit, container, "d2");

    await fireEvent.click(muteBtn(container, zh["phone.hangup"])!);
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("unavailable");
    // The talking path says the call was **not ended** (not "still live").
    expect(alert.textContent).toContain("挂断失败");
    expect(alert.textContent).toContain("没有被挂断");
  });

  /**
   * REQ-A1150 / F-SH-455 — the **other** absent field on this surface.
   *
   * The sibling test above pins that an event with no `muted` is "no claim". The same
   * rule holds for `recording`, and here it is not hypothetical: `incall.rs` emits the
   * real in-call bridge's upcall with `recording: None` **on purpose**, because the
   * upcall carries only direction / state / peer — its own comment records why: 「Claiming
   * `Some("Off")` here reset the UI's recording indicator to Off on *every* state change,
   * including the ones the in-call toggles themselves provoke (`hold`/`speaker`/`mute` all
   * call `onCallStateChanged`), so a user who had just started recording watched it
   * silently clear」. `TelephonyCall.recording` is documented optional for exactly this
   * reason and `PhoneApp.svelte` reads it guarded at both sites — this surface cast
   * `undefined` into the three-valued type instead, so the very failure the Rust comment
   * describes was still live on the incoming-call overlay.
   */
  test("an event that makes no recording claim does not clear a live recording (REQ-A1150)", async () => {
    const emit = installBridge();
    const { container } = render(IncomingCall);
    await settle();
    await answerCall(emit, container, "c13");

    // The daemon says this call is being recorded.
    emit({
      id: "c13",
      direction: "Incoming",
      state: "Active",
      peer: "13800000000",
      recording: "On",
      muted: false,
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain(zh["phone.recording"]);
    });

    // Now the real in-call bridge's upcall shape: direction / state / peer and **no
    // toggle at all**. Absent is "no claim", so the live recording must survive it.
    emit({ id: "c13", direction: "Incoming", state: "Active", peer: "13800000000" });
    await tick();
    await settle();
    expect(container.textContent).toContain(zh["phone.recording"]);
    // …and the toggle still offers to *stop* it rather than starting a second one.
    expect(
      container.querySelector(`button[aria-label="${zh["phone.recordStop"]}"]`),
    ).toBeTruthy();
  });

  /**
   * REQ-A1150 / F-SH-455 (second site) — the same rule on the **reply** of the toggle
   * itself, which is the other place `recording` is read. `toggleRecord` used to do
   * `if (res) recording = res.recording as …`, so an accepted reply whose body omits
   * the field moved the indicator to `undefined` — i.e. it turned a live recording off
   * on screen while the device kept recording. Only a claim moves it.
   */
  test("an accepted recording reply that makes no claim leaves the indicator alone (REQ-A1150)", async () => {
    const emit = installBridge(async (command) => {
      // The stop is accepted, but this reply carries no `recording` field.
      if (command === "telephony_stop_recording") {
        return { id: "c14", direction: "Incoming", state: "Active", peer: "13800000000" };
      }
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();
    await answerCall(emit, container, "c14");

    emit({
      id: "c14",
      direction: "Incoming",
      state: "Active",
      peer: "13800000000",
      recording: "On",
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain(zh["phone.recording"]);
    });

    await fireEvent.click(
      container.querySelector(`button[aria-label="${zh["phone.recordStop"]}"]`)!,
    );
    await tick();
    await settle();

    // The host accepted but claimed nothing, so the indicator must not invent "Off".
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain(zh["phone.recording"]);
    expect(
      container.querySelector(`button[aria-label="${zh["phone.recordStop"]}"]`),
    ).toBeTruthy();
  });

  /**
   * A call has **two** independent mutable flags (`recording`, `muted`) and every
   * `Watch` event is applied as a *snapshot*, so an event carrying only the flag it is
   * about would silently clear the other. The daemon sends both on every change event;
   * this pins the component half in both directions — and, crucially, that an event
   * with **no** `muted` field is "no claim", not "unmuted".
   */
  test("a recording event never clears the mute flag (nor a mute event the recording)", async () => {
    const emit = installBridge();
    const { container } = render(IncomingCall);
    await settle();
    await answerCall(emit, container, "c12");

    const evt = (extra: Record<string, unknown>) =>
      emit({
        id: "c12",
        direction: "Incoming",
        state: "Active",
        peer: "13800000000",
        recording: "Off",
        ...extra,
      });

    // The daemon says this call is muted.
    evt({ muted: true });
    await tick();
    await settle();
    expect(muteBtn(container, zh["phone.unmute"])).toBeTruthy();

    // A recording change arrives carrying the current mute flag → still muted.
    evt({ recording: "On", muted: true });
    await tick();
    await settle();
    expect(muteBtn(container, zh["phone.unmute"])).toBeTruthy();
    expect(container.textContent).toContain(zh["phone.recording"]);

    // The mirror direction: a mute change must not clear the recording.
    evt({ recording: "On", muted: false });
    await tick();
    await settle();
    expect(muteBtn(container, zh["phone.mute"])).toBeTruthy();
    expect(container.textContent).toContain(zh["phone.recording"]);

    // An event from a host that predates the field makes NO mute claim, so the state
    // the user chose must survive it rather than being reset to "unmuted".
    evt({ muted: true });
    await tick();
    await settle();
    evt({});
    await tick();
    await settle();
    expect(muteBtn(container, zh["phone.unmute"])).toBeTruthy();
  });

  /**
   * The two **device-only** in-call controls belong on the surface that renders real
   * calls — this one — and were missing from it.
   *
   * `telephony_set_speaker` / `telephony_set_hold` are implemented, typed and registered,
   * and `tauri-command-scan` passes because `PhoneApp.svelte` calls them. But `PhoneApp`
   * drives the **daemon** transport, which has no audio route and no hold — the host
   * refuses both there ("no in-call service is bound"). The one surface where they can
   * actually succeed is this overlay, which is driven by the real in-call bridge
   * (`incall.rs` emits `telephony-event` for `ROLE_DIALER` calls), and its talking row
   * offered only mute / record / hangup. A wired sibling hid the hollow twin: the gate
   * saw a caller and stopped looking.
   */
  const talkingCall = async (
    container: HTMLElement,
    emit: (p: unknown) => void,
    id: string,
    peer: string,
  ) => {
    emit({ id, direction: "Incoming", state: "Ringing", peer });
    await tick();
    await settle();
    await fireEvent.click(container.querySelector(`button[aria-label="${zh["phone.answer"]}"]`)!);
    await tick();
    await settle();
    emit({ id, direction: "Incoming", state: "Active", peer });
    await tick();
    await settle();
  };

  test("the loudspeaker toggle is on the real-call surface and goes through the host", async () => {
    const calls: Record<string, unknown>[] = [];
    const emit = installBridge(async (command, args) => {
      calls.push({ cmd: command, ...(args ?? {}) });
      if (command === "telephony_set_speaker") {
        return {
          id: "c-spk",
          peer: "13100000000",
          state: "Active",
          direction: "Incoming",
          speaker: args?.speaker === true,
        };
      }
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();
    await talkingCall(container, emit, "c-spk", "13100000000");

    const on = () => container.querySelector(`button[aria-label="${zh["phone.speaker"]}"]`);
    expect(on()).toBeTruthy();
    await fireEvent.click(on()!);
    await vi.waitFor(() => {
      expect(
        container.querySelector(`button[aria-label="${zh["phone.speakerOff"]}"]`),
      ).toBeTruthy();
    });
    // The desired state travels (not a toggle), addressed to this call.
    expect(calls.find((c) => c.cmd === "telephony_set_speaker")).toMatchObject({
      callId: "c-spk",
      speaker: true,
    });
  });

  test("a refused loudspeaker switch says so and leaves the button alone", async () => {
    const emit = installBridge(async (command) => {
      if (command === "telephony_set_speaker") {
        throw {
          code: "amos.telephony.speaker_refused",
          message:
            "telephony speaker: no in-call service is bound (AmOS is not the default phone app)",
        };
      }
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();
    await talkingCall(container, emit, "c-spk2", "13200000000");

    await fireEvent.click(
      container.querySelector(`button[aria-label="${zh["phone.speaker"]}"]`)!,
    );
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("no in-call service is bound");
    expect(alert.textContent).toContain(zh["phone.speakerFailed"].split("{detail}")[0]);
    // A fabricated `Ok` would have lit the button over a call still on the earpiece.
    expect(container.querySelector(`button[aria-label="${zh["phone.speaker"]}"]`)).toBeTruthy();
    expect(container.querySelector(`button[aria-label="${zh["phone.speakerOff"]}"]`)).toBeNull();
  });

  test("the hold toggle is on the real-call surface and shows the held caption", async () => {
    const calls: Record<string, unknown>[] = [];
    const emit = installBridge(async (command, args) => {
      calls.push({ cmd: command, ...(args ?? {}) });
      if (command === "telephony_set_hold") {
        return {
          id: "c-hold",
          peer: "13300000001",
          state: "Active",
          direction: "Incoming",
          hold: args?.hold === true,
        };
      }
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();
    await talkingCall(container, emit, "c-hold", "13300000001");

    await fireEvent.click(container.querySelector(`button[aria-label="${zh["phone.hold"]}"]`)!);
    await vi.waitFor(() => {
      expect(container.querySelector(`button[aria-label="${zh["phone.holdOff"]}"]`)).toBeTruthy();
    });
    expect(calls.find((c) => c.cmd === "telephony_set_hold")).toMatchObject({
      callId: "c-hold",
      hold: true,
    });
    // The caption is the host's confirmation, not a local assumption.
    expect(container.textContent).toContain(zh["phone.onHold"]);
  });

  /**
   * REQ-A1188 / F-TEL-021 — the **third** device-only in-call control, left behind when
   * round #28 moved speaker/hold onto the surface that renders real `ROLE_DIALER` calls.
   *
   * `telephony_play_dtmf` is implemented, typed and registered, and `tauri-command-scan`
   * passes because `PhoneApp.svelte` calls it — but `PhoneApp` drives the *daemon*
   * transport, where the host refuses every device-only control ("no in-call service is
   * bound"). This overlay is the one surface a real incoming call reaches, and it had no
   * keypad: an auto-attendant's "press 1 to confirm" had nowhere to send a tone.
   */
  const dtmfKey = (container: HTMLElement, k: string) =>
    container.querySelector(
      `button[aria-label="${zh["phone.dtmfKey"].replace("{key}", k)}"]`,
    ) as HTMLButtonElement | null;

  test("the DTMF keypad is on the real-call surface and sends each key through the host", async () => {
    const calls: Record<string, unknown>[] = [];
    const emit = installBridge(async (command, args) => {
      calls.push({ cmd: command, ...(args ?? {}) });
      if (command === "telephony_play_dtmf") return true; // delivered to the call
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();
    await talkingCall(container, emit, "c-dtmf", "13400000001");

    // A disclosure: no pad until asked for, so it does not crowd the call screen.
    expect(container.querySelector('[data-testid="dtmf-pad"]')).toBeNull();
    await fireEvent.click(container.querySelector('[data-testid="dtmf-open"]')!);
    await tick();
    expect(container.querySelector('[data-testid="dtmf-pad"]')).toBeTruthy();
    // All twelve keys of a real keypad, each addressed by its localized label.
    expect(container.querySelectorAll('[data-testid="dtmf-key"]').length).toBe(12);

    await fireEvent.click(dtmfKey(container, "1")!);
    await vi.waitFor(() => {
      expect(calls.find((c) => c.cmd === "telephony_play_dtmf")).toMatchObject({
        callId: "c-dtmf",
        tone: "1",
      });
    });
    // The echo lights the key locally; a *confirmed* delivery stops disclaiming the far end.
    expect(container.querySelector('[data-testid="dtmf-echo"]')!.textContent).toContain("1");
    expect(container.textContent).toContain(zh["phone.dtmfSent"]);
  });

  test("a refused tone says so and does not claim the far end heard it", async () => {
    const emit = installBridge(async (command) => {
      if (command === "telephony_play_dtmf") {
        throw {
          code: "amos.telephony.dtmf_refused",
          message:
            "telephony DTMF: no in-call service is bound (AmOS is not the default phone app)",
        };
      }
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();
    await talkingCall(container, emit, "c-dtmf2", "13400000002");
    await fireEvent.click(container.querySelector('[data-testid="dtmf-open"]')!);
    await tick();

    await fireEvent.click(dtmfKey(container, "7")!);
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("no in-call service is bound");
    expect(alert.textContent).toContain(zh["phone.dtmfFailed"].split("{detail}")[0]);
    // The key still echoed (the user's press is real), but the note never claims delivery,
    // and the call is still up to retry on.
    expect(container.textContent).not.toContain(zh["phone.dtmfSent"]);
    expect(container.querySelector(`button[aria-label="${zh["phone.hangup"]}"]`)).toBeTruthy();
  });

  /**
   * `false` is not a failure — it is the host's honest "the tone did not reach the call"
   * (a bound service that declined to hand it over). It must stay a disclaimer, not an
   * error, and it must not be dressed up as delivered.
   */
  test("a host that answers 'not delivered' keeps the pad's own disclaimer", async () => {
    const emit = installBridge(async (command) => {
      if (command === "telephony_play_dtmf") return false;
      return null;
    });
    const { container } = render(IncomingCall);
    await settle();
    await talkingCall(container, emit, "c-dtmf3", "13400000003");
    await fireEvent.click(container.querySelector('[data-testid="dtmf-open"]')!);
    await tick();

    await fireEvent.click(dtmfKey(container, "5")!);
    await tick();
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull(); // not an error
    expect(container.querySelector('[data-testid="dtmf-echo"]')!.textContent).toContain("5");
    expect(container.textContent).toContain(zh["phone.dtmfLocal"]); // still disclaiming
  });

  test("the keypad's echo clears when the disclosure closes", async () => {
    const emit = installBridge();
    const { container } = render(IncomingCall);
    await settle();
    await talkingCall(container, emit, "c-dtmf4", "13400000004");

    const open = container.querySelector('[data-testid="dtmf-open"]')!;
    await fireEvent.click(open);
    await tick();
    await fireEvent.click(dtmfKey(container, "9")!);
    await tick();
    expect(container.querySelector('[data-testid="dtmf-echo"]')!.textContent).toContain("9");

    await fireEvent.click(open); // close
    await tick();
    await fireEvent.click(open); // reopen
    await tick();
    expect(container.querySelector('[data-testid="dtmf-pad"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="dtmf-echo"]')!.textContent).not.toContain("9");
  });
});

<script lang="ts">
  // PhoneApp.svelte — Svelte 5 (runes) single-source implementation of the phone
  // screen. Keypad/dial
  // logic reuses lib/phone + lib/emergency; dialing/events/record go through
  // lib/backend telephony; recent/frequent derive from the call log via
  // createStoreValue (mirrors useOutgoingCalls). Real dial/record verified on-device.
  import { KEYS, REAL_CALL_ID, backspace, callActionOutcome, clearDial, fmtCallDuration, placeOutgoingCall, pushKey } from "../lib/phone";
  import { forgetRealCall, realCallSnapshot } from "../lib/realCall";
  import { playRingback, stopCallTone } from "../lib/callTone";
  import { EMERGENCY_NUMBERS, EMERGENCY_QUICK_NUMBER, emergencyLabelKey, isEmergencyNumber } from "../lib/emergency";
  import {
    onTelephonyEvent, realDial, telephonyDial, telephonyEnd, telephonyPlayDtmf,
    telephonySetHold, telephonySetMuted, telephonySetSpeaker, telephonySimulateIncoming,
    telephonyStartRecording, telephonyStopRecording, telephonyStatus,
    blocklistAdd, blocklistClear, blocklistCheck, blocklistRemove, blocklistSetUnknown,
    blocklistSnapshot, blocklistStatus, blocklistRequestRole,
    telephonyDefaultDialerStatus, telephonyRequestDefaultDialer,
    telephonyBackendKind, realDialStatus,
    bridged, bridgeDiag,
  } from "../lib/backend";
  import type { BlockReasonOut, BlockRuleOut, BlocklistStatusOut, DialerRoleStatusOut, TelephonyCall } from "../lib/backend";
  import { amosWarn } from "../lib/debugLog";
  // Svelte's own `get` (NOT `../svelte/store`, the shared-store wrapper): the flush needs a
  // non-reactive read of the call-log store.
  import { get } from "svelte/store";
  import { CONTACTS_KEY, contactNameFor, normalizeContacts } from "../lib/contacts";
  import type { Contact } from "../lib/contacts";
  import { CALLLOG_KEY, callDateStamp, callHistory, callWhenLabel, clearCallHistory, filterHistory, flushPendingCalls, fmtCallClock, frequentNumbers, logNameFor, missedCalls, normalizeCallLog, pendingCallCount, recordCall } from "../lib/calllog";
  import type { CallFilter, CallRecord } from "../lib/calllog";
  import { composeSmsTo } from "./appLinks";
  import { NOTIF_KEY, addNotif, newNotifId, normalizeNotifs } from "../lib/settings";
  import type { Notif } from "../lib/settings";
  import { bgT } from "./bgText";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { iconSvg } from "../lib/sysIcons";
  import { t } from "./locale.svelte";
  import { createStoreValue } from "./store";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { phoneChannel } from "./appLinks";
  import { onMount } from "svelte";
  import { emitDockBounce } from "../lib/dockConfig";
  import { surface } from "./shellState.svelte";

  type PhoneTab = "keys" | "recent" | "frequent" | "emergency" | "block";
  const SUB: Record<string, string> = {
    "2": "ABC", "3": "DEF", "4": "GHI", "5": "JKL",
    "6": "MNO", "7": "PQRS", "8": "TUV", "9": "WXYZ",
  };
  let num = $state("");
  let calling = $state(false);
  let activeId = $state<string | null>(null);
  let talking = $state(false);
  let recording = $state<"Off" | "On" | "Failed">("Off");
  let dialError = $state<string | null>(null);
  // A non-error status line (e.g. a call handed to the system dialer) — shown in the
  // same slot as `dialError` but not styled as a failure.
  let notice = $state<string | null>(null);
  // The host's own words for the last refused **in-call** action. `dialError`/`notice`
  // live on the keypad (they render only `{#if !calling}`), so an in-call refusal had
  // no slot at all — the recording toggle's rejection was discarded and the screen
  // stayed silent (the same F-SH-236 family as `IncomingCall.svelte`).
  let inCallError = $state<string | null>(null);
  // This call is a **simulation**: the daemon's mock/demo provider answered on a host
  // with no telephony stack, so nothing left the device. Only ever set on the desktop
  // fallback branch of `placeOutgoingCall` — on a device that branch is unreachable by
  // construction — and it drives the "模拟通话" line, because "通话中" alone would claim
  // a call that never happened (REQ-A311).
  let simulated = $state(false);
  let tab = $state<PhoneTab>("keys");
  // Phone dial deep link (Spotlight's "fill the dialler" action): **prefill only** —
  // placing the call stays the user's decision, so a link never starts one. The link is
  // a request and is consumed once (a later remount starts clean), exactly like the
  // Messages compose link.
  let dialNonce = 0;
  $effect(() => {
    return phoneChannel().subscribe((v) => {
      if (!v || v.number.trim() === "" || v.nonce === dialNonce) return;
      dialNonce = v.nonce;
      num = v.number;
      tab = "keys";
      dialError = null;
      notice = null;
      phoneChannel().set({ number: "", nonce: dialNonce });
    });
  });
  /**
   * Whether the **daemon's** call state says this call is muted. It is not a local
   * flag: muting is a call state other surfaces read too (the lock screen, the AI
   * assistant) via the `Watch` stream, so this mirrors the daemon exactly like
   * `recording` does. Locally flipping it would make this screen the only place that
   * believes the user is muted — the shape `docs/telephony.md` recorded as
   * 「已静音（本地…）」 before the daemon owned the flag.
   */
  let muted = $state(false);
  /**
   * Whether this call's audio is routed to the loudspeaker / whether it is on hold.
   *
   * Device-only call state, like `speaker` on the wire: the daemon's transport has no
   * audio route and no hold, so a daemon snapshot never claims either and the host
   * refuses the command instead of reporting a switch it did not make. Both follow the
   * "absent means no claim" rule the event handler applies below.
   */
  let speaker = $state(false);
  let hold = $state(false);
  let padOpen = $state(false);
  let dtmf = $state("");
  /**
   * Whether the host confirmed the **last** DTMF tone reached the call: `true` when a
   * bound in-call service handed it to Telecom, `false` when it did not go out, `null`
   * when nothing has been sent yet. The pad's honesty note is the only thing that reads
   * it — a promise about the far end is exactly the kind of claim this screen must earn
   * from the host rather than assert (see `phone.dtmfLocal` / `phone.dtmfSent`).
   */
  let dtmfReached = $state<boolean | null>(null);
  let elapsedSec = $state(0);
  let activeRef: string | null = null;
  let activeAtRef: number | null = null;
  /**
   * Call ids we ended locally. The daemon can report a call as still live for a
   * beat after `telephony_end`, so this stops a resume/recheck from re-adopting a
   * call the user just hung up (which would make the in-call screen reappear).
   */
  const endedIds = new Set<string>();

  // ---- Spam blocking (calls + SMS) -------------------------------------------
  // Rules live in Rust (shared with the SMS filter and the Android call-screening
  // service), so this screen is a thin, honest view over that one source. The
  // shared `invoke()` helper does NOT throw: it swallows a command rejection and
  // returns `null`, leaving the reason in `bridgeDiag()`. So every call here must
  // check `null` / `bridgeDiag()` — otherwise a rejected rule silently does nothing.
  let blockRules = $state<BlockRuleOut[]>([]);
  let blockUnknown = $state(false);
  let blockStatus = $state<BlocklistStatusOut | null>(null);
  /**
   * The **last enforcement probe** was refused, so `blockStatus`'s `null` is 「我没问到」 and
   * not a verdict (REQ-A1513 / F-SH-758). A separate flag because `null` is also the value
   * before the first read lands — that is 「还没问」, and drawing the sentence for it would
   * cry wolf on every open. Note `null` here is **never** the desktop: `blocklist_status` is
   * registered unconditionally and the desktop `role_probe()` `Err` is answered as
   * `role_supported:false` (`blocklist.rs` `role_status_from`), so a `null` only ever means
   * the command was refused.
   */
  let blockStatusUnanswered = $state(false);
  let blockNum = $state("");
  let blockKind = $state<BlockRuleOut["kind"]>("exact");
  let blockChannel = $state<BlockRuleOut["channel"]>("both");
  let blockErr = $state("");
  let blockBusy = $state(false);
  /**
   * Whether AmOS is the device's **default phone app** (`ROLE_DIALER`), probed from the
   * host. `null` = the probe was refused (`invoke` resolves `null`, reason in
   * `bridgeDiag()`). It is **not** desktop: `telephony_default_dialer_status` returns a
   * `DialerRoleStatus` (non-`Result`), is registered unconditionally, and the desktop
   * `role_probe()` `Err` is folded by `dialer_role_status_from` into an **answered**
   * `role_supported:false`. So a refusal must say so rather than hiding the prompt.
   *
   * This is the remedy the whole real in-call seam lacked: answer / hang-up / mute /
   * speaker / hold / DTMF / recording each refuse with "AmOS is not the default phone
   * app", and until this round nothing in any layer could tell the user whether that is
   * true or offer the grant (REQ-A1180).
   */
  let dialerRole = $state<DialerRoleStatusOut | null>(null);
  /**
   * The **last default-phone-app probe** was refused, so `dialerRole`'s `null` is 「我没问到」
   * and not a verdict (REQ-A1531 / F-SH-774). A separate flag because `null` is also the value
   * before the first read lands — that is 「还没问」, and drawing the sentence for it would cry
   * wolf on every open. Same shape as the sibling `blockStatusUnanswered` on this screen.
   */
  let dialerRoleUnanswered = $state(false);
  let dialerBusy = $state(false);
  let dialerErr = $state("");
  /**
   * Live "would this be blocked?" preview for the address being typed. Only a
   * POSITIVE answer is kept: `blocklistCheck` returns `null` both for "allowed"
   * and for "bridge unavailable", so a null is never rendered as a promise that
   * the number is safe.
   */
  let blockPreview = $state<BlockReasonOut | null>(null);
  let confirmClearRules = $state(false);

  const loadBlocklist = async () => {
    const b = await blocklistSnapshot();
    if (!b) {
      // `invoke` returns null when the command failed (reason in `bridgeDiag()`);
      // never shown as a silent empty list.
      if (bridged()) blockErr = t("phone.blockLoadFailed");
      return;
    }
    blockRules = b.rules;
    blockUnknown = b.block_unknown;
  };
  // Rules alone do not block calls — the OS Call Screening role does. Probe it so
  // the UI can say whether rejection is actually live.
  const loadBlockStatus = async () => {
    // `null` = the probe was refused (`invoke` resolves `null`, reason in `bridgeDiag()`).
    // It is **not** desktop: the desktop answer is a real `role_supported:false`. So a
    // refused probe must say so rather than leaving the banner blank (REQ-A1513 / F-SH-758).
    const answer = await blocklistStatus();
    blockStatus = answer;
    blockStatusUnanswered = answer === null;
  };
  const refreshBlock = async () => {
    await loadBlocklist();
    await loadBlockStatus();
  };
  $effect(() => {
    if (!bridged()) return;
    void refreshBlock();
  });
  // Is AmOS the default phone app? Same "probe, don't assume" rule as the Call Screening
  // role above: `null` (no bridge) leaves the prompt hidden instead of claiming a verdict.
  const loadDialerRole = async () => {
    const answer = await telephonyDefaultDialerStatus();
    dialerRole = answer;
    dialerRoleUnanswered = answer === null;
  };
  const requestDialerRole = async () => {
    dialerErr = "";
    dialerBusy = true;
    try {
      const ok = await telephonyRequestDefaultDialer();
      if (!ok && bridged()) {
        dialerErr = t("phone.dialerRoleFailed");
        amosWarn("phone", "dialer role request failed", bridgeDiag("telephony_request_default_dialer"));
      }
    } finally {
      dialerBusy = false;
    }
    // The dialog only *posts*; the user answers it in a separate system Activity, so the
    // verdict is re-read (never assumed from the command's answer) — the same rule
    // `requestBlockRole` follows.
    await loadDialerRole();
  };
  // The Call Screening role is granted in a *separate* system Activity, so the
  // user's answer lands long after `blocklist_request_role` returned (that command
  // only posts the dialog). Re-probe the status on resume/focus — and every time
  // the 拦截 tab is opened — so the banner flips to "active" (or back to "needs
  // granting" after an external revoke) without restarting the app.
  $effect(() => {
    if (tab !== "block" || !bridged()) return;
    void loadBlockStatus();
  });
  // Same re-probe on the keypad tab: the ROLE_DIALER dialog is a separate system Activity,
  // so the screen must not keep claiming "not the default phone app" after the user grants
  // it (or stop claiming it after an external revoke).
  $effect(() => {
    if (tab !== "keys" || !bridged()) return;
    void loadDialerRole();
  });
  // Live preview: ask the DAEMON whether the address being typed is already
  // covered (debounced). Only a positive match is kept — see `blockPreview`.
  $effect(() => {
    const addr = blockNum.trim();
    const channel = blockChannel;
    if (tab !== "block" || !bridged() || addr === "") {
      blockPreview = null;
      return;
    }
    // The cleanup below runs when the address/channel/tab changes, but clearing the
    // *timer* is not enough: once the debounce has fired the `blocklistCheck` promise
    // is already in flight, and a reply that lands after the user emptied the field
    // would still write `blockPreview` — drawing a match for an abandoned number and
    // defeating this effect's own `addr === "" ⇒ null` guard. So the landing is gated
    // on the run still being live.
    let live = true;
    const id = window.setTimeout(() => {
      void blocklistCheck(addr, channel).then((r) => {
        if (!live) return; // the field changed/cleared while the daemon was answering
        blockPreview = r;
      });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  });
  /**
   * Adopt a call that is ALREADY running. The call UI is component-local, so
   * reopening the Phone app during a live call used to show a bare keypad with no
   * way to hang up; `onTelephonyEvent` also ignores events for a call it never
   * adopted (`activeRef` null), so an inbound call answered elsewhere stayed
   * invisible. Reads the daemon's list (never invents a call) and ignores an
   * `Ended` snapshot.
   */
  const adoptLiveCall = async () => {
    if (!bridged() || calling) return;
    const live = await telephonyStatus();
    if (calling) return; // a local call won the race
    // The daemon's list cannot contain a call AmOS owns through `ROLE_DIALER`: that one
    // is reported by `incall.rs`'s upcall under the fixed id `real` and by nothing else,
    // so the page would forget it on every remount (`AppPane`'s `{#key id}` unmounts this
    // component whenever the user switches apps) — a bare keypad over a live call, which
    // is the outcome the hand-off adoption was added to prevent. The shell-global
    // subscriber is never remounted; what it recorded is read here (`lib/realCall.ts`)
    // (REQ-A1231).
    // `null` is a *refused read* (`invoke` answers `null` for "no host" and for a thrown
    // command alike) — a different sentence from "the daemon has no calls" — so it is kept
    // as its own case rather than folded into an empty list (`read-fold-scan`). It changes
    // nothing about the snapshot, which is the one thing we do know either way.
    const known: TelephonyCall[] = live === null ? [] : live.slice();
    const snap = realCallSnapshot();
    if (snap) known.push(snap);
    // Ignore calls we already ended locally, and never adopt an `Ended` snapshot.
    const live1 = known.filter((c) => c.state !== "Ended" && !endedIds.has(c.id));
    const call = live1.find((c) => c.state === "Active") ?? live1[0];
    if (!call) return;
    num = call.peer || num;
    calling = true;
    activeId = call.id;
    activeRef = call.id;
    talking = call.state === "Active";
    recording = (call.recording as "Off" | "On" | "Failed") ?? "Off";
    // `false` (not a fallback to the previous value): a daemon *snapshot* always knows
    // the mute flag, so its absence would mean the payload is not a daemon snapshot at
    // all — the per-event path below is where an absent field must not be read.
    muted = call.muted === true;
    // A daemon snapshot never carries either (no audio route, no hold), so this reads as
    // "the route we are on" — the earpiece, not held. `=== true` keeps an absent field
    // from being read as a claim, the same rule the event path applies.
    speaker = call.speaker === true;
    hold = call.hold === true;
    activeAtRef = talking ? Date.now() : null;
  };

  onMount(() => {
    const recheck = () => {
      if (document.visibilityState !== "visible" || !bridged()) return;
      void loadBlockStatus();
      // The ROLE_DIALER grant happens in the system's own Activity, so the verdict lands
      // after `telephony_request_default_dialer` returned — coming back to the foreground
      // is when the prompt must flip (or reappear after a revoke).
      void loadDialerRole();
      void adoptLiveCall();
    };
    // Returning to the app mid-call must restore the in-call UI.
    void adoptLiveCall();
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  });

  /** Two-step "clear every rule" (rules alone never reject calls — the role does). */
  const clearAllRules = async () => {
    if (!confirmClearRules) {
      confirmClearRules = true;
      return;
    }
    confirmClearRules = false;
    blockErr = "";
    await blocklistClear();
    // `blocklist_clear` is a `void` command: `invoke` never rejects, so the reply cannot
    // say whether the rules were actually dropped. `refreshBlock()` re-reads, so the
    // failure is not drawn as success — the rules stay on screen — but without this the
    // clear was a silent no-op: the list simply did not change and nothing said why.
    // (Same attribution rule as `toggleBlockUnknown` below, and the failure direction is
    // the safe one: the blocklist stays in force.)
    if (!bridgeDiag("blocklist_clear").ok) {
      blockErr = t("phone.blockSaveFailed");
      amosWarn("blocklist", "clear failed", bridgeDiag("blocklist_clear"));
    }
    await refreshBlock();
  };

  const addBlockRule = async (
    raw: string = blockNum,
    kind: BlockRuleOut["kind"] = blockKind,
    channel: BlockRuleOut["channel"] = blockChannel,
  ) => {
    const pattern = raw.trim();
    if (!pattern) return false;
    blockErr = "";
    blockBusy = true;
    try {
      // The domain rejects junk (too short / letters / short prefix); the injected
      // error surfaces as a `null` result (see `invoke`), not a thrown promise.
      const rule = await blocklistAdd(pattern, kind, channel);
      if (!rule) {
        amosWarn("blocklist", "add rejected", bridgeDiag("blocklist_add"));
        blockErr = t("phone.blockInvalid");
        return false;
      }
      blockNum = "";
      await refreshBlock();
      return true;
    } finally {
      blockBusy = false;
    }
  };
  const removeBlockRule = async (id: string) => {
    blockErr = "";
    const removed = await blocklistRemove(id);
    // Ask about **this** command's outcome: `bridgeDiag()` without a name is a global
    // slot that any other command can overwrite, which here decides between "the removal
    // failed" and "the rule was already gone" (REQ-A296).
    if (!bridgeDiag("blocklist_remove").ok) {
      blockErr = t("phone.blockRemoveFailed");
      amosWarn("blocklist", "remove failed", bridgeDiag("blocklist_remove"));
    } else if (!removed) {
      // Not an error: the rule was already gone (e.g. removed elsewhere).
      amosWarn("blocklist", "remove: rule not found", id);
    }
    await refreshBlock();
  };
  const toggleBlockUnknown = async () => {
    const next = !blockUnknown;
    blockUnknown = next; // optimistic, rolled back on failure
    blockErr = "";
    await blocklistSetUnknown(next);
    // Same attribution rule: an unrelated failure must not roll back a switch the host
    // really saved, and an unrelated success must not hide this one's failure.
    if (!bridgeDiag("blocklist_set_unknown").ok) {
      blockUnknown = !next;
      blockErr = t("phone.blockSaveFailed");
      amosWarn("blocklist", "set_unknown failed", bridgeDiag("blocklist_set_unknown"));
    }
    // The switch is an **input** to the banner, not just to the rule list:
    // `filters_calls` is "a rule covers calls **or** the switch is on", so arming it
    // must re-read the status like every other mutator here does. Without this the
    // panel stayed silent about enforcement until the tab was left and re-entered.
    await refreshBlock();
  };
  const requestBlockRole = async () => {
    blockErr = "";
    blockBusy = true;
    try {
      const ok = await blocklistRequestRole();
      if (!ok && bridged()) {
        blockErr = t("phone.blockRoleFailed");
        amosWarn("blocklist", "role request failed", bridgeDiag("blocklist_request_role"));
      }
    } finally {
      blockBusy = false;
    }
    await loadBlockStatus();
  };
  // One-tap entry (call log): block this exact number on both channels and show it.
  const blockFromRecents = (n: string) => {
    tab = "block";
    void addBlockRule(n, "exact", "both");
  };
  // The enforcement banner is about CALL rules, and the role probe answers one of
  // three things: held (rejection is live), askable (supported + the native glue is
  // bound → a foreground grant can be offered), or neither (desktop build, Android
  // without the role, or a bridge that is not ready). All three must render — the
  // "neither" case is exactly where the user must not assume calls are blocked.
  // `filters_calls`, not `has_call_rules`: the withheld-number path rejects under
  // the 「屏蔽未知/隐藏号码」 switch alone (an unparseable address is `Unknown`), so
  // with the switch on and **zero** call rules a withheld caller is still rejected.
  // The banner must appear then too — the call-side twin of `filters_sms`.
  const filtersCalls = $derived(!!blockStatus?.filters_calls);
  const roleHeld = $derived(!!blockStatus?.role_held);
  const roleAskable = $derived(!!blockStatus?.role_supported && !!blockStatus.role_requestable);
  // The dialer twin: rendered while the role is **not** held, in three states — "askable"
  // (the native glue is bound → offer the grant), "the host answered: no such role"
  // (desktop, a device without telephony: nothing to grant here), and "we could not ask"
  // (the probe was refused) — because the whole in-call seam is dead in all three and only
  // the first is fixable here. `dialerRoleUnanswered` keeps the third out of the blank
  // default the second shares with "not asked yet" (REQ-A1531 / F-SH-774).
  const dialerSupportedUnheld = $derived(
    !!dialerRole?.role_supported && !dialerRole.role_held,
  );
  const dialerAskable = $derived(!!dialerRole?.role_requestable);

  // The address book, **live** — not a snapshot taken at init. This screen is
  // remounted on every app switch (the pane is `{#key id}`), but a **split pane**
  // keeps it mounted beside the Contacts screen, so a contact added or renamed in
  // the other pane must reach the recents/history labels here — and the name
  // `recordOutgoing` writes into the call log — without waiting for a remount.
  // Same fix, same primitive as the sibling `IncomingCall` (which is mounted once
  // for the whole shell, so there it was stale for the entire session).
  const contactsStore = createStoreValue<unknown>(CONTACTS_KEY, []);
  let contacts = $state<Contact[]>([]);
  $effect(() => {
    return contactsStore.subscribe((v) => {
      contacts = normalizeContacts(v);
    });
  });

  // recents / frequent from the shared call log (like useOutgoingCalls).
  const callLogStore = createStoreValue<unknown>(CALLLOG_KEY, []);
  // A rejected call-log write (full/unavailable storage) must be visible: the log is
  // content the user expects to still be there next time.
  let storeErr = $state("");
  let callLog = $state<CallRecord[]>([]);
  let flushing = false;
  // A call that ended while storage was unavailable is kept in memory by
  // `lib/calllog` (see `queuePendingCall`); the history screen is the place that can both
  // write it and tell the user, so it retries here and admits to what has not landed
  // (REQ-A150). A successful flush clears the notice.
  const flushPendingCallsNow = () => {
    if (flushing || pendingCallCount() === 0) return;
    flushing = true;
    try {
      // `get(callLogStore)` and **not** the `callLog` state: reading the state here would
      // make it a dependency of the subscribing effect below, and the store's synchronous
      // first callback (which assigns a fresh normalized array) would then re-enter this
      // effect forever — `effect_update_depth_exceeded`.
      const landed = flushPendingCalls(normalizeCallLog(get(callLogStore)), (next) =>
        callLogStore.save(next),
      );
      storeErr =
        landed > 0 || pendingCallCount() === 0
          ? ""
          : t("phone.pendingCalls", { n: pendingCallCount() });
    } finally {
      flushing = false;
    }
  };
  $effect(() => {
    // `subscribe` invokes its callback **synchronously** with the current value, so this
    // one subscription also *is* the flush-on-mount: a pending call left over by a finished
    // call is retried here, where a screen exists to report the outcome. (An extra
    // `flushPendingCallsNow()` after subscribing was removed as dead code — a negative
    // control showed it changed nothing.)
    const unsub = callLogStore.subscribe((v) => {
      callLog = normalizeCallLog(v);
      flushPendingCallsNow();
    });
    return unsub;
  });
  const frequent = $derived(
    frequentNumbers(callLog, 3).map((n) => ({ num: n, label: contactNameFor(contacts, n) ?? n })),
  );

  // Known name for the number currently being dialed: the address book first, then
  // the best name the call log remembers for it (`lib/calllog.logNameFor`, which
  // uses the SAME digit-normalised equality as the recents list) — so a number you
  // have called before shows who it was *before* you dial again.
  const dialName = $derived(
    num ? (contactNameFor(contacts, num) ?? logNameFor(callLog, num) ?? "") : "",
  );

  // ---- Call history page ------------------------------------------------------
  // The full log (newest-first, capped) with the three per-row actions the user
  // asked for: call back / text back / block. The log is the single shared source
  // (`amos.calllog`), written by outgoing dials AND finished incoming calls.
  //
  // The page adds a direction filter and a two-step "clear" over that one source;
  // both are honest — clearing really drops the local records (there is no system
  // call log to reconcile with), and the filter only ever hides rows it also
  // normalizes (see `filterHistory`).
  const FILTERS: CallFilter[] = ["all", "incoming", "outgoing", "missed"];
  let logFilter = $state<CallFilter>("all");
  let confirmClear = $state(false);
  const history = $derived(
    filterHistory(callLog, logFilter).map((r) => ({
      num: r.number,
      label: contactNameFor(contacts, r.number) ?? r.name ?? r.number,
      ts: r.ts,
      direction: r.direction ?? null,
    })),
  );
  // Total rows across every direction (so an empty *filtered* view can be told
  // apart from an empty log — "该筛选下暂无记录" vs "暂无最近通话").
  const historyTotal = $derived(callHistory(callLog).length);
  const missedTotal = $derived(missedCalls(callLog));
  const whenOf = (ts: number): string => {
    const bucket = callWhenLabel(ts);
    if (bucket === "unknown") return "";
    const day =
      bucket === "today"
        ? t("phone.whenToday")
        : bucket === "yesterday"
          ? t("phone.whenYesterday")
          : callDateStamp(ts);
    const clock = fmtCallClock(ts);
    return clock ? `${day} ${clock}` : day;
  };
  const dirLabel = (d: string | null): string =>
    d === "incoming"
      ? t("phone.dirIncoming")
      : d === "outgoing"
        ? t("phone.dirOutgoing")
        : d === "missed"
          ? t("phone.dirMissed")
          : t("phone.dirUnknown");
  // Filter-chip label: the "all" chip is its own word; the rest reuse the exact
  // direction wording shown on the rows, so a chip never says something the rows
  // do not.
  const filterLabel = (f: CallFilter): string =>
    f === "all" ? t("phone.historyFilterAll") : dirLabel(f);
  // Clear the whole history (two-step: the first tap arms, the second commits so a
  // stray tap cannot wipe the log). Resets the filter, since an empty log has none.
  const clearLog = () => {
    // Wiping the history is destructive: only claim it when the write landed.
    if (!callLogStore.save(clearCallHistory())) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    confirmClear = false;
    logFilter = "all";
  };
  const callBack = (n: string) => void startCall(n);
  const smsBack = (n: string) => composeSmsTo(n);

  const recordOutgoing = (number: string, name?: string, body?: string) => {
    const next = recordCall(callLog, number, name, Date.now(), "outgoing");
    // The entry may not reach the log — say so rather than losing it silently.
    storeErr = callLogStore.save(next) ? "" : t("common.storeWriteFailed");
    const label = name && name.trim() !== "" ? name.trim() : number;
    const entry: Notif = {
      id: newNotifId(),
      app: bgT("app.phone"),
      title: label,
      body,
      icon: "📞",
      time: Date.now(),
    };
    writeStoreValue(
      NOTIF_KEY,
      addNotif(normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, [])), entry),
    );
  };

  const tap = (k: string) => {
    if (!calling) num = pushKey(num, k);
  };
  const startCall = async (number = num) => {
    const target = number.trim();
    if (target === "") return;
    num = target;
    calling = true;
    talking = false;
    activeId = null;
    activeRef = null;
    activeAtRef = null;
    elapsedSec = 0;
    recording = "Off";
    muted = false;
    speaker = false;
    hold = false;
    padOpen = false;
    dtmf = "";
    dtmfReached = null;
    dialError = null;
    notice = null;
    inCallError = null;
    simulated = false;
    // **Real path first** (`placeOutgoingCall`): a direct ACTION_CALL through the host,
    // then a daemon backed by a genuinely real stack, and only on a host with no
    // telephony stack at all does the daemon's simulated call stand in. The routing is
    // the library's decision, so this screen and ContactsApp cannot drift apart.
    //
    // Whether a number is an emergency number is a property of the **number**, not of
    // which button was pressed: passing it in from each call site is how a
    // keypad-typed `110` used to be treated differently from the emergency page's
    // `110`. The question is asked once, here.
    const outcome = await placeOutgoingCall(target, isEmergencyNumber(target), {
      system: (n) => realDial(n),
      daemonReal: async () => (await telephonyBackendKind())?.real === true,
      hostStatus: () => realDialStatus(),
      daemon: (n, e) => telephonyDial(n, e),
    });
    if (outcome.kind === "failed") {
      calling = false;
      // The host's own words when it gave any: on a device that is usually the remedy
      // ("grant CALL_PHONE and re-open the app"), which a generic line would hide.
      dialError = outcome.reason !== "" ? t("phone.dialFailedDetail", { detail: outcome.reason }) : t("phone.dialFailed");
      return;
    }
    // `ACTION_CALL` was handed to Android Telecom. **Which dialer owns it now** decides
    // what this screen may show, and the answer is the ROLE_DIALER role, not a guess:
    //
    //   * AmOS holds the role ⇒ Telecom resolves the call straight back into *our own*
    //     `AmosInCallService` — the "system dialer" and this app are the same process —
    //     so there is no other in-call screen to fall back to. Such a call crosses the
    //     bridge under the fixed id `real` (`incall.rs`), and only a *bound* in-call
    //     service ever emits it, so pointing this screen at that id hands the real
    //     `Dialing`/`Active`/`Ended` events to a surface that has a hang-up key. The
    //     alternative — stepping back to the keypad and calling it "handed to the
    //     system" — left a live call with no control anywhere on screen (the "system"
    //     that took it *is* this app).
    //   * AmOS does **not** hold the role ⇒ another dialer owns the call and there is
    //     genuinely no screen here to drive, so the keypad + notice is the honest view.
    //
    // The probe is re-read rather than trusting `dialerRole` as it was at mount: the
    // grant is answered in a separate system Activity, so the role can have been
    // granted (or revoked) since. A probe that fails answers `null` — no verdict — and
    // we keep the previous reading rather than downgrading a real call to "handed off".
    if (outcome.kind === "handed-off") {
      const role = await telephonyDefaultDialerStatus();
      if (role) dialerRole = role;
      recordOutgoing(target, contactNameFor(contacts, target) ?? target, t("phone.dialed"));
      if (dialerRole?.role_held) {
        calling = true;
        talking = false;
        activeId = REAL_CALL_ID;
        activeRef = REAL_CALL_ID;
        activeAtRef = null;
        return;
      }
      calling = false;
      notice = t("phone.handedToSystem");
      return;
    }
    activeId = outcome.id || null;
    activeRef = activeId;
    // The log entry says which of the two this was — a simulated dial is recorded as
    // one, so the recents list cannot read back as a call the device placed.
    simulated = outcome.simulated;
    recordOutgoing(
      target,
      contactNameFor(contacts, target) ?? target,
      outcome.simulated ? t("phone.dialedSimulated") : t("phone.dialed"),
    );
  };
  const pick = (n: string) => {
    if (calling) return;
    num = n;
    tab = "keys";
  };

  const endCall = async () => {
    const id = activeId;
    // Remember the id BEFORE ending: a resume/recheck may still see it live (the daemon
    // reports a call as live for a beat after a *successful* `telephony_end`).
    if (id) endedIds.add(id);
    if (id) {
      await telephonyEnd(id);
      // The verdict is not the return value: `telephony_end` answers a typed `AmosError`
      // when the in-call service refuses the hang-up or the daemon is unreachable, and
      // `invoke` folds that into `null` — the same value its `void` success has. Reading
      // that `null` as "ended" tore the call surface down and said nothing, so a call the
      // device never let go of looked hung up and had no key left to try again. The
      // sibling `IncomingCall.svelte::leave` says the same thing in its own comment.
      const out = callActionOutcome(bridgeDiag("telephony_end"));
      if (out.kind === "refused") {
        // `endedIds` records the calls we ended. Nothing ended, so the id must not stay
        // there claiming otherwise (F-ALM-004: ask the host first, forget second).
        endedIds.delete(id);
        inCallError = t("phone.hangupFailed", {
          detail: out.detail === "" ? t("phone.actionNoReason") : out.detail,
        });
        return; // keep the surface — the call is still up and must stay hangable
      }
    }
    // The host accepted the hang-up — so the shell-global record of the platform-owned call
    // must not outlive it. `endedIds` above is component-local and dies with the remount
    // that `adoptLiveCall` exists to survive, and the stream's `Ended` trails a successful
    // `telephony_end` by a beat; without this, leaving the app in that window and returning
    // re-adopts a call the user just ended (REQ-A1234).
    if (id) forgetRealCall(id);
    calling = false;
    talking = false;
    activeId = null;
    activeRef = null;
    recording = "Off";
    muted = false;
    speaker = false;
    hold = false;
    simulated = false;
    padOpen = false;
    dtmf = "";
    dtmfReached = null;
    dialError = null;
    notice = null;
    inCallError = null;
  };
  const toggleRecord = async () => {
    if (!activeId) return;
    inCallError = null;
    const turningOn = recording !== "On";
    const command = turningOn ? "telephony_start_recording" : "telephony_stop_recording";
    const res = turningOn
      ? await telephonyStartRecording(activeId)
      : await telephonyStopRecording(activeId);
    // The verdict is not the return value: a refused recording answers a typed
    // `AmosError` that `invoke` folds into `null` — the same value a `void` success
    // has — so `if (res)` read a refusal as "nothing to say". Ask the diagnosis slot.
    const out = callActionOutcome(bridgeDiag(command));
    if (out.kind === "refused") {
      inCallError = t("phone.recordFailed", {
        detail: out.detail === "" ? t("phone.actionNoReason") : out.detail,
      });
      return;
    }
    // Absent is "no claim", like the mute/speaker/hold fields: a reply that does not
    // mention recording must keep the state the user is looking at.
    if (res && typeof res.recording === "string") {
      recording = res.recording as "Off" | "On" | "Failed";
    }
  };
  /**
   * Toggle the call's mute flag through the daemon. Same verdict rule as
   * `toggleRecord`: a refusal answers a typed `AmosError` that `invoke` folds into
   * `null` — indistinguishable from success — so the outcome is read from the
   * diagnosis slot, and the flag is only moved when the daemon confirms it.
   */
  const toggleMute = async () => {
    if (!activeId) return;
    inCallError = null;
    const next = !muted;
    const command = "telephony_set_muted";
    const res = await telephonySetMuted(activeId, next);
    const out = callActionOutcome(bridgeDiag(command));
    if (out.kind === "refused") {
      inCallError = t("phone.muteFailed", {
        detail: out.detail === "" ? t("phone.actionNoReason") : out.detail,
      });
      return;
    }
    // The daemon's answer is authoritative; a `null` here with no refusal recorded
    // means the reply was empty, so don't claim a state change that was not confirmed.
    if (res && typeof res.muted === "boolean") muted = res.muted;
  };
  /**
   * Toggle the loudspeaker route. Device-only: without a bound in-call service the host
   * has no audio route to change and refuses in typed words, so the button must report
   * that rather than light up over a call still on the earpiece. Same verdict rule as
   * `toggleMute` — the outcome is read from the diagnosis slot, and the flag only moves
   * when the host confirms it.
   */
  const toggleSpeaker = async () => {
    if (!activeId) return;
    inCallError = null;
    const next = !speaker;
    const res = await telephonySetSpeaker(activeId, next);
    const out = callActionOutcome(bridgeDiag("telephony_set_speaker"));
    if (out.kind === "refused") {
      inCallError = t("phone.speakerFailed", {
        detail: out.detail === "" ? t("phone.actionNoReason") : out.detail,
      });
      return;
    }
    if (res && typeof res.speaker === "boolean") speaker = res.speaker;
  };
  /** Put the call on hold / take it off. Same device-only contract and verdict rule as
   *  `toggleSpeaker`: a call that cannot be held is a typed refusal, never a lit button. */
  const toggleHold = async () => {
    if (!activeId) return;
    inCallError = null;
    const next = !hold;
    const res = await telephonySetHold(activeId, next);
    const out = callActionOutcome(bridgeDiag("telephony_set_hold"));
    if (out.kind === "refused") {
      inCallError = t("phone.holdFailed", {
        detail: out.detail === "" ? t("phone.actionNoReason") : out.detail,
      });
      return;
    }
    if (res && typeof res.hold === "boolean") hold = res.hold;
  };
  const simIncoming = async () => {
    if (calling) return;
    dialError = null;
    notice = null;
    const from = num.trim() !== "" ? num.trim() : "02112345678";
    await telephonySimulateIncoming(from);
    // The verdict is not the return value: `telephony_simulate_incoming` answers a typed
    // `AmosError` when the daemon is unreachable or refuses the ring, and `invoke` folds
    // that into `null` — the value a refused ring shares with an accepted one whose id the
    // caller ignores. Discarding it made the button acknowledge nothing: no call arrived and
    // no words explained why. The keypad's own failure slot is `dialError` (`{#if !calling}`);
    // `inCallError` lives inside `{#if calling}` and has no render point on this surface.
    const out = callActionOutcome(bridgeDiag("telephony_simulate_incoming"));
    if (out.kind === "refused") {
      dialError = t("phone.simIncomingFailed", {
        detail: out.detail === "" ? t("phone.actionNoReason") : out.detail,
      });
      return;
    }
    // P4: 触发 Dock 弹跳（仅在应用未激活时）。After the ring is confirmed: a bounce is a
    // claim that a call is arriving, so a refused sim must not send one.
    const s = surface();
    if (s.kind !== "app" || s.id !== "phone") {
      emitDockBounce("phone");
    }
  };
  /**
   * Press a DTMF key: echo it on the pad **and** hand the tone to the call.
   *
   * The local echo is the visual feedback (a keypad must light up when pressed), but it
   * is not the whole action — the host command that sends the tone to Telecom exists
   * (`telephony_play_dtmf`) and was never called, so on a device where AmOS is the
   * default phone app the digits stopped at the glass while the pad blamed the audio
   * pipeline. The answer decides what the note may claim: `true` was handed to the call,
   * `false` was not, a typed refusal is the host's own words. (REQ-A1146 / F-SH-453)
   */
  const pressDtmf = async (k: string) => {
    if (dtmf.length < 12) dtmf = dtmf + k;
    if (!activeId) return;
    inCallError = null;
    const res = await telephonyPlayDtmf(activeId, k);
    const out = callActionOutcome(bridgeDiag("telephony_play_dtmf"));
    if (out.kind === "refused") {
      inCallError = t("phone.dtmfFailed", {
        detail: out.detail === "" ? t("phone.actionNoReason") : out.detail,
      });
      return;
    }
    // `false` is not a failure — it is the host's honest "the tone did not reach the
    // call" (no in-call service is bound). Either way the note now reports what we
    // learned; only a confirmed delivery lets it stop disclaiming the far end.
    dtmfReached = res === true;
  };

  $effect(() => {
    return onTelephonyEvent((call) => {
      // A platform-owned call this screen has never adopted can arrive here. `ContactsApp`
      // hands a dial-out to Telecom — which resolves it straight back into our own in-call
      // service (fixed id `real`) when AmOS holds `ROLE_DIALER` — and routes the shell to
      // this app, but `real_dial`'s `ACTION_CALL` returns *before* Telecom adds the call, so
      // the first event routinely lands **after** this component mounted, when
      // `adoptLiveCall` had nothing to find and the shell's snapshot was still empty.
      // Dropping it left a bare keypad over a live call — the outcome the hand-off adoption
      // exists to prevent, one app switch away. Adopt it here instead.
      //
      // Only an un-owned (`activeRef` null: a daemon call this page is already driving is
      // not to be hijacked), *outgoing*, platform call that is actually **up or being
      // placed**. The direction filter mirrors `IncomingCall`, which owns incoming calls
      // and draws them on its own overlay; the state whitelist is what keeps the *tail* of
      // a finished call from being adopted — `AmosInCallService.onCallRemoved` runs
      // `onCallStateChanged` once more with no active call, which the bridge maps to
      // `state: "Unknown"` and (the latch now cleared) `direction: "Outgoing"`
      // (`incall.rs` / `AmosInCallService.kt`), exactly the shape a bare
      // `call.state !== "Ended"` test would read as a live call.
      if (
        activeRef === null &&
        call.direction === "Outgoing" &&
        call.id === REAL_CALL_ID &&
        (call.state === "Dialing" || call.state === "Active")
      ) {
        num = call.peer || num;
        calling = true;
        activeId = REAL_CALL_ID;
        activeRef = REAL_CALL_ID;
        // Adopted through the real in-call bridge, so it is by definition not a
        // simulation — even though the desktop branch is the only writer of `true`.
        simulated = false;
        // Absent is no claim — but a call being adopted for the first time has no prior
        // state to keep, so it starts from the neutral values rather than from whatever
        // the previous call left behind.
        recording = "Off";
        muted = false;
        speaker = false;
        hold = false;
        talking = false;
        activeAtRef = null;
        elapsedSec = 0;
      }
      if (call.id !== activeRef) return;
      // The real in-call bridge's upcall carries direction / state / peer and no toggle,
      // so its event omits `recording` — reading that absence as a state would clear a
      // recording indicator the user just lit. Same "absent is no claim" rule as below.
      if (typeof call.recording === "string") {
        recording = call.recording as "Off" | "On" | "Failed";
      }
      // An absent `muted` is "no claim", NOT "unmuted": every daemon event carries the
      // call's mute flag, but a reply that predates this field must not silently
      // unmute a call the user muted.
      if (typeof call.muted === "boolean") muted = call.muted;
      // Speaker and hold follow the same rule, and for the same reason: only the real
      // in-call bridge answers them and a `Watch` event (which cannot) arrives
      // interleaved with the command replies that can, so an absent field must keep the
      // state the user is looking at instead of dropping it.
      if (typeof call.speaker === "boolean") speaker = call.speaker;
      if (typeof call.hold === "boolean") hold = call.hold;
      if (call.state === "Active") {
        // Stamp the clock only on the **edge** into talking. A second `Active` for the
        // same call is not a new call: the daemon re-broadcasts the live call's current
        // state on a mute / recording toggle (`service.rs` `event_to_state_event` sends
        // `proto_state(state)`, so `MutedChanged`/`RecordingChanged` arrive as
        // `state: "Active"`), and the real in-call bridge re-emits on every toggle
        // (`incall.rs`: hold / speaker / mute all call `onCallStateChanged`). Re-stamping
        // on each of them restarted the elapsed clock at 0:00 whenever the user pressed
        // 静音 / 扬声器 / 保持 / 录音 mid-call.
        if (!talking) {
          talking = true;
          activeAtRef = Date.now();
          elapsedSec = 0;
        }
      } else if (call.state === "Ended") {
        endedIds.add(call.id);
        calling = false;
        talking = false;
        activeId = null;
        activeRef = null;
        activeAtRef = null;
        elapsedSec = 0;
        recording = "Off";
        muted = false;
        padOpen = false;
        dtmf = "";
      }
    });
  });

  $effect(() => {
    if (!talking) return;
    const id = setInterval(() => {
      if (activeAtRef != null) elapsedSec = Math.floor((Date.now() - activeAtRef) / 1000);
    }, 500);
    return () => clearInterval(id);
  });

  // Ringback tone (AmOS-managed call): play the real MP3 waiting tone while
  // Dialing and not yet connected (stops when connected / call ends / unmount).
  //
  // The daemon's transport carries no audio at all, so this file stands in a waiting
  // tone for it. A **real** Telecom call does not need — and must not get — one: the
  // network's own ringback is playing through the platform's audio path, and layering
  // this MP3 over it would sound two waiting tones at once.
  $effect(() => {
    const ring = calling && !talking && !!activeId && activeId !== REAL_CALL_ID;
    if (ring) playRingback();
    return () => stopCallTone();
  });
</script>

<div class="flex h-full w-full flex-col items-center p-4">
  <StoreErrorBar message={storeErr} />
  {#if !calling}
    <div role="tablist" aria-label={t("phone.tabs")} class="mb-2 flex w-full max-w-xs gap-1 rounded-xl bg-neutral-200/80 p-1 dark:bg-white/10">
      {#each [
        { id: "keys", label: t("phone.tabKeys") },
        { id: "recent", label: t("phone.tabRecent") },
        { id: "frequent", label: t("phone.tabFrequent") },
        { id: "emergency", label: t("phone.tabEmergency") },
        { id: "block", label: t("phone.tabBlock") },
      ] as tb (tb.id)}
        <button role="tab" aria-selected={tab === tb.id} onclick={() => (tab = tb.id as PhoneTab)}
          class="flex-1 rounded-lg px-2 py-2.5 text-ios-footnote font-medium transition {tab === tb.id ? 'bg-white text-neutral-900 shadow dark:bg-white/20 dark:text-white' : 'text-neutral-600 hover:text-neutral-900 dark:text-white/70 dark:hover:text-white'}">
          {tb.label}
        </button>
      {/each}
    </div>
  {/if}
  {#if !calling && notice}
    <p role="status" class="my-2 max-w-xs text-center text-ios-footnote text-neutral-600 dark:text-neutral-400">{notice}</p>
  {/if}
  {#if !calling && dialError}
    <p role="alert" class="my-2 max-w-xs text-center text-ios-footnote text-danger">{dialError}</p>
  {/if}

  {#if calling}
    <div class="flex w-full flex-col items-center">
      <div class="py-8 text-center">
        <!-- iOS-style avatar placeholder -->
        <div class="mx-auto mb-6 grid h-32 w-32 place-items-center rounded-full bg-gradient-to-br from-blue-400 to-blue-600 text-5xl font-light text-white shadow-lg">
          {num ? num.charAt(0) : "?"}
        </div>
        <div class="text-ios-title1 font-semibold tabular-nums">{num || "—"}</div>
        <div class="mt-2 text-ios-body text-neutral-600 dark:text-neutral-400">{talking ? t("phone.talking") : t("phone.call")}{!talking && num ? " …" : ""}</div>
        {#if talking}
          <!-- role="timer": the elapsed value changes on its own once a second, so a screen
               reader must be able to query it on demand — the same contract as the four clock
               surfaces (StatusBar / LockScreen / ClockWidget / StageClock, REQ-A284). It stays
               a static role, NOT aria-live; a clock that speaks every second is hostile, and an
               `aria-label` on a role-less div names nothing at all. -->
          <div role="timer" aria-label={t("a11y.callDuration")} class="mt-3 text-ios-callout tabular-nums font-medium text-accent">{fmtCallDuration(elapsedSec)}</div>
        {/if}
      </div>
      {#if simulated}
        <!-- Nothing left the device: the daemon's mock answered because this host has no
             telephony stack. The header above says "呼叫/通话中" either way, so without
             this line the screen would claim a call that never happened (REQ-A311). -->
        <p role="status" class="my-2 max-w-xs text-center text-ios-footnote text-neutral-600 dark:text-neutral-400">{t("phone.simulatedCall")}</p>
      {/if}
      {#if recording === "On"}
        <p class="flex items-center gap-2 text-ios-footnote font-medium text-danger"><span class="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden="true"></span>{t("phone.recording")}</p>
      {/if}
      {#if recording === "Failed"}
        <p class="text-ios-footnote text-neutral-600 dark:text-neutral-400">{t("phone.recordUnavailable")}</p>
      {/if}
      {#if inCallError}
        <p role="alert" class="mt-2 max-w-xs rounded-lg bg-danger/8 px-3 py-1.5 text-center text-ios-footnote text-danger">{inCallError}</p>
      {/if}
      {#if muted}
        <p class="mt-2 text-ios-footnote text-neutral-600 dark:text-neutral-400">{t("phone.muted")}</p>
      {/if}
      {#if hold}
        <p class="mt-2 text-ios-footnote text-neutral-600 dark:text-neutral-400">{t("phone.onHold")}</p>
      {/if}


      {#if talking}
        {#if padOpen}
          <div class="my-3 flex w-full max-w-[210px] flex-col items-center gap-2">
            <div class="h-6 w-full truncate rounded-full bg-black/5 px-3 text-center text-sm tabular-nums tracking-[0.2em] dark:bg-white/10">{dtmf || "\u00A0"}</div>
            <div class="grid w-full grid-cols-3 gap-2">
              {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as k (k)}
                <button onclick={() => void pressDtmf(k)} aria-label={t("phone.dtmfKey", { key: k })}
                  class="grid aspect-square place-items-center rounded-full bg-neutral-300/90 text-lg text-neutral-900 transition active:scale-90 dark:bg-white/10 dark:text-white">{k}</button>
              {/each}
            </div>
            {#if dtmf}
              <button onclick={() => (dtmf = "")} aria-label={t("phone.dtmfClear")} class="text-xs text-accent">{t("phone.clear")}</button>
            {/if}
            <!-- The pad's claim must be the host's answer, not an assumption either way.
                 `pressDtmf` sends each key through `telephony_play_dtmf`, which answers
                 `true` only when a bound in-call service handed the tone to Telecom — so
                 the note says the tones are local until one is *confirmed* delivered, and
                 stops disclaiming the far end the moment it is. Asserting the local-only
                 sentence unconditionally was the other half of the same lie: on a device
                 where AmOS is the default dialer the digits *could* reach the call, and
                 the screen blamed the audio pipeline for its own missing call. -->
            <p class="text-center text-[10px] leading-tight text-neutral-500 dark:text-neutral-400">{t(dtmfReached === true ? "phone.dtmfSent" : "phone.dtmfLocal")}</p>
          </div>
        {/if}
        <div class="mt-2 flex items-center gap-5">
          {#if activeId}
            <button onclick={() => void toggleRecord()} aria-label={recording === "On" ? t("phone.recordStop") : t("phone.recordStart")}
              data-icon={recording === "On" ? "stop" : "record"}
              class={"grid h-16 w-16 place-items-center rounded-full transition active:scale-90 " + (recording === "On" ? "bg-danger text-white shadow-lg" : "bg-neutral-200 text-danger dark:bg-white/10")}>
              {@html iconSvg(recording === "On" ? "stop" : "record", "h-7 w-7")}
            </button>
          {/if}
          <button onclick={() => void toggleMute()} aria-label={muted ? t("phone.unmute") : t("phone.mute")}
            data-icon={muted ? "micOff" : "mic"}
            class={"grid h-16 w-16 place-items-center rounded-full transition active:scale-90 " + (muted ? "bg-danger text-white shadow-lg" : "bg-neutral-200 text-neutral-700 dark:bg-white/10 dark:text-white")}>
            {@html iconSvg(muted ? "micOff" : "mic", "h-7 w-7")}
          </button>
          <!-- Speaker and hold are **device-only** capabilities: the host command refuses
               in typed words when no in-call service is bound (a fabricated `Ok` would
               light the button over a call still on the earpiece), and `toggleSpeaker` /
               `toggleHold` report that refusal instead of moving the flag. They are
               offered because on the device where they *can* work there was otherwise no
               control at all for either. -->
          <button onclick={() => void toggleSpeaker()} aria-label={speaker ? t("phone.speakerOff") : t("phone.speaker")}
            data-icon="volume" aria-pressed={speaker}
            class={"grid h-16 w-16 place-items-center rounded-full transition active:scale-90 " + (speaker ? "bg-accent text-white" : "bg-neutral-200 text-neutral-700 dark:bg-white/10 dark:text-white")}>
            {@html iconSvg("volume", "h-7 w-7")}
          </button>
          <button onclick={() => void toggleHold()} aria-label={hold ? t("phone.holdOff") : t("phone.hold")}
            data-icon="pause" aria-pressed={hold}
            class={"grid h-16 w-16 place-items-center rounded-full transition active:scale-90 " + (hold ? "bg-accent text-white" : "bg-neutral-200 text-neutral-700 dark:bg-white/10 dark:text-white")}>
            {@html iconSvg("pause", "h-7 w-7")}
          </button>
          <!-- A disclosure: the click reveals/hides the DTMF pad, and the accessible name
               (「拨号盘」) is the same in both states, so the open/closed state rides on
               `aria-expanded` (the repo idiom for a region; `aria-pressed` is for on/off). -->
          <button onclick={() => { padOpen = !padOpen; dtmf = ""; }} aria-label={t("phone.dtmf")} aria-expanded={padOpen} data-icon="dialpad"
            class="grid h-16 w-16 place-items-center rounded-full bg-neutral-200 text-neutral-700 transition active:scale-90 dark:bg-white/10 dark:text-white">{@html iconSvg("dialpad", "h-7 w-7")}</button>
        </div>
      {/if}
      <div class="mt-6">
        <button onclick={() => void endCall()} aria-label={t("a11y.end")} data-icon="end" class="grid h-20 w-20 place-items-center rounded-full bg-danger text-white shadow-[0_8px_24px_rgba(220,38,38,0.4)] transition active:scale-90">{@html iconSvg("x", "h-8 w-8")}</button>
      </div>
    </div>


  {:else if tab === "keys"}
    <div class="flex w-full flex-col items-center">
      <!-- Default-phone-app role (ROLE_DIALER): the precondition for answering / hanging
           up / mute / speaker / hold / DTMF / recording on a real call. Every state is
           rendered — including "the probe was refused" — so a dead in-call seam can never
           look like nothing at all (REQ-A1531 / F-SH-774; the `dialer-role-unavailable`
           line is the host's own answer, `dialer-role-unanswered` is our silence). -->
      {#if dialerSupportedUnheld}
        {#if dialerAskable}
          <div data-testid="dialer-role-needed" role="status" class="mb-1 w-full max-w-xs rounded-2xl bg-amber-500/15 px-3 py-2 text-center text-xs text-amber-700 dark:text-amber-300">
            <p>{t("phone.dialerRoleNeeded")}</p>
            <button onclick={() => void requestDialerRole()} disabled={dialerBusy} data-testid="dialer-grant-role"
              class="mt-1.5 rounded-full bg-accent px-3 py-1 text-xs text-white active:scale-95 disabled:opacity-50">
              {t("phone.dialerRoleGrant")}
            </button>
            {#if dialerErr}
              <p role="alert" data-testid="dialer-role-error" class="mt-1.5 text-danger">{dialerErr}</p>
            {/if}
          </div>
        {:else}
          <p data-testid="dialer-role-unavailable" role="status" class="mb-1 w-full max-w-xs rounded-2xl bg-black/5 px-3 py-2 text-center text-xs opacity-70 dark:bg-white/10">
            {t("phone.dialerRoleUnsupported")}
          </p>
        {/if}
      {:else if dialerRoleUnanswered}
        <!-- The probe was refused: `dialerRole` is `null`, which is 「我没问到」. The
             `!!dialerRole?.role_supported` fold used to draw this as **nothing at all**,
             the same state as the host's own `role_supported:false` answer — so the screen
             that must offer the fix for a dead in-call seam said nothing (REQ-A1531 /
             F-SH-774). -->
        <p data-testid="dialer-role-unanswered" role="status" class="mb-1 w-full max-w-xs rounded-2xl bg-amber-500/15 px-3 py-2 text-center text-xs text-amber-700 dark:text-amber-300">
          {t("phone.dialerRoleStatusUnanswered")}
        </p>
      {/if}
      <div class="flex w-full max-w-xs items-center justify-center px-4 pb-3 pt-4">
        <span class="block max-w-full truncate font-light tabular-nums leading-none {num.length > 9 ? 'text-[32px] tracking-tight' : num.length > 5 ? 'text-[40px] tracking-tight' : 'text-5xl tracking-tight'}">{num}</span>
      </div>
      {#if dialName}
        <div data-testid="dial-known-name" class="max-w-full truncate px-4 text-ios-subhead text-neutral-600 dark:text-neutral-400">{dialName}</div>
      {/if}
      <div class="grid w-full max-w-xs grid-cols-3 justify-items-center gap-x-3 gap-y-5 py-4">
        {#each KEYS as k (k)}
          <button onclick={() => tap(k)} aria-label={k}
            class="grid h-[72px] w-[72px] place-items-center rounded-full bg-white/90 text-neutral-900 shadow-sm ring-1 ring-black/5 transition active:scale-95 active:bg-neutral-100 dark:bg-white/10 dark:text-white dark:ring-white/10 dark:active:bg-white/[0.15]">
            <span class="flex flex-col items-center leading-none">
              <span class="text-[34px] font-light leading-none">{k}</span>
              {#if SUB[k]}
                <span class="mt-1 text-[9px] font-semibold uppercase tracking-[0.3em] opacity-50">{SUB[k]}</span>
              {/if}
            </span>
          </button>
        {/each}
      </div>


      <div class="mt-4 flex items-start justify-center gap-12">
        <div class="flex flex-col items-center gap-2">
          <button onclick={() => (num = backspace(num))} disabled={!num} aria-label={t("a11y.backspace")} data-icon="delete"
            class="grid h-12 w-12 place-items-center rounded-full bg-neutral-200/90 text-neutral-700 transition active:scale-95 disabled:opacity-25 dark:bg-white/10 dark:text-white">{@html iconSvg("delete", "h-5 w-5")}</button>
          <button onclick={() => (num = clearDial(num))} disabled={!num} aria-label={t("phone.clear")} class="text-ios-body text-accent disabled:opacity-25">{t("phone.clear")}</button>
        </div>
        <button onclick={() => void startCall()} disabled={!num} aria-label={t("phone.call")} data-icon="phone"
          class="grid h-[68px] w-[68px] place-items-center rounded-full bg-ios-green text-white shadow-[0_6px_24px_rgba(52,199,89,0.5)] transition active:scale-95 disabled:opacity-40 disabled:shadow-none">
          {@html iconSvg("phone", "h-7 w-7")}
        </button>
        <div class="w-12" aria-hidden="true"></div>
      </div>
      <button onclick={() => void simIncoming()} disabled={calling} aria-label={t("phone.simIncoming")}
        class="mt-4 text-ios-caption1 uppercase tracking-widest text-accent/70 transition hover:text-accent disabled:opacity-30">{t("phone.simIncoming")}</button>
    </div>


  {:else if tab === "recent"}
    <div class="flex w-full flex-col items-center" data-testid="call-history">
      <div class="flex w-full max-w-sm items-baseline justify-between gap-2 pb-1 pt-3">
        <span class="text-lg font-medium opacity-80">{t("phone.historyTitle")}</span>
        <div class="flex shrink-0 items-center gap-2">
          {#if missedTotal > 0}
            <span class="text-xs text-danger" data-testid="missed-count">{t("phone.missedCount", { n: missedTotal })}</span>
          {/if}
          {#if historyTotal > 0}
            {#if confirmClear}
              <button onclick={clearLog} data-testid="history-clear-confirm" class="rounded-full bg-danger/8 px-2.5 py-1 text-xs text-danger active:scale-95">{t("phone.historyClearConfirm")}</button>
              <button onclick={() => (confirmClear = false)} data-testid="history-clear-cancel" class="rounded-full bg-black/5 px-2.5 py-1 text-xs active:scale-95 dark:bg-white/10">{t("phone.historyClearCancel")}</button>
            {:else}
              <button onclick={() => (confirmClear = true)} data-testid="history-clear" title={t("phone.historyClear")} class="rounded-full bg-black/5 px-2.5 py-1 text-xs active:scale-95 dark:bg-white/10">{t("phone.historyClear")}</button>
            {/if}
          {/if}
        </div>
      </div>
      {#if historyTotal > 0}
        <div class="flex w-full max-w-sm items-center gap-1.5 overflow-x-auto pb-1" data-testid="history-filters">
          {#each FILTERS as f (f)}
            <button onclick={() => (logFilter = f)} aria-pressed={logFilter === f} data-filter={f} class={"shrink-0 rounded-full px-3.5 py-1.5 text-xs " + (logFilter === f ? "bg-accent text-white" : "bg-black/5 text-neutral-700 dark:bg-white/10 dark:text-neutral-300")}>{filterLabel(f)}</button>
          {/each}
        </div>
      {/if}
      {#if history.length === 0}
        <p class="py-10 text-sm opacity-50" data-testid="history-empty">{historyTotal === 0 ? t("phone.emptyRecent") : t("phone.historyEmptyFilter")}</p>
      {:else}
        <ul class="w-full max-w-sm divide-y divide-black/5 dark:divide-white/10">
          {#each history as it, i (`${it.num}-${it.ts}-${i}`)}
            {@const missed = it.direction === "missed"}
            <li class="flex items-center gap-3 py-3" data-testid="history-row" data-direction={it.direction ?? "unknown"}>
              <span aria-label={dirLabel(it.direction)} title={dirLabel(it.direction)}
                class={"grid h-9 w-9 shrink-0 place-items-center rounded-full text-ios-body font-medium " + (missed ? "bg-danger/8 text-danger" : "bg-neutral-100 opacity-70 dark:bg-white/10")}>
                {it.direction === "outgoing" ? "↗" : it.direction === "incoming" || missed ? "↙" : "•"}
              </span>
              <div class="min-w-0 flex-1">
                <div class={"truncate text-ios-body font-medium " + (missed ? "text-danger" : "text-neutral-900 dark:text-white")}>{it.label}</div>
                {#if it.label !== it.num}
                  <div class="truncate text-ios-footnote text-neutral-500 tabular-nums dark:text-neutral-400">{it.num}{#if whenOf(it.ts)}{" · "}{whenOf(it.ts)}{/if}</div>
                {:else if whenOf(it.ts)}
                  <div class="truncate text-ios-footnote text-neutral-500 tabular-nums dark:text-neutral-400">{whenOf(it.ts)}</div>
                {/if}
              </div>
              <div class="flex shrink-0 items-center gap-1.5">
                <button onclick={() => callBack(it.num)} aria-label={t("phone.callBack")} title={t("phone.callBack")} data-icon="phone" data-testid={`call-back-${it.num}`}
                  class="grid h-10 w-10 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 active:scale-90 dark:text-emerald-300">{@html iconSvg("phone", "h-[18px] w-[18px]")}</button>
                <button onclick={() => smsBack(it.num)} aria-label={t("phone.smsBack")} title={t("phone.smsBack")} data-icon="messageCircle" data-testid={`sms-back-${it.num}`}
                  class="grid h-10 w-10 place-items-center rounded-full bg-accent/10 text-accent active:scale-90">{@html iconSvg("messageCircle", "h-[18px] w-[18px]")}</button>
                <button onclick={() => blockFromRecents(it.num)} aria-label={t("phone.blockThisNumber")} title={t("phone.blockThisNumber")} data-icon="x" data-testid={`block-caller-${it.num}`}
                  class="grid h-10 w-10 place-items-center rounded-full bg-danger/8 text-danger active:scale-90 dark:bg-danger/20">{@html iconSvg("x", "h-[18px] w-[18px]")}</button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="mt-3 max-w-sm text-center text-xs leading-relaxed opacity-40">{t("phone.historyHint")}</p>
    </div>
  {:else if tab === "frequent"}
    <div class="flex w-full flex-col items-center">
      <div class="py-5 text-center text-lg font-medium opacity-70">{t("phone.tabFrequent")}</div>
      {#if frequent.length === 0}
        <p class="py-10 text-sm opacity-50">{t("phone.emptyFrequent")}</p>
      {:else}
        <ul class="w-full max-w-xs divide-y divide-black/5 dark:divide-white/10">
          {#each frequent as it (it.num)}
            <li>
              <button onclick={() => pick(it.num)} title={it.num} data-testid="frequent-row" class="flex w-full items-center justify-between gap-2 py-3 text-left">
                <span class="truncate text-sm">{it.label}</span>
                {#if it.label !== it.num}
                  <span class="shrink-0 text-xs opacity-50 tabular-nums">{it.num}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>


  {:else if tab === "emergency"}
    <div class="flex w-full flex-col items-center">
      <div class="py-5 text-center text-lg font-medium opacity-70">{t("phone.emergencyTitle")}</div>
      <ul class="w-full max-w-xs space-y-2.5">
        {#each EMERGENCY_NUMBERS as code (code)}
          {@const primary = code === EMERGENCY_QUICK_NUMBER}
          <li>
            <button onclick={() => void startCall(code)} aria-label={`${t("phone.emergencyCall")} ${code}`}
              class={"flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition active:scale-[0.99] " +
                (primary ? "bg-danger text-white shadow-[0_6px_18px_rgba(220,38,38,0.35)]" : "bg-danger/10 text-red-700 ring-1 ring-danger/25 dark:text-red-300")}>
              <span class="text-base font-semibold">{t(emergencyLabelKey(code), { num: code })}</span>
              <span class="text-2xl tabular-nums tracking-widest">{code}</span>
            </button>
          </li>
        {/each}
      </ul>
      <p class="mt-4 max-w-xs text-center text-xs leading-relaxed opacity-50">{t("phone.emergencyHint")}</p>
    </div>

  {:else if tab === "block"}
    <div class="flex w-full flex-col items-center" data-testid="blocklist-panel">
      <!-- Enforcement status: rules alone do not reject calls — the OS role does.
           All three **verdicts** are rendered, so "rules exist but nothing enforces
           them" can never look like "all good" — and a refused probe gets its own
           sentence too, so neither can look like nothing at all (REQ-A1513). -->
      {#if filtersCalls}
        {#if roleHeld}
          <p data-testid="block-role-held" class="mb-2 w-full max-w-sm rounded-2xl bg-emerald-500/15 px-3 py-2 text-center text-xs text-emerald-700 dark:text-emerald-300">
            {t("phone.blockRoleHeld")}
          </p>
        {:else if roleAskable}
          <div data-testid="block-role-needed" class="mb-2 w-full max-w-sm rounded-2xl bg-amber-500/15 px-3 py-2 text-center text-xs text-amber-700 dark:text-amber-300">
            <p>{t("phone.blockRoleNeeded")}</p>
            <button onclick={() => void requestBlockRole()} disabled={blockBusy} data-testid="block-grant-role"
              class="mt-1.5 rounded-full bg-accent px-3 py-1 text-xs text-white active:scale-95 disabled:opacity-50">
              {t("phone.blockRoleGrant")}
            </button>
          </div>
        {:else}
          <p data-testid="block-role-unavailable" class="mb-2 w-full max-w-sm rounded-2xl bg-black/5 px-3 py-2 text-center text-xs opacity-70 dark:bg-white/10">
            {t("phone.blockRoleUnsupported")}
          </p>
        {/if}
      {:else if blockStatusUnanswered}
        <!-- 这一读被拒：`!!blockStatus?.filters_calls` 曾把它折成 false，整条横幅画成**什么都没有**
             —— 而这正是本块注释保证不会发生的「or like nothing at all」，且把授予权限的补救一并藏掉，
             尽管规则列表（另一个读）是好的。宿主答了「没在过滤通话」时这个旗标是 false，所以这句不
             会替一个真正的裁决说话（REQ-A1513 / F-SH-758）。 -->
        <p data-testid="block-status-unanswered" class="mb-2 w-full max-w-sm rounded-2xl bg-amber-500/15 px-3 py-2 text-center text-xs text-amber-700 dark:text-amber-300">
          {t("phone.blockStatusUnanswered")}
        </p>
      {/if}
      <!-- Add a rule: pattern + exact/prefix + which channel it covers. The input
           gets its own full-width row (on a 360px phone the old single row left it
           only ~65px wide, so the placeholder never fit). -->
      <div class="mb-2 w-full max-w-sm space-y-1.5">
        <input bind:value={blockNum} data-testid="block-number" aria-label={t("phone.blockPlaceholder")} onkeydown={(e) => e.key === "Enter" && void addBlockRule()} placeholder={t("phone.blockPlaceholder")} class="w-full rounded-full bg-black/5 px-3.5 py-2 text-sm outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:ring-white/10 dark:placeholder:text-white/30" />
        <div class="flex items-center gap-1.5">
          <select bind:value={blockKind} data-testid="block-kind" aria-label={t("phone.blockKindLabel")} class="min-w-0 flex-1 rounded-full bg-black/5 px-2.5 py-2 text-xs dark:bg-white/10">
            <option value="exact">{t("phone.blockKindExact")}</option>
            <option value="prefix">{t("phone.blockKindPrefix")}</option>
          </select>
          <select bind:value={blockChannel} data-testid="block-channel" aria-label={t("phone.blockChannelLabel")} class="min-w-0 flex-1 rounded-full bg-black/5 px-2.5 py-2 text-xs dark:bg-white/10">
            <option value="both">{t("phone.blockChannelBoth")}</option>
            <option value="call">{t("phone.blockChannelCall")}</option>
            <option value="sms">{t("phone.blockChannelSms")}</option>
          </select>
          <button onclick={() => void addBlockRule()} disabled={blockBusy} data-testid="block-add" class="shrink-0 rounded-full bg-accent px-4 py-2 text-xs text-white active:scale-95 disabled:opacity-50">{t("phone.blockAdd")}</button>
        </div>
      </div>
      {#if blockPreview}
        <p
          data-testid="block-preview"
          class="mb-1 w-full max-w-sm rounded-lg bg-amber-500/15 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
        >
          {blockPreview.kind === "rule"
            ? t("phone.blockPreviewRule", { pattern: blockPreview.pattern })
            : t("phone.blockPreviewUnknown")}
        </p>
      {/if}
      {#if blockErr}
        <p class="mb-1 text-xs text-red-500" role="alert">{blockErr}</p>
      {/if}
      <button onclick={() => void toggleBlockUnknown()} aria-pressed={blockUnknown} data-testid="block-unknown" class={"mb-2 w-full max-w-sm rounded-2xl px-4 py-2 text-left text-sm " + (blockUnknown ? "bg-accent/10 text-accent" : "bg-black/5 dark:bg-white/10")}>
        {t("phone.blockUnknown")} · {blockUnknown ? t("phone.on") : t("phone.off")}
      </button>
      {#if blockRules.length > 0}
        <button
          onclick={() => void clearAllRules()}
          data-testid="block-clear"
          class="mb-2 w-full max-w-sm rounded-2xl bg-black/5 px-4 py-2 text-sm text-danger dark:bg-white/10"
        >
          {confirmClearRules ? t("phone.blockClearConfirm") : t("phone.blockClear")}
        </button>
      {/if}
      {#if blockRules.length === 0}
        <p class="py-6 text-center text-sm opacity-60">{t("phone.blockEmpty")}</p>
      {:else}
        <ul class="w-full max-w-sm space-y-2">
          {#each blockRules as r (r.id)}
            <li class="flex items-center justify-between gap-2 rounded-2xl bg-black/5 px-3 py-2 dark:bg-white/10">
              <div class="min-w-0">
                <div class="truncate text-sm font-medium">{r.pattern}</div>
                <div class="text-xs opacity-60">
                  {r.kind === "prefix" ? t("phone.blockKindPrefix") : t("phone.blockKindExact")} · {r.channel === "both" ? t("phone.blockChannelBoth") : r.channel === "call" ? t("phone.blockChannelCall") : t("phone.blockChannelSms")}{#if r.label} · {r.label}{/if}
                </div>
              </div>
              <button onclick={() => void removeBlockRule(r.id)} aria-label={t("phone.blockRemove")} data-testid={`block-remove-${r.pattern}`} class="shrink-0 rounded-full bg-neutral-200 px-2 py-1 text-xs dark:bg-neutral-700">{t("phone.blockRemove")}</button>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="mt-4 max-w-sm text-center text-xs leading-relaxed opacity-50">{t("phone.blockHint")}</p>
    </div>
  {/if}
</div>


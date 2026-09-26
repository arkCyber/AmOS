<script lang="ts">
  // IncomingCall.svelte — Svelte 5 (runes) port of the React incoming-call surface.
  // Subscribes to the telephony event stream (daemon Watch + the real in-call bridge);
  // for INCOMING calls it takes over the screen (Ringing→Answer/Decline; answered→Active
  // in-call with mute/record/loudspeaker/hold/hangup). Outgoing calls are the Phone
  // screen's own UI. Offline (no events) it renders nothing — same as React.
  import { t } from "./locale.svelte";
  import { playIncomingRing, stopCallTone } from "../lib/callTone";
  import {
    bridgeDiag,
    onTelephonyEvent,
    telephonyAnswer,
    telephonyEnd,
    telephonyPlayDtmf,
    telephonySetHold,
    telephonySetMuted,
    telephonySetSpeaker,
    telephonyStartRecording,
    telephonyStopRecording,
    type TelephonyCall,
  } from "../lib/backend";
  import { readStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import { createStoreValue } from "./store";
  import { iconSvg } from "../lib/sysIcons";
  import {
    CALLLOG_KEY,
    normalizeCallLog,
    queuePendingCall,
    recordCall,
  } from "../lib/calllog";
  import { CONTACTS_KEY, contactNameFor, normalizeContacts, type Contact } from "../lib/contacts";
  import { callerDisplayLabel, hasPeerNumber } from "../lib/callDisplay";
  import { callActionOutcome } from "../lib/phone";
  import { forgetRealCall, noteRealCall } from "../lib/realCall";
  import { attachFocusTrap } from "../lib/focusTrap";

  let call = $state<TelephonyCall | null>(null);
  let phase = $state<"ringing" | "talking">("ringing");
  let recording = $state<"Off" | "On" | "Failed">("Off");
  /**
   * Whether the **daemon's** call state says this call is muted — not a local flag.
   *
   * Muting is call state that other surfaces read (the Phone screen's own in-call
   * UI, the lock screen, the AI assistant) via the `Watch` stream, so this mirrors
   * the daemon exactly like `recording` does. It used to be a component-local
   * `$state` flipped by `onclick={() => (muted = !muted)}`: the label, the glyph and
   * the colour moved while the daemon was never told, so answering a call and
   * tapping Mute left every other surface (and the actual microphone) believing the
   * user was still talking. The sibling record toggle on this very surface was
   * already daemon-bound (REQ-A992) — the asymmetry is what hid it.
   */
  let muted = $state(false);
  /**
   * Whether this call's audio is on the loudspeaker / whether it is on hold.
   *
   * These two are the **device-only** in-call controls: the daemon's transport has no
   * audio route and no hold, so it can never answer them, and their only meaningful
   * home is here — the overlay the real in-call bridge drives (`incall.rs` emits
   * `telephony-event` once AmOS holds `ROLE_DIALER`). Same "absent is no claim" rule as
   * `muted`: the bridge's upcall carries neither field, so only a command's own reply
   * (or an event that mentions the field) moves them.
   */
  let speaker = $state(false);
  let hold = $state(false);
  /**
   * The DTMF pad on the surface the user actually reaches during a real call.
   *
   * `telephony_play_dtmf` exists, has a device binding, and its only entry point used to be
   * `PhoneApp.svelte` — the surface this overlay covers (it is `absolute inset-0 z-[90]` for
   * the whole life of an incoming call). So an incoming call from an auto-attendant ("press 1
   * to confirm") had nowhere to send the tone: the same hollow-twin shape REQ-A1166 fixed for
   * speaker/hold, left one control over. `dtmf` is the local echo (a keypad must light up);
   * `dtmfReached` is the host's answer — `true` only when a bound in-call service handed the
   * tone to Telecom, `false` when it did not, `null` before the first key.
   */
  let dtmf = $state("");
  let dtmfReached = $state<boolean | null>(null);
  let padOpen = $state(false);
  const DTMF_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;
  // The host's own words for the last refused in-call action, in the user's language
  // (F-SH-236). Empty = the last action was accepted (or none ran yet). While it is
  // set the surface stays where it is — a refused answer is not a connected call.
  let actionError = $state("");
  // Tracks the incoming call we surfaced so we write one log entry per finished
  // call (answered / missed / declined) — never duplicate on repeat events.
  let surfacedId: string | null = null;
  // Whether the surfaced call was actually answered, so the history row is
  // "incoming" (talked) vs "missed" (rang out / declined) instead of guessing.
  let answered = false;
  /**
   * The address book, **live** — not a snapshot taken at init.
   *
   * The shell mounts this component once (it is an always-on overlay that renders
   * nothing between calls), so hydrating `amos.contacts` at init alone left it with
   * the address book as it was when the shell booted: a contact the user added in a
   * later Contacts session was invisible here, so both the headline and the name
   * written into the call log fell back to the raw number. `createStoreValue` is the
   * shared primitive for exactly this (same window, sibling webviews, and the Tauri
   * cross-window bus), and it is what the sibling `PhoneApp` already uses for the
   * call log.
   */
  const contactsStore = createStoreValue<unknown>(CONTACTS_KEY, []);
  let contacts = $state<Contact[]>([]);
  $effect(() => {
    return contactsStore.subscribe((v) => {
      contacts = normalizeContacts(v);
    });
  });

  $effect(() => {
    return onTelephonyEvent((c) => {
      // Before the direction filter, deliberately: the platform-owned call is ours to
      // drive, and its UI lives in a component (`PhoneApp`) that is remounted on every
      // app switch — so this, the one subscriber that outlives that remount, is where
      // the stream's last word on it is written down. It is *usually outgoing*, which
      // the overlay below ignores.
      noteRealCall(c);
      if (c.direction !== "Incoming") return; // outgoing = Phone screen's own UI
      if (c.state === "Ringing") {
        surfacedId = c.id;
        answered = false;
        call = c;
        phase = "ringing";
        recording = "Off";
        muted = false;
        speaker = false;
        hold = false;
        dtmf = "";
        dtmfReached = null;
        padOpen = false;
        actionError = ""; // a new call never inherits the last refusal's words
      } else if (c.state === "Active") {
        answered = true;
        call = c;
        phase = "talking";
        // Same "absent is no claim" rule as `muted` below: the real in-call bridge's
        // upcall omits `recording` on the events its own hold / speaker / mute
        // toggles provoke, so casting the missing field here reset a live recording
        // the user had just started. Only a claim moves the indicator.
        if (typeof c.recording === "string") {
          recording = c.recording as "Off" | "On" | "Failed";
        }
        // An absent `muted` is "no claim", NOT "unmuted": every daemon event carries
        // the call's mute flag, but a reply that predates this field must not
        // silently unmute a call the user muted.
        if (typeof c.muted === "boolean") muted = c.muted;
        // Speaker and hold follow the same rule and for the same reason: the real
        // bridge's upcall mentions neither, so an event that omits them must keep the
        // state the user is looking at rather than dropping the route they chose.
        if (typeof c.speaker === "boolean") speaker = c.speaker;
        if (typeof c.hold === "boolean") hold = c.hold;
      } else if (c.state === "Ended") {
        // Persist the finished incoming call into the shared log so the Phone
        // screen's history reflects it too. The log is number-keyed, so calls with
        // no (empty/hidden) caller id are intentionally not recorded.
        if (surfacedId === c.id && c.peer) {
          const prev = normalizeCallLog(readStoreValue<unknown>(CALLLOG_KEY, []));
          const label = contactNameFor(contacts, c.peer) ?? c.peer;
          const next = recordCall(prev, c.peer, label, Date.now(), answered ? "incoming" : "missed");
          // The overlay is closing, so this is the one place with nobody to tell — and the
          // reason a rejected write used to lose the row for good. It is now queued in
          // memory and flushed (with an honest notice) by the Phone screen's history, which
          // is where the user would look for it (REQ-A150).
          if (!writeStoreValueChecked(CALLLOG_KEY, next)) {
            queuePendingCall(next[0]);
          }
        }
        surfacedId = null;
        answered = false;
        muted = false;
        speaker = false;
        hold = false;
        dtmf = "";
        dtmfReached = null;
        padOpen = false;
        call = call && call.id === c.id ? null : call;
      }
    });
  });

  /**
   * 接听 / 挂断是否真的被系统接受了。
   *
   * `invoke` 从不 reject：命令失败时它把原因写进 `bridgeDiag(command)` 并返回 `null` ——
   * 而对一个返回 `void` 的命令，**成功值也是 `null`**。所以旧代码里
   * `phase = "talking"; await telephonyAnswer(call.id);` 结果从未被读过：接听被系统拒绝时
   * 铃声停了、覆盖层挂出静音/录音/挂断三个键并显示「通话中」，而真实来电根本没接通
   * （F-SH-236）。判据只能取自诊断槽，不能取自返回值。
   */
  const actionRefusal = (command: string): string | null => {
    const out = callActionOutcome(bridgeDiag(command));
    if (out.kind === "accepted") return null;
    return out.detail === "" ? t("phone.actionNoReason") : out.detail;
  };

  const answer = async () => {
    if (!call) return;
    actionError = "";
    phase = "talking"; // optimistic: the Active event confirms; a refusal rolls this back
    await telephonyAnswer(call.id);
    const why = actionRefusal("telephony_answer");
    if (why === null) return;
    // The optimistic flip was wrong — nothing answered this call, so go back to the
    // screen that tells the truth (the ringtone effect restarts with `phase`).
    phase = "ringing";
    actionError = t("phone.answerFailed", { detail: why });
  };
  const leave = async () => {
    // This one function backs two buttons — 拒绝 while the call is ringing and 挂断 once
    // it is talking — so a refusal must name the action pressed *and* the state the user
    // actually sees. The decline sentence says the call is still **ringing**; the talking
    // sentence (shared with `PhoneApp.svelte`'s in-call hang-up) says it was not ended.
    const declining = phase === "ringing";
    const id = call?.id;
    actionError = "";
    if (id) await telephonyEnd(id);
    const why = id ? actionRefusal("telephony_end") : null;
    if (why !== null) {
      // Do NOT hide the surface: the call is still ringing / still connected and the
      // user must be able to retry (hiding it is how a failed hang-up read as done).
      actionError = declining
        ? t("phone.declineFailed", { detail: why })
        : t("phone.hangupFailed", { detail: why });
      return;
    }
    // Accepted: the shell-global record of the platform-owned call must not outlive it.
    // This overlay's own `call` is component state and clears either way, but a *real*
    // incoming call is also in `lib/realCall.ts` (written below, before the direction
    // filter), and that record is cleared only by the stream's `Ended` — which trails
    // this hang-up by a beat, so the Phone screen would re-adopt a call the user ended
    // here (REQ-A1234).
    if (id) forgetRealCall(id);
    call = null;
    muted = false;
  };
  /**
   * 录音开关也是「返回值答不了这个问题」的那一族。
   *
   * `telephony_start_recording` / `telephony_stop_recording` 在设备拒绝时返回**定型**
   * `AmosError`（`TelephonyRecordingRefused`，或前台门/非默认拨号器的信封），而 `invoke`
   * 把它折成 `null` —— 与「成功但返回 `null`」同一个值。旧代码 `if (res) recording = …`
   * 只认成功那一半：拒绝时按钮文字不变、屏幕上**一个字也没有**，用户无从知道录音到底开没开
   * （与 F-SH-236 同族，而同表面的 `answer`/`leave` 早已改走诊断槽）。判据只能取自
   * `bridgeDiag(command)`；`res` 仅用来读回被接受的权威快照。
   */
  const toggleRecord = async () => {
    if (!call) return;
    actionError = "";
    const turningOn = recording !== "On";
    const command = turningOn ? "telephony_start_recording" : "telephony_stop_recording";
    const res = turningOn
      ? await telephonyStartRecording(call.id)
      : await telephonyStopRecording(call.id);
    const why = actionRefusal(command);
    if (why !== null) {
      actionError = t("phone.recordFailed", { detail: why });
      return;
    }
    // A start/stop reply that carries no `recording` claim (the real bridge answers
    // one — see `incall.rs`) leaves the indicator where it was rather than reading
    // "Off" out of a missing field.
    if (res && typeof res.recording === "string") {
      recording = res.recording as "Off" | "On" | "Failed";
    }
  };
  /**
   * The mute toggle is the same "the return value cannot answer this" family as the
   * record toggle above — and, like it, it used to be purely local.
   *
   * `telephony_set_muted` answers a typed `AmosError` when the platform refuses
   * (`TelephonyMuteRefused` — a real Telecom call has no in-call mute bridge yet),
   * and `invoke` folds that into `null`, the same value it gives a success whose
   * body it did not keep. So the verdict comes from the diagnosis slot
   * (`actionRefusal`), and the flag only moves when the daemon's own snapshot
   * confirms it — a refusal leaves the button where it was and says why.
   */
  const toggleMute = async () => {
    if (!call) return;
    actionError = "";
    const next = !muted;
    const res = await telephonySetMuted(call.id, next);
    const why = actionRefusal("telephony_set_muted");
    if (why !== null) {
      actionError = t("phone.muteFailed", { detail: why });
      return;
    }
    if (res && typeof res.muted === "boolean") muted = res.muted;
  };
  /**
   * Loudspeaker / hold — the device-only pair, on the surface that actually has a device.
   *
   * Both share `toggleMute`'s verdict rule (the refusal comes from the diagnosis slot,
   * never from the return value, and the flag moves only on the host's confirmation) and
   * both are refused in typed words on a daemon call, where there is no audio route and
   * no hold to change. Without a bound in-call service the honest answer is that refusal,
   * so the button must report it rather than light up over an untouched route.
   */
  const toggleSpeaker = async () => {
    if (!call) return;
    actionError = "";
    const next = !speaker;
    const res = await telephonySetSpeaker(call.id, next);
    const why = actionRefusal("telephony_set_speaker");
    if (why !== null) {
      actionError = t("phone.speakerFailed", { detail: why });
      return;
    }
    if (res && typeof res.speaker === "boolean") speaker = res.speaker;
  };
  const toggleHold = async () => {
    if (!call) return;
    actionError = "";
    const next = !hold;
    const res = await telephonySetHold(call.id, next);
    const why = actionRefusal("telephony_set_hold");
    if (why !== null) {
      actionError = t("phone.holdFailed", { detail: why });
      return;
    }
    if (res && typeof res.hold === "boolean") hold = res.hold;
  };
  /**
   * Press a DTMF key: echo it on the pad **and** hand the tone to the call.
   *
   * Same verdict rule as `pressDtmf` in `PhoneApp.svelte` (the pad that was, until now, the
   * only one): the local echo is the keypress feedback, but the action is the host command —
   * a typed refusal is the host's own words, and only a confirmed delivery (`res === true`,
   * i.e. a bound in-call service handed the tone to Telecom) lets the note stop disclaiming
   * the far end. `false` is not a failure; it is the host's honest "the tone did not reach
   * the call". An empty `call` (a stale click as the overlay closes) sends nothing.
   */
  const pressDtmf = async (k: string) => {
    if (dtmf.length < 12) dtmf = dtmf + k;
    if (!call) return;
    actionError = "";
    const res = await telephonyPlayDtmf(call.id, k);
    const why = actionRefusal("telephony_play_dtmf");
    if (why !== null) {
      actionError = t("phone.dtmfFailed", { detail: why });
      return;
    }
    dtmfReached = res === true;
  };

  // Ring the phone with the real MP3 while an incoming call is ringing (stops on
  // answer / decline / unmount — the WebView tone until the daemon confirms).
  $effect(() => {
    if (!call || phase !== "ringing") return;
    playIncomingRing();
    return () => stopCallTone();
  });

  // WCAG 2.1.2: keyboard focus trap while the call surface is on screen.
  // Tab cycles between answer / decline / mute / record / loudspeaker / hold / dialpad /
  // (the pad's own keys while it is open) / hangup.
  // Escape is intentionally not bound (a misclick on Esc must not hang up).
  let rootEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!call || !rootEl) return;
    return attachFocusTrap(rootEl);
  });
</script>

{#if call}
  {@const name = contactNameFor(contacts, call.peer)}
  {@const label = callerDisplayLabel(call.peer, name, t("phone.unknown"))}
  {@const ringing = phase === "ringing"}
  <div
    bind:this={rootEl}
    role="dialog"
    aria-label={ringing ? t("phone.incoming") : t("phone.talking")}
    class="pointer-events-auto absolute inset-0 z-[90] flex flex-col items-center overflow-hidden bg-neutral-950 text-white"
  >
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0"
      style="background:radial-gradient(120% 60% at 50% -10%, rgba(16,185,129,0.35), transparent 60%), radial-gradient(120% 50% at 50% 115%, rgba(239,68,68,0.25), transparent 60%)"
    ></div>
    {#if ringing}
      <div aria-hidden="true" class="absolute inset-0 -z-0 animate-pulse bg-black/20"></div>
    {/if}

    <div class="relative mt-10 text-center">
      <div class="text-sm font-semibold uppercase tracking-[0.3em] text-emerald-300/90">
        {ringing ? t("phone.incoming") : t("phone.talking")}
      </div>
    </div>

    {#if actionError}
      <!-- Refused action: the host's own words, said out loud instead of the surface
           pretending the call changed state (F-SH-236). -->
      <p
        role="alert"
        class="relative mx-6 mt-4 max-w-[92%] rounded-xl bg-red-500/20 px-3 py-2 text-center text-sm text-red-100 ring-1 ring-red-400/40"
      >{actionError}</p>
    {/if}

    <div class="relative mt-16 flex min-w-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <div
        aria-hidden="true"
        class={
          "grid h-36 w-36 place-items-center rounded-full bg-white/10 text-white/80 shadow-2xl ring-1 ring-white/20 " +
          (ringing ? "animate-pulse" : "")
        }
      >{@html iconSvg("phone", "h-16 w-16")}</div>
      <div class="mt-8 max-w-full text-3xl font-semibold leading-tight break-words">{label}</div>
      {#if hasPeerNumber(call.peer)}
        <div class="mt-2 text-sm tracking-widest text-white/50 tabular-nums">{call.peer}</div>
      {/if}
      {#if recording === "On"}
        <div class="mt-4 flex items-center gap-2 text-sm font-medium text-red-300">
          <span aria-hidden="true" class="h-2 w-2 animate-pulse rounded-full bg-red-400"></span>
          {t("phone.recording")}
        </div>
      {/if}
      {#if recording === "Failed"}
        <!-- The daemon reports a **three**-valued recording state (`telephony.rs::call_payload`
             maps `ProtoRecording::RecordingFailed` → "Failed"). Rendering only "On" makes a
             device that *failed* to record look exactly like one that is not recording — the
             absence of the badge read as "nothing happened". The sibling in-call surface
             (`PhoneApp.svelte`) already renders this state as 「录音不可用」. -->
        <div class="mt-4 text-sm font-medium text-white/70">
          {t("phone.recordUnavailable")}
        </div>
      {/if}
      {#if hold}
        <!-- The host confirmed the call is held. Rendered on the surface that can put a
             real call on hold — the sibling `PhoneApp.svelte` drew this caption for a
             transport that always refuses the command. -->
        <div class="mt-4 text-sm font-medium text-white/70">{t("phone.onHold")}</div>
      {/if}
    </div>

    {#if ringing}
      <div class="relative mb-12 flex w-full items-center justify-around px-10">
        <div class="flex flex-col items-center gap-2">
          <button
            onclick={() => void leave()}
            aria-label={t("phone.decline")}
            data-icon="x"
            class="grid h-24 w-24 place-items-center rounded-full bg-red-500 text-3xl text-white shadow-[0_12px_30px_rgba(239,68,68,0.45)] transition active:scale-90"
          >{@html iconSvg("x", "h-9 w-9")}</button>
          <span class="text-sm font-medium text-white/80">{t("phone.decline")}</span>
        </div>
        <div class="flex flex-col items-center gap-2">
          <button
            onclick={() => void answer()}
            aria-label={t("phone.answer")}
            data-icon="phone"
            class="grid h-24 w-24 place-items-center rounded-full bg-emerald-500 text-4xl text-white shadow-[0_12px_30px_rgba(16,185,129,0.5)] transition active:scale-90"
          >{@html iconSvg("phone", "h-12 w-12")}</button>
          <span class="text-sm font-medium text-white/80">{t("phone.answer")}</span>
        </div>
      </div>
    {:else}
      {#if padOpen}
        <!-- DTMF pad, above the control row (the same place `PhoneApp.svelte` puts it).
             Without it an incoming call from an auto-attendant had nowhere to send a tone:
             the only pad lived on the surface this overlay covers (REQ-A1188 / F-TEL-021). -->
        <div
          class="relative mb-6 flex w-full max-w-[210px] flex-col items-center gap-2"
          data-testid="dtmf-pad"
        >
          <div
            class="h-7 w-full truncate rounded-full bg-white/10 px-3 text-center text-base tabular-nums tracking-[0.2em] text-white"
            data-testid="dtmf-echo"
          >{dtmf || " "}</div>
          <div class="grid w-full grid-cols-3 gap-2">
            {#each DTMF_KEYS as k (k)}
              <button
                onclick={() => void pressDtmf(k)}
                aria-label={t("phone.dtmfKey", { key: k })}
                data-testid="dtmf-key"
                class="grid aspect-square place-items-center rounded-full bg-white/10 text-lg text-white ring-1 ring-white/20 transition active:scale-90"
              >{k}</button>
            {/each}
          </div>
          {#if dtmf}
            <button
              onclick={() => (dtmf = "")}
              aria-label={t("phone.dtmfClear")}
              class="text-xs text-emerald-300"
            >{t("phone.clear")}</button>
          {/if}
          <!-- The note states the host's answer, not an assumption either way: local-only
               until a key is *confirmed* delivered, then done disclaiming the far end. -->
          <p class="text-center text-[10px] leading-tight text-white/60" data-testid="dtmf-note">
            {t(dtmfReached === true ? "phone.dtmfSent" : "phone.dtmfLocal")}
          </p>
        </div>
      {/if}
      <div class="relative mb-12 flex w-full items-end justify-center gap-8 px-6">
        <div class="flex flex-col items-center gap-1.5">
          <button
            onclick={() => void toggleMute()}
            aria-label={muted ? t("phone.unmute") : t("phone.mute")}
            data-icon={muted ? "micOff" : "mic"}
            class={
              "grid h-16 w-16 place-items-center rounded-full text-2xl transition active:scale-90 " +
              (muted ? "bg-red-500 text-white" : "bg-white/10 text-white ring-1 ring-white/20")
            }
          >{@html iconSvg(muted ? "micOff" : "mic", "h-7 w-7")}</button>
          <span class="text-xs text-white/70">{muted ? t("phone.unmute") : t("phone.mute")}</span>
        </div>
        <div class="flex flex-col items-center gap-1.5">
          <button
            onclick={() => void toggleRecord()}
            aria-label={recording === "On" ? t("phone.recordStop") : t("phone.recordStart")}
            data-icon={recording === "On" ? "stop" : "record"}
            class={
              "grid h-16 w-16 place-items-center rounded-full text-2xl transition active:scale-90 " +
              (recording === "On" ? "bg-red-500 text-white" : "bg-white/10 text-white ring-1 ring-white/20")
            }
          >{@html iconSvg(recording === "On" ? "stop" : "record", "h-7 w-7")}</button>
          <span class="text-xs text-white/70">
            {recording === "On" ? t("phone.recordStop") : t("phone.recordStart")}
          </span>
        </div>
        <div class="flex flex-col items-center gap-1.5">
          <button
            onclick={() => void toggleSpeaker()}
            aria-label={speaker ? t("phone.speakerOff") : t("phone.speaker")}
            aria-pressed={speaker}
            data-icon="volume"
            class={
              "grid h-16 w-16 place-items-center rounded-full text-2xl transition active:scale-90 " +
              (speaker ? "bg-white text-neutral-900" : "bg-white/10 text-white ring-1 ring-white/20")
            }
          >{@html iconSvg("volume", "h-7 w-7")}</button>
          <span class="text-xs text-white/70">
            {speaker ? t("phone.speakerOff") : t("phone.speaker")}
          </span>
        </div>
        <div class="flex flex-col items-center gap-1.5">
          <button
            onclick={() => void toggleHold()}
            aria-label={hold ? t("phone.holdOff") : t("phone.hold")}
            aria-pressed={hold}
            data-icon="pause"
            class={
              "grid h-16 w-16 place-items-center rounded-full text-2xl transition active:scale-90 " +
              (hold ? "bg-white text-neutral-900" : "bg-white/10 text-white ring-1 ring-white/20")
            }
          >{@html iconSvg("pause", "h-7 w-7")}</button>
          <span class="text-xs text-white/70">{hold ? t("phone.holdOff") : t("phone.hold")}</span>
        </div>
        <div class="flex flex-col items-center gap-1.5">
          <!-- A disclosure: the label 「拨号盘」 is the same in both states, so open/closed
               rides on `aria-expanded` (the repo idiom for a region), not `aria-pressed`. -->
          <button
            onclick={() => {
              padOpen = !padOpen;
              dtmf = "";
              dtmfReached = null;
            }}
            aria-label={t("phone.dtmf")}
            aria-expanded={padOpen}
            data-icon="dialpad"
            data-testid="dtmf-open"
            class={
              "grid h-16 w-16 place-items-center rounded-full text-2xl transition active:scale-90 " +
              (padOpen ? "bg-white text-neutral-900" : "bg-white/10 text-white ring-1 ring-white/20")
            }
          >{@html iconSvg("dialpad", "h-7 w-7")}</button>
          <span class="text-xs text-white/70">{t("phone.dtmf")}</span>
        </div>
        <div class="flex flex-col items-center gap-1.5">
          <button
            onclick={() => void leave()}
            aria-label={t("phone.hangup")}
            data-icon="x"
            class="grid h-16 w-16 place-items-center rounded-full bg-red-500 text-2xl text-white transition active:scale-90"
          >{@html iconSvg("x", "h-7 w-7")}</button>
          <span class="text-xs text-white/70">{t("phone.hangup")}</span>
        </div>
      </div>
    {/if}
  </div>
{/if}


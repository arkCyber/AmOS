<script lang="ts">
  // IncomingCall.svelte — Svelte 5 (runes) port of the React incoming-call surface.
  // Subscribes to the daemon telephony event stream; for INCOMING calls it takes
  // over the screen (Ringing→Answer/Decline; answered→Active in-call with
  // mute/record/hangup). Outgoing calls are the Phone screen's own UI. Offline (no
  // events) it renders nothing — same as React.
  import { t } from "./locale.svelte";
  import {
    onTelephonyEvent,
    telephonyAnswer,
    telephonyEnd,
    telephonyStartRecording,
    telephonyStopRecording,
    type TelephonyCall,
  } from "../lib/backend";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { iconSvg } from "../lib/sysIcons";
  import { CALLLOG_KEY, normalizeCallLog, recordCall } from "../lib/calllog";
  import { CONTACTS_KEY, contactNameFor, normalizeContacts, type Contact } from "../lib/contacts";

  let call = $state<TelephonyCall | null>(null);
  let phase = $state<"ringing" | "talking">("ringing");
  let recording = $state<"Off" | "On" | "Failed">("Off");
  let muted = $state(false);
  // Tracks the incoming call we surfaced so we write one log entry per finished
  // call (answered / missed / declined) — never duplicate on repeat events.
  let surfacedId: string | null = null;
  let contacts = $state<Contact[]>(
    normalizeContacts(readStoreValue<unknown>(CONTACTS_KEY, [])),
  );

  $effect(() => {
    return onTelephonyEvent((c) => {
      if (c.direction !== "Incoming") return; // outgoing = Phone screen's own UI
      if (c.state === "Ringing") {
        surfacedId = c.id;
        call = c;
        phase = "ringing";
        recording = "Off";
        muted = false;
      } else if (c.state === "Active") {
        call = c;
        phase = "talking";
        recording = c.recording as "Off" | "On" | "Failed";
      } else if (c.state === "Ended") {
        // Persist the finished incoming call into the shared log so the Phone
        // screen's Recent/Frequent list reflects it too.
        if (surfacedId === c.id && c.peer) {
          const prev = normalizeCallLog(readStoreValue<unknown>(CALLLOG_KEY, []));
          const label = contactNameFor(contacts, c.peer) ?? c.peer;
          writeStoreValue(CALLLOG_KEY, recordCall(prev, c.peer, label, Date.now()));
        }
        surfacedId = null;
        muted = false;
        call = call && call.id === c.id ? null : call;
      }
    });
  });

  const answer = async () => {
    if (!call) return;
    phase = "talking"; // optimistic; daemon also confirms via Active event
    await telephonyAnswer(call.id);
  };
  const leave = async () => {
    const id = call?.id;
    if (id) await telephonyEnd(id);
    call = null;
    muted = false;
  };
  const toggleRecord = async () => {
    if (!call) return;
    const res =
      recording !== "On"
        ? await telephonyStartRecording(call.id)
        : await telephonyStopRecording(call.id);
    if (res) recording = res.recording as "Off" | "On" | "Failed";
  };

  // Ring the phone while an incoming call is ringing (WebView tone until answer).
  $effect(() => {
    if (!call || phase !== "ringing") return;
    const AC =
      typeof window !== "undefined" &&
      ((window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!AC) return;
    const ctx = new AC();
    const beep = () => {
      if (ctx.state === "closed") return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 620;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.52);
    };
    beep();
    const timer = setInterval(beep, 1000);
    return () => {
      clearInterval(timer);
      void ctx.close();
    };
  });
</script>

{#if call}
  {@const label = contactNameFor(contacts, call.peer) ?? call.peer}
  {@const ringing = phase === "ringing"}
  <div
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

    <div class="relative mt-16 flex min-w-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <div
        aria-hidden="true"
        class={
          "grid h-36 w-36 place-items-center rounded-full bg-white/10 text-white/80 shadow-2xl ring-1 ring-white/20 " +
          (ringing ? "animate-pulse" : "")
        }
      >{@html iconSvg("phone", "h-16 w-16")}</div>
      <div class="mt-8 max-w-full text-3xl font-semibold leading-tight break-words">{label}</div>
      <div class="mt-2 text-sm tracking-widest text-white/50 tabular-nums">{call.peer}</div>
      {#if recording === "On"}
        <div class="mt-4 flex items-center gap-2 text-sm font-medium text-red-300">
          <span aria-hidden="true" class="h-2 w-2 animate-pulse rounded-full bg-red-400"></span>
          {t("phone.recording")}
        </div>
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
      <div class="relative mb-12 flex w-full items-end justify-center gap-8 px-6">
        <div class="flex flex-col items-center gap-1.5">
          <button
            onclick={() => (muted = !muted)}
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


<script lang="ts">
  // PhoneApp.svelte — Svelte 5 (runes) single-source implementation of the phone
  // screen. Keypad/dial
  // logic reuses lib/phone + lib/emergency; dialing/events/record go through
  // lib/backend telephony; recent/frequent derive from the call log via
  // createStoreValue (mirrors useOutgoingCalls). Real dial/record verified on-device.
  import { KEYS, backspace, clearDial, fmtCallDuration, pushKey } from "../lib/phone";
  import { EMERGENCY_NUMBERS, EMERGENCY_QUICK_NUMBER } from "../lib/emergency";
  import {
    onTelephonyEvent, telephonyDial, telephonyEnd, telephonySimulateIncoming,
    telephonyStartRecording, telephonyStopRecording,
  } from "../lib/backend";
  import { CONTACTS_KEY, contactNameFor, normalizeContacts } from "../lib/contacts";
  import type { Contact } from "../lib/contacts";
  import { CALLLOG_KEY, frequentNumbers, normalizeCallLog, recentNumbers, recordCall } from "../lib/calllog";
  import type { CallRecord } from "../lib/calllog";
  import { NOTIF_KEY, addNotif } from "../lib/settings";
  import type { Notif } from "../lib/settings";
  import { zh } from "../i18n/locales/zh";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { iconSvg } from "../lib/sysIcons";
  import { t } from "./locale.svelte";
  import { createStoreValue } from "./store";

  type PhoneTab = "keys" | "recent" | "frequent" | "emergency";
  const SUB: Record<string, string> = {
    "2": "ABC", "3": "DEF", "4": "GHI", "5": "JKL",
    "6": "MNO", "7": "PQRS", "8": "TUV", "9": "WXYZ",
  };
  const EMERGENCY_LABEL = (code: string): string => {
    const m: Record<string, string> = {
      "110": t("phone.emergency.police"),
      "119": t("phone.emergency.fire"),
      "120": t("phone.emergency.ambulance"),
      "122": t("phone.emergency.traffic"),
      "112": t("phone.emergency.international"),
    };
    return m[code] ?? "";
  };
  let num = $state("");
  let calling = $state(false);
  let activeId = $state<string | null>(null);
  let talking = $state(false);
  let recording = $state<"Off" | "On" | "Failed">("Off");
  let dialError = $state<string | null>(null);
  let tab = $state<PhoneTab>("keys");
  let muted = $state(false);
  let padOpen = $state(false);
  let dtmf = $state("");
  let elapsedSec = $state(0);
  let activeRef: string | null = null;
  let activeAtRef: number | null = null;

  const initContacts = normalizeContacts(readStoreValue<unknown>(CONTACTS_KEY, []));
  let contacts = $state<Contact[]>(initContacts);

  // recents / frequent from the shared call log (like useOutgoingCalls).
  const callLogStore = createStoreValue<unknown>(CALLLOG_KEY, []);
  let callLog = $state<CallRecord[]>([]);
  $effect(() => {
    const unsub = callLogStore.subscribe((v) => (callLog = normalizeCallLog(v)));
    return unsub;
  });
  const recents = $derived(
    recentNumbers(callLog, 4).map((n) => ({ num: n, label: contactNameFor(contacts, n) ?? n })),
  );
  const frequent = $derived(
    frequentNumbers(callLog, 3).map((n) => ({ num: n, label: contactNameFor(contacts, n) ?? n })),
  );

  const recordOutgoing = (number: string, name?: string, body?: string) => {
    const next = recordCall(callLog, number, name);
    callLogStore.save(next);
    const label = name && name.trim() !== "" ? name.trim() : number;
    const entry: Notif = {
      id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      app: zh["app.phone"],
      title: label,
      body,
      icon: "📞",
      time: Date.now(),
    };
    writeStoreValue(NOTIF_KEY, addNotif(readStoreValue<Notif[]>(NOTIF_KEY, []), entry));
  };

  const tap = (k: string) => {
    if (!calling) num = pushKey(num, k);
  };
  const startCall = async (number = num, emergency = false) => {
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
    padOpen = false;
    dtmf = "";
    dialError = null;
    // AmOS-managed call (daemon) so Telecom binds OUR in-call UI and we can play
    // a ringback tone while Dialing — instead of ACTION_CALL which hands the UI
    // (and any ringing) to the system dialer.
    const call = await telephonyDial(target, emergency);
    if (!call) {
      calling = false;
      dialError = t("phone.dialFailed");
      return;
    }
    activeId = call.id ?? null;
    activeRef = activeId;
    recordOutgoing(target, contactNameFor(contacts, target) ?? target, t("phone.dialed"));
  };
  const pick = (n: string) => {
    if (calling) return;
    num = n;
    tab = "keys";
  };
  const emergencyDial = (n: string) => void startCall(n, true);

  const endCall = async () => {
    if (activeId) await telephonyEnd(activeId);
    calling = false;
    talking = false;
    activeId = null;
    activeRef = null;
    recording = "Off";
    muted = false;
    padOpen = false;
    dtmf = "";
    dialError = null;
  };
  const toggleRecord = async () => {
    if (!activeId) return;
    const target = recording !== "On";
    const res = target
      ? await telephonyStartRecording(activeId)
      : await telephonyStopRecording(activeId);
    if (res) recording = res.recording as "Off" | "On" | "Failed";
  };
  const simIncoming = async () => {
    if (calling) return;
    const from = num.trim() !== "" ? num.trim() : "02112345678";
    await telephonySimulateIncoming(from);
  };
  const pressDtmf = (k: string) => {
    if (dtmf.length < 12) dtmf = dtmf + k;
  };

  $effect(() => {
    return onTelephonyEvent((call) => {
      if (call.id !== activeRef) return;
      recording = call.recording as "Off" | "On" | "Failed";
      if (call.state === "Active") {
        talking = true;
        activeAtRef = Date.now();
      } else if (call.state === "Ended") {
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

  // Ringback tone (AmOS-managed call): beep while Dialing and not yet connected.
  $effect(() => {
    const ring = calling && !talking && !!activeId;
    if (!ring) return;
    let ctx: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    try {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      const burst = () => {
        if (!ctx || ctx.state === "closed") return;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = 440;
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
        o.connect(g);
        g.connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.42);
      };
      burst();
      timer = setInterval(burst, 800);
    } catch {
      /* audio unavailable */
    }
    return () => {
      if (timer) clearInterval(timer);
      if (ctx) void ctx.close();
    };
  });
</script>

<div class="flex h-full w-full flex-col items-center p-3">
  {#if !calling}
    <div role="tablist" aria-label={t("phone.tabs")} class="mb-1 flex w-full max-w-xs gap-1 rounded-full bg-neutral-200/80 p-1 dark:bg-white/10">
      {#each [
        { id: "keys", label: t("phone.tabKeys") },
        { id: "recent", label: t("phone.tabRecent") },
        { id: "frequent", label: t("phone.tabFrequent") },
        { id: "emergency", label: t("phone.tabEmergency") },
      ] as tb (tb.id)}
        <button role="tab" aria-selected={tab === tb.id} onclick={() => (tab = tb.id as PhoneTab)}
          class="flex-1 rounded-full px-2 py-1.5 text-xs font-medium transition {tab === tb.id ? 'bg-white text-neutral-900 shadow dark:bg-white/20 dark:text-white' : 'text-neutral-600 hover:text-neutral-900 dark:text-white/70 dark:hover:text-white'}">
          {tb.label}
        </button>
      {/each}
    </div>
  {/if}
  {#if !calling && dialError}
    <p role="alert" class="my-2 max-w-xs text-center text-xs text-danger">{dialError}</p>
  {/if}

  {#if calling}
    <div class="flex w-full flex-col items-center">
      <div class="py-4 text-center">
        <div class="text-3xl tabular-nums tracking-widest">{num || "—"}</div>
        <div class="mt-1 text-sm opacity-70">{talking ? t("phone.talking") : t("phone.call")}{!talking && num ? " …" : ""}</div>
        {#if talking}
          <div aria-label="call duration" class="mt-0.5 text-xs tabular-nums tracking-widest text-accent/80">{fmtCallDuration(elapsedSec)}</div>
        {/if}
      </div>
      {#if recording === "On"}
        <p class="flex items-center gap-1.5 text-xs font-medium text-danger"><span class="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden="true"></span>{t("phone.recording")}</p>
      {/if}
      {#if recording === "Failed"}
        <p class="text-xs opacity-60">{t("phone.recordUnavailable")}</p>
      {/if}
      {#if muted}
        <p class="mt-1 text-xs opacity-60">{t("phone.muted")}</p>
      {/if}


      {#if talking}
        {#if padOpen}
          <div class="my-3 flex w-full max-w-[210px] flex-col items-center gap-2">
            <div class="h-6 w-full truncate rounded-full bg-black/5 px-3 text-center text-sm tabular-nums tracking-[0.2em] dark:bg-white/10">{dtmf || "\u00A0"}</div>
            <div class="grid w-full grid-cols-3 gap-2">
              {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as k (k)}
                <button onclick={() => pressDtmf(k)} aria-label={t("phone.dtmfKey", { key: k })}
                  class="grid aspect-square place-items-center rounded-full bg-neutral-300/90 text-lg text-neutral-900 transition active:scale-90 dark:bg-white/10 dark:text-white">{k}</button>
              {/each}
            </div>
            {#if dtmf}
              <button onclick={() => (dtmf = "")} aria-label={t("phone.dtmfClear")} class="text-xs text-accent">{t("phone.clear")}</button>
            {/if}
          </div>
        {/if}
        <div class="mt-2 flex items-center gap-5">
          {#if activeId}
            <button onclick={() => void toggleRecord()} aria-label={recording === "On" ? t("phone.recordStop") : t("phone.recordStart")}
              data-icon={recording === "On" ? "stop" : "record"}
              class={"grid h-14 w-14 place-items-center rounded-full transition active:scale-90 " + (recording === "On" ? "bg-danger text-white" : "bg-neutral-200 text-danger dark:bg-white/10")}>
              {@html iconSvg(recording === "On" ? "stop" : "record", "h-7 w-7")}
            </button>
          {/if}
          <button onclick={() => (muted = !muted)} aria-label={muted ? t("phone.unmute") : t("phone.mute")}
            data-icon={muted ? "micOff" : "mic"}
            class={"grid h-14 w-14 place-items-center rounded-full transition active:scale-90 " + (muted ? "bg-danger text-white" : "bg-neutral-200 text-neutral-700 dark:bg-white/10 dark:text-white")}>
            {@html iconSvg(muted ? "micOff" : "mic", "h-7 w-7")}
          </button>
          <button onclick={() => { padOpen = !padOpen; dtmf = ""; }} aria-label={t("phone.dtmf")} data-icon="dialpad"
            class="grid h-14 w-14 place-items-center rounded-full bg-neutral-200 text-neutral-700 transition active:scale-90 dark:bg-white/10 dark:text-white">{@html iconSvg("dialpad", "h-7 w-7")}</button>
        </div>
      {/if}
      <div class="mt-6">
        <button onclick={() => void endCall()} aria-label="end" data-icon="end" class="grid h-16 w-16 place-items-center rounded-full bg-danger text-white transition active:scale-90">{@html iconSvg("x", "h-7 w-7")}</button>
      </div>
    </div>


  {:else if tab === "keys"}
    <div class="flex w-full flex-col items-center">
      <div class="flex w-full max-w-xs items-center justify-center px-3 pb-1 pt-2">
        <span class="block max-w-full truncate font-light tabular-nums leading-none {num.length > 9 ? 'text-[26px] tracking-[0.02em]' : num.length > 5 ? 'text-[32px] tracking-[0.04em]' : 'text-[40px] tracking-[0.05em]'}">{num}</span>
      </div>
      <div class="grid w-full max-w-xs grid-cols-3 justify-items-center gap-x-1 gap-y-3">
        {#each KEYS as k (k)}
          <button onclick={() => tap(k)} aria-label={k}
            class="grid h-[76px] w-[76px] place-items-center rounded-full bg-neutral-300/90 text-neutral-900 transition active:scale-95 dark:bg-white/10 dark:text-white">
            <span class="flex flex-col items-center leading-none">
              <span class="text-[26px] font-light leading-none">{k}</span>
              {#if SUB[k]}
                <span class="mt-1 text-xs tracking-[0.22em] opacity-55">{SUB[k]}</span>
              {/if}
            </span>
          </button>
        {/each}
      </div>


      <div class="mt-3 flex items-start justify-center gap-12">
        <div class="flex flex-col items-center gap-2">
          <button onclick={() => (num = backspace(num))} disabled={!num} aria-label="backspace" data-icon="delete"
            class="grid h-11 w-11 place-items-center rounded-full bg-neutral-300/90 text-neutral-700 transition active:scale-90 disabled:opacity-25 dark:bg-white/10 dark:text-white">{@html iconSvg("delete", "h-5 w-5")}</button>
          <button onclick={() => (num = clearDial(num))} disabled={!num} aria-label="clear" class="text-xs text-accent disabled:opacity-25">{t("phone.clear")}</button>
        </div>
        <button onclick={() => void startCall()} disabled={!num} aria-label="call" data-icon="phone"
          class="grid h-[60px] w-[60px] place-items-center rounded-full bg-green-500 text-white shadow-[0_6px_16px_rgba(52,199,89,0.45)] transition active:scale-90 disabled:opacity-40">
          {@html iconSvg("phone", "h-7 w-7")}
        </button>
        <div class="w-11" aria-hidden="true"></div>
      </div>
      <button onclick={() => void simIncoming()} disabled={calling} aria-label={t("phone.simIncoming")}
        class="mt-3 text-xs uppercase tracking-widest text-accent/70 transition hover:text-accent disabled:opacity-30">{t("phone.simIncoming")}</button>
    </div>


  {:else if tab === "recent"}
    <div class="flex w-full flex-col items-center">
      <div class="py-5 text-center text-lg font-medium opacity-70">{t("phone.tabRecent")}</div>
      {#if recents.length === 0}
        <p class="py-10 text-sm opacity-50">{t("phone.emptyRecent")}</p>
      {:else}
        <ul class="w-full max-w-xs divide-y divide-black/5 dark:divide-white/10">
          {#each recents as it (it.num)}
            <li>
              <button onclick={() => pick(it.num)} title={it.num} class="flex w-full items-center justify-between gap-2 py-3 text-left">
                <span class="truncate text-sm">{it.label}</span>
                <span class="shrink-0 text-xs opacity-50 tabular-nums">{it.num}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
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
              <button onclick={() => pick(it.num)} title={it.num} class="flex w-full items-center justify-between gap-2 py-3 text-left">
                <span class="truncate text-sm">{it.label}</span>
                <span class="shrink-0 text-xs opacity-50 tabular-nums">{it.num}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>


  {:else}
    <div class="flex w-full flex-col items-center">
      <div class="py-5 text-center text-lg font-medium opacity-70">{t("phone.emergencyTitle")}</div>
      <ul class="w-full max-w-xs space-y-2.5">
        {#each EMERGENCY_NUMBERS as code (code)}
          {@const primary = code === EMERGENCY_QUICK_NUMBER}
          <li>
            <button onclick={() => emergencyDial(code)} aria-label={`${t("phone.emergencyCall")} ${code}`}
              class={"flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition active:scale-[0.99] " +
                (primary ? "bg-danger text-white shadow-[0_6px_18px_rgba(220,38,38,0.35)]" : "bg-danger/10 text-red-700 ring-1 ring-danger/25 dark:text-red-300")}>
              <span class="text-base font-semibold">{EMERGENCY_LABEL(code) ?? t("phone.emergencyGeneric", { num: code })}</span>
              <span class="text-2xl tabular-nums tracking-widest">{code}</span>
            </button>
          </li>
        {/each}
      </ul>
      <p class="mt-4 max-w-xs text-center text-xs leading-relaxed opacity-50">{t("phone.emergencyHint")}</p>
    </div>
  {/if}
</div>


<script lang="ts">
  // PhoneApp.svelte — Svelte 5 (runes) single-source implementation of the phone
  // screen. Keypad/dial
  // logic reuses lib/phone + lib/emergency; dialing/events/record go through
  // lib/backend telephony; recent/frequent derive from the call log via
  // createStoreValue (mirrors useOutgoingCalls). Real dial/record verified on-device.
  import { KEYS, backspace, clearDial, fmtCallDuration, pushKey } from "../lib/phone";
  import { playRingback, stopCallTone } from "../lib/callTone";
  import { EMERGENCY_NUMBERS, EMERGENCY_QUICK_NUMBER } from "../lib/emergency";
  import {
    onTelephonyEvent, telephonyDial, telephonyEnd, telephonySimulateIncoming,
    telephonyStartRecording, telephonyStopRecording,
    blocklistAdd, blocklistRemove, blocklistSetUnknown, blocklistSnapshot,
    blocklistStatus, blocklistRequestRole,
    bridged, bridgeDiag,
  } from "../lib/backend";
  import type { BlockRuleOut, BlocklistStatusOut } from "../lib/backend";
  import { CONTACTS_KEY, contactNameFor, normalizeContacts } from "../lib/contacts";
  import type { Contact } from "../lib/contacts";
  import { CALLLOG_KEY, callDateStamp, callHistory, callWhenLabel, clearCallHistory, filterHistory, fmtCallClock, frequentNumbers, missedCalls, normalizeCallLog, recordCall } from "../lib/calllog";
  import type { CallFilter, CallRecord } from "../lib/calllog";
  import { composeSmsTo } from "./appLinks";
  import { NOTIF_KEY, addNotif } from "../lib/settings";
  import type { Notif } from "../lib/settings";
  import { zh } from "../i18n/locales/zh";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { iconSvg } from "../lib/sysIcons";
  import { t } from "./locale.svelte";
  import { createStoreValue } from "./store";
  import { onMount } from "svelte";

  type PhoneTab = "keys" | "recent" | "frequent" | "emergency" | "block";
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

  // ---- Spam blocking (calls + SMS) -------------------------------------------
  // Rules live in Rust (shared with the SMS filter and the Android call-screening
  // service), so this screen is a thin, honest view over that one source. The
  // shared `invoke()` helper does NOT throw: it swallows a command rejection and
  // returns `null`, leaving the reason in `bridgeDiag()`. So every call here must
  // check `null` / `bridgeDiag()` — otherwise a rejected rule silently does nothing.
  let blockRules = $state<BlockRuleOut[]>([]);
  let blockUnknown = $state(false);
  let blockStatus = $state<BlocklistStatusOut | null>(null);
  let blockNum = $state("");
  let blockKind = $state<BlockRuleOut["kind"]>("exact");
  let blockChannel = $state<BlockRuleOut["channel"]>("both");
  let blockErr = $state("");
  let blockBusy = $state(false);

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
    // `null` = host/desktop (no Call Screening role exists) or a failed probe; the
    // honest default is "no status", so the banner simply stays hidden.
    blockStatus = await blocklistStatus();
  };
  const refreshBlock = async () => {
    await loadBlocklist();
    await loadBlockStatus();
  };
  $effect(() => {
    if (!bridged()) return;
    void refreshBlock();
  });
  // The Call Screening role is granted in a *separate* system Activity, so the
  // user's answer lands long after `blocklist_request_role` returned (that command
  // only posts the dialog). Re-probe the status on resume/focus — and every time
  // the 拦截 tab is opened — so the banner flips to "active" (or back to "needs
  // granting" after an external revoke) without restarting the app.
  $effect(() => {
    if (tab !== "block" || !bridged()) return;
    void loadBlockStatus();
  });
  onMount(() => {
    const recheck = () => {
      if (document.visibilityState === "visible" && bridged()) void loadBlockStatus();
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  });

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
        console.warn("[blocklist] add rejected", bridgeDiag());
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
    if (!bridgeDiag().ok) {
      blockErr = t("phone.blockRemoveFailed");
      console.warn("[blocklist] remove failed", bridgeDiag());
    } else if (!removed) {
      // Not an error: the rule was already gone (e.g. removed elsewhere).
      console.warn("[blocklist] remove: rule not found", id);
    }
    await refreshBlock();
  };
  const toggleBlockUnknown = async () => {
    const next = !blockUnknown;
    blockUnknown = next; // optimistic, rolled back on failure
    blockErr = "";
    await blocklistSetUnknown(next);
    if (!bridgeDiag().ok) {
      blockUnknown = !next;
      blockErr = t("phone.blockSaveFailed");
      console.warn("[blocklist] set_unknown failed", bridgeDiag());
    }
  };
  const requestBlockRole = async () => {
    blockErr = "";
    blockBusy = true;
    try {
      const ok = await blocklistRequestRole();
      if (!ok && bridged()) {
        blockErr = t("phone.blockRoleFailed");
        console.warn("[blocklist] role request failed", bridgeDiag());
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
  const hasCallRules = $derived(!!blockStatus?.has_call_rules);
  const roleHeld = $derived(!!blockStatus?.role_held);
  const roleAskable = $derived(!!blockStatus?.role_supported && !!blockStatus.role_requestable);

  const initContacts = normalizeContacts(readStoreValue<unknown>(CONTACTS_KEY, []));
  let contacts = $state<Contact[]>(initContacts);

  // recents / frequent from the shared call log (like useOutgoingCalls).
  const callLogStore = createStoreValue<unknown>(CALLLOG_KEY, []);
  let callLog = $state<CallRecord[]>([]);
  $effect(() => {
    const unsub = callLogStore.subscribe((v) => (callLog = normalizeCallLog(v)));
    return unsub;
  });
  const frequent = $derived(
    frequentNumbers(callLog, 3).map((n) => ({ num: n, label: contactNameFor(contacts, n) ?? n })),
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
    callLogStore.save(clearCallHistory());
    confirmClear = false;
    logFilter = "all";
  };
  const callBack = (n: string) => void startCall(n);
  const smsBack = (n: string) => composeSmsTo(n);

  const recordOutgoing = (number: string, name?: string, body?: string) => {
    const next = recordCall(callLog, number, name, Date.now(), "outgoing");
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

  // Ringback tone (AmOS-managed call): play the real MP3 waiting tone while
  // Dialing and not yet connected (stops when connected / call ends / unmount).
  $effect(() => {
    const ring = calling && !talking && !!activeId;
    if (ring) playRingback();
    return () => stopCallTone();
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
        { id: "block", label: t("phone.tabBlock") },
      ] as tb (tb.id)}
        <button role="tab" aria-selected={tab === tb.id} onclick={() => (tab = tb.id as PhoneTab)}
          class="flex-1 rounded-full px-2 py-2 text-xs font-medium transition {tab === tb.id ? 'bg-white text-neutral-900 shadow dark:bg-white/20 dark:text-white' : 'text-neutral-600 hover:text-neutral-900 dark:text-white/70 dark:hover:text-white'}">
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
        <span class="block max-w-full truncate font-medium tabular-nums leading-none {num.length > 9 ? 'text-[26px] tracking-[0.02em]' : num.length > 5 ? 'text-[32px] tracking-[0.04em]' : 'text-[40px] tracking-[0.05em]'}">{num}</span>
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
    <div class="flex w-full flex-col items-center" data-testid="call-history">
      <div class="flex w-full max-w-sm items-baseline justify-between gap-2 pb-1 pt-3">
        <span class="text-lg font-medium opacity-80">{t("phone.historyTitle")}</span>
        <div class="flex shrink-0 items-center gap-2">
          {#if missedTotal > 0}
            <span class="text-xs text-danger" data-testid="missed-count">{t("phone.missedCount", { n: missedTotal })}</span>
          {/if}
          {#if historyTotal > 0}
            {#if confirmClear}
              <button onclick={clearLog} aria-label="history-clear-confirm" class="rounded-full bg-danger/15 px-2.5 py-1 text-xs text-danger active:scale-95">{t("phone.historyClearConfirm")}</button>
              <button onclick={() => (confirmClear = false)} aria-label="history-clear-cancel" class="rounded-full bg-black/5 px-2.5 py-1 text-xs active:scale-95 dark:bg-white/10">{t("phone.historyClearCancel")}</button>
            {:else}
              <button onclick={() => (confirmClear = true)} aria-label="history-clear" title={t("phone.historyClear")} class="rounded-full bg-black/5 px-2.5 py-1 text-xs active:scale-95 dark:bg-white/10">{t("phone.historyClear")}</button>
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
            <li class="flex items-center gap-2 py-2" data-testid="history-row" data-direction={it.direction ?? "unknown"}>
              <span aria-label={dirLabel(it.direction)} title={dirLabel(it.direction)}
                class={"grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm " + (missed ? "bg-danger/15 text-danger" : "bg-black/5 opacity-70 dark:bg-white/10")}>
                {it.direction === "outgoing" ? "↗" : it.direction === "incoming" || missed ? "↙" : "•"}
              </span>
              <div class="min-w-0 flex-1">
                <div class={"truncate text-sm " + (missed ? "text-danger" : "")}>{it.label}</div>
                {#if it.label !== it.num}
                  <div class="truncate text-xs opacity-55 tabular-nums">{it.num}{#if whenOf(it.ts)}{" · "}{whenOf(it.ts)}{/if}</div>
                {:else if whenOf(it.ts)}
                  <div class="truncate text-xs opacity-55 tabular-nums">{whenOf(it.ts)}</div>
                {/if}
              </div>
              <div class="flex shrink-0 items-center gap-1.5">
                <button onclick={() => callBack(it.num)} aria-label={`call-back-${it.num}`} title={t("phone.callBack")} data-icon="phone"
                  class="grid h-10 w-10 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 active:scale-90 dark:text-emerald-300">{@html iconSvg("phone", "h-[18px] w-[18px]")}</button>
                <button onclick={() => smsBack(it.num)} aria-label={`sms-back-${it.num}`} title={t("phone.smsBack")} data-icon="messageCircle"
                  class="grid h-10 w-10 place-items-center rounded-full bg-accent/15 text-accent active:scale-90">{@html iconSvg("messageCircle", "h-[18px] w-[18px]")}</button>
                <button onclick={() => blockFromRecents(it.num)} aria-label={`block-caller-${it.num}`} title={t("phone.blockThisNumber")} data-icon="x"
                  class="grid h-10 w-10 place-items-center rounded-full bg-danger/10 text-danger active:scale-90 dark:bg-danger/20">{@html iconSvg("x", "h-[18px] w-[18px]")}</button>
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
              <button onclick={() => pick(it.num)} title={it.num} class="flex w-full items-center justify-between gap-2 py-3 text-left">
                <span class="truncate text-sm">{it.label}</span>
                <span class="shrink-0 text-xs opacity-50 tabular-nums">{it.num}</span>
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

  {:else if tab === "block"}
    <div class="flex w-full flex-col items-center" data-testid="blocklist-panel">
      <!-- Enforcement status: rules alone do not reject calls — the OS role does.
           All three states are rendered, so "rules exist but nothing enforces
           them" can never look like "all good" (or like nothing at all). -->
      {#if hasCallRules}
        {#if roleHeld}
          <p data-testid="block-role-held" class="mb-2 w-full max-w-sm rounded-2xl bg-emerald-500/15 px-3 py-2 text-center text-xs text-emerald-700 dark:text-emerald-300">
            {t("phone.blockRoleHeld")}
          </p>
        {:else if roleAskable}
          <div data-testid="block-role-needed" class="mb-2 w-full max-w-sm rounded-2xl bg-amber-500/15 px-3 py-2 text-center text-xs text-amber-700 dark:text-amber-300">
            <p>{t("phone.blockRoleNeeded")}</p>
            <button onclick={() => void requestBlockRole()} disabled={blockBusy} aria-label="block-grant-role"
              class="mt-1.5 rounded-full bg-accent px-3 py-1 text-xs text-white active:scale-95 disabled:opacity-50">
              {t("phone.blockRoleGrant")}
            </button>
          </div>
        {:else}
          <p data-testid="block-role-unavailable" class="mb-2 w-full max-w-sm rounded-2xl bg-black/5 px-3 py-2 text-center text-xs opacity-70 dark:bg-white/10">
            {t("phone.blockRoleUnsupported")}
          </p>
        {/if}
      {/if}
      <!-- Add a rule: pattern + exact/prefix + which channel it covers. The input
           gets its own full-width row (on a 360px phone the old single row left it
           only ~65px wide, so the placeholder never fit). -->
      <div class="mb-2 w-full max-w-sm space-y-1.5">
        <input bind:value={blockNum} aria-label="block-number" onkeydown={(e) => e.key === "Enter" && void addBlockRule()} placeholder={t("phone.blockPlaceholder")} class="w-full rounded-full bg-black/5 px-3.5 py-2 text-sm outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:ring-white/10 dark:placeholder:text-white/30" />
        <div class="flex items-center gap-1.5">
          <select bind:value={blockKind} aria-label="block-kind" class="min-w-0 flex-1 rounded-full bg-black/5 px-2.5 py-2 text-xs dark:bg-white/10">
            <option value="exact">{t("phone.blockKindExact")}</option>
            <option value="prefix">{t("phone.blockKindPrefix")}</option>
          </select>
          <select bind:value={blockChannel} aria-label="block-channel" class="min-w-0 flex-1 rounded-full bg-black/5 px-2.5 py-2 text-xs dark:bg-white/10">
            <option value="both">{t("phone.blockChannelBoth")}</option>
            <option value="call">{t("phone.blockChannelCall")}</option>
            <option value="sms">{t("phone.blockChannelSms")}</option>
          </select>
          <button onclick={() => void addBlockRule()} disabled={blockBusy} aria-label="block-add" class="shrink-0 rounded-full bg-accent px-4 py-2 text-xs text-white active:scale-95 disabled:opacity-50">{t("phone.blockAdd")}</button>
        </div>
      </div>
      {#if blockErr}
        <p class="mb-1 text-xs text-red-500" role="alert">{blockErr}</p>
      {/if}
      <button onclick={() => void toggleBlockUnknown()} aria-pressed={blockUnknown} aria-label="block-unknown" class={"mb-2 w-full max-w-sm rounded-2xl px-4 py-2 text-left text-sm " + (blockUnknown ? "bg-accent/15 text-accent" : "bg-black/5 dark:bg-white/10")}>
        {t("phone.blockUnknown")} · {blockUnknown ? t("phone.on") : t("phone.off")}
      </button>
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
              <button onclick={() => void removeBlockRule(r.id)} aria-label={`block-remove-${r.pattern}`} class="shrink-0 rounded-full bg-neutral-200 px-2 py-1 text-xs dark:bg-neutral-700">{t("phone.blockRemove")}</button>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="mt-4 max-w-sm text-center text-xs leading-relaxed opacity-50">{t("phone.blockHint")}</p>
    </div>
  {/if}
</div>


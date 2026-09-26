<script lang="ts">
  // LockScreen.svelte — Svelte 5 (runes) port of the React `SystemPanels.LockScreen`
  // (the whole-screen surface the shell shows while locked). Reads amos.lock /
  // amos.settings, shows clock/date, PIN pad (or tap-to-unlock when no PIN), and
  // the always-reachable emergency quick-dial. Emits 'unlock' to the shell.
  import { t, locale } from "./locale.svelte";
  import { fmtClock } from "../lib/time";
  import {
    realDial,
    realDialStatus,
    telephonyBackendKind,
    telephonyDefaultDialerStatus,
    telephonyDial,
  } from "../lib/backend";
  import { placeOutgoingCall } from "../lib/phone";
  import { wmOpenReported } from "../lib/wm";
  import { deviceQuickEmergencyNumber } from "../lib/emergency";
  import { createStoreValue } from "./store";
  import { propsChannel } from "./propsBus";
  import { isCustomWallpaper, WALLPAPER_FILES } from "../lib/wallpaper";
  import { iconSvg, batterySvg } from "../lib/sysIcons";
  import { batteryReadout, batteryTone } from "../lib/batteryStatus";
  import { systemStatusWithHostBattery } from "../lib/system";
  import { attachFocusTrap } from "../lib/focusTrap";

  const bus = propsChannel<{ ready?: boolean }>("lock");

  const lockStore = createStoreValue<{ enabled?: boolean; pin?: string }>("amos.lock", {});
  const settingsStore = createStoreValue<{ lockWallpaper?: string }>("amos.settings", {});
  let lockCfg = $state<{ enabled?: boolean; pin?: string }>({});
  let prefs = $state<{ lockWallpaper?: string }>({});
  $effect(() => {
    const un = lockStore.subscribe((v) => (lockCfg = v ?? {}));
    return un;
  });
  $effect(() => {
    const un = settingsStore.subscribe((v) => (prefs = v ?? {}));
    return un;
  });

  const needPin = $derived(!!lockCfg.enabled && !!lockCfg.pin);
  const dark =
    typeof document !== "undefined" && !!document.documentElement?.classList?.contains("dark");
  const lockWall = $derived(prefs.lockWallpaper);
  const lockBgUrl = $derived.by(() => {
    // Always resolve a wallpaper: use the user's lock wallpaper if chosen, else
    // fall back to the theme default (dark/light) so the lock screen is never a
    // bare gray panel.
    const w = lockWall;
    if (!w) return `wallpapers/${dark ? "dark" : "light"}`;
    const f = isCustomWallpaper(w) ? w : WALLPAPER_FILES[w] ?? (dark ? "dark" : "light");
    return isCustomWallpaper(f) ? f : `wallpapers/${f}`;
  });

  let pin = $state("");
  let bad = $state(false);
  let emergency = $state(false);
  let dialFailed = $state(false);
  let simulated = $state(false);
  let handedOff = $state(false);
  let owned = $state(false);
  let roleUnread = $state(false);

  // The one-tap number is the **device's** region choice, not a constant: a
  // hardcoded 110 reaches nobody outside CN/JP (KR's police is 112, AU/NZ dial
  // 000, the US dials 911). Read once per mount — the OS locale does not change
  // under a locked screen — and used for both the dial and the label, so what the
  // user reads is exactly what is dialed.
  const quickDial = deviceQuickEmergencyNumber();

  // Keyboard focus trap (WCAG 2.1.2): Tab cycles inside the lock screen only.
  // Escape is not handled here (a locked device must not escape without auth).
  let rootEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!rootEl) return;
    return attachFocusTrap(rootEl);
  });

  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });
  const dateStr = $derived(
    new Intl.DateTimeFormat(locale() === "zh" ? "zh-CN" : "en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(now),
  );

  // Real battery, top-right (iOS-style). Layered daemon → host → browser; when no
  // source reports a level we render nothing (honest, never a fabricated number).
  // Polled slowly — a lock screen can sit for a long time.
  const BATTERY_POLL_MS = 30_000;
  let batteryLevel = $state<number | null>(null);
  let batteryCharging = $state<boolean | null>(null);
  const battTone = $derived(batteryTone({ levelPct: batteryLevel, charging: batteryCharging }));
  /** The shared read-out: the shown text AND the accessible name (see below). */
  const readout = $derived(batteryReadout({ levelPct: batteryLevel, charging: batteryCharging }));
  $effect(() => {
    let stopped = false;
    const read = async () => {
      const sys = await systemStatusWithHostBattery();
      if (!sys || stopped) return;
      batteryLevel = sys.battery_level_pct;
      batteryCharging = sys.battery_charging;
    };
    void read();
    const id = window.setInterval(read, BATTERY_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  });

  const tap = (d: string) => {
    if (pin.length < 6) pin += d;
    bad = false;
  };
  const backspace = () => (pin = pin.slice(0, -1));
  const submit = () => {
    if (pin === lockCfg.pin) {
      pin = "";
      bus.emit("unlock");
    } else {
      bad = true;
      pin = "";
    }
  };

  const dialEmergency = async () => {
    if (emergency) return;
    dialFailed = false;
    simulated = false;
    handedOff = false;
    owned = false;
    roleUnread = false;
    emergency = true;
    // The **same** routing the keypad and Contacts use (`lib/phone::placeOutgoingCall`):
    // the real platform path (`ACTION_CALL` through Android Telecom) first, then a daemon
    // backed by a genuinely real stack, and only a host with no telephony stack at all may
    // answer with a simulated call. This surface used to call `telephonyDial` directly,
    // which meant the OS's most safety-critical button — the one-tap emergency dial a
    // locked user reaches without authenticating — was answered by the daemon's mock
    // provider (an unconditional `Ok`) and never reached `ACTION_CALL` on a real device.
    // The routing is the library's, so this screen and the other two cannot drift apart.
    const outcome = await placeOutgoingCall(quickDial, true, {
      system: (n) => realDial(n),
      daemonReal: async () => (await telephonyBackendKind())?.real === true,
      hostStatus: () => realDialStatus(),
      daemon: (n, e) => telephonyDial(n, e),
    });
    // The in-flight guard ends **here**, on every outcome. `placeOutgoingCall` resolves once
    // the attempt is placed, not when the call ends, and this screen keeps no in-call state
    // to stay disabled for — so `emergency` is not a "a call is up" fact. Left set (as it was:
    // only the `failed` branch cleared it), the one control a locked user reaches without
    // authenticating stayed `disabled` and read "正在呼叫 …" for the rest of the lock session,
    // on the very successful dial the rest of the routing works to make possible.
    emergency = false;
    if (outcome.kind === "failed") {
      dialFailed = true;
      return;
    }
    // A simulated emergency call is the one thing a user must never be told is real, so
    // the fact rides on screen when the only path available was the daemon's.
    if (outcome.kind === "managed") {
      simulated = outcome.simulated;
      return;
    }
    // `ACTION_CALL` was handed to Android Telecom — but **who owns the call now** is the
    // `ROLE_DIALER` role, not the mere fact that this screen handed it off. The other two
    // consumers of `placeOutgoingCall` (`PhoneApp.startCall`, `ContactsApp.callNumber`)
    // both ask; this one did not, and asserted "the system dialer owns it" on every
    // hand-off. When AmOS itself holds the role, Telecom resolves the call straight back
    // into *this app's own* `AmosInCallService` (fixed id `real`), so the sentence is
    // false and — while locked only this screen is drawn — the user has no hang-up
    // anywhere. The in-call surface is brought up; it sits behind the lock overlay until
    // the unlock that makes a hang-up key relevant.
    const role = await telephonyDefaultDialerStatus();
    if (role?.role_held) {
      owned = true;
      await wmOpenReported("phone", "lockscreen");
      return;
    }
    // `null` is 「我没问到」, not "another dialer holds it": `invoke` resolves `null` on a
    // failed command and never rejects, so a refused probe established no owner at all.
    if (role === null) {
      roleUnread = true;
      await wmOpenReported("phone", "lockscreen");
      return;
    }
    handedOff = true;
  };
</script>

<div
  bind:this={rootEl}
  role="dialog"
  aria-modal="true"
  aria-label={t("shell.lockTitle")}
  class={
    "fade-in absolute inset-0 z-50 flex flex-col items-center justify-center overflow-hidden px-6 text-neutral-50 " +
    (lockBgUrl ? "" : "bg-neutral-900/75 backdrop-blur-2xl")
  }
>
  {#if lockBgUrl}
    <div aria-hidden="true" class="absolute inset-0 bg-cover bg-center" style={`background-image:url(${lockBgUrl})`}></div>
    <div aria-hidden="true" class="absolute inset-0 bg-black/35"></div>
  {/if}
  {#if batteryLevel !== null}
    <div
      data-testid="lock-battery"
      aria-label={readout ? t(readout.key, { pct: readout.pct }) : t("a11y.batteryLevel")}
      class="absolute right-6 top-6 z-20 flex items-center gap-1.5 text-neutral-100 tabular-nums"
    >
      {@html batterySvg(batteryLevel, "h-3.5 w-3.5", battTone)}
      <span aria-hidden="true">{readout?.pct}</span>
    </div>
  {/if}
    <div class="relative z-10 flex w-full flex-col items-center">
      <!-- role="timer": screen readers can ask "what time is it?" and read this on demand;
           aria-label is the descriptive name; no aria-live (per-second interruption is hostile). (REQ-A284) -->
      <div class="text-center leading-none" role="timer" aria-label={t("a11y.currentTime")}>
        <div class="text-7xl font-medium tabular-nums tracking-tight">{fmtClock(now)}</div>
        <div class="mt-2.5 text-lg text-neutral-200">{dateStr}</div>
        <div class="mt-7 flex items-center justify-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-400">
          <span aria-hidden="true" data-icon="lock" class="grid h-3.5 w-3.5 place-items-center">{@html iconSvg("lock", "h-3.5 w-3.5")}</span> {t("shell.lockTitle")}
        </div>
      </div>

    {#if needPin}
      <div class="my-7 text-2xl tabular-nums tracking-[0.35em] text-neutral-100">
        {#if bad}
          <span class="text-3xl text-red-400">✗</span>
        {:else}
          <span class="text-3xl">{pin.length ? "●".repeat(pin.length) : "○○○○○○"}</span>
        {/if}
      </div>
      <div class="grid grid-cols-3 gap-x-6 gap-y-4">
        {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"] as k (k)}
          {@const confirm = k === "✓"}
          {@const back = k === "⌫"}
          <button
            onclick={confirm ? submit : back ? backspace : () => tap(k)}
            aria-label={k}
            data-icon={confirm ? "check" : back ? "delete" : undefined}
            class={
              "grid h-[72px] w-[72px] place-items-center rounded-full text-2xl font-light transition active:scale-95 " +
              (confirm
                ? "bg-ios-green text-white shadow-lg active:opacity-90"
                : "bg-white/15 text-white backdrop-blur-md ring-1 ring-white/30 active:bg-white/25")
            }
          >
            {#if confirm}
              {@html iconSvg("check", "h-8 w-8")}
            {:else if back}
              {@html iconSvg("delete", "h-7 w-7")}
            {:else}
              {k}
            {/if}
          </button>
        {/each}
      </div>
    {:else}
      <button
        onclick={() => bus.emit("unlock")}
        class="mt-10 rounded-full bg-white/15 px-9 py-3 text-base font-medium ring-1 ring-white/25 backdrop-blur transition active:bg-white/25"
      >{t("shell.unlock")}</button>
    {/if}

    <button
      onclick={() => void dialEmergency()}
      disabled={emergency}
      class="mt-10 rounded-full bg-danger/20 px-8 py-3 text-ios-body font-medium text-white ring-1 ring-danger/40 backdrop-blur-md transition active:scale-95 active:bg-danger/30 disabled:opacity-60"
      aria-label={t("shell.emergency", { num: quickDial })}
    >
      {emergency
        ? t("shell.emergencyCalling", { num: quickDial })
        : t("shell.emergency", { num: quickDial })}
    </button>
    {#if dialFailed}
      <p class="mt-3 max-w-xs text-center text-xs text-red-200/80">{t("shell.emergencyUnreachable")}</p>
    {/if}
    {#if handedOff}
      <p role="status" class="mt-3 max-w-xs text-center text-xs text-neutral-300/90">{t("phone.handedToSystem")}</p>
    {/if}
    {#if owned}
      <p role="status" class="mt-3 max-w-xs text-center text-xs text-neutral-300/90">{t("shell.emergencyOwned")}</p>
    {/if}
    {#if roleUnread}
      <p role="status" class="mt-3 max-w-xs text-center text-xs text-neutral-300/90">{t("shell.emergencyRoleUnread")}</p>
    {/if}
    {#if simulated}
      <p role="status" class="mt-3 max-w-xs text-center text-xs text-amber-200/90">{t("phone.simulatedCall")}</p>
    {/if}
  </div>
</div>


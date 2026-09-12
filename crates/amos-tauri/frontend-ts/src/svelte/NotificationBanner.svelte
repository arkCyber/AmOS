<script lang="ts">
  // NotificationBanner.svelte — Svelte 5 (runes) port of the React
  // NotificationBanner chrome island. Mounted once in the phone frame, over every
  // screen; when a notification is added and DND is OFF it shows the newest as a
  // toast (tap to acknowledge → clears the app's badge) and plays the arrival
  // alert — the synthesized chime (`lib/notifyTone`) and/or a haptic pulse —
  // gated by the effective sound policy (`lib/sound`: persisted bits × DND).
  // Pure island: reads the shared NOTIF + DND + SOUND stores, no external props.
  // Same transient logic + timings.
  import { writeStoreValue } from "../lib/amosStore";
  import {
    NOTIF_KEY,
    SETTINGS_KEY,
    dndActive,
    newestAddedNotif,
    normalizeQuick,
    removeAppNotifs,
    type Notif,
  } from "../lib/settings";
  import {
    SOUND_KEY,
    effectiveAlert,
    normalizeSound,
    shouldRingOnArrival,
    shouldVibrateOnArrival,
  } from "../lib/sound";
  import { playNotifyTone } from "../lib/notifyTone";
  import { createStoreValue } from "./store";

  const SHOW_MS = 4200;
  /** Haptic pulse length (ms) for one arriving notification. */
  const HAPTIC_MS = 30;

  const notifStore = createStoreValue<Notif[]>(NOTIF_KEY, []);
  const settingsStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  const soundStore = createStoreValue<unknown>(SOUND_KEY, {});

  let notifs = $state<Notif[]>([]);
  let settingsRaw = $state<unknown>({});
  let soundRaw = $state<unknown>({});
  let banner = $state<Notif | null>(null);

  // Transient, non-reactive mirrors of the local refs (prev list + timer id).
  let prev: Notif[] = [];
  let timer: number | null = null;
  // Seed `prev` from the FIRST store read so pre-existing notifications at mount
  // are not mistaken for "just arrived" (mirrors React prev=notifs initialisation).
  let seeded = false;

  $effect(() => {
    const un = notifStore.subscribe((v) => {
      if (!seeded) {
        seeded = true;
        prev = v;
      }
      notifs = v;
    });
    return un;
  });
  $effect(() => {
    const un = settingsStore.subscribe((v) => (settingsRaw = v));
    return un;
  });
  $effect(() => {
    const un = soundStore.subscribe((v) => (soundRaw = v));
    return un;
  });
  const dnd = $derived(dndActive(normalizeQuick(settingsRaw)));
  // The policy the *user* chose, folded with DND: DND mutes both bits.
  const policy = $derived(effectiveAlert(normalizeSound(soundRaw), dnd));

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  /** Best-effort haptic pulse; unsupported hosts (desktop/tests) are a no-op. */
  const haptic = () => {
    try {
      navigator.vibrate?.(HAPTIC_MS);
    } catch {
      /* no vibration motor / blocked — silent */
    }
  };

  // React to arrival / DND like the React useEffect([notifs, dnd]).
  $effect(() => {
    clearTimer();
    if (dnd) {
      // DND hides a visible banner and suppresses new ones.
      banner = null;
      prev = notifs;
      return;
    }
    const added = newestAddedNotif(prev, notifs);
    if (added) {
      banner = added;
      timer = window.setTimeout(() => {
        banner = null;
        timer = null;
      }, SHOW_MS);
      // Audible/haptic arrival alert, gated by the *effective* policy. Both gates
      // require the unread count to have actually grown, so a dismissal/clear
      // (or a policy change while idle) never re-alerts.
      if (shouldRingOnArrival(prev.length, notifs.length, policy)) playNotifyTone();
      if (shouldVibrateOnArrival(prev.length, notifs.length, policy)) haptic();
    }
    prev = notifs;
  });

  // Acknowledge: mark the banner's app notifications as read and dismiss.
  const ack = () => {
    const b = banner;
    if (!b) return;
    if (b.app) {
      writeStoreValue(NOTIF_KEY, removeAppNotifs(notifs, b.app));
    }
    banner = null;
    clearTimer();
  };
</script>

{#if banner}
  <button
    onclick={ack}
    aria-label="notification: acknowledge"
    class="absolute inset-x-3 top-[46px] z-[70] flex items-start gap-3 rounded-2xl bg-white/90 px-3 py-2.5 text-left shadow-lg ring-1 ring-black/10 backdrop-blur-md dark:bg-neutral-900/90 dark:ring-white/10"
  >
    <span class="text-xl leading-none" aria-hidden="true">{banner.icon ?? "🔔"}</span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-xs font-semibold text-neutral-900 dark:text-white">
        {banner.app ?? banner.title ?? "Notification"}
      </span>
      {#if banner.title}
        <span class="block truncate text-xs text-neutral-700 dark:text-neutral-300">
          {banner.title}
        </span>
      {/if}
      {#if banner.body}
        <span class="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
          {banner.body}
        </span>
      {/if}
    </span>
    <span aria-hidden="true" class="opacity-50">✓</span>
  </button>
{/if}

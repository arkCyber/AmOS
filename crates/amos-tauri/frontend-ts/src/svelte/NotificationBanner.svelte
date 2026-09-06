<script lang="ts">
  // NotificationBanner.svelte — Svelte 5 (runes) port of the React
  // NotificationBanner chrome island. Mounted once in the phone frame, over every
  // screen; when a notification is added and DND is OFF it shows the newest as a
  // toast (tap to acknowledge → clears the app's badge). Pure island: reads the
  // shared NOTIF + DND stores, no external props. Same transient logic + timings.
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
  import { createStoreValue } from "./store";

  const SHOW_MS = 4200;

  const notifStore = createStoreValue<Notif[]>(NOTIF_KEY, []);
  const settingsStore = createStoreValue<unknown>(SETTINGS_KEY, {});

  let notifs = $state<Notif[]>([]);
  let settingsRaw = $state<unknown>({});
  let banner = $state<Notif | null>(null);

  // Transient, non-reactive mirrors of the React refs (prev list + timer id).
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
  const dnd = $derived(dndActive(normalizeQuick(settingsRaw)));

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
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

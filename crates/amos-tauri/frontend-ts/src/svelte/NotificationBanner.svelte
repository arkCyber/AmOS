<script lang="ts">
  // NotificationBanner.svelte — Svelte 5 (runes) port of the React
  // NotificationBanner chrome island. Mounted once in the phone frame, over every
  // screen; when a notification is added and DND is OFF it shows the newest as a
  // toast (tap to acknowledge → clears the app's badge) and plays the arrival
  // alert — the synthesized chime (`lib/notifyTone`) and/or a haptic pulse —
  // gated by the effective sound policy (`lib/sound`: persisted bits × DND).
  // Pure island: reads the shared NOTIF + DND + SOUND stores, no external props.
  // Same transient logic + timings.
  import { writeStoreValueChecked } from "../lib/amosStore";
  import { deleteDeliveriesOnDevice } from "../lib/pushNotifications";
  import {
    NOTIF_KEY,
    SETTINGS_KEY,
    dndActive,
    droppedAppNotifs,
    newestAddedNotif,
    normalizeNotifs,
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
  import { NOTIF_BANNER_SHOW_MS } from "../lib/desktopLayout";
  import { createStoreValue } from "./store";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { t } from "./locale.svelte";

  /** 自动消失时长（ms）—— G-γ 起从 `lib/desktopLayout.ts` 取，与桌面 banner 同源。
   * 仓内仅 desktopLayout.ts 持有一份字面值；其他位置都 import 这个常量
   * （`desktop-notification-banner.svelte.test.ts` 的负控 #1 钉此）。 */
  const SHOW_MS = NOTIF_BANNER_SHOW_MS;
  /** Haptic pulse length (ms) for one arriving notification. */
  const HAPTIC_MS = 30;

  const notifStore = createStoreValue<unknown>(NOTIF_KEY, []);
  const settingsStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  const soundStore = createStoreValue<unknown>(SOUND_KEY, {});

  let notifs = $state<Notif[]>([]);
  let settingsRaw = $state<unknown>({});
  let soundRaw = $state<unknown>({});
  let banner = $state<Notif | null>(null);
  // The store's answer to the last acknowledge, when it was a refusal.
  let storeErr = $state("");

  // Transient, non-reactive mirrors of the local refs (prev list + timer id).
  let prev: Notif[] = [];
  let timer: number | null = null;
  // Seed `prev` from the FIRST store read so pre-existing notifications at mount
  // are not mistaken for "just arrived" (mirrors React prev=notifs initialisation).
  let seeded = false;

  $effect(() => {
    const un = notifStore.subscribe((v) => {
      const list = normalizeNotifs(v);
      if (!seeded) {
        seeded = true;
        prev = list;
      }
      notifs = list;
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
      storeErr = ""; // a new arrival replaces the toast: the old refusal's line goes with it
      timer = window.setTimeout(() => {
        banner = null;
        timer = null;
      }, SHOW_MS);
    }
    // Audible/haptic arrival alert, gated by the *effective* policy. The gate's fact is
    // **this arrival** (`added`, an id absent from `prev`) — not how much longer the list
    // got. `amos.notifications` is capped, so at the cap a delivery that really landed
    // leaves the list the same length, and the old `prev.length`/`notifs.length` pair read
    // that as "nothing arrived" and stopped alerting altogether (REQ-A1636). A dismissal /
    // clear, or a re-read of a list that only shrank or stayed put, is still not an arrival —
    // `newestAddedNotif` answers `null` and the gate stays shut. The chime honors the user's
    // loudness (REQ-A205); under DND the effective gate never rings.
    const arrived = added !== null;
    if (shouldRingOnArrival(arrived, policy)) playNotifyTone({ volume: policy.volume });
    if (shouldVibrateOnArrival(arrived, policy)) haptic();
    prev = notifs;
  });

  // Acknowledge: mark the banner's app notifications as read and dismiss.
  //
  // Acknowledging is a **removal**, and `amos.notifications` is a projection of the device's
  // push history — `osPushWatcher` re-asks `push_get_history` every few seconds and writes back
  // anything the store no longer holds. So the push rows among the ones being dropped must also
  // go on the device. Left local, the id disappears from the store and comes straight back on
  // the next poll, which the arrival detector reads as a **new** delivery: the same toast, the
  // same chime (`shouldRingOnArrival` only asks whether the list grew) and the same haptic, for
  // a delivery that never happened twice. The two centres' `dismiss` has relayed since
  // REQ-A1202; this is the same removal with the same obligation (REQ-A1260).
  const ack = () => {
    const b = banner;
    if (!b) return;
    if (b.app) {
      // Snapshot the rows about to be dropped **before** the write: a successful write
      // dispatches `STORE_CHANGED_EVENT`, whose listener sets `notifs` to the new list
      // synchronously — reading it after would name the survivors, not the dropped rows.
      const dropped = droppedAppNotifs(notifs, b.app);
      // The local write is the one whose answer we can read, and the one the ✓ claims
      // happened: a refused write leaves every row in place, so the toast must **not**
      // vanish as if the acknowledge had landed. Report it and stay put — the row is still
      // there, the user can press ✓ again. The device half goes after, so a refusal never
      // deletes from the device the rows the store still holds (REQ-A1408 ∕ F-SH-666).
      if (!writeStoreValueChecked(NOTIF_KEY, removeAppNotifs(notifs, b.app))) {
        storeErr = t("common.storeWriteFailed");
        clearTimer(); // the auto-hide would otherwise swallow the sentence
        return;
      }
      deleteDeliveriesOnDevice(dropped);
    }
    storeErr = "";
    banner = null;
    clearTimer();
  };
</script>

{#if banner}
  <!-- role="alert" makes the wrapper a live region (aria-live=assertive + aria-atomic=true):
       a notification arriving is the canonical "interrupt me" event — a polite nudge would
       be lost while the user is focused on a typing task. (REQ-A284) -->
  <div role="alert" class="absolute inset-x-3 top-[46px] z-[70]">
  <button
    onclick={ack}
    aria-label={t("a11y.acknowledgeNotification")}
    data-testid="notif-ack"
    class="flex w-full items-start gap-3 rounded-2xl bg-white/90 px-3 py-2.5 text-left shadow-lg ring-1 ring-black/10 backdrop-blur-md dark:bg-neutral-900/90 dark:ring-white/10"
  >
    <span class="text-xl leading-none" aria-hidden="true">{banner.icon ?? "🔔"}</span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-xs font-semibold text-neutral-900 dark:text-white">
        {banner.app ?? banner.title ?? t("nc.untitled")}
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
  <StoreErrorBar message={storeErr} />
  </div>
{/if}

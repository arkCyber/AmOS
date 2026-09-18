<script lang="ts">
  // NotificationsPage.svelte — 「通知」sub page. Real controls backed by the shared
  // quick-settings + notification stores: a Do-Not-Disturb switch (lib/settings
  // dnd, persisted under amos.settings — same policy the shell honours) plus a
  // read-only view of the current notifications with a clear-all action.
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
  import { bridged } from "../../lib/backend";
  import { dropPushNotifs } from "../../lib/pushNotifBridge";
  import {
    clearNotificationHistory,
    getPushStatus,
    requestPushPermission,
    simulateReceivePush,
    type RustPushStatus,
  } from "../../lib/pushNotifications";
  import {
    NOTIF_KEY,
    SETTINGS_KEY,
    dndActive,
    flipQuick,
    normalizeNotifs,
    normalizeQuick,
    type Notif,
    type QuickSettings,
  } from "../../lib/settings";
  import { t } from "../locale.svelte";
  import { GROUP, LABEL, HINT } from "./kit";
  import ToggleRow from "./ToggleRow.svelte";

  const readQuick = (): QuickSettings => normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {}));
  let qs = $state<QuickSettings>(readQuick());
  const dnd = $derived(dndActive(qs));
  const toggleDnd = () => {
    const next = flipQuick(qs, "dnd");
    qs = next;
    writeStoreValue(SETTINGS_KEY, next);
  };

  const initNotifs = normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, []));
  let notifs = $state<Notif[]>(initNotifs);
  const clearAll = () => {
    notifs = [];
    writeStoreValue(NOTIF_KEY, []);
  };

  // ── Push backend (REQ-A383) ────────────────────────────────────────────────
  // The device's own view of remote notifications. `null` = not asked yet; the page
  // never invents a status, and `PushStatus.available` is the Rust side's honest
  // answer for platforms with no push support.
  let pushStatus = $state<RustPushStatus | null>(null);
  let pushBusy = $state(false);
  /** The host could not be asked at all (no bridge / offline) — a different fact
   *  from "the backend says it is unavailable". */
  let pushOffline = $state(false);

  const loadPush = async () => {
    if (!bridged()) {
      pushOffline = true;
      return;
    }
    pushStatus = await getPushStatus();
    pushOffline = false;
  };

  // One read on mount (same one-shot guard the Notification Center uses for its
  // device reads): a retry is an explicit user action, not an effect loop.
  let pushRead = false;
  $effect(() => {
    if (pushRead) return;
    pushRead = true;
    void loadPush();
  });

  const askPermission = async () => {
    pushBusy = true;
    await requestPushPermission();
    await loadPush();
    pushBusy = false;
  };

  const clearPushHistory = async () => {
    if (!confirm(t("pushSettings.confirmClearAll"))) return;
    await clearNotificationHistory();
    // Local half of the clear: the list must not keep showing what the device no
    // longer has. (The shell's own notifications stay — they are not push's to wipe.)
    notifs = dropPushNotifs(notifs);
    writeStoreValue(NOTIF_KEY, notifs);
    await loadPush();
  };

  /** Dev-only: proves the whole path (payload → Rust history → the shell's list). */
  const sendTestPush = async () => {
    await simulateReceivePush({
      aps: { alert: { title: t("pushSettings.sendTest"), body: "AmOS" } },
    });
    await loadPush();
  };

  const isDev = import.meta.env.DEV;
  const permissionText = $derived(
    pushStatus?.permission === "authorized" || pushStatus?.permission === "provisional"
      ? t("pushPermission.successDescription")
      : pushStatus?.permission === "denied"
        ? t("pushPermission.denied")
        : t("pushPermission.description"),
  );
  const stats = $derived(
    pushStatus === null
      ? []
      : [
          { label: t("pushSettings.totalReceived"), value: pushStatus.statistics.total_received },
          { label: t("pushSettings.withBadge"), value: pushStatus.statistics.with_badge },
          { label: t("pushSettings.withSound"), value: pushStatus.statistics.with_sound },
          { label: t("pushSettings.silent"), value: pushStatus.statistics.silent },
        ],
  );

</script>

<div class="space-y-5">
  <section class={GROUP}>
    <ToggleRow label={t("settings.dnd")} on={dnd} ontoggle={toggleDnd} />
    <div class="px-4 pb-3">
      <p class={HINT}>{dnd ? t("settings.dndOn") : t("settings.dndOff")}</p>
    </div>
  </section>

  <section class={GROUP} data-testid="push-settings">
    <div class="px-4 py-3">
      <p class={LABEL}>{t("pushPermission.title")}</p>
      {#if pushStatus === null}
        <p class="mt-1 {HINT}">
          {pushOffline ? t("pushSettings.unavailable") : t("pushSettings.loading")}
        </p>
        {#if pushOffline}
          <button
            onclick={() => void loadPush()}
            class="mt-2 rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 dark:bg-white/10"
          >
            {t("pushSettings.retry")}
          </button>
        {/if}
      {:else if !pushStatus.available}
        <!-- The Rust side answers `available: false` on platforms with no push
             backend; the page says so instead of showing controls that cannot work. -->
        <p class="mt-1 {HINT}">{t("pushSettings.unavailable")}</p>
      {:else}
        <p class="mt-1 {HINT}">{permissionText}</p>
        {#if pushStatus.permission === "denied"}
          <p class="mt-1 {HINT}">{t("pushPermission.deniedHint")}</p>
        {/if}
      {/if}
    </div>

    {#if pushStatus?.available}
      {#if pushStatus.permission === "notdetermined"}
        <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
          <button
            onclick={() => void askPermission()}
            disabled={pushBusy}
            class="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white transition active:scale-95 disabled:opacity-50"
          >
            {pushBusy ? t("pushPermission.requesting") : t("pushPermission.request")}
          </button>
        </div>
      {/if}

      <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
        <p class={LABEL}>{t("pushSettings.deviceToken")}</p>
        <p class="mt-1 break-all font-mono text-xs opacity-70">
          {pushStatus.device_token?.token ?? t("pushSettings.noToken")}
        </p>
        {#if pushStatus.device_token}
          <p class="mt-1 text-xs opacity-60">
            {t("pushSettings.environment")}:
            {pushStatus.device_token.environment === "production"
              ? t("pushSettings.envProduction")
              : t("pushSettings.envDevelopment")}
            · {t("pushSettings.registeredAt")} {pushStatus.device_token.registered_at}
          </p>
        {/if}
      </div>

      <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
        <p class={LABEL}>{t("pushSettings.statistics")}</p>
        <div class="mt-1 grid grid-cols-2 gap-x-4 gap-y-2">
          {#each stats as s (s.label)}
            <p class="text-sm">
              <span class="opacity-60">{s.label}</span>
              <span class="font-medium">{s.value}</span>
            </p>
          {/each}
        </div>
      </div>

      <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
        <p class={LABEL}>{t("pushSettings.lastReceived")}</p>
        <p class="mt-1 text-xs opacity-70">
          {pushStatus.statistics.last_received ?? t("pushSettings.never")}
        </p>
      </div>

      <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
        <button
          onclick={() => void clearPushHistory()}
          class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 dark:bg-white/10"
        >
          {t("pushSettings.clearAll")}
        </button>
      </div>

      {#if isDev}
        <div class="border-t border-black/5 px-4 py-3 dark:border-white/10">
          <button
            onclick={() => void sendTestPush()}
            class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 dark:bg-white/10"
          >
            {t("pushSettings.sendTest")}
          </button>
        </div>
      {/if}
    {/if}
  </section>

  <section class={GROUP}>
    <div class="flex items-center justify-between gap-2 px-4 py-3">
      <span class={LABEL}>{t("settings.notifList")}</span>
      <button
        onclick={clearAll}
        disabled={notifs.length === 0}
        class="rounded-full bg-black/5 px-3 py-1 text-xs opacity-70 active:scale-95 disabled:opacity-40 dark:bg-white/10"
      >
        {t("settings.notifClear")}
      </button>
    </div>
    {#if notifs.length === 0}
      <div class="px-4 pb-4">
        <p class={HINT}>{t("settings.notifEmpty")}</p>
      </div>
    {:else}
      <ul class="border-t border-black/5 dark:border-white/10">
        {#each notifs.slice(0, 10) as n (n.id)}
          <li class="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
            <div class="min-w-0">
              <p class="truncate font-medium">{n.app ?? ""}</p>
              {#if n.title}
                <p class="truncate opacity-80">{n.title}</p>
              {/if}
              {#if n.body}
                <p class="truncate text-xs opacity-50">{n.body}</p>
              {/if}
            </div>
            <span class="shrink-0 text-xs opacity-50">
              {new Date(n.time).toLocaleTimeString()}
            </span>
          </li>
        {/each}
      </ul>
      {#if notifs.length > 10}
        <p class="border-t border-black/5 px-4 py-2 text-xs opacity-50 dark:border-white/10">
          {t("settings.notifMore", { n: String(notifs.length - 10) })}
        </p>
      {/if}
    {/if}
  </section>
</div>

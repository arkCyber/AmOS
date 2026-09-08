<script lang="ts">
  // NotificationsPage.svelte — 「通知」sub page. Real controls backed by the shared
  // quick-settings + notification stores: a Do-Not-Disturb switch (lib/settings
  // dnd, persisted under amos.settings — same policy the shell honours) plus a
  // read-only view of the current notifications with a clear-all action.
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
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
  import { GROUP, ROW, LABEL, HINT } from "./kit";
  import Switch from "./Switch.svelte";

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
</script>

<div class="space-y-5">
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.dnd")}</span>
      <Switch on={dnd} aria={t("settings.dnd")} ontoggle={toggleDnd} />
    </div>
    <div class="px-4 pb-3">
      <p class={HINT}>{dnd ? t("settings.dndOn") : t("settings.dndOff")}</p>
    </div>
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

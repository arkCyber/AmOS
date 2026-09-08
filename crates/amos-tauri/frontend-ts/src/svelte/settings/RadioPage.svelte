<script lang="ts">
  // RadioPage.svelte — Wi‑Fi / 蓝牙 sub page of the iOS-style Settings. Renders a
  // master switch row bound to the shared quick-settings radio bits (same store +
  // policy as the control center, see lib/settings.ts flipRadio / airplane gating).
  import { t } from "../locale.svelte";
  import type { QuickSettings, RadioKey } from "../../lib/settings";
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
  import {
    WIFI_KEY,
    NEIGHBORHOOD,
    connectOpenOrSaved,
    forgetNetwork,
    normalizeWifi,
    signalBars,
    sortNetworks,
    type WifiCfg,
  } from "../../lib/wifi";
  import { GROUP, ROW, LABEL, SUB, HINT } from "./kit";
  import Switch from "./Switch.svelte";

  let {
    which,
    qs,
    onToggle,
  }: { which: "wifi" | "bluetooth"; qs: QuickSettings; onToggle: (k: RadioKey) => void } = $props();

  const title = $derived(which === "wifi" ? t("settings.wifi") : t("settings.bluetooth"));
  const on = $derived(which === "wifi" ? !!qs.wifi : !!qs.bluetooth);

  // Wi‑Fi neighbourhood view (iOS-style). Honest: there is no real radio yet, so
  // this is a deterministic demo list; a device scan bridge would feed the same
  // shape. Only open / already-current networks can be "joined" (never a faked
  // passworded join).
  let cfg = $state<WifiCfg>(normalizeWifi(readStoreValue<unknown>(WIFI_KEY, undefined)));
  let scanning = $state(false);
  const saveCfg = (next: WifiCfg) => {
    cfg = next;
    writeStoreValue(WIFI_KEY, next);
  };
  const runScan = () => {
    scanning = true;
    window.setTimeout(() => {
      scanning = false;
    }, 700);
  };
  const sorted = $derived.by(() =>
    sortNetworks(NEIGHBORHOOD, cfg.current, cfg.saved),
  );
</script>

<div class="space-y-5">
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{title}</span>
      <Switch on={on} disabled={qs.airplane} aria={title} ontoggle={() => onToggle(which)} />
    </div>
    {#if qs.airplane}
      <div class={SUB}></div>
      <div class="px-4 py-3">
        <p class={HINT}>{t("settings.airplaneBlocks")}</p>
      </div>
    {:else}
      <div class={SUB}></div>
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        <span class={LABEL}>{t("settings.currentNetwork")}</span>
        <span class="truncate text-[15px] opacity-60">{which === "wifi" && on && cfg.current ? cfg.current : on ? t("settings.on") : t("settings.off")}</span>
      </div>
    {/if}
  </section>

  {#if which === "wifi" && on && !qs.airplane}
    <section class={GROUP}>
      <div class="flex items-center justify-between gap-2 px-4 py-2">
        <span class="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">{t("settings.wifiNearby")}</span>
        <button
          onclick={runScan}
          disabled={scanning}
          aria-label={t("settings.wifiScan")}
          class="rounded-full px-2 py-0.5 text-xs text-accent disabled:opacity-40"
        >{scanning ? "…" : t("settings.wifiScan")}</button>
      </div>
      <div class={SUB}></div>
      {#if cfg.current}
        <div class="flex items-center justify-between gap-3 px-4 py-3">
          <span class="flex items-center gap-2">
            <span class="truncate text-[15px] text-neutral-800 dark:text-neutral-100">{cfg.current}</span>
            <span class="shrink-0 text-xs opacity-50">{t("settings.wifiConnected")}</span>
          </span>
          <span aria-hidden="true" class="shrink-0 text-accent">✓</span>
        </div>
        <div class={SUB}></div>
        <button
          onclick={() => cfg.current && saveCfg(forgetNetwork(cfg, cfg.current))}
          aria-label={t("settings.wifiForget")}
          class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-[15px] text-danger"
        >{t("settings.wifiForget")}</button>
      {/if}
      {#each sorted as net (net.ssid)}
        {#if net.ssid !== cfg.current}
          <div class={SUB}></div>
          <button
            onclick={() => {
              // Only an open network (or the already-current one) joins here; a
              // secure new AP is disabled because it would need a password + real
              // radio (never silently faked).
              if (!net.secure || net.ssid === cfg.current)
                saveCfg(connectOpenOrSaved(cfg, NEIGHBORHOOD, net.ssid));
            }}
            disabled={net.secure && net.ssid !== cfg.current}
            aria-label={net.ssid}
            class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left disabled:opacity-40"
          >
            <span class="flex min-w-0 items-center gap-2">
              <span class="truncate text-[15px] text-neutral-800 dark:text-neutral-100">{net.ssid}</span>
              {#if net.secure}<span class="text-xs" aria-hidden="true">🔒</span>{/if}
            </span>
            <span class="flex shrink-0 items-end gap-0.5" aria-hidden="true">
              {#each [1, 2, 3] as i (i)}
                <span
                  class="w-0.5 rounded-sm {i <= signalBars(net.signal) ? 'bg-accent' : 'bg-black/20 dark:bg-white/20'}"
                  style:height={`${5 + i * 3}px`}
                ></span>
              {/each}
            </span>
          </button>
        {/if}
      {/each}
      <div class={SUB}></div>
      <div class="px-4 py-2">
        <p class={HINT}>{t("settings.wifiSimNote")}</p>
      </div>
    </section>
  {/if}

  <section class={GROUP}>
    <div class="px-4 py-3">
      <p class={HINT}>{on ? t("settings.radioOnDesc") : t("settings.radioOffDesc")}</p>
    </div>
  </section>
</div>

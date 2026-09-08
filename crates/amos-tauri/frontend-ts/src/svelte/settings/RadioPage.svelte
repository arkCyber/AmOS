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
    autoRejoin,
    connectOpenOrSaved,
    connectWithPassword,
    forgetNetwork,
    hasPassword,
    normalizeWifi,
    signalBars,
    sortNetworks,
    type WifiCfg,
  } from "../../lib/wifi";
  import {
    BT_KEY,
    DEMO_DEVICES,
    btGlyph,
    normalizeBt,
    setDiscoverable,
    type BtCfg,
  } from "../../lib/bluetooth";
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

  // ---- remembered-password / auto-rejoin ----
  // Auto-reconnect the strongest remembered (open or passworded) network when the
  // page opens with Wi‑Fi on and nothing connected yet — iOS behaviour.
  $effect(() => {
    if (which === "wifi" && on && !qs.airplane) {
      const next = autoRejoin(cfg, NEIGHBORHOOD);
      if (next.current !== cfg.current) saveCfg(next);
    }
  });

  // Password entry for a secure network we haven't joined before.
  let pwFor = $state<string | null>(null);
  let pwVal = $state("");
  const joinNet = (net: { ssid: string; secure: boolean }) => {
    if (net.ssid === cfg.current) return;
    if (net.secure) {
      if (hasPassword(cfg, net.ssid)) {
        saveCfg(connectOpenOrSaved(cfg, NEIGHBORHOOD, net.ssid));
      } else {
        pwFor = net.ssid;
        pwVal = "";
      }
    } else {
      saveCfg(connectOpenOrSaved(cfg, NEIGHBORHOOD, net.ssid));
    }
  };
  const submitPassword = () => {
    if (pwFor) saveCfg(connectWithPassword(cfg, NEIGHBORHOOD, pwFor, pwVal));
    pwFor = null;
    pwVal = "";
  };

  // ---- Bluetooth "this device + discoverable" config (same RadioPage) ----
  let btCfg = $state<BtCfg>(normalizeBt(readStoreValue<unknown>(BT_KEY, undefined)));
  const saveBt = (next: BtCfg) => {
    btCfg = next;
    writeStoreValue(BT_KEY, next);
  };
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
      {#if which === "wifi"}
        <div class={SUB}></div>
        <div class="flex items-center justify-between gap-3 px-4 py-3">
          <span class={LABEL}>{t("settings.currentNetwork")}</span>
          <span class="truncate text-[15px] opacity-60">{which === "wifi" && on && cfg.current ? cfg.current : on ? t("settings.on") : t("settings.off")}</span>
        </div>
      {/if}
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
            onclick={() => joinNet(net)}
            aria-label={net.ssid}
            class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left disabled:opacity-40"
          >
            <span class="flex min-w-0 items-center gap-2">
              <span class="truncate text-[15px] text-neutral-800 dark:text-neutral-100">{net.ssid}</span>
              {#if net.secure}
                <span class="shrink-0 text-xs" aria-hidden="true">🔒</span>
              {/if}
              {#if net.secure && !hasPassword(cfg, net.ssid)}
                <span class="shrink-0 text-[11px] opacity-50">{t("settings.wifiNeedsPw")}</span>
              {/if}
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
      {#if pwFor}
        <div class={SUB}></div>
        <div class="space-y-2 px-4 py-3">
          <p class="text-sm font-medium text-neutral-800 dark:text-neutral-100">
            {t("settings.wifiPwFor", { net: pwFor })}
          </p>
          <input
            type="password"
            bind:value={pwVal}
            onkeydown={(e) => {
              if (e.key === "Enter") submitPassword();
            }}
            placeholder={t("settings.wifiPassword")}
            aria-label={t("settings.wifiPassword")}
            class="w-full rounded-lg bg-black/5 px-2.5 py-1.5 text-sm outline-none dark:bg-white/10"
          />
          <div class="flex gap-2">
            <button onclick={() => { pwFor = null; pwVal = ""; }} aria-label={t("settings.wifiCancel")} class="flex-1 rounded-lg bg-black/5 px-3 py-1.5 text-sm text-neutral-700 dark:bg-white/10 dark:text-neutral-200">{t("settings.wifiCancel")}</button>
            <button onclick={submitPassword} aria-label={t("settings.wifiConnect")} class="flex-1 rounded-lg bg-accent px-3 py-1.5 text-sm text-white">{t("settings.wifiConnect")}</button>
          </div>
        </div>
      {/if}
      <div class={SUB}></div>
      <div class="px-4 py-2">
        <p class={HINT}>{t("settings.wifiSimNote")}</p>
      </div>
    </section>
  {/if}

  {#if which === "bluetooth" && on && !qs.airplane}
    <section class={GROUP}>
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        <span class={LABEL}>{t("settings.btDeviceName")}</span>
        <span class="truncate text-[15px] opacity-60">{btCfg.name}</span>
      </div>
      <div class={SUB}></div>
      <div class={ROW}>
        <span class={LABEL}>{t("settings.btDiscoverable")}</span>
        <Switch
          on={btCfg.discoverable}
          aria={t("settings.btDiscoverable")}
          ontoggle={() => saveBt(setDiscoverable(btCfg, !btCfg.discoverable))}
        />
      </div>
      <div class={SUB}></div>
      <div class="px-4 py-2">
        <p class={HINT}>{t("settings.btSimNote")}</p>
      </div>
    </section>

    <section class={GROUP}>
      <div class="px-4 py-2">
        <span class="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">{t("settings.btNearby")}</span>
      </div>
      <div class={SUB}></div>
      {#each DEMO_DEVICES as dev (dev.id)}
        <div class="flex items-center justify-between gap-3 px-4 py-3">
          <span class="flex items-center gap-2">
            <span aria-hidden="true" class="text-base">{btGlyph(dev.kind)}</span>
            <span class="truncate text-[15px] text-neutral-800 dark:text-neutral-100">{dev.name}</span>
          </span>
          <span class="shrink-0 text-xs opacity-50">{t("settings.btNotPaired")}</span>
        </div>
        {#if dev.id !== DEMO_DEVICES[DEMO_DEVICES.length - 1]?.id}
          <div class={SUB}></div>
        {/if}
      {/each}
    </section>
  {/if}

  <section class={GROUP}>
    <div class="px-4 py-3">
      <p class={HINT}>{on ? t("settings.radioOnDesc") : t("settings.radioOffDesc")}</p>
    </div>
  </section>
</div>

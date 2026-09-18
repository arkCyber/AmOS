<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from './locale.svelte';
  import { iconSvg } from '../lib/sysIcons';
  import {
    connect,
    disconnect,
    discoverDevices,
    getDevices,
    getStatus,
    isAirPlayAvailable,
    setVolume,
    stopDiscovery,
  } from '../lib/airplay';
  import type { AirPlayDevice, AirPlayStatus } from '../lib/airplay';

  let available = $state(false);
  let devices = $state<AirPlayDevice[]>([]);
  let status = $state<AirPlayStatus | null>(null);
  let discovering = $state(false);
  let connecting = $state(false);
  let selectedDeviceId = $state<string | null>(null);

  let refreshInterval: number | null = null;

  onMount(async () => {
    available = await isAirPlayAvailable();
    if (available) {
      await loadStatus();
      await startDiscovery();
      // Refresh device list and status every 3 seconds
      refreshInterval = window.setInterval(async () => {
        await loadDevices();
        await loadStatus();
      }, 3000);
    }
  });

  onDestroy(() => {
    if (refreshInterval !== null) {
      window.clearInterval(refreshInterval);
    }
    if (discovering) {
      stopDiscovery();
    }
  });

  async function loadDevices() {
    devices = await getDevices();
  }

  async function loadStatus() {
    status = await getStatus();
  }

  async function startDiscovery() {
    discovering = true;
    const result = await discoverDevices();
    if (result.kind === 'ok') {
      await loadDevices();
    }
  }

  async function handleConnect(deviceId: string) {
    connecting = true;
    selectedDeviceId = deviceId;
    const result = await connect(deviceId);
    connecting = false;
    if (result.kind === 'ok') {
      await loadStatus();
      await loadDevices();
    } else {
      console.error('Failed to connect:', result);
    }
  }

  async function handleDisconnect() {
    connecting = true;
    const result = await disconnect();
    connecting = false;
    if (result.kind === 'ok') {
      await loadStatus();
      await loadDevices();
    }
  }

  async function handleVolumeChange(e: Event) {
    const target = e.target as HTMLInputElement;
    const volume = parseFloat(target.value);
    await setVolume(volume);
  }

  function getDeviceKindLabel(kind: string): string {
    return t(`airplay.deviceKind.${kind}`);
  }
</script>

<div class="airplay-panel rounded-2xl bg-slate-800/95 p-4 backdrop-blur-xl">
  {#if !available}
    <div class="text-center text-slate-400 text-sm py-8">
      <div class="mb-2">{@html iconSvg('airplay', 'h-8 w-8 mx-auto opacity-40')}</div>
      <div>{t('airplay.unavailable')}</div>
    </div>
  {:else}
    <div class="mb-3 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <div>{@html iconSvg('airplay', 'h-5 w-5 text-sky-400')}</div>
        <h3 class="text-sm font-medium text-slate-100">{t('airplay.title')}</h3>
      </div>
      {#if status?.active}
        <div class="flex items-center gap-1 text-xs text-sky-400">
          <div class="h-2 w-2 rounded-full bg-sky-400 animate-pulse"></div>
          <span>{t('airplay.streaming')}</span>
        </div>
      {/if}
    </div>

    {#if status?.active && status.device}
      <!-- Connected device card -->
      <div class="mb-3 rounded-xl bg-sky-500/20 border border-sky-500/30 p-3">
        <div class="flex items-center justify-between mb-2">
          <div class="flex-1">
            <div class="text-sm font-medium text-slate-100">{status.device.name}</div>
            <div class="text-xs text-slate-400">{getDeviceKindLabel(status.device.kind)}</div>
          </div>
          <button
            onclick={handleDisconnect}
            disabled={connecting}
            class="rounded-lg bg-slate-700/80 hover:bg-slate-600 px-3 py-1.5 text-xs font-medium text-slate-100 transition disabled:opacity-50"
          >
            {connecting ? t('airplay.disconnecting') : t('airplay.disconnect')}
          </button>
        </div>

        <!-- Volume control -->
        {#if status.device.supports_audio}
          <div class="mt-3 flex items-center gap-2">
            <div>{@html iconSvg('volume', 'h-4 w-4 text-slate-400')}</div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={status.volume}
              oninput={handleVolumeChange}
              class="flex-1 h-1.5 rounded-full bg-slate-700 accent-sky-400"
            />
            <span class="text-xs text-slate-400 w-10 text-right">{Math.round(status.volume * 100)}%</span>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Device list -->
    <div class="space-y-2 max-h-64 overflow-y-auto">
      {#if discovering && devices.length === 0}
        <div class="text-center text-slate-400 text-sm py-4">
          <div class="animate-spin mb-2">{@html iconSvg('rotateCcw', 'h-5 w-5 mx-auto')}</div>
          <div>{t('airplay.searching')}</div>
        </div>
      {:else if devices.length === 0}
        <div class="text-center text-slate-400 text-sm py-4">
          {t('airplay.noDevices')}
        </div>
      {:else}
        {#each devices as device (device.id)}
          <button
            onclick={() => handleConnect(device.id)}
            disabled={connecting || device.connected}
            class="w-full rounded-lg bg-slate-700/50 hover:bg-slate-700 p-3 text-left transition disabled:opacity-50 border border-transparent hover:border-sky-500/30"
          >
            <div class="flex items-center justify-between">
              <div class="flex-1">
                <div class="text-sm font-medium text-slate-100 flex items-center gap-2">
                  {device.name}
                  {#if device.connected}
                    <span class="text-xs text-sky-400">{t('airplay.connected')}</span>
                  {/if}
                </div>
                <div class="text-xs text-slate-400 mt-0.5">
                  {getDeviceKindLabel(device.kind)}
                  {#if device.signal_strength > 0}
                    · {t('airplay.signalStrength', { strength: device.signal_strength })}
                  {/if}
                </div>
                <div class="flex items-center gap-2 mt-1">
                  {#if device.supports_audio}
                    <span class="text-[10px] text-slate-500 bg-slate-800/50 px-1.5 py-0.5 rounded">
                      {t('airplay.audio')}
                    </span>
                  {/if}
                  {#if device.supports_video}
                    <span class="text-[10px] text-slate-500 bg-slate-800/50 px-1.5 py-0.5 rounded">
                      {t('airplay.video')}
                    </span>
                  {/if}
                  {#if device.supports_mirroring}
                    <span class="text-[10px] text-slate-500 bg-slate-800/50 px-1.5 py-0.5 rounded">
                      {t('airplay.mirroring')}
                    </span>
                  {/if}
                </div>
              </div>
              {#if connecting && selectedDeviceId === device.id}
                <div class="animate-spin">{@html iconSvg('rotateCcw', 'h-4 w-4 text-sky-400')}</div>
              {:else if !device.connected}
                <div class="text-slate-500">›</div>
              {/if}
            </div>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Custom scrollbar for device list */
  .airplay-panel ::-webkit-scrollbar {
    width: 6px;
  }
  .airplay-panel ::-webkit-scrollbar-track {
    background: transparent;
  }
  .airplay-panel ::-webkit-scrollbar-thumb {
    background: rgb(71 85 105 / 0.5);
    border-radius: 3px;
  }
  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .airplay-panel ::-webkit-scrollbar-thumb:hover {
    background: rgb(71 85 105 / 0.7);
  }
  }
</style>

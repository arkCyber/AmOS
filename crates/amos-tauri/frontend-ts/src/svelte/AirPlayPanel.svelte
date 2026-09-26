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
  import type { AirPlayDevice, AirPlayResult, AirPlayStatus } from '../lib/airplay';

  /**
   * `null` = **the host did not answer** (`invoke` resolves `null` for a refused command and
   * never rejects), which is neither "this platform has AirPlay" nor "it does not"
   * (REQ-A1336 / F-SH-602). It used to be a plain `false` because the reader folded the
   * refusal away, so the panel drew the platform-capability sentence for a question nobody
   * answered — and never offered a retry.
   */
  let available = $state<boolean | null>(null);
  /** `null` = the device list could not be read (`[]` = the host answered "none"). */
  let devices = $state<AirPlayDevice[] | null>(null);
  let status = $state<AirPlayStatus | null>(null);
  /**
   * The **last status read** was refused, so `status`'s `null` is 「我没问到」 and not 「没有在
   * 投屏」(REQ-A1497 / F-SH-737). A separate flag because `status === null` is also its value
   * before the first read lands — that is 「还没问」, and drawing the sentence for it would cry
   * wolf on every open. The device list has the same distinction (`devices === null` ⇒
   * `airplay.devicesUnanswered`) but is masked at startup by the `discovering` spinner.
   */
  let statusUnanswered = $state(false);
  let discovering = $state(false);
  let connecting = $state(false);
  let selectedDeviceId = $state<string | null>(null);
  /**
   * The last refusal, in the user's language (REQ-A467). The host refuses operations it has no
   * implementation for (`not_implemented`); the panel used to send those to the console only, so a
   * tap on a device looked like it did nothing at all.
   */
  let error = $state<string | null>(null);

  let refreshInterval: number | null = null;
  /**
   * The host was **told** to discover, so it holds platform discovery state that only
   * `airplay_stop_discovery` releases (REQ-A845 / F-SH-272).
   *
   * `discovering` cannot answer this. It means 「the one-shot request is in flight」 — it is
   * cleared the moment the reply lands (see `startDiscovery`) — so by unmount it is always
   * `false` and the teardown below never ran: `platform_stop_discovery` was left uncalled,
   * and the platform route detector stayed live after the panel closed.
   */
  let discoveryIssued = false;

  /**
   * Ask the host whether AirPlay exists, and start the panel only on a real **yes**.
   *
   * Split out of `onMount` so the unanswered state can offer a retry: a refusal used to be
   * indistinguishable from "no AirPlay here" and the panel had no way back (REQ-A1336).
   * The interval is created at most once, so a retry after a late "yes" does not stack polls.
   */
  async function probe() {
    const answer = await isAirPlayAvailable();
    available = answer;
    if (answer !== true) return;
    await loadStatus();
    // Set before the call, not after: the host may already hold discovery state when a
    // reply never arrives, and the stop is idempotent (the Rust side just clears a flag
    // and tears the platform object down), so the safe polarity is to stop when in doubt.
    discoveryIssued = true;
    await startDiscovery();
    // Refresh device list and status every 3 seconds
    if (refreshInterval === null) {
      refreshInterval = window.setInterval(() => {
        void loadDevices();
        void loadStatus();
      }, 3000);
    }
  }

  onMount(() => {
    void probe();
  });

  onDestroy(() => {
    if (refreshInterval !== null) {
      window.clearInterval(refreshInterval);
    }
    if (discoveryIssued) {
      // The verdict is deliberately dropped: the panel is being destroyed, so there is no
      // surface left to say 「the host refused to stop」 on, and nothing to retry with. The
      // list is in scripts/void-cmd-allowlist.json (`no-visible-claim`).
      void stopDiscovery();
    }
  });

  async function loadDevices() {
    devices = await getDevices();
  }

  async function loadStatus() {
    const answer = await getStatus();
    status = answer;
    statusUnanswered = answer === null;
  }

  /**
   * A refusal has to reach the user as a sentence, not as a console line (REQ-A467). Returns
   * `null` for `ok`, and the localized sentence for every refusal kind — the union is exhaustive,
   * so a new result kind becomes a type error here rather than a silent fall-through.
   *
   * `result === null` is its own arm (REQ-A1336): the host did not answer, which is not the
   * same fact as "the operation failed" — `failed` says the host tried and reported, and only
   * the host can say that.
   */
  function explain(result: AirPlayResult | null): string | null {
    if (result === null) return t('airplay.actionUnanswered');
    switch (result.kind) {
      case 'ok':
        return null;
      case 'not_implemented':
        return t('airplay.controlUnavailable');
      case 'unavailable':
        return t('airplay.unavailable');
      case 'permission_denied':
        return t('airplay.permissionDenied');
      case 'device_not_found':
        return t('airplay.deviceNotFound');
      case 'failed':
        return t('airplay.failed');
    }
  }

  async function startDiscovery() {
    discovering = true;
    const result = await discoverDevices();
    // Discovery is one-shot here: leaving this `true` pinned the "searching…" spinner for the rest
    // of the panel's life whenever the host refused (measured on macOS, where AVRouteDetector
    // answers "requires main thread").
    discovering = false;
    error = explain(result);
    if (result?.kind === 'ok') {
      await loadDevices();
    }
  }

  async function handleConnect(deviceId: string) {
    connecting = true;
    selectedDeviceId = deviceId;
    error = null;
    const result = await connect(deviceId);
    connecting = false;
    if (result?.kind === 'ok') {
      await loadStatus();
      await loadDevices();
    } else {
      error = explain(result);
    }
  }

  async function handleDisconnect() {
    connecting = true;
    error = null;
    const result = await disconnect();
    connecting = false;
    if (result?.kind === 'ok') {
      await loadStatus();
      await loadDevices();
    } else {
      error = explain(result);
    }
  }

  async function handleVolumeChange(e: Event) {
    const target = e.target as HTMLInputElement;
    const volume = parseFloat(target.value);
    error = explain(await setVolume(volume));
  }

  function getDeviceKindLabel(kind: string): string {
    return t(`airplay.deviceKind.${kind}`);
  }
</script>

<div class="airplay-panel rounded-2xl bg-slate-800/95 p-4 backdrop-blur-xl">
  {#if available === null}
    <!-- The host did not answer. Not the platform-capability sentence, and the retry has to
         be here or a single refusal dead-ends the panel for the session (REQ-A1336). -->
    <div class="text-center text-slate-400 text-sm py-8" data-testid="airplay-unanswered">
      <div class="mb-2">{@html iconSvg('airplay', 'h-8 w-8 mx-auto opacity-40')}</div>
      <div>{t('airplay.unavailableUnanswered')}</div>
      <button
        onclick={() => void probe()}
        class="mt-3 rounded-lg bg-slate-700/80 hover:bg-slate-600 px-3 py-1.5 text-xs font-medium text-slate-100 transition"
      >
        {t('airplay.retry')}
      </button>
    </div>
  {:else if !available}
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
      {:else if statusUnanswered}
        <!-- 这一读被拒：`status?.active` 曾把它画成「没有在投屏」，静默地把正在投的会话
             （连同断开、音量）藏掉。宿主答了「没在投屏」时 statusUnanswered 是 false，
             所以这句不会替它说话（REQ-A1497 / F-SH-737）。 -->
        <div class="text-xs text-amber-300" data-testid="airplay-status-unanswered">
          {t('airplay.streamStatusUnanswered')}
        </div>
      {/if}
    </div>

    {#if error}
      <p
        role="status"
        data-testid="airplay-error"
        class="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
      >
        {error}
      </p>
    {/if}

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
      {#if discovering && (devices === null || devices.length === 0)}
        <div class="text-center text-slate-400 text-sm py-4">
          <div class="animate-spin mb-2">{@html iconSvg('rotateCcw', 'h-5 w-5 mx-auto')}</div>
          <div>{t('airplay.searching')}</div>
        </div>
      {:else if devices === null}
        <!-- 「读不出来」不是「没有设备」（REQ-A1336）：后者是宿主答了、列表是空的。 -->
        <div class="text-center text-slate-400 text-sm py-4" data-testid="airplay-devices-unanswered">
          {t('airplay.devicesUnanswered')}
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

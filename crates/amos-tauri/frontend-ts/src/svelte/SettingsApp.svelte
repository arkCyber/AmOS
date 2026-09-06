<script lang="ts">
  // SettingsApp.svelte — Svelte 5 (runes) port of the React Settings screen
  // (src/apps.tsx → `Settings`, rendered by COMPONENTS.settings).
  //
  // STATUS: staged wholesale migration (round 1). This file currently ports the
  // self-contained pure groups: 外观/语言/自动息屏/唤醒 + iCloud 同步 + AI 推理后端
  // + 锁屏密码 (LockSettings). Remaining panels (SensorPanel/SystemPanel/
  // TaskManager/LmkDebugPanel/Wallpaper/LockWallpaper) are appended in later
  // rounds. Not yet wired to apps.tsx; production only switches once all panels
  // are present and parity-tested. Baseline stays green meanwhile.
  //
  // React-only helpers (Segmented / Switch) are reproduced inline as snippets;
  // all persistence reuses the framework-free pure libs.
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import {
    BACKUP_KEY,
    SETTINGS_KEY,
    SYNC_STORES,
    readCloud,
    setCloudPrefs,
    snapshotStores,
    type CloudPrefs,
  } from "../lib/cloud";
  import { AUTOOFF_STORE_KEY, clampAutoOffSec, WAKE_HOME_KEY, wakeHomeEnabled } from "../lib/display";
  import {
    DEEPSEEK_ENDPOINT,
    DEEPSEEK_MODEL,
    readAiConfig,
    setAiConfig,
    type AiProviderId,
  } from "../lib/providers";
  import { describeEngine, type EngineView } from "../lib/aiEngine";
  import { bridged, getAiStatus, switchAiBackend } from "../lib/backend";
  import { LOCK_KEY, makeLock, sanitizePin, type LockCfg } from "../lib/lock";
  import { t, locale, setLocale } from "./locale.svelte";
  import { themeMode, themeDark, setThemeMode } from "./theme.svelte";
  import SensorPanel from "./SensorPanel.svelte";
  import WallpaperCard from "./WallpaperCard.svelte";
  import LockWallpaperCard from "./LockWallpaperCard.svelte";
  import SystemPanel from "./SystemPanel.svelte";
  import TaskManager from "./TaskManager.svelte";
  import LmkDebugPanel from "./LmkDebugPanel.svelte";

  const GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const ROW = "flex items-center justify-between gap-3 px-4 py-3";
  const LABEL = "text-[15px] text-neutral-800 dark:text-neutral-100";
  const SUB = "h-px bg-black/5 dark:bg-white/10";
  const FIELD = "w-full rounded-lg bg-black/5 px-2.5 py-1.5 text-sm outline-none dark:bg-white/10";

  /* ---- General: auto screen-off + wake-home ---- */
  let autoOffStr = $state(
    String(clampAutoOffSec(readStoreValue<unknown>(AUTOOFF_STORE_KEY, 0))),
  );
  const pickAutoOff = (v: string) => {
    writeStoreValue(AUTOOFF_STORE_KEY, Number(v));
    autoOffStr = v;
  };
  let wakeHome = $state(wakeHomeEnabled(readStoreValue<unknown>(WAKE_HOME_KEY, true)));
  const toggleWakeHome = () => {
    wakeHome = !wakeHome;
    writeStoreValue(WAKE_HOME_KEY, wakeHome);
  };

  /* ---- iCloud-style sync ---- */
  let cloud = $state<CloudPrefs>(readCloud(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {})));
  const persistCloud = (partial: Partial<CloudPrefs>) => {
    const cur = readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {});
    writeStoreValue(SETTINGS_KEY, setCloudPrefs(cur, partial));
    cloud = { ...cloud, ...partial };
  };
  const syncNow = () => {
    const stores: Record<string, unknown> = {};
    for (const k of SYNC_STORES) stores[k] = readStoreValue<unknown>(k, []);
    writeStoreValue(BACKUP_KEY, snapshotStores(stores));
    persistCloud({ enabled: cloud.enabled, lastSync: Date.now() });
  };

  /* ---- AI inference backend (local vs cloud DeepSeek) ---- */
  const initialCfg = readAiConfig(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {}));
  let aiEdits = $state({
    provider: initialCfg.provider as AiProviderId,
    model: initialCfg.model ?? DEEPSEEK_MODEL,
    endpoint: initialCfg.endpoint ?? DEEPSEEK_ENDPOINT,
    apiKey: initialCfg.apiKey ?? "",
  });
  let aiMsg = $state("");
  let aiLive = $state<string | null>(null);
  let aiView = $state<EngineView>(describeEngine(null));

  $effect(() => {
    if (!bridged()) return;
    getAiStatus().then((s) => {
      const m = s?.model && s.model.trim() ? s.model : "offline";
      aiLive = m;
      aiView = describeEngine(s);
    });
  });
  const pickProvider = (p: AiProviderId) => (aiEdits.provider = p);
  const saveAi = () => {
    const cur = readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {});
    writeStoreValue(SETTINGS_KEY, setAiConfig(cur, aiEdits));
    if (bridged()) {
      const provider = aiEdits.provider === "deepseek" ? "deepseek" : "local";
      void switchAiBackend(provider, aiEdits.apiKey).then((report) => {
        aiMsg = report ? `${t("settings.aiApplied")}: ${report}` : t("settings.aiSaved");
        getAiStatus().then((s) => {
          const m = s?.model && s.model.trim() ? s.model : "offline";
          aiLive = m;
          aiView = describeEngine(s);
        });
      });
    } else {
      aiMsg = t("settings.aiSaved");
    }
  };

  /* ---- Lock screen passcode (LockSettings) ---- */
  let lockInit = readStoreValue<LockCfg>(LOCK_KEY, { enabled: false });
  let lockCfg = $state<LockCfg>(lockInit);
  let lockOn = $state(lockInit.enabled);
  let lockPin = $state("");
  let lockMsg = $state("");
  $effect(() => {
    const clean = sanitizePin(lockPin);
    if (clean !== lockPin) lockPin = clean;
  });
  const saveLock = () => {
    const next = makeLock(lockOn, lockPin, lockCfg);
    lockCfg = next;
    lockOn = next.enabled;
    writeStoreValue(LOCK_KEY, next);
    lockMsg = lockOn && !next.enabled ? t("lock.pin") : t("lock.saved");
  };
</script>

<div class="space-y-5 p-4">
  {#snippet seg(opts: { value: string; label: string }[], cur: string, onpick: (v: string) => void, aria?: string)}
    <div role="radiogroup" aria-label={aria} class="inline-flex rounded-[9px] bg-neutral-200/70 p-[3px] ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10">
      {#each opts as o}
        <button
          role="radio"
          aria-checked={o.value === cur}
          onclick={() => onpick(o.value)}
          class={"rounded-md px-3.5 py-1.5 text-sm leading-none transition " +
            (o.value === cur
              ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-white dark:shadow-black/40"
              : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white")}
        >
          {o.label}
        </button>
      {/each}
    </div>
  {/snippet}

  {#snippet sw(onv: boolean, ontoggle: () => void, aria?: string)}
    <button
      role="switch"
      aria-checked={onv}
      aria-label={aria}
      onclick={ontoggle}
      class={"h-7 w-[46px] shrink-0 rounded-full p-0.5 transition " +
        (onv ? "bg-green-500" : "bg-neutral-300 dark:bg-neutral-600")}
    >
      <span class={"block h-6 w-6 rounded-full bg-white shadow transition-transform " +
        (onv ? "translate-x-[18px]" : "translate-x-0")}></span>
    </button>
  {/snippet}

  <!-- General -->
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.appearance")}</span>
      {@render seg(
        [
          { value: "light", label: t("theme.light") },
          { value: "dark", label: t("theme.dark") },
          { value: "auto", label: t("theme.auto") },
        ],
        themeMode(),
        (v) => setThemeMode(v as "light" | "dark" | "auto"),
        "appearance",
      )}
    </div>
    <div class={SUB}></div>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.language")}</span>
      {@render seg(
        [
          { value: "zh", label: "中文" },
          { value: "en", label: "English" },
        ],
        locale(),
        (v) => setLocale(v as "zh" | "en"),
        "language",
      )}
    </div>
    <div class={SUB}></div>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.autoOff")}</span>
      {@render seg(
        [
          { value: "0", label: t("settings.autoOffOff") },
          { value: "15", label: t("settings.autoOff15") },
          { value: "30", label: t("settings.autoOff30") },
          { value: "60", label: t("settings.autoOff60") },
        ],
        autoOffStr,
        pickAutoOff,
        "auto-screen-off",
      )}
    </div>
    <div class={SUB}></div>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.wakeHome")}</span>
      {@render sw(wakeHome, toggleWakeHome, t("settings.wakeHome"))}
    </div>
  </section>

  <!-- iCloud-style sync -->
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.icloud")}</span>
      {@render sw(cloud.enabled, () => persistCloud({ enabled: !cloud.enabled }), t("settings.icloud"))}
    </div>
    {#if cloud.enabled}
      <div class={SUB}></div>
      <div class="px-4 py-3">
        <p class="text-xs opacity-70">{t("settings.icloudHint")}</p>
        {#if cloud.lastSync > 0}
          <p class="mt-1 text-xs opacity-60">
            {t("settings.syncedAt", { time: new Date(cloud.lastSync).toLocaleTimeString() })}
          </p>
        {/if}
        <button onclick={syncNow} class="mt-2 rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95">
          {t("settings.syncNow")}
        </button>
      </div>
    {/if}
  </section>
  <!-- AI inference backend -->
  <section class={"p-4 " + GROUP}>
    <div class="flex items-center justify-between gap-2">
      <span class={LABEL}>{t("settings.aiBackend")}</span>
      <div class="flex gap-1.5" role="group" aria-label={t("settings.aiBackend")}>
        <button
          onclick={() => pickProvider("local")}
          aria-pressed={aiEdits.provider === "local"}
          class={"rounded-full px-3 py-1.5 text-xs transition " +
            (aiEdits.provider === "local"
              ? "bg-accent text-white"
              : "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300")}
        >
          {t("settings.aiLocal")}
        </button>
        <button
          onclick={() => pickProvider("deepseek")}
          aria-pressed={aiEdits.provider === "deepseek"}
          class={"rounded-full px-3 py-1.5 text-xs transition " +
            (aiEdits.provider === "deepseek"
              ? "bg-accent text-white"
              : "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300")}
        >
          {t("settings.aiCloud")}
        </button>
      </div>
    </div>
    {#if aiEdits.provider === "deepseek"}
      <div class="mt-3 space-y-2">
        <span class="block text-[11px] opacity-60">{t("settings.aiModel")}</span>
        <input bind:value={aiEdits.model} class={FIELD} />
        <span class="block text-[11px] opacity-60">{t("settings.aiEndpoint")}</span>
        <input bind:value={aiEdits.endpoint} class={FIELD} />
        <span class="block text-[11px] opacity-60">{t("settings.aiKey")}</span>
        <input
          bind:value={aiEdits.apiKey}
          type="password"
          placeholder={aiEdits.apiKey ? "••••••••" : ""}
          class={FIELD}
        />
        <p class="text-[11px] opacity-50">{t("settings.aiKeyHint")}</p>
      </div>
    {/if}
    <div class="mt-3 flex items-center justify-between gap-2">
      <span class="text-[11px] opacity-50">{t("settings.aiNote")}</span>
      <button onclick={saveAi} class="rounded-full bg-accent px-3 py-1.5 text-xs text-white active:scale-95">
        {t("settings.aiSave")}
      </button>
    </div>
    {#if aiMsg}
      <p role="status" class="mt-2 text-[11px] text-accent">{aiMsg}</p>
    {/if}
    <p class="mt-1 text-[11px] opacity-60">{t("settings.aiCurrent", { model: aiLive ?? "—" })}</p>
    {#if aiView.engine}
      <p class="mt-0.5 text-[11px] opacity-70">
        {aiView.engine === "mock"
          ? t("settings.aiMockEngine")
          : t("settings.aiRealEngine", { engine: aiView.engine, model: aiView.engine_model || aiView.engine })}
      </p>
    {/if}
    {#if aiView.asr}
      <p class="text-[11px] opacity-60">{t("settings.aiAsr", { asr: aiView.asr })}</p>
    {/if}
    {#if aiView.accelerator}
      <p class="text-[11px] opacity-60">{t("settings.aiAccel", { accel: aiView.accelerator })}</p>
    {/if}
    {#if aiView.degraded}
      <p role="alert" class="mt-2 rounded-md bg-red-500/15 px-2 py-1 text-[11px] font-medium text-red-700 dark:text-red-300">
        {t("settings.aiDegraded")}
      </p>
    {/if}
    {#if aiView.profile && aiView.profile.decode_runs > 0}
      <div class="mt-2 rounded-md bg-black/5 px-2 py-1.5 text-[11px] opacity-80 dark:bg-white/10">
        <span class="font-medium opacity-70">{t("settings.aiProfile")}</span>
        <span class="ml-2">{t("settings.aiProfileTps", { v: aiView.profile.decode_tokens_per_sec.toFixed(1) })}</span>
        <span class="ml-2">{t("settings.aiProfileTtft", { v: aiView.profile.ttft_ms.toFixed(0) })}</span>
        <span class="ml-2">{t("settings.aiProfileTokens", { v: String(aiView.profile.decode_tokens_total) })}</span>
      </div>
    {/if}
  </section>

  <SensorPanel />
  <SystemPanel />
  <TaskManager />
  <LmkDebugPanel />
  <WallpaperCard />
  <LockWallpaperCard />

  <!-- Lock screen passcode (LockSettings) -->
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("lock.enable")}</span>
      {@render sw(lockOn, () => (lockOn = !lockOn), t("lock.enable"))}
    </div>
    <p class="px-4 pb-3 text-xs opacity-60">
      {lockCfg.enabled ? t("lock.stateOn") : t("lock.stateOff")}
      {lockCfg.pin ? ` ${t("lock.pinSet")}` : ""}
      {lockOn !== lockCfg.enabled || (lockOn && lockPin.trim().length > 0) ? ` · ${t("lock.pin")}` : ""}
    </p>
    {#if lockOn}
      <div class="flex items-center gap-2 border-t border-black/5 px-4 py-3 dark:border-white/10">
        <input
          bind:value={lockPin}
          placeholder={t("lock.pin")}
          inputmode="numeric"
          class={FIELD}
        />
        <button onclick={saveLock} class="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95">
          {t("lock.save")}
        </button>
      </div>
    {/if}
    {#if lockMsg}
      <p class="px-4 pb-3 text-xs opacity-60">{lockMsg}</p>
    {/if}
  </section>
  <p class="px-1 text-xs opacity-50">mode={themeMode()} · dark={String(themeDark())} · locale={locale()}</p>
</div>



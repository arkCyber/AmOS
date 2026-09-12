<script lang="ts">
  // AiPage.svelte — 「AI 与智能」sub page (the old AI-inference-backend group
  // relocated). Lets the user pick local Ollama vs a cloud OpenAI-compatible
  // provider (OpenAI / DeepSeek / custom endpoint) and configure the
  // model/endpoint/API key; shows the live engine state via lib/aiEngine.
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
  import { SETTINGS_KEY } from "../../lib/settings";
  import {
    cloudDefaultEndpoint,
    cloudDefaultModel,
    envFor,
    isCloudProvider,
    readAiConfig,
    setAiConfig,
    type AiConfig,
    type AiProviderId,
  } from "../../lib/providers";
  import { describeEngine, isRealEngine, type EngineView } from "../../lib/aiEngine";
  import { bridged, getAiStatus, switchAiBackend } from "../../lib/backend";
  import {
    clearDiag,
    diagStats,
    recentDiag,
    setDiagMinLevel,
    subscribeDiag,
    type DiagEntry,
    type DiagLevel,
  } from "../../lib/debugLog";
  import { t } from "../locale.svelte";
  import { GROUP, LABEL, FIELD } from "./kit";

  /**
   * Localized circuit-breaker state (REQ-A131). An unknown/empty state is reported
   * as-is rather than mapped to a friendly default: a label we cannot translate must
   * not be silently replaced by "closed", which would hide that the backend is being
   * skipped.
   */
  const breakerStateLabel = (state: string): string => {
    if (state === "closed") return t("settings.aiBreakerClosed");
    if (state === "open") return t("settings.aiBreakerOpen");
    if (state === "half_open") return t("settings.aiBreakerHalfOpen");
    return state;
  };

  /**
   * Localized name of an alert rule (REQ-A133). Unknown ids are shown verbatim: a rule
   * we cannot name must not be hidden behind a generic "problem" label (the daemon's
   * `detail` still carries the numbers).
   */
  const alertRuleLabel = (id: string): string => {
    if (id === "breaker_open") return t("settings.alertBreakerOpen");
    if (id === "engine_degraded") return t("settings.alertEngineDegraded");
    if (id === "log_trail_incomplete") return t("settings.alertLogTrailIncomplete");
    if (id === "generations_rejected") return t("settings.alertGenerationsRejected");
    if (id === "power_throttled") return t("settings.alertPowerThrottled");
    if (id === "dvfs_write_failures") return t("settings.alertDvfsWriteFailures");
    return id;
  };

  const initialCfg = readAiConfig(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {}));
  let aiEdits = $state({
    provider: initialCfg.provider as AiProviderId,
    model:
      initialCfg.model ??
      (isCloudProvider(initialCfg.provider) ? cloudDefaultModel(initialCfg.provider) : ""),
    endpoint:
      initialCfg.endpoint ??
      (isCloudProvider(initialCfg.provider) ? cloudDefaultEndpoint(initialCfg.provider) : ""),
    apiKey: initialCfg.apiKey ?? "",
  });
  let aiMsg = $state("");
  let aiLive = $state<string | null>(null);
  let aiView = $state<EngineView>(describeEngine(null));

  // ---- Client-side diagnostics ledger (audit P1-3) -------------------------------
  // The shell's failures (failed bridge calls, corrupt stores, rejected rules) are
  // recorded in lib/debugLog's bounded ring instead of vanishing into logcat. This
  // block shows the most recent ones *together with what the ring dropped*, so a
  // short list can never be mistaken for "nothing else happened".
  let diagEntries = $state<DiagEntry[]>(recentDiag(5));
  let diagInfo = $state(diagStats());
  const refreshDiag = () => {
    diagEntries = recentDiag(5);
    diagInfo = diagStats();
  };
  $effect(() => subscribeDiag(refreshDiag));
  const onClearDiag = () => {
    clearDiag();
    refreshDiag();
  };
  const isCloud = $derived(isCloudProvider(aiEdits.provider));

  // The env the daemon must be (re)started with for the SELECTED provider.
  // `lib/providers.envFor` is the single owner of that mapping — the launcher
  // (`scripts/ai-backend.sh`) uses it too — so showing it here cannot drift from
  // what actually applies. The API key is shown as a presence marker, never the
  // secret itself.
  const aiEnv = $derived.by(() => {
    const env = envFor({
      provider: aiEdits.provider,
      model: aiEdits.model || undefined,
      endpoint: aiEdits.endpoint || undefined,
      apiKey: aiEdits.apiKey || undefined,
    });
    return Object.entries(env).map(
      ([k, v]) => [k, k === "AMOS_API_KEY" ? "••••" : v] as const,
    );
  });

  // Client-side periodic probe (gap-analysis #33): the daemon heartbeats *itself*,
  // but nobody was asking it on a schedule — this page read the engine once and kept
  // a stale snapshot forever. While the page is open we re-read `ai_status` every
  // 10 s, so a daemon that died, degraded or swapped engines shows up here; a hidden
  // tab stops asking (never a background poll).
  const AI_PROBE_MS = 10_000;
  let lastProbe = $state(0);
  $effect(() => {
    if (!bridged()) return;
    let alive = true;
    const probe = async () => {
      const s = await getAiStatus();
      if (!alive) return;
      const m = s?.model && s.model.trim() ? s.model : "offline";
      aiLive = m;
      aiView = describeEngine(s);
      lastProbe = Date.now();
    };
    void probe();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void probe();
    }, AI_PROBE_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  });
  /** Local wall-clock of the last successful probe ("" before the first one). */
  const probeStamp = $derived.by(() => {
    if (!lastProbe) return "";
    const d = new Date(lastProbe);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  });
  const pickProvider = (p: AiProviderId) => {
    // A key is per-provider and lives only in transient UI state (never in
    // settings). Switching to a *different* provider clears it so we never send
    // one provider's key to another. A previously-saved cloud key still resumes
    // via the 0600 file (~/.amos/ai.key) when that provider is re-applied.
    if (aiEdits.provider !== p) aiEdits.apiKey = "";
    aiEdits.provider = p;
    if (p === "local") return;
    // A preset owns its model + endpoint: adopt its defaults on switch so we
    // never silently keep the previous provider's model/endpoint (e.g. an OpenAI
    // URL sent to Claude). "custom" has no default → cleared, ready to fill.
    aiEdits.model = cloudDefaultModel(p);
    aiEdits.endpoint = cloudDefaultEndpoint(p);
  };
  const PROVIDERS: { id: AiProviderId; labelKey: string }[] = [
    { id: "local", labelKey: "settings.aiLocal" },
    { id: "openai", labelKey: "settings.aiOpenai" },
    { id: "deepseek", labelKey: "settings.aiDeepseek" },
    { id: "moonshot", labelKey: "settings.aiMoonshot" },
    { id: "qwen", labelKey: "settings.aiQwen" },
    { id: "zhipu", labelKey: "settings.aiZhipu" },
    { id: "groq", labelKey: "settings.aiGroq" },
    { id: "mistral", labelKey: "settings.aiMistral" },
    { id: "anthropic", labelKey: "settings.aiAnthropic" },
    { id: "gemini", labelKey: "settings.aiGemini" },
    { id: "custom", labelKey: "settings.aiCustom" },
  ];
  const saveAi = () => {
    // A custom endpoint is required — don't silently send requests nowhere.
    if (aiEdits.provider === "custom" && !aiEdits.endpoint.trim()) {
      aiMsg = t("settings.aiCustomNeedsEndpoint");
      return;
    }
    const cfg: AiConfig = {
      provider: aiEdits.provider,
      model: isCloud && aiEdits.model ? aiEdits.model : undefined,
      endpoint: isCloud && aiEdits.endpoint ? aiEdits.endpoint : undefined,
      apiKey: aiEdits.apiKey,
    };
    const cur = readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {});
    writeStoreValue(SETTINGS_KEY, setAiConfig(cur, cfg));
    if (bridged()) {
      void switchAiBackend(cfg.provider, {
        model: cfg.model,
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey,
      }).then((report) => {
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
</script>

<section class={"p-4 " + GROUP}>
  <div class="flex items-center justify-between gap-2">
    <span class={LABEL}>{t("settings.aiBackend")}</span>
    <div class="flex flex-wrap gap-1.5" role="group" aria-label={t("settings.aiBackend")}>
      {#each PROVIDERS as p (p.id)}
        <button
          onclick={() => pickProvider(p.id)}
          aria-pressed={aiEdits.provider === p.id}
          class={"rounded-full px-3 py-1.5 text-xs transition " +
            (aiEdits.provider === p.id
              ? "bg-accent text-white"
              : "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300")}
        >
          {t(p.labelKey)}
        </button>
      {/each}
    </div>
  </div>
  {#if isCloud}
    <div class="mt-3 space-y-2">
      <span class="block text-[11px] opacity-60">{t("settings.aiModel")}</span>
      <input bind:value={aiEdits.model} class={FIELD} placeholder={t("settings.aiModelPlaceholder")} />
      <span class="block text-[11px] opacity-60">{t("settings.aiEndpoint")}</span>
      <input
        bind:value={aiEdits.endpoint}
        class={FIELD}
        placeholder={aiEdits.provider === "custom" ? t("settings.aiEndpointPlaceholder") : undefined}
      />
      <span class="block text-[11px] opacity-60">{t("settings.aiKey")}</span>
      <input
        bind:value={aiEdits.apiKey}
        type="password"
        placeholder={aiEdits.apiKey ? "••••••••" : ""}
        class={FIELD}
      />
      <p class="text-[11px] opacity-50">{t("settings.aiKeyHint")}</p>
      {#if aiEdits.provider === "custom"}
        <p class="text-[11px] opacity-50">{t("settings.aiCustomHint")}</p>
      {/if}
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
  {#if probeStamp}
    <p data-testid="ai-probe" class="mt-0.5 text-[11px] opacity-40">
      {t("settings.aiProbe", { time: probeStamp })}
    </p>
  {/if}
  {#if aiView.engine}
    <p class="mt-0.5 text-[11px] opacity-70" data-testid="ai-engine-line">
      {!isRealEngine(aiView)
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
  {#if aiView.pool}
    <div class="mt-2 rounded-md bg-black/5 px-2 py-1.5 text-[11px] opacity-80 dark:bg-white/10">
      <span class="font-medium opacity-70">{t("settings.aiGate")}</span>
      <span class="ml-2">{t("settings.aiGateSlots", { busy: String(aiView.pool.in_flight), total: String(aiView.pool.capacity) })}</span>
      {#if aiView.pool.rejected_saturated + aiView.pool.rejected_timeout > 0}
        <span class="ml-2 text-amber-700 dark:text-amber-300">
          {t("settings.aiGateRejected", { n: String(aiView.pool.rejected_saturated + aiView.pool.rejected_timeout) })}
        </span>
      {/if}
    </div>
  {/if}
  {#if aiView.cache}
    <div class="mt-2 rounded-md bg-black/5 px-2 py-1.5 text-[11px] opacity-80 dark:bg-white/10">
      <span class="font-medium opacity-70">{t("settings.aiCache")}</span>
      {#if aiView.cache.enabled}
        <span class="ml-2">{t("settings.aiCacheStats", { hits: String(aiView.cache.hits), misses: String(aiView.cache.misses) })}</span>
      {:else}
        <span class="ml-2 opacity-70">{t("settings.aiCacheOff")}</span>
      {/if}
    </div>
  {/if}
  {#if aiView.breaker}
    <div class="mt-2 rounded-md bg-black/5 px-2 py-1.5 text-[11px] opacity-80 dark:bg-white/10">
      <span class="font-medium opacity-70">{t("settings.aiBreaker")}</span>
      {#if aiView.breaker.enabled}
        <span
          class="ml-2"
          class:text-amber-700={aiView.breaker.state !== "closed"}
          class:dark:text-amber-300={aiView.breaker.state !== "closed"}
          data-testid="ai-breaker-state"
        >{breakerStateLabel(aiView.breaker.state)}</span>
        {#if aiView.breaker.rejections > 0}
          <!-- Calls were *skipped on purpose* while the backend was down: say so,
               instead of letting a short list look like nothing happened. -->
          <span class="ml-2 text-amber-700 dark:text-amber-300" data-testid="ai-breaker-skipped">
            {t("settings.aiBreakerSkipped", { n: String(aiView.breaker.rejections) })}
          </span>
        {/if}
      {:else}
        <span class="ml-2 opacity-70" data-testid="ai-breaker-state">{t("settings.aiBreakerOff")}</span>
      {/if}
    </div>
  {/if}
  {#if aiView.alerts && aiView.alerts.length > 0}
    <div class="mt-2 rounded-md bg-black/5 px-2 py-1.5 text-[11px] opacity-80 dark:bg-white/10">
      <span class="font-medium opacity-70">{t("settings.aiAlerts")}</span>
      <ul data-testid="ai-alerts" class="mt-1 space-y-1">
        {#each aiView.alerts as a (a.id)}
          <li data-testid={`ai-alert-${a.id}`} class={a.severity === "error" ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300"}>
            <span class="font-medium">{alertRuleLabel(a.id)}</span>
            <span class="opacity-80"> — {a.detail}</span>
            <span class="opacity-60">（{t("settings.aiAlertActiveFor", { n: String(a.active_for_seconds) })}）</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if aiView.logSink}
    <div class="mt-2 rounded-md bg-black/5 px-2 py-1.5 text-[11px] opacity-80 dark:bg-white/10">
      <span class="font-medium opacity-70">{t("settings.aiLogSink")}</span>
      {#if aiView.logSink.enabled}
        <span class="ml-2" data-testid="ai-log-sink">{t("settings.aiLogSinkBytes", { n: String(aiView.logSink.bytes_written) })}</span>
        {#if aiView.logSink.lost_bytes > 0 || aiView.logSink.write_failures > 0}
          <!-- The trail is incomplete: say so instead of implying the log is intact. -->
          <span class="ml-2 text-amber-700 dark:text-amber-300" data-testid="ai-log-sink-loss">
            {t("settings.aiLogSinkLoss", {
              lost: String(aiView.logSink.lost_bytes),
              fails: String(aiView.logSink.write_failures),
            })}
          </span>
        {/if}
      {:else}
        <span class="ml-2 opacity-70" data-testid="ai-log-sink">{t("settings.aiLogSinkOff")}</span>
      {/if}
    </div>
  {/if}
  <div class="mt-2 rounded-md bg-black/5 px-2 py-1.5 text-[11px] opacity-80 dark:bg-white/10">
    <div class="flex items-center justify-between gap-2">
      <span class="font-medium opacity-70">{t("settings.aiClientDiag")}</span>
      <div class="flex items-center gap-1">
        <!-- The level knob is real (not a code-only constant): raising it to `debug`
             records the noisy paths too. Persisted by setDiagMinLevel. -->
        <select
          data-testid="ai-diag-level"
          aria-label={t("settings.aiClientDiagLevel")}
          value={diagInfo.minLevel}
          onchange={(e) => {
            setDiagMinLevel((e.currentTarget as HTMLSelectElement).value as DiagLevel);
            refreshDiag();
          }}
          class="rounded-full bg-neutral-300/70 px-2 py-0.5 text-[10px] dark:bg-neutral-700/70"
        >
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <button
          type="button"
          onclick={onClearDiag}
          data-testid="ai-diag-clear"
          class="rounded-full bg-neutral-300/70 px-2 py-0.5 text-[10px] dark:bg-neutral-700/70"
        >{t("settings.aiClientClear")}</button>
      </div>
    </div>
    <!-- What is shown vs. what the ledger dropped: never a silently truncated list. -->
    <div data-testid="ai-diag-counts" class="mt-1 opacity-70">
      {t("settings.aiClientDiagCounts", {
        n: String(diagInfo.recorded),
        cap: String(diagInfo.cap),
        evicted: String(diagInfo.evicted),
        suppressed: String(diagInfo.suppressed),
      })}
    </div>
    {#if diagEntries.length === 0}
      <p data-testid="ai-diag-empty" class="mt-1 opacity-60">{t("settings.aiClientDiagEmpty")}</p>
    {:else}
      <ul data-testid="ai-diag" class="mt-1 space-y-0.5 font-mono text-[10px]">
        {#each diagEntries as e (e.seq)}
          <li data-testid="ai-diag-item" class="truncate">{e.level} · {e.area} · {e.msg}</li>
        {/each}
      </ul>
    {/if}
  </div>
  <div class="mt-2 rounded-md bg-black/5 px-2 py-1.5 text-[11px] opacity-80 dark:bg-white/10">
    <span class="font-medium opacity-70">{t("settings.aiEnvHint")}</span>
    <div data-testid="ai-env" class="mt-1 space-y-0.5 font-mono text-[10px] leading-relaxed">
      {#each aiEnv as [k, v] (k)}
        <div class="truncate">{k}={v}</div>
      {/each}
    </div>
  </div>
</section>

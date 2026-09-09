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
    readAiConfig,
    setAiConfig,
    type AiConfig,
    type AiProviderId,
  } from "../../lib/providers";
  import { describeEngine, type EngineView } from "../../lib/aiEngine";
  import { bridged, getAiStatus, switchAiBackend } from "../../lib/backend";
  import { t } from "../locale.svelte";
  import { GROUP, LABEL, FIELD } from "./kit";

  const initialCfg = readAiConfig(readStoreValue<Record<string, unknown>>(SETTINGS_KEY, {}));
  let aiEdits = $state({
    provider: initialCfg.provider as AiProviderId,
    model:
      initialCfg.model ??
      (initialCfg.provider !== "local" ? cloudDefaultModel(initialCfg.provider) : ""),
    endpoint:
      initialCfg.endpoint ??
      (initialCfg.provider !== "local" ? cloudDefaultEndpoint(initialCfg.provider) : ""),
    apiKey: initialCfg.apiKey ?? "",
  });
  let aiMsg = $state("");
  let aiLive = $state<string | null>(null);
  let aiView = $state<EngineView>(describeEngine(null));
  const isCloud = $derived(aiEdits.provider !== "local");

  $effect(() => {
    if (!bridged()) return;
    getAiStatus().then((s) => {
      const m = s?.model && s.model.trim() ? s.model : "offline";
      aiLive = m;
      aiView = describeEngine(s);
    });
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

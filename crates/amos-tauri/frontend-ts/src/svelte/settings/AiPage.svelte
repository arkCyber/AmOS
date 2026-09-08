<script lang="ts">
  // AiPage.svelte — 「AI 与智能」sub page (the old AI-inference-backend group
  // relocated). Lets the user pick local vs cloud (DeepSeek) and configure the
  // model/endpoint/API key; shows the live engine state via lib/aiEngine.
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
  import { SETTINGS_KEY } from "../../lib/settings";
  import {
    DEEPSEEK_ENDPOINT,
    DEEPSEEK_MODEL,
    readAiConfig,
    setAiConfig,
    type AiProviderId,
  } from "../../lib/providers";
  import { describeEngine, type EngineView } from "../../lib/aiEngine";
  import { bridged, getAiStatus, switchAiBackend } from "../../lib/backend";
  import { t } from "../locale.svelte";
  import { GROUP, LABEL, FIELD } from "./kit";

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
</script>

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

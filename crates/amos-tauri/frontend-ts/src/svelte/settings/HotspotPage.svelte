<script lang="ts">
  // HotspotPage.svelte — 「个人热点」sub page. The on/off master switch is the shared
  // radio bit (`qs.hotspot`, the same store + airplane policy as the control center —
  // see lib/settings.ts flipRadio); the configuration (name / password / band /
  // security / client cap) persists through lib/hotspot (durable amos.hotspot).
  // Honest: no real tethering stack is attached in this build, so the page never
  // claims a running AP, never invents a client list, and refuses to switch on a
  // config that could not produce a working AP (blank name / too-short WPA key).
  import { readStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
  import {
    HOTSPOT_KEY,
    hotspotProblems,
    hotspotReady,
    isOpenNetwork,
    normalizeHotspot,
    setBand,
    setMaxClients,
    setPassword,
    setSecurity,
    setSsid,
    suggestPassword,
    type HotspotBand,
    type HotspotCfg,
    type HotspotProblem,
    type HotspotSecurity,
  } from "../../lib/hotspot";
  import type { QuickSettings, RadioKey } from "../../lib/settings";
  import type { RadioRefusalView } from "../../lib/radioControl";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, SUB, HINT, FIELD } from "./kit";
  import Switch from "./Switch.svelte";
  import Segmented from "./Segmented.svelte";

  let {
    qs,
    onToggle,
    refusal,
  }: {
    qs: QuickSettings;
    onToggle: (k: RadioKey) => void;
    /** The last refused write (REQ-A203), or `null` when nothing was refused. */
    refusal?: RadioRefusalView | null;
  } = $props();

  let cfg = $state<HotspotCfg>(normalizeHotspot(readStoreValue<unknown>(HOTSPOT_KEY, undefined)));
  // A rejected config write must be visible: the screen may not claim it "saved".
  let saveErr = $state("");
  const saveCfg = (next: HotspotCfg) => {
    if (!writeStoreValueChecked(HOTSPOT_KEY, next)) {
      saveErr = t("settings.radioSaveFailed");
      return;
    }
    saveErr = "";
    cfg = next;
  };

  const on = $derived(!!qs.hotspot);
  const blocked = $derived(!!qs.airplane);
  const problems = $derived(hotspotProblems(cfg));
  const ready = $derived(hotspotReady(cfg));
  const open = $derived(isOpenNetwork(cfg));

  // A problem must be read in the UI's own language — never the raw key.
  const PROBLEM_KEY: Record<HotspotProblem, string> = {
    ssidEmpty: "settings.hotspotProblemSsid",
    passwordTooShort: "settings.hotspotProblemPw",
  };
  const problemText = $derived(problems.map((p) => t(PROBLEM_KEY[p])).join(" · "));

  // Switching the AP on is refused while the config could not produce a working AP —
  // the switch must never claim a hotspot that cannot exist.
  const toggleHotspot = () => {
    if (!on && !ready) return;
    onToggle("hotspot");
  };
  const pickBand = (v: string) => saveCfg(setBand(cfg, v as HotspotBand));
  const pickSecurity = (v: string) => saveCfg(setSecurity(cfg, v as HotspotSecurity));
</script>

<div class="space-y-5">
  {#if saveErr}
    <p
      role="status"
      data-testid="hotspot-store-error"
      class="rounded-lg bg-black/5 px-3 py-1.5 text-[11px] text-danger dark:bg-white/10"
    >
      {saveErr}
    </p>
  {/if}
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.hotspot")}</span>
      <Switch on={on} disabled={blocked} aria={t("settings.hotspot")} ontoggle={toggleHotspot} />
    </div>
    <div class="px-4 pb-3">
      <p class={HINT}>{t("settings.hotspotDesc")}</p>
    </div>
    {#if blocked}
      <div class={SUB}></div>
      <div class="px-4 py-3">
        <p class={HINT}>{t("settings.airplaneBlocks")}</p>
      </div>
    {/if}
    {#if refusal}
      <div class={SUB}></div>
      <div class="px-4 py-3">
        <!-- A refused write (REQ-A203): the device said no *this time* — the sentence
             sits next to the switch that did not move, instead of a tap that only
             recorded a ledger entry. -->
        <p role="status" data-testid="hotspot-refused" class={HINT}>
          {refusal.noteKey === "" ? t("radio.refused.unknown") : t(refusal.noteKey)}
        </p>
      </div>
    {/if}
  </section>

  {#if !blocked}
    <section class={GROUP}>
      <div class={ROW}>
        <span class={LABEL}>{t("settings.hotspotName")}</span>
        <input
          value={cfg.ssid}
          aria-label={t("settings.hotspotName")}
          placeholder={t("settings.hotspotName")}
          onchange={(e) => saveCfg(setSsid(cfg, (e.currentTarget as HTMLInputElement).value))}
          class="{FIELD} max-w-[60%] text-right"
        />
      </div>
      <div class={SUB}></div>
      <div class={ROW}>
        <span class={LABEL}>{t("settings.hotspotPassword")}</span>
        <span class="flex min-w-0 items-center gap-2">
          <input
            value={cfg.password}
            aria-label={t("settings.hotspotPassword")}
            placeholder={t("settings.hotspotPassword")}
            disabled={open}
            onchange={(e) =>
              saveCfg(setPassword(cfg, (e.currentTarget as HTMLInputElement).value))}
            class="{FIELD} max-w-[40%] text-right disabled:opacity-40"
          />
          <button
            type="button"
            disabled={open}
            onclick={() => saveCfg(setPassword(cfg, suggestPassword()))}
            aria-label={t("settings.hotspotGenerate")}
            class="shrink-0 text-xs text-accent disabled:opacity-40"
          >{t("settings.hotspotGenerate")}</button>
        </span>
      </div>
      <div class={SUB}></div>
      <div class={ROW}>
        <span class={LABEL}>{t("settings.hotspotBand")}</span>
        <Segmented
          options={[
            { value: "2.4", label: t("settings.hotspotBand24") },
            { value: "5", label: t("settings.hotspotBand5") },
          ]}
          value={cfg.band}
          onpick={pickBand}
          aria={t("settings.hotspotBand")}
        />
      </div>
      <div class={SUB}></div>
      <div class={ROW}>
        <span class={LABEL}>{t("settings.hotspotSecurity")}</span>
        <Segmented
          options={[
            { value: "wpa2", label: t("settings.hotspotSecWpa2") },
            { value: "wpa3", label: t("settings.hotspotSecWpa3") },
            { value: "open", label: t("settings.hotspotSecOpen") },
          ]}
          value={cfg.security}
          onpick={pickSecurity}
          aria={t("settings.hotspotSecurity")}
        />
      </div>
      <div class={SUB}></div>
      <div class={ROW}>
        <span class={LABEL}>{t("settings.hotspotMaxClients")}</span>
        <Segmented
          options={[
            { value: "1", label: "1" },
            { value: "3", label: "3" },
            { value: "5", label: "5" },
            { value: "10", label: "10" },
          ]}
          value={String(cfg.maxClients)}
          onpick={(v) => saveCfg(setMaxClients(cfg, Number(v)))}
          aria={t("settings.hotspotMaxClients")}
        />
      </div>
      {#if problems.length > 0}
        <div class={SUB}></div>
        <div class="px-4 py-3">
          <p class={HINT} data-testid="hotspot-problems">{problemText}</p>
        </div>
      {/if}
      {#if open}
        <div class={SUB}></div>
        <div class="px-4 py-3">
          <p class={HINT} data-testid="hotspot-open-warning">
            {t("settings.hotspotOpenWarning")}
          </p>
        </div>
      {/if}
      <div class={SUB}></div>
      <div class="px-4 py-2">
        <p class={HINT}>{t("settings.hotspotSimNote")}</p>
      </div>
    </section>
  {/if}

  {#if on && !blocked}
    <section class={GROUP}>
      <div class="px-4 py-3">
        <p class={HINT} data-testid="hotspot-clients">{t("settings.hotspotClientsHint")}</p>
      </div>
    </section>
  {/if}
</div>

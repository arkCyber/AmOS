<script lang="ts">
  // HotspotPage.svelte — 「个人热点」sub page. The on/off master switch is the shared
  // radio bit (`qs.hotspot`, the same store + airplane policy as the control center —
  // see lib/settings.ts flipRadio); the configuration (name / password / band /
  // security / client cap) persists through lib/hotspot (durable amos.hotspot).
  // Honest: no real tethering stack is attached in this build, so the page never
  // claims a running AP, never invents a client list, and refuses to switch on a
  // config that could not produce a working AP (blank name / too-short WPA key).
  import { readStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
  import { radioOpenSettings } from "../../lib/backend";
  import { radioDisplayOn } from "../../lib/quickRadio";
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
  import { GROUP, SUB, HINT, FIELD } from "./kit";
  import ChoiceRow from "./ChoiceRow.svelte";
  import Field from "./Field.svelte";
  import ToggleRow from "./ToggleRow.svelte";
  import StoreErrorBar from "../StoreErrorBar.svelte";

  let {
    qs,
    onToggle,
    refusal,
    storeError = "",
  }: {
    qs: QuickSettings;
    onToggle: (k: RadioKey) => void;
    /** The last refused write (REQ-A203), or `null` when nothing was refused. */
    refusal?: RadioRefusalView | null;
    /**
     * The **store's** refusal for the AP switch, if any (REQ-A1381). `saveErr` is this
     * page's own config write and `refusal` is the device's answer; the switch is the tap's
     * success report, so the store's verdict is said in its own line.
     */
    storeError?: string;
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

  // "Is the AP on?" — the shared predicate, not the stored bit: airplane mode owns the
  // other radios, so a gated hotspot reads off (the sentence below says the same).
  const on = $derived(radioDisplayOn(qs, "hotspot"));
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
  //
  // The refusal is also *drawn*: a switch that looks live but silently returns is the
  // shape this page exists to avoid, and it was the odd one out — airplane mode already
  // disabled the same switch (with its sentence below). Both reasons a turn-on cannot
  // happen now read the same way: the row is disabled and the line beneath it says which
  // (the problem text when the config is the blocker, `settings.airplaneBlocks` when the
  // gate is). Turning an already-on AP *off* stays possible regardless of the config, so
  // the readiness half only applies while `on` is false — hence `ready` alone is not the
  // predicate.
  const canToggle = $derived(!blocked && (on || ready));
  const toggleHotspot = () => {
    if (!canToggle) return;
    onToggle("hotspot");
  };
  // The device refusing the AP is not a dead end: a normal install cannot hold
  // `TETHER_PRIVILEGED`, so `TetheringGlue.setWifiTethering` can answer "no" and the
  // system's tethering settings is where the user can still start it. The refusal carries
  // that surface token; the open verdict is reported rather than swallowed (REQ-A1456).
  let surfaceFailed = $state(false);
  const openApSettings = async () => {
    surfaceFailed = !(await radioOpenSettings("hotspot"));
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
    <ToggleRow
      label={t("settings.hotspot")}
      on={on}
      disabled={!canToggle}
      ontoggle={toggleHotspot}
    />
    {#if storeError}
      <div class={SUB}></div>
      <div class="px-4 pb-2"><StoreErrorBar message={storeError} /></div>
    {/if}
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
        <!-- The way out the refusal carries (REQ-A1456): the device said no to *this*
             attempt, and the system's own tethering settings is where the user can still
             switch the AP on — offered instead of leaving the refusal a dead end. -->
        {#if refusal.surface !== null}
          <button
            class="mt-1 text-[11px] font-semibold text-accent underline underline-offset-2"
            data-testid="hotspot-refused-open-settings"
            onclick={() => void openApSettings()}
          >{t("radio.openSettings")}</button>
        {/if}
        {#if surfaceFailed}
          <p role="status" data-testid="hotspot-surface-failed" class={HINT}>
            {t("radio.openSettingsFailed")}
          </p>
        {/if}
      </div>
    {/if}
  </section>

  {#if !blocked}
    <section class={GROUP}>
      <Field label={t("settings.hotspotName")}>
        {#snippet control({ id })}
          <input
            {id}
            value={cfg.ssid}
            placeholder={t("settings.hotspotName")}
            onchange={(e) => saveCfg(setSsid(cfg, (e.currentTarget as HTMLInputElement).value))}
            class="{FIELD} max-w-[60%] text-right"
          />
        {/snippet}
      </Field>
      <div class={SUB}></div>
      <Field label={t("settings.hotspotPassword")}>
        {#snippet control({ id })}
          <span class="flex min-w-0 items-center gap-2">
            <input
              {id}
              value={cfg.password}
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
        {/snippet}
      </Field>
      <div class={SUB}></div>
      <ChoiceRow
        label={t("settings.hotspotBand")}
        options={[
          { value: "2.4", label: t("settings.hotspotBand24") },
          { value: "5", label: t("settings.hotspotBand5") },
        ]}
        value={cfg.band}
        onpick={pickBand}
      />
      <div class={SUB}></div>
      <ChoiceRow
        label={t("settings.hotspotSecurity")}
        options={[
          { value: "wpa2", label: t("settings.hotspotSecWpa2") },
          { value: "wpa3", label: t("settings.hotspotSecWpa3") },
          { value: "open", label: t("settings.hotspotSecOpen") },
        ]}
        value={cfg.security}
        onpick={pickSecurity}
      />
      <div class={SUB}></div>
      <ChoiceRow
        label={t("settings.hotspotMaxClients")}
        options={[
          { value: "1", label: "1" },
          { value: "3", label: "3" },
          { value: "5", label: "5" },
          { value: "10", label: "10" },
        ]}
        value={String(cfg.maxClients)}
        onpick={(v) => saveCfg(setMaxClients(cfg, Number(v)))}
      />
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

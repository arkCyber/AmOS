<script lang="ts">
  // QuarantinePanel.svelte — the **read side** of the P1-1 corrupt-value quarantine.
  //
  // `readJson` preserves the raw bytes of a corrupt store under `${key}.corrupt` and
  // logs an error, but until now nothing ever read that copy: the bytes were a dead end
  // the user could not see or recover. This panel lists what is preserved and lets the
  // user copy it out (the app does not try to "repair" JSON it already failed to parse).
  // Renders nothing when there is nothing preserved — the Diagnostics page's rule.
  import { listQuarantined, readQuarantine } from "../../lib/amosStore";
  import { copySelection } from "../../lib/clipboard";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, HINT, H2 } from "./kit";

  let rows = $state(listQuarantined());
  let copied = $state("");

  const copy = async (key: string) => {
    const raw = readQuarantine(key);
    if (raw === null) return;
    copied = (await copySelection(raw)) ? key : "";
  };
</script>

{#if rows.length > 0}
  <section class={GROUP} data-testid="store-quarantine">
    <div class={ROW}>
      <span class={H2}>{t("settings.quarantineTitle")}</span>
      <button
        onclick={() => (rows = listQuarantined())}
        aria-label={t("settings.quarantineRefresh")}
        class="shrink-0 rounded-full bg-black/5 px-2.5 py-1 text-xs active:scale-95 dark:bg-white/10"
      >
        {t("settings.quarantineRefresh")}
      </button>
    </div>
    <p class="px-4 pb-2 text-xs opacity-60">{t("settings.quarantineHint")}</p>
    {#each rows as r (r.key)}
      <div class={ROW}>
        <span class="flex min-w-0 flex-col">
          <span class={LABEL}>{r.key}</span>
          <span class={HINT}>{t("settings.quarantineBytes", { n: String(r.bytes) })}</span>
        </span>
        <button
          onclick={() => void copy(r.key)}
          aria-label="quarantine-copy"
          class="shrink-0 rounded-full bg-black/5 px-3 py-1 text-xs active:scale-95 dark:bg-white/10"
        >
          {copied === r.key ? t("settings.quarantineCopied") : t("settings.quarantineCopy")}
        </button>
      </div>
    {/each}
  </section>
{/if}

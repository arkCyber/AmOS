<script lang="ts">
  // LanguagePage.svelte — 「语言」sub page. Switches zh / en through the shared
  // reactive locale singleton (which also broadcasts to the shell).
  import { t, locale, setLocale } from "../locale.svelte";
  import { GROUP, ROW, LABEL, HINT } from "./kit";
  import Segmented from "./Segmented.svelte";
</script>

<section class={GROUP}>
  <div class={ROW}>
    <span class={LABEL}>{t("settings.language")}</span>
    <Segmented
      options={[
        { value: "zh", label: "中文" },
        { value: "en", label: "English" },
      ]}
      value={locale()}
      onpick={(v) => setLocale(v as "zh" | "en")}
      aria="language"
    />
  </div>
  <div class="px-4 pb-3">
    <p class={HINT}>{t("settings.languageHint")}</p>
  </div>
</section>

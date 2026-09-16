<script lang="ts">
  // LanguagePage.svelte — 「语言」sub page. Switches zh / en through the shared
  // reactive locale singleton (which also broadcasts to the shell).
  import { t, locale, setLocale } from "../locale.svelte";
  import { GROUP, HINT } from "./kit";
  import ChoiceRow from "./ChoiceRow.svelte";
</script>

<section class={GROUP}>
  <ChoiceRow
    label={t("settings.language")}
    options={[
      { value: "zh", label: "中文" },
      { value: "en", label: "English" },
    ]}
    value={locale()}
    onpick={(v) => setLocale(v as "zh" | "en")}
  />
  <div class="px-4 pb-3">
    <p class={HINT}>{t("settings.languageHint")}</p>
  </div>
</section>

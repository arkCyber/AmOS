<script lang="ts">
  // DisplayPage.svelte — 「显示与亮度」sub page. Appearance (浅/深/自动), auto
  // screen-off timeout and wake→home preference — relocated unchanged from the
  // old single-page SettingsApp, still persisting through lib/display.
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
  import { AUTOOFF_STORE_KEY, clampAutoOffSec, WAKE_HOME_KEY, wakeHomeEnabled } from "../../lib/display";
  import { t } from "../locale.svelte";
  import { themeMode, setThemeMode } from "../theme.svelte";
  import { GROUP, ROW, LABEL, SUB } from "./kit";
  import Switch from "./Switch.svelte";
  import Segmented from "./Segmented.svelte";

  let autoOffStr = $state(String(clampAutoOffSec(readStoreValue<unknown>(AUTOOFF_STORE_KEY, 0))));
  let wakeHome = $state(wakeHomeEnabled(readStoreValue<unknown>(WAKE_HOME_KEY, true)));

  const pickAutoOff = (v: string) => {
    writeStoreValue(AUTOOFF_STORE_KEY, Number(v));
    autoOffStr = v;
  };
  const toggleWakeHome = () => {
    wakeHome = !wakeHome;
    writeStoreValue(WAKE_HOME_KEY, wakeHome);
  };
</script>

<section class={GROUP}>
  <div class={ROW}>
    <span class={LABEL}>{t("settings.appearance")}</span>
    <Segmented
      options={[
        { value: "light", label: t("theme.light") },
        { value: "dark", label: t("theme.dark") },
        { value: "auto", label: t("theme.auto") },
      ]}
      value={themeMode()}
      onpick={(v) => setThemeMode(v as "light" | "dark" | "auto")}
      aria="appearance"
    />
  </div>
  <div class={SUB}></div>
  <div class={ROW}>
    <span class={LABEL}>{t("settings.autoOff")}</span>
    <Segmented
      options={[
        { value: "0", label: t("settings.autoOffOff") },
        { value: "15", label: t("settings.autoOff15") },
        { value: "30", label: t("settings.autoOff30") },
        { value: "60", label: t("settings.autoOff60") },
      ]}
      value={autoOffStr}
      onpick={pickAutoOff}
      aria="auto-screen-off"
    />
  </div>
  <div class={SUB}></div>
  <div class={ROW}>
    <span class={LABEL}>{t("settings.wakeHome")}</span>
    <Switch on={wakeHome} ontoggle={toggleWakeHome} aria={t("settings.wakeHome")} />
  </div>
</section>

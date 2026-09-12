<script lang="ts">
  // DisplayPage.svelte — 「显示与亮度」sub page. Appearance (浅/深/自动), auto
  // screen-off timeout and wake→home preference — relocated unchanged from the
  // old single-page SettingsApp, still persisting through lib/display.
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
  import { AUTOOFF_STORE_KEY, clampAutoOffSec, WAKE_HOME_KEY, wakeHomeEnabled } from "../../lib/display";
  import { heldReasons, onHoldChange } from "../../lib/keepAwakeCore";
  import { t } from "../locale.svelte";
  import { themeMode, setThemeMode } from "../theme.svelte";
  import { GROUP, ROW, LABEL, SUB, HINT } from "./kit";
  import Switch from "./Switch.svelte";
  import Segmented from "./Segmented.svelte";
  import { onMount } from "svelte";

  let autoOffStr = $state(String(clampAutoOffSec(readStoreValue<unknown>(AUTOOFF_STORE_KEY, 0))));
  let wakeHome = $state(wakeHomeEnabled(readStoreValue<unknown>(WAKE_HOME_KEY, true)));

  // Why the screen is being held awake **right now** (lib/keepAwakeCore reason
  // bus: "call" while a call is up, "video" while a video plays; the auto screen-off
  // watcher honours the same bus). Without this readout the user picks "30 s" and
  // then watches the screen never sleep during a call or video — indistinguishable
  // from a broken timeout. Live: subscribes to the bus so a call starting while
  // this page is open updates it.
  let holds = $state<string[]>(heldReasons());
  onMount(() => onHoldChange(() => (holds = heldReasons())));

  /** Localized hold reason. A reason we don't know shows its raw key verbatim —
   *  a new hold must never be silently hidden from the user. */
  const REASON_KEYS: Record<string, string> = {
    call: "settings.keepAwakeCall",
    video: "settings.keepAwakeVideo",
  };
  const reasonLabel = (r: string) => (REASON_KEYS[r] ? t(REASON_KEYS[r]) : r);

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
  {#if autoOffStr !== "0"}
    <!-- Only meaningful once a timeout is set: explains why the screen is NOT
         sleeping despite it. Empty bus = an authoritative "nothing is holding". -->
    <div class={`px-4 pb-3 ${HINT}`} data-testid="keep-awake">
      {t("settings.keepAwake")}: {holds.length === 0
        ? t("settings.keepAwakeNone")
        : holds.map(reasonLabel).join(" · ")}
    </div>
  {/if}
  <div class={SUB}></div>
  <div class={ROW}>
    <span class={LABEL}>{t("settings.wakeHome")}</span>
    <Switch on={wakeHome} ontoggle={toggleWakeHome} aria={t("settings.wakeHome")} />
  </div>
</section>

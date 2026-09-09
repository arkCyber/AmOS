<script lang="ts">
  // CellularPage.svelte — 「蜂窝网络」sub page (real persisted preferences). Master
  // "蜂窝数据" + "数据漫游" toggles persist through lib/cellular (durable amos.cellular),
  // matching the honest pattern of the Wi‑Fi/蓝牙 bits — no fabricated signal/carrier.
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
  import { CELLULAR_KEY, flipCellular, normalizeCellular, type CellularPrefs } from "../../lib/cellular";
  import {
    cellularService,
    cellularStateKey,
    defaultRadioSignal,
  } from "../../lib/cellularService";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, HINT, VALUE } from "./kit";
  import Switch from "./Switch.svelte";

  const initPrefs = normalizeCellular(readStoreValue<unknown>(CELLULAR_KEY, {}));
  let prefs = $state<CellularPrefs>(initPrefs);
  const toggle = (key: "data" | "roaming") => {
    const next = flipCellular(prefs, key);
    prefs = next;
    writeStoreValue(CELLULAR_KEY, next);
  };
  // Honest service state: no real modem is attached (defaultRadioSignal()), so this
  // page tells the truth — it never invents a signal/carrier. `connected` is only
  // reachable once a real radio source reports a real signal.
  const status = $derived(
    t(cellularStateKey(cellularService(prefs, defaultRadioSignal()))),
  );
</script>

<div class="space-y-5">
  <section class={GROUP} data-testid="cellular-status">
    <div class={ROW}>
      <span class={LABEL}>{t("settings.cellularService")}</span>
      <span class={VALUE}>{status}</span>
    </div>
    <div class="px-4 pb-3">
      <p class={HINT}>{t("settings.cellularDesc")}</p>
    </div>
  </section>

  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.cellularData")}</span>
      <Switch on={prefs.data} aria={t("settings.cellularData")} ontoggle={() => toggle("data")} />
    </div>
    <div class="px-4 pb-3">
      <p class={HINT}>{t("settings.cellularDesc")}</p>
    </div>
  </section>

  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.cellularRoaming")}</span>
      <Switch
        on={prefs.roaming}
        disabled={!prefs.data}
        aria={t("settings.cellularRoaming")}
        ontoggle={() => toggle("roaming")}
      />
    </div>
    <div class="px-4 pb-3">
      <p class={HINT}>{t("settings.cellularRoamingDesc")}</p>
    </div>
  </section>
</div>

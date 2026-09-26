<script lang="ts">
  // CellularPage.svelte — 「蜂窝网络」sub page (real persisted preferences). Master
  // "蜂窝数据" + "数据漫游" toggles persist through lib/cellular (durable amos.cellular),
  // matching the honest pattern of the Wi‑Fi/蓝牙 bits — no fabricated signal/carrier.
  import { readStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
  import { CELLULAR_KEY, flipCellular, normalizeCellular, type CellularPrefs } from "../../lib/cellular";
  import {
    cellularService,
    cellularStateKey,
    type RadioSignal,
  } from "../../lib/cellularService";
  import { cellularRadio } from "../cellularRadio";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, HINT, VALUE } from "./kit";
  import ToggleRow from "./ToggleRow.svelte";
  import StoreErrorBar from "../StoreErrorBar.svelte";

  const initPrefs = normalizeCellular(readStoreValue<unknown>(CELLULAR_KEY, {}));
  let prefs = $state<CellularPrefs>(initPrefs);
  /** 拒写时那一句，以及它属于哪一行 —— 渲染在**被按下的那个开关自己那一块**里。 */
  let storeErr = $state("");
  let errWhere = $state<"" | "data" | "roaming">("");
  const toggle = (key: "data" | "roaming") => {
    const next = flipCellular(prefs, key);
    // 这一次翻转是**纯存储**的判决：数据/漫游两个位只存在于 `amos.cellular`，没有第二个
    // 权威可问。拒写时本地 `prefs` 必须原样不动 —— 否则开关亮着、上面那句「服务状态」
    // 也由这个没落盘的位算出来，屏幕在说一件不成立的事（F-SH-632）。
    if (!writeStoreValueChecked(CELLULAR_KEY, next)) {
      storeErr = t("common.storeWriteFailed");
      errWhere = key;
      return;
    }
    storeErr = "";
    errWhere = "";
    prefs = next;
  };
  // Honest service state, from the **one** radio source there is (the same store the
  // Notification Center installs from `cellular_signal`). 这里过去写死 `defaultRadioSignal()`：
  // 一个事实两张脸、两个来源 —— 通知中心在真机上画信号格，本页却仍说「无蜂窝服务」。
  // 读同一个 store，两边不可能再分叉（「一个事实两张脸、两个来源」那一族的形状）。
  //
  // `null` 是**第三态**：本页要「印出一句话」，所以它比通知中心那一格更需要这个区别 ——
  // 后者在同一个值上只是**沉默**（不画），前者却在陈述「本机无 SIM / 调制解调器」。
  // 从未问过宿主时印那句断言，正是这个仓库反复判为缺陷的形状（「没有答案 ≠ 没有设备」），
  // 兄弟先例见 `NotificationCenter.svelte` 里紧挨着本次读取的 `rotationAvailable: boolean | null`
  // （REQ-A1539 ∕ F-SH-780）。
  let radio = $state<RadioSignal | null>(null);
  $effect(() => {
    const un = cellularRadio.subscribe((v) => (radio = v));
    return un;
  });
  const status = $derived(
    radio === null
      ? t("settings.cellularUnknown")
      : t(cellularStateKey(cellularService(prefs, radio))),
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
    <ToggleRow
      label={t("settings.cellularData")}
      on={prefs.data}
      ontoggle={() => toggle("data")}
    />
    {#if errWhere === "data"}<StoreErrorBar message={storeErr} />{/if}
    <div class="px-4 pb-3">
      <p class={HINT}>{t("settings.cellularDesc")}</p>
    </div>
  </section>

  <section class={GROUP}>
    <ToggleRow
      label={t("settings.cellularRoaming")}
      on={prefs.roaming}
      disabled={!prefs.data}
      ontoggle={() => toggle("roaming")}
    />
    {#if errWhere === "roaming"}<StoreErrorBar message={storeErr} />{/if}
    <div class="px-4 pb-3">
      <p class={HINT}>{t("settings.cellularRoamingDesc")}</p>
    </div>
  </section>
</div>

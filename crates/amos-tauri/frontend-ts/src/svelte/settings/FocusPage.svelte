<script lang="ts">
  // FocusPage.svelte — 「专注模式」sub page.
  //
  // REQ-A206: the 勿扰 row is **the real Do-Not-Disturb bit** — persisted through
  // the shared quick-settings store (`amos.settings.dnd`, lib/settings), the same
  // single write path and key the shell, control center, arrival banner and the
  // 通知 page all read. It used to write a decorative `amos.focus.dnd` field that
  // no silencing path ever read: two switches with the same name in Settings, one
  // real and one fake. 工作 / 睡眠 stay per-scenario *intent* (lib/focusPrefs,
  // durable amos.focus) — the hint says plainly that they do not silence anything
  // yet.
  import { readStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
  import { createStoreValue } from "../store";
  import {
    FOCUS_KEY,
    FOCUS_SCENARIOS,
    focusLabelKey,
    normalizeFocus,
    toggleFocus,
    type FocusId,
    type FocusPrefs,
  } from "../../lib/focusPrefs";
  import {
    SETTINGS_KEY,
    dndActive,
    flipQuick,
    normalizeQuick,
    saveQuick,
    type QuickSettings,
  } from "../../lib/settings";
  import { t } from "../locale.svelte";
  import { GROUP, SUB, HINT } from "./kit";
  import ToggleRow from "./ToggleRow.svelte";
  import StoreErrorBar from "../StoreErrorBar.svelte";
  import FocusSchedule from "./FocusSchedule.svelte";

  const readQuick = (): QuickSettings => normalizeQuick(readStoreValue<unknown>(SETTINGS_KEY, {}));
  let qs = $state<QuickSettings>(readQuick());
  // 这一位不止这一个写入者：`osFocusWatcher`（REQ-A684）在每个时间窗边界、以及每次编辑时段时
  // 都会写 `amos.settings.dnd`——而时段编辑器就画在本页开关的**正下方**。所以这一页必须**订阅**
  // 这个键（与 `StatusBar` ∕ `Dock` ∕ `ControlCenter` ∕ 通知中心等九个读者同一条原语），否则
  // 开关停在打开那一刻的值：用户刚在上面开了个覆盖「现在」的时段，下面的手表却仍显示勿扰关着。
  const quickStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  $effect(() => {
    const un = quickStore.subscribe((v) => (qs = normalizeQuick(v)));
    return un;
  });
  const dnd = $derived(dndActive(qs));
  /** 拒写时那一句，以及它属于哪一行 —— 渲染在**被按下的那个开关自己那一块**里。 */
  let storeErr = $state("");
  let errWhere = $state<"" | "dnd" | FocusId>("");
  const toggleDnd = () => {
    // Same store, same flip policy as the 通知 page — there is exactly one DND.
    const next = flipQuick(qs, "dnd");
    // 这一次翻转是**纯存储**的判决：不向任何设备发问，所以 `amos.settings` 就是全部的真相。
    // 存储答「没写成」时本地那一位必须原样不动 —— `writeJson` 拒绝之后既不派发
    // `STORE_CHANGED_EVENT`、也不留存任何东西，没有任何第二条线会把开关纠正回来，它就一直
    // 亮着而外壳照旧投递通知（F-SH-630）。成功时这句本地赋值本来就是多余的：派发是同步的，
    // `quickStore` 的订阅会把 `next` 送回来 —— REQ-A1340 装的正是这条订阅。
    // `next` 是窄化后的翻转值，必须**载入**原始 blob 而不是覆盖它：`amos.settings` 里还住着
    // AI provider 与云同步偏好（REQ-A1397 ∕ F-SH-656）。
    if (!saveQuick(next)) {
      storeErr = t("common.storeWriteFailed");
      errWhere = "dnd";
      return;
    }
    storeErr = "";
    errWhere = "";
    qs = next;
  };

  const initPrefs = normalizeFocus(readStoreValue<unknown>(FOCUS_KEY, {}));
  let prefs = $state<FocusPrefs>(initPrefs);
  const toggle = (id: FocusId) => {
    const next = toggleFocus(prefs, id);
    // 与勿扰**同一条纪律**：`amos.focus` 只由这一页写、也没有设备可问，所以拒写时开关必须
    // 留在原处 —— 否则「工作 ∕ 睡眠」显示已记录而盘上没有，刷新之后它自己又关掉（F-SH-632）。
    if (!writeStoreValueChecked(FOCUS_KEY, next)) {
      storeErr = t("common.storeWriteFailed");
      errWhere = id;
      return;
    }
    storeErr = "";
    errWhere = "";
    prefs = next;
  };
  const idKey = (id: FocusId): string => focusLabelKey(id);
</script>

<section class={GROUP}>
  <ToggleRow label={t("settings.focusDnd")} on={dnd} ontoggle={toggleDnd} />
  {#if errWhere === "dnd"}<StoreErrorBar message={storeErr} />{/if}
  {#if FOCUS_SCENARIOS.length > 0}<div class={SUB}></div>{/if}
  {#each FOCUS_SCENARIOS as id, i (id)}
    <ToggleRow label={t(idKey(id))} on={prefs[id]} ontoggle={() => toggle(id)} />
    {#if errWhere === id}<StoreErrorBar message={storeErr} />{/if}
    {#if i < FOCUS_SCENARIOS.length - 1}<div class={SUB}></div>{/if}
  {/each}
  <div class="px-4 pb-3">
    <p class={HINT}>{t("settings.focusHint")}</p>
  </div>
</section>

<FocusSchedule />

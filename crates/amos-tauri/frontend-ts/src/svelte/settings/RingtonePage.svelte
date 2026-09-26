<script lang="ts">
  // RingtonePage.svelte — 来电铃声与振动设置子页面
  //
  // 提供铃声选择、振动开关和预览功能。铃声列表目前为硬编码，
  // 未来可从系统读取 /system/media/audio/ringtones/ 或用户自定义路径。
  //
  // 持久化策略（REQ-A993 / F-SH-314 修正）：**振动位**用 lib/sound 的
  // `amos.sound.vibrate` —— 与 SoundPage 的通知触感开关同一真相来源，也是到达提示音
  // 路径（`shouldVibrateOnArrival`）已经读的那个位；**铃声 id**在 lib/sound 的策略里
  // 没有位置，用 lib/callRingtone 的 `amos.ringtone`。
  //
  // 修正前这页把自己的 `{selected, vibrate}` 写在自造的 `amos.ringtone` 键下，**没有
  // 任何读者**：来电铃声永远是固定的 `sounds/phone/incoming.mp3`，没有任何代码振动，
  // 预览放的是通知音 —— 而本页自己的文案（「来电时播放的铃声」「来电时同时振动」
  // 「播放当前选择的铃声」）三件都承诺了。
  import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
  import {
    CALL_RINGTONE_IDS,
    RINGTONE_KEY,
    hasLegacyVibrate,
    normalizeRingtonePrefs,
    type CallRingtoneId,
  } from "../../lib/callRingtone";
  import { flipSound, loadSound, saveSound, type SoundPolicy } from "../../lib/sound";
  import { previewCallRingtone } from "../../lib/callTone";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, HINT, H2 } from "./kit";
  import ToggleRow from "./ToggleRow.svelte";
  import StoreErrorBar from "../StoreErrorBar.svelte";

  // 铃声列表存的是 **i18n key** 而不是译好的名字：`t()` 只有在渲染期调用才跟着
  // locale 走（见 locale.svelte.ts 的文件头），把这个表在挂载时译好就等于把语言冻在
  // 打开页面的那一刻 —— 切语言后标题变了、铃铛名字没变，同一屏两种语言。
  const RINGTONE_NAME_KEY: Record<CallRingtoneId, string> = {
    classic: "ringtone.classic",
    modern: "ringtone.modern",
    piano: "ringtone.piano",
    guitar: "ringtone.guitar",
    bell: "ringtone.bell",
  };

  // 初始化只读一次、只在普通（非 $state）局部量上判断，免得把 `$state` 在挂载作用域里读
  // 出来（Svelte 会警告 state_referenced_locally，见仓库的 REQ-A472 纪律）。
  const initialSound = loadSound();
  const rawPrefs = readStoreValue<unknown>(RINGTONE_KEY, null);
  const stored = normalizeRingtonePrefs(rawPrefs, initialSound.vibrate);
  // 旧格式（`{selected, vibrate}`）里的振动位一次性搬进唯一的策略位，之后只写 `selected`
  // —— 否则一个把「来电振动」关掉的用户会看到它被默认值悄悄打开（与 normalizeSound 的
  // 迁移容忍同一套道理）。
  //
  // 这是一次**两个键、两笔写**的迁移，顺序就是那道闸（REQ-A1452 ∕ FMEA F-SH-703）：先把位
  // 抬进 `amos.sound`，**落了地**才把旧记录里的 `vibrate` 删掉。删的那半是破坏性的，且旧字段
  // 是这枚选择**唯一**的副本 —— 在搬移之前删就等于把偏好毁掉：下次开机读到的只有它的缺席，
  // 于是回落到默认值（`saveSound` 的裁决原先被丢在地上，`migrated !== initialSound` 就直接
  // 写）。同文件里用户自己那枚开关早就读这枚裁决（F-SH-638），这条挂载路径是剩下的兄弟。
  const moved =
    stored.vibrate === initialSound.vibrate || saveSound({ ...initialSound, vibrate: stored.vibrate });
  // 搬走之后必须把旧记录里的 `vibrate` 删掉（REQ-A1076）：`normalizeRingtonePrefs` 优先读
  // 它，留在原地就会永远压过策略位 —— 用户在本页或「声音与触感」打开振动，铃声路径仍拿到
  // `false`，开关显示 ON 却永不振动。只留 `selected`，旧位就此退休。
  // 拒写时**留着它**：它既是重试的凭据（下一次挂载重跑同一段迁移），也是那句「这里曾有一枚
  // 选择」的唯一记录。留着不会重新压过策略位 —— 相等的两半上面根本没有动过策略位。
  if (moved && hasLegacyVibrate(rawPrefs)) {
    writeStoreValue(RINGTONE_KEY, JSON.stringify({ selected: stored.selected }));
  }

  // 显示位取**权威那一份**：搬移没落地时 `amos.sound` 仍是旧值，开关就必须画旧值 —— 否则
  // 屏上写着「来电时同时振动」而电话进来不振（F-SH-638 的镜像）。挂载路径没有可依附的手势，
  // 所以不说一句话；下一次挂载（存储可用时）自会补上这次迁移。
  let sound = $state<SoundPolicy>(
    moved ? { ...initialSound, vibrate: stored.vibrate } : initialSound,
  );
  let selected = $state<CallRingtoneId>(stored.selected);

  /** 拒写时那一句，以及它属于哪一行 —— 渲染在**被按下的那个控件自己那一块**里。 */
  let storeErr = $state("");
  let errWhere = $state<"" | "ringtone" | "vibrate">("");
  const selectRingtone = (id: CallRingtoneId) => {
    // 这一枚键的**权威读者是来电路径**（`lib/callTone` 读 `amos.ringtone` 决定响哪支）。
    // 拒写时 `selected` 必须原样不动 —— 否则 ✓ 挪到了新铃铛上，而来电仍然响旧的那支，
    // 屏幕在替一个没有落盘的选择作证（F-SH-632）。
    if (!writeStoreValueChecked(RINGTONE_KEY, JSON.stringify({ selected: id }))) {
      storeErr = t("common.storeWriteFailed");
      errWhere = "ringtone";
      return;
    }
    storeErr = "";
    errWhere = "";
    selected = id;
    previewCallRingtone(id); // 选择后自动预览（放的就是选中的这支）
  };

  /**
   * 这一枚位（`amos.sound.vibrate`）的**权威读者是来电路径**：`lib/callTone` 在
   * `incomingRingPlan(..., loadSound().vibrate, ...)` 里读它决定来电振不振。`saveSound`
   * 现在把裁决还回来（它原本签 `void`，三个调用点**结构上**都看不到），所以这里必须
   * 先问再动屏幕 —— 否则屏上说「来电时同时振动」开着，电话进来却不振（F-SH-638）。
   */
  const toggleVibrate = () => {
    const next = flipSound(sound, "vibrate");
    if (!saveSound(next)) {
      storeErr = t("common.storeWriteFailed");
      errWhere = "vibrate";
      return;
    }
    storeErr = "";
    errWhere = "";
    sound = next;
  };
</script>

<div class="flex flex-col gap-5 px-4 pb-6 pt-2">
  <section class={GROUP}>
    <div class="px-4 py-3">
      <h3 class={H2}>{t("ringtone.selectTitle")}</h3>
    </div>
    {#each CALL_RINGTONE_IDS as tone (tone)}
      <button
        type="button"
        class={ROW + " cursor-pointer active:bg-black/5 dark:active:bg-white/5"}
        onclick={() => selectRingtone(tone)}
        data-testid="ringtone-option-{tone}"
      >
        <span class="flex-1 text-left">{t(RINGTONE_NAME_KEY[tone])}</span>
        {#if selected === tone}
          <span class="text-accent" data-testid="ringtone-selected">✓</span>
        {/if}
      </button>
    {/each}
    {#if errWhere === "ringtone"}<div class="px-4"><StoreErrorBar message={storeErr} /></div>{/if}
    <div class="px-4 pb-3">
      <p class={HINT}>{t("ringtone.selectHint")}</p>
    </div>
  </section>

  <section class={GROUP}>
    <ToggleRow
      label={t("ringtone.vibrateOnRing")}
      on={sound.vibrate}
      ontoggle={toggleVibrate}
    />
    {#if errWhere === "vibrate"}<div class="px-4"><StoreErrorBar message={storeErr} /></div>{/if}
    <div class="px-4 pb-3">
      <p class={HINT}>{t("ringtone.vibrateHint")}</p>
    </div>
  </section>

  <section class={GROUP}>
    <div class="px-4 py-3">
      <button
        type="button"
        onclick={() => previewCallRingtone(selected)}
        class="rounded-full bg-accent px-6 py-2 text-sm text-white active:scale-95"
        data-testid="ringtone-preview"
      >
        {t("ringtone.preview")}
      </button>
      <p class="mt-2 text-xs opacity-60">{t("ringtone.previewDesc")}</p>
    </div>
  </section>
</div>

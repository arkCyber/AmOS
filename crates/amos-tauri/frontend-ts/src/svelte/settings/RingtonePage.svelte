<script lang="ts">
  // RingtonePage.svelte — 来电铃声与振动设置子页面
  //
  // 提供铃声选择、振动开关和预览功能。铃声列表目前为硬编码，
  // 未来可从系统读取 /system/media/audio/ringtones/ 或用户自定义路径。
  //
  // 持久化策略：复用 lib/sound.ts 的 amos.sound 存储键，保持与
  // SoundPage 通知音量/震动开关的单一真相来源。
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
  import { playNotifyTone } from "../../lib/notifyTone";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, HINT, H2 } from "./kit";
  import ToggleRow from "./ToggleRow.svelte";

  const RINGTONE_KEY = "amos.ringtone";

  interface RingtonePrefs {
    selected: string;
    vibrate: boolean;
  }

  const DEFAULT_PREFS: RingtonePrefs = {
    selected: "classic",
    vibrate: true,
  };

  // 铃声列表（后续可从系统动态读取）
  const RINGTONES = [
    { id: "classic", name: t("ringtone.classic") },
    { id: "modern", name: t("ringtone.modern") },
    { id: "piano", name: t("ringtone.piano") },
    { id: "guitar", name: t("ringtone.guitar") },
    { id: "bell", name: t("ringtone.bell") },
  ];

  function loadPrefs(): RingtonePrefs {
    const raw = readStoreValue<unknown>(RINGTONE_KEY, null);
    if (!raw) return DEFAULT_PREFS;
    try {
      const parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
      return {
        selected: typeof parsed.selected === "string" ? parsed.selected : "classic",
        vibrate: typeof parsed.vibrate === "boolean" ? parsed.vibrate : true,
      };
    } catch {
      return DEFAULT_PREFS;
    }
  }

  function savePrefs(prefs: RingtonePrefs): void {
    writeStoreValue(RINGTONE_KEY, JSON.stringify(prefs));
  }

  let prefs = $state<RingtonePrefs>(loadPrefs());

  const selectRingtone = (id: string) => {
    prefs = { ...prefs, selected: id };
    savePrefs(prefs);
    // 选择后自动预览
    previewRingtone();
  };

  const toggleVibrate = () => {
    prefs = { ...prefs, vibrate: !prefs.vibrate };
    savePrefs(prefs);
  };

  const previewRingtone = () => {
    // 当前使用通知音作为预览（未来可替换为真实铃声资源）
    playNotifyTone({ volume: 0.6 });
  };
</script>

<div class="flex flex-col gap-5 px-4 pb-6 pt-2">
  <section class={GROUP}>
    <div class="px-4 py-3">
      <h3 class={H2}>{t("ringtone.selectTitle")}</h3>
    </div>
    {#each RINGTONES as tone (tone.id)}
      <button
        type="button"
        class={ROW + " cursor-pointer active:bg-black/5 dark:active:bg-white/5"}
        onclick={() => selectRingtone(tone.id)}
        data-testid="ringtone-option-{tone.id}"
      >
        <span class="flex-1 text-left">{tone.name}</span>
        {#if prefs.selected === tone.id}
          <span class="text-accent" data-testid="ringtone-selected">✓</span>
        {/if}
      </button>
    {/each}
    <div class="px-4 pb-3">
      <p class={HINT}>{t("ringtone.selectHint")}</p>
    </div>
  </section>

  <section class={GROUP}>
    <ToggleRow
      label={t("ringtone.vibrateOnRing")}
      on={prefs.vibrate}
      ontoggle={toggleVibrate}
    />
    <div class="px-4 pb-3">
      <p class={HINT}>{t("ringtone.vibrateHint")}</p>
    </div>
  </section>

  <section class={GROUP}>
    <div class="px-4 py-3">
      <button
        type="button"
        onclick={previewRingtone}
        class="rounded-full bg-accent px-6 py-2 text-sm text-white active:scale-95"
        data-testid="ringtone-preview"
      >
        {t("ringtone.preview")}
      </button>
      <p class="mt-2 text-xs opacity-60">{t("ringtone.previewDesc")}</p>
    </div>
  </section>
</div>

<script lang="ts">
  // SoundPage.svelte — 「声音与触感」sub page. The two policy bits + the chime
  // loudness live in lib/sound (the single owner of the durable `amos.sound`
  // key — the same policy the status bar and the notification-arrival ring/haptic
  // read), plus an asset-free audible preview via lib/notifyTone.playNotifyTone
  // (never throws, safe in tests).
  import {
    flipSound,
    loadSound,
    saveSound,
    setSoundVolume,
    type SoundPolicy,
  } from "../../lib/sound";
  import { playNotifyTone } from "../../lib/notifyTone";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, HINT } from "./kit";
  import Field from "./Field.svelte";
  import ToggleRow from "./ToggleRow.svelte";

  let prefs = $state<SoundPolicy>(loadSound());
  const toggle = (key: "ring" | "vibrate") => {
    const next = flipSound(prefs, key);
    prefs = next;
    saveSound(next);
  };
  // 0..100 slider → 0..1 policy loudness. Persisted through the same lib/sound
  // write path as the switches (single owner of `amos.sound`).
  const setVolume = (pct: number) => {
    const next = setSoundVolume(prefs, pct / 100);
    prefs = next;
    saveSound(next);
  };
  const preview = () => {
    playNotifyTone({ volume: prefs.volume });
    if (!prefs.ring) toggle("ring"); // preview implies audible alerts enabled
  };
</script>

<div class="space-y-5">
  <section class={GROUP}>
    <ToggleRow
      label={t("settings.notifySound")}
      on={prefs.ring}
      ontoggle={() => toggle("ring")}
    />
    <div class="px-4 pb-3">
      <p class={HINT}>{t("settings.notifySoundDesc")}</p>
    </div>
    <Field label={t("settings.notifyVolume")}>
      {#snippet control({ id })}
        <div class="flex items-center gap-2">
          <!-- A native range input: named by the row's <label for={id}> above, never by a
               duplicated aria-label (REQ-A283). -->
          <input
            {id}
            type="range"
            min="0"
            max="100"
            step="5"
            value={Math.round(prefs.volume * 100)}
            data-testid="sound-volume"
            oninput={(e) =>
              setVolume(Number((e.currentTarget as HTMLInputElement).value))}
            class="w-28 cursor-pointer accent-accent"
          />
          <span class="w-9 text-right text-xs tabular-nums opacity-70"
            >{Math.round(prefs.volume * 100)}%</span
          >
        </div>
      {/snippet}
    </Field>
    <div class="px-4 pb-3">
      <p class={HINT}>{t("settings.notifyVolumeDesc")}</p>
    </div>
    <div class={ROW}>
      <button
        onclick={preview}
        class="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95"
      >
        {t("settings.soundTrial")}
      </button>
      <span class="text-xs opacity-50">{t("settings.soundTrialDesc")}</span>
    </div>
  </section>

  <section class={GROUP}>
    <ToggleRow label={t("settings.haptics")} on={prefs.vibrate} ontoggle={() => toggle("vibrate")} />
    <div class="px-4 pb-3">
      <p class={HINT}>{t("settings.hapticsDesc")}</p>
    </div>
  </section>
</div>

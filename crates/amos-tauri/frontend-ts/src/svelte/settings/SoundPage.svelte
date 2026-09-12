<script lang="ts">
  // SoundPage.svelte — 「声音与触感」sub page. The two policy bits live in
  // lib/sound (the single owner of the durable `amos.sound` key — the same policy
  // the status bar and the notification-arrival ring/haptic read), plus an
  // asset-free audible preview via lib/notifyTone.playNotifyTone (never throws,
  // safe in tests).
  import { flipSound, loadSound, saveSound, type SoundPolicy } from "../../lib/sound";
  import { playNotifyTone } from "../../lib/notifyTone";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, HINT } from "./kit";
  import Switch from "./Switch.svelte";

  let prefs = $state<SoundPolicy>(loadSound());
  const toggle = (key: keyof SoundPolicy) => {
    const next = flipSound(prefs, key);
    prefs = next;
    saveSound(next);
  };
  const preview = () => {
    playNotifyTone();
    if (!prefs.ring) toggle("ring"); // preview implies audible alerts enabled
  };
</script>

<div class="space-y-5">
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.notifySound")}</span>
      <Switch on={prefs.ring} aria={t("settings.notifySound")} ontoggle={() => toggle("ring")} />
    </div>
    <div class="px-4 pb-3">
      <p class={HINT}>{t("settings.notifySoundDesc")}</p>
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
    <div class={ROW}>
      <span class={LABEL}>{t("settings.haptics")}</span>
      <Switch on={prefs.vibrate} aria={t("settings.haptics")} ontoggle={() => toggle("vibrate")} />
    </div>
    <div class="px-4 pb-3">
      <p class={HINT}>{t("settings.hapticsDesc")}</p>
    </div>
  </section>
</div>

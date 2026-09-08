<script lang="ts">
  // SoundPage.svelte — 「声音与触感」sub page. New, genuinely persistent sound
  // preferences (lib/soundPrefs, durable amos.sound) + an asset-free audible
  // preview via lib/notifyTone.playNotifyTone (never throws, safe in tests).
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
  import { SOUND_KEY, flipSound, normalizeSound, type SoundPrefs } from "../../lib/soundPrefs";
  import { playNotifyTone } from "../../lib/notifyTone";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, HINT } from "./kit";
  import Switch from "./Switch.svelte";

  const initPrefs = normalizeSound(readStoreValue<unknown>(SOUND_KEY, {}));
  let prefs = $state<SoundPrefs>(initPrefs);
  const toggle = (key: keyof SoundPrefs) => {
    const next = flipSound(prefs, key);
    prefs = next;
    writeStoreValue(SOUND_KEY, next);
  };
  const preview = () => {
    playNotifyTone();
    if (!prefs.notify) toggle("notify"); // preview implies audible alerts enabled
  };
</script>

<div class="space-y-5">
  <section class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.notifySound")}</span>
      <Switch on={prefs.notify} aria={t("settings.notifySound")} ontoggle={() => toggle("notify")} />
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
      <Switch on={prefs.haptics} aria={t("settings.haptics")} ontoggle={() => toggle("haptics")} />
    </div>
    <div class="px-4 pb-3">
      <p class={HINT}>{t("settings.hapticsDesc")}</p>
    </div>
  </section>
</div>

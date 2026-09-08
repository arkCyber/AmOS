<script lang="ts">
  // LockPage.svelte — 「锁屏密码」sub page (the old LockSettings group relocated).
  // Enabling only succeeds with a valid 4–6 digit numeric passcode (lib/lock).
  import { readStoreValue, writeStoreValue } from "../../lib/amosStore";
  import { LOCK_KEY, makeLock, sanitizePin, type LockCfg } from "../../lib/lock";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, SUB, FIELD, HINT } from "./kit";
  import Switch from "./Switch.svelte";

  const lockInit = readStoreValue<LockCfg>(LOCK_KEY, { enabled: false });
  let lockCfg = $state<LockCfg>(lockInit);
  let lockOn = $state(lockInit.enabled);
  let lockPin = $state("");
  let lockMsg = $state("");
  $effect(() => {
    const clean = sanitizePin(lockPin);
    if (clean !== lockPin) lockPin = clean;
  });
  const saveLock = () => {
    const next = makeLock(lockOn, lockPin, lockCfg);
    lockCfg = next;
    lockOn = next.enabled;
    writeStoreValue(LOCK_KEY, next);
    lockMsg = lockOn && !next.enabled ? t("lock.pin") : t("lock.saved");
  };
</script>

<section class={GROUP}>
  <div class={ROW}>
    <span class={LABEL}>{t("lock.enable")}</span>
    <Switch on={lockOn} aria={t("lock.enable")} ontoggle={() => (lockOn = !lockOn)} />
  </div>
  <p class="px-4 pb-3 text-xs opacity-60">
    {lockCfg.enabled ? t("lock.stateOn") : t("lock.stateOff")}
    {lockCfg.pin ? ` ${t("lock.pinSet")}` : ""}
  </p>
  {#if lockOn}
    <div class={SUB}></div>
    <div class="flex items-center gap-2 px-4 py-3">
      <input bind:value={lockPin} placeholder={t("lock.pin")} inputmode="numeric" class={FIELD} />
      <button
        onclick={saveLock}
        class="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95"
      >
        {t("lock.save")}
      </button>
    </div>
  {/if}
  {#if lockMsg}
    <div class="px-4 pb-3">
      <p class={HINT}>{lockMsg}</p>
    </div>
  {/if}
</section>

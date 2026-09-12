<script lang="ts">
  // LockPage.svelte — 「锁屏密码」sub page (the old LockSettings group relocated).
  // Enabling only succeeds with a valid 4–6 digit numeric passcode (lib/lock).
  import { readStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
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
    // What the user *asked for*, captured before the policy has its say: `makeLock` may
    // refuse the enable (no usable 4–6 digit passcode), and in that case the page must not
    // say "Saved" (REQ-A149). This is the whole difference from the previous code, whose
    // condition `lockOn && !next.enabled` compared the *already updated* `lockOn` with
    // `next.enabled` — always false, so its `lock.pin` branch was dead and an enable that
    // the policy refused was reported as a successful save.
    const wanted = lockOn;
    const typed = sanitizePin(lockPin);
    const next = makeLock(wanted, lockPin, lockCfg);
    // A passcode that only *looks* saved is a security claim, not a cosmetic one: the
    // state changes only if the store really accepted the new config.
    if (!writeStoreValueChecked(LOCK_KEY, next)) {
      lockMsg = t("lock.saveFailed");
      return;
    }
    lockCfg = next;
    lockOn = next.enabled;
    const refusedEnable = wanted && !next.enabled;
    // Refused a *changed* passcode while keeping the previous one: the enable stands, so
    // only the "Saved" claim was wrong — the user has to hear that the new digits did not
    // take either way.
    const refusedPin = wanted && typed !== "" && next.pin !== typed;
    lockMsg = refusedEnable || refusedPin ? t("lock.pin") : t("lock.saved");
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

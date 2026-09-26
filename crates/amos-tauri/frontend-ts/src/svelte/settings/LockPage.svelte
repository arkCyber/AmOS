<script lang="ts">
  // LockPage.svelte — 「锁屏密码」sub page (the old LockSettings group relocated).
  // Enabling only succeeds with a valid 4–6 digit numeric passcode (lib/lock).
  import { readStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
  import { LOCK_KEY, makeLock, sanitizePin, type LockCfg } from "../../lib/lock";
  import {
    biometricAuthenticate,
    biometricAvailable,
    biometricHwUnavailable,
    biometricNeedsEnrollment,
    biometricNoHardware,
    biometricReady,
    biometricUnknown,
    type BiometricAvailability,
    type BiometricKind,
  } from "../../lib/biometric";
  import { t } from "../locale.svelte";
  import { GROUP, SUB, FIELD, HINT, VALUE } from "./kit";
  import ToggleRow from "./ToggleRow.svelte";

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

  /**
   * 生物识别半边（REQ-A528）。
   *
   * 这一页此前**只有密码**，而索引的搜索别名一直写着「面容」 —— 搜索会把想找 Face ID 的用户送到
   * 这里，然后什么都不给。`lib/biometric.ts` 的实现、文档与测试早就齐备（它的头部写着 modal 必须
   * 由**用户手势**触发、`available` 不解释原因、`fallback` 必须被当成"验证过"来处理），宿主侧两条
   * 命令也已注册 ⇒ 缺的只是这个面。
   *
   * 三条不撒谎的规则，逐条对着那个模块的语义：
   *   * `null` = 没有桥（桌面/宿主）⇒ 说"此设备没有生物识别"，并且**不画按钮**（画一个按了不会成功
   *     的按钮就是 REQ-A468 那种缺陷）；
   *   * 有硬件但没登记 ⇒ 说清"要先在系统设置里登记"，也不画按钮（平台会立刻以 `not_enrolled` 拒绝）；
   *   * 四种非成功结果各有各的话：回退（用户选了设备密码）、取消（**不是失败**）、不可用、错误；
   *     错误字符串原样显示（`{ error }`），不吞。
   *
   * 还有一条边界写在文案里：这一项**只验证身份，不放行任何操作** —— 目前本仓没有任何路径由它放行，
   * 说成"解锁/保护"会是谎（`lock.biometricHint`）。
   */
  let avail = $state<BiometricAvailability | null>(null);
  /**
   * 是否已经拿到宿主的回答。**在拿到之前不能说"不支持"** —— 首帧就断言"此设备没有生物识别"，
   * 对有生物识别的设备是一句假话（i18n 的"死键"检查抓到的：`lock.biometricChecking` 写了但没用，
   * 因为我把"还没回答"和"回答是不支持"画成了同一个状态）。
   */
  let availChecked = $state(false);
  let availLoaded = false;
  let verifying = $state(false);
  let bioMsg = $state("");

  $effect(() => {
    if (availLoaded) return;
    availLoaded = true;
    void loadBiometric();
  });

  async function loadBiometric() {
    avail = await biometricAvailable(); // `null` = no bridge (desktop/host), never a throw
    availChecked = true;
  }

  /**
   * 宿主报的名字优先（平台自己知道该叫"面容 ID"还是"指纹"），否则按 `kind` 取**本地化**名。
   *
   * 这里刻意不用 `lib/biometric.ts` 曾经的 `biometricLabel()`：它返回的是**写死的中文**，
   * 而这一页跟随语言 ⇒ 英文界面会显示中文。文案归 i18n，lib 不该带单语言的副本
   * （那个助手已在 REQ-A528 删除，理由写在 CHANGELOG 里）。
   */
  const kindKey = (kind: BiometricKind): string =>
    kind === "face"
      ? "lock.biometricKindFace"
      : kind === "fingerprint"
        ? "lock.biometricKindFingerprint"
        : kind === "iris"
          ? "lock.biometricKindIris"
          : kind === "biometric"
            ? "lock.biometricKindBiometric"
            : "lock.biometricKindNone";
  const bioName = $derived(avail && avail.label ? avail.label : t(kindKey(avail?.kind ?? "none")));
  const bioReady = $derived(biometricReady(avail));
  const bioNeedsEnrollment = $derived(biometricNeedsEnrollment(avail));
  const bioHwUnavailable = $derived(biometricHwUnavailable(avail));
  const bioNoHardware = $derived(biometricNoHardware(avail));
  // 「没有答案」与「设备说没有」分开（REQ-A779）：这一档绝不能说任何关于硬件的话。
  const bioUnknown = $derived(biometricUnknown(avail));

  async function verifyBiometric() {
    verifying = true;
    bioMsg = "";
    // 用户手势触发的调用（按钮点击）：平台要求如此，静默触发会被直接拒绝。
    const r = await biometricAuthenticate(t("lock.biometricReason"));
    verifying = false;
    if (r.ok) {
      switch (r.result) {
        case "authenticated":
          bioMsg = t("lock.biometricOk");
          return;
        case "fallback":
          bioMsg = t("lock.biometricFallback");
          return;
        case "cancelled":
          bioMsg = t("lock.biometricCancelled");
          return;
        case "unavailable":
          bioMsg = t("lock.biometricUnavailableResult");
          return;
      }
      return;
    }
    switch (r.error) {
      case "not_enrolled":
        bioMsg = t("lock.biometricNotEnrolled");
        return;
      case "locked_out":
        bioMsg = t("lock.biometricLockedOut");
        return;
      default:
        // 平台自己的错误串照实说 —— 吞掉它就会变成"按了没反应"。
        bioMsg = t("lock.biometricError", { error: r.error });
    }
  }
</script>

<section class={GROUP}>
  <ToggleRow
    label={t("lock.enable")}
    on={lockOn}
    ontoggle={() => (lockOn = !lockOn)}
  />
  <p class="px-4 pb-3 text-xs opacity-60">
    {lockCfg.enabled ? t("lock.stateOn") : t("lock.stateOff")}
    {lockCfg.pin ? ` ${t("lock.pinSet")}` : ""}
  </p>
  {#if lockOn}
    <div class={SUB}></div>
    <div class="flex items-center gap-2 px-4 py-3">
      <!-- The only visible affordance of this field is its placeholder, so the name is the
           `aria-label` carrying that same string (REQ-A283) — not `<label for>`, which would
           have added text the design does not show. -->
      <input
        bind:value={lockPin}
        placeholder={t("lock.pin")}
        aria-label={t("lock.pin")}
        inputmode="numeric"
        class={FIELD}
      />
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
      <!-- The save result is announced: "Saved" / "refused" / "failed" is the answer to an
           action, and a screen-reader user who pressed 保存 must hear it (REQ-A283). -->
      <p class={HINT} role="status">{lockMsg}</p>
    </div>
  {/if}
  <!-- REQ-A1131：这一页一直在说密码的**位数**，从不说它挡住了什么。机制是界面门禁而不是
       保密边界（不加密、明文保存），并且**刻意**不设错误次数锁定（本机没有找回密码的途径，
       锁死会把数据一起关在外面）。边界写在用户形成信念的这里，与上面生物识别那一行的形状一致。 -->
  <p class="px-4 pb-3 text-xs opacity-60">{t("lock.passcodeHint")}</p>
</section>

<!-- 生物识别（REQ-A528）：与密码同页，因为索引的搜索别名把「面容」指到了这里 -->
<section class={GROUP} data-testid="lock-biometric">
  <div class="flex items-center justify-between gap-3 px-4 py-3">
    <span class="text-ios-body text-neutral-800 dark:text-neutral-100">{t("lock.biometric")}</span>
    <span class={VALUE}>
      <!-- 四档，不能合并（REQ-A779）：只有 `not-enrolled` 能说"去登记"，只有 `no-hardware`
           能说"本机没有"，而"平台没回答"那一档必须承认自己不知道 —— 上一版把后两档
           合成了一句"没有生物识别"，于是没有传感器的手机被指去登记指纹。 -->
      {#if !availChecked}
        {t("lock.biometricChecking")}
      {:else if bioReady}
        {t("lock.biometricReady", { label: bioName })}
      {:else if bioNeedsEnrollment}
        {t("lock.biometricNeedsEnrollment")}
      {:else if bioHwUnavailable}
        {t("lock.biometricHwUnavailable")}
      {:else if bioNoHardware}
        {t("lock.biometricUnsupported")}
      {:else if bioUnknown}
        {avail?.detail
          ? t("lock.biometricUnknownDetail", { detail: avail.detail })
          : t("lock.biometricUnknown")}
      {:else}
        {t("lock.biometricUnknown")}
      {/if}
    </span>
  </div>
  {#if bioReady}
    <div class={SUB}></div>
    <div class="px-4 py-3">
      <!-- 只在**真的可用**时才画按钮：`available` 为假时平台会立刻拒绝，画出来就是"按了不会成功
           的按钮"（REQ-A468 的教训）。名称是可见文案本身，不是第二个名字（REQ-A283）。 -->
      <button
        onclick={verifyBiometric}
        disabled={verifying}
        class="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95 disabled:opacity-50"
      >
        {verifying ? t("lock.biometricVerifying") : t("lock.biometricVerify", { label: bioName })}
      </button>
    </div>
  {/if}
  {#if bioMsg}
    <div class="px-4 pb-3">
      <p class={HINT} role="status">{bioMsg}</p>
    </div>
  {/if}
  <p class="px-4 pb-3 text-xs opacity-60">{t("lock.biometricHint")}</p>
</section>

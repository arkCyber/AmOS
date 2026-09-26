<script lang="ts">
  // AboutPage.svelte — 「关于本机」sub page. Shows only genuinely obtainable data:
  // OS/build identity from lib/version (this UI client) plus live device telemetry
  // (battery / charging) from the daemon when bridged via lib/system. Nothing is
  // fabricated — offline device fields show the honest "—" placeholder.
  import {
    systemStatusWithHostBattery,
    normalizeSystemHealth,
    type SystemStatus,
  } from "../../lib/system";
  import { bridged } from "../../lib/backend";
  import { AMOS_OS_NAME, AMOS_UI_VERSION, AMOS_DEVICE_LABEL } from "../../lib/version";
  import { CELLULAR_KEY, defaultCellular, normalizeCellular } from "../../lib/cellular";
  import {
    cellularService,
    cellularStateKey,
    type RadioSignal,
  } from "../../lib/cellularService";
  import { cellularRadio } from "../cellularRadio";
  import { readStoreValue } from "../../lib/amosStore";
  import {
    otaStatus,
    otaCheck,
    otaOutcome,
    otaOutcomeKey,
    otaReasonKey,
    otaInstall,
    otaInstallOutcome,
    otaInstallOutcomeKey,
    readOtaFacts,
    type OtaStatus,
    type OtaCheckResult,
    type OtaCheckRecord,
    type OtaInstallResult,
  } from "../../lib/ota";
  import { readOtaCheckRecord, recordOtaCheck } from "../osOtaWatcher";
  import { t } from "../locale.svelte";
  import { GROUP, ROW, LABEL, VALUE, HINT } from "./kit";

  let sys = $state<SystemStatus>(normalizeSystemHealth(null));
  let connected = $state(false);
  let lastProbe = $state(0);

  // System update (OTA): the host's check against the `amos-ota` decision core.
  // Identity is read once; the decision is only taken when the user asks, because
  // it depends on live facts (battery / network) the host must be handed.
  let ota = $state<OtaStatus | null>(null);
  let otaResult = $state<OtaCheckResult | null>(null);
  let checking = $state(false);
  // The **install** is a separate, deliberate step: the check only reports an
  // offer. `staged` is the best outcome and means downloaded+verified, not
  // applied — a reboot the runtime performs (see the copy below).
  let installing = $state(false);
  let installResult = $state<OtaInstallResult | null>(null);
  // The 「上次检查」 record, seeded from storage at mount. `amos.ota` has **two**
  // producers of a check — the shell's background watcher (`osOtaWatcher`) and the
  // 「检查更新」 button below — so it is `$state`, not a mount-time snapshot: a check
  // taken here is a check, and the row that answers "when did we last check?" must
  // follow it rather than keep quoting an older one (REQ-A1530 ∕ F-SH-773). It is
  // still only the *record*; the button asks the host live, never this.
  let lastCheck = $state<OtaCheckRecord | null>(readOtaCheckRecord());

  // REQ-A204 (same defect class as REQ-A79): a one-shot battery read goes stale
  // the moment it is taken. While this page is open, re-probe the daemon every
  // 10 s — visible tab only — and stamp each answer so the readout always shows
  // when it was last taken. A null answer (daemon dropped) resets the row to the
  // honest "—" instead of leaving an old percentage on screen.
  const ABOUT_PROBE_MS = 10_000;
  $effect(() => {
    if (!bridged()) return;
    connected = true;
    let alive = true;
    const probe = async () => {
      const raw = await systemStatusWithHostBattery();
      if (!alive) return;
      sys = raw ?? normalizeSystemHealth(null);
      lastProbe = Date.now();
    };
    void probe();
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void probe();
    }, ABOUT_PROBE_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  });

  // Identity/status of the update source: read once when bridged. A null answer
  // (offline) leaves `ota` null and the section reports the honest "not connected".
  $effect(() => {
    if (!bridged()) return;
    let alive = true;
    void otaStatus().then((s) => {
      if (alive) ota = s;
    });
    return () => {
      alive = false;
    };
  });

  /**
   * Ask the host for a decision. The facts are gathered by `readOtaFacts`
   * (`lib/ota`) — the same helper the shell's background watcher uses, so the two
   * surfaces can never hand the host different answers to the same question. The
   * reasoning behind the Wi-Fi rule (a *bearer* question, not a glyph question)
   * lives there.
   */
  async function checkForUpdate() {
    if (checking) return;
    checking = true;
    // A fresh check supersedes the offer the previous install verdict described — so that
    // verdict is retracted here, before the new one lands. Left standing it would sit under
    // a decision it does not belong to (「已下载并校验」 beside 「已是最新」), which is a
    // rendered claim about the current state that nothing in the current state supports
    // (REQ-A1454).
    installResult = null;
    try {
      const result = await otaCheck(await readOtaFacts());
      otaResult = result;
      // A check the user takes here *is* a check, so it becomes the 「上次检查」 record
      // — but only when the host actually answered. `null` is "no answer" (unbridged,
      // or the command threw), and stamping it would overwrite a real verdict with a
      // state we never observed (the rule `otaWatcherTick` already states for its own
      // tick). A refused write still leaves `lastCheck` following this session.
      if (result !== null) lastCheck = recordOtaCheck(result);
    } finally {
      checking = false;
    }
  }

  /**
   * Download and verify the offered update from the host's configured image.
   *
   * This is the deliberate second step: a check only says an update *exists*.
   * The host stages and verifies the bytes; it does **not** flash — applying the
   * image is a reboot the runtime owns — so the copy below never says
   * "installed".
   */
  async function installUpdate() {
    if (installing) return;
    installing = true;
    try {
      installResult = await otaInstall(await readOtaFacts());
    } finally {
      installing = false;
    }
  }

  const updateOutcome = $derived(otaOutcome(otaResult));
  // The `{version}` param is only meaningful for the "available" headline; passing
  // it to the others is harmless (translate leaves an unused param interpolated away).
  const updateHeadline = $derived(
    t(otaOutcomeKey(updateOutcome), { version: otaResult?.version ?? "" }),
  );
  const updateReason = $derived(
    otaResult?.reason_code ? t(otaReasonKey(otaResult.reason_code)) : "",
  );
  const updateChannel = $derived(otaResult?.channel ?? ota?.channel ?? "—");
  // An unusable `AMOS_OTA_CHANNEL` is an operator error the host refuses to answer
  // for, so it is *shown* rather than folded away: the channel cell above would
  // otherwise read the `stable` fallback lane as if the operator had chosen it. The
  // host's own message is rendered verbatim (as `installDetail` is), because it is
  // the only text that names the offending variable and value.
  const updateChannelError = $derived(ota?.channel_error ?? "");
  // The source a check will read. The host states whether one exists *without*
  // running a check, so the page can say "no update source" up front instead of
  // only reporting `unconfigured` a gesture later. `source` is the host's own path
  // (empty when unconfigured) and is shown verbatim — never a fabricated one; "—"
  // is the honest cell when the host never answered at all (offline).
  const otaSource = $derived(
    ota === null
      ? "—"
      : ota.configured
        ? ota.source
        : t("settings.updateSourceUnconfigured"),
  );

  // The install's own verdict. A non-null reason (the failure's cause) takes
  // precedence over the generic sentence, so the user sees *why* it failed rather
  // than "failed".
  const installOutcome = $derived(otaInstallOutcome(installResult));
  const installHeadline = $derived(t(otaInstallOutcomeKey(installOutcome)));
  const installDetail = $derived(
    installResult?.fail_reason ?? installResult?.detail ?? "",
  );
  // A staged install whose signer was not established still says 「已下载并校验完成」 —
  // true of the *integrity* check, but the sentence is read as "this image is
  // genuine". The verdict the host reports is the missing half, so it gets its own
  // line (and the key id, when there is one) rather than being folded into the
  // failure detail above.
  //
  // Two ways that half can be missing, and they need different words:
  //  * `untrusted` — the host checked and refused the signer.
  //  * `trusted` but `verified_by !== "ed25519"` — the host could only match the
  //    key *id* against a list and ran no cryptography (`amos-ota::TrustingVerifier`,
  //    documented as *not a security boundary*). The verdict is `trusted` because
  //    the id is on the list, which is not the same claim. Anything other than
  //    `"ed25519"` — including a host too old to send the field — is treated as the
  //    weak mode: an unknown strength must never be read as the strong one.
  // `missing` is already refused by the policy gate before an install is offered.
  const installSignature = $derived.by(() => {
    const sig = installResult?.signature;
    if (!sig) return null;
    if (sig.verdict === "untrusted") {
      return { kind: "untrusted" as const, key: sig.key_id ?? "—" };
    }
    if (sig.verdict === "trusted" && sig.verified_by !== "ed25519") {
      return { kind: "policy" as const, key: sig.key_id ?? "—" };
    }
    return null;
  });
  // Only an `eligible` check can be installed; the button is hidden otherwise so
  // there is no way to press it for an update the host has not offered.
  const canInstall = $derived(
    updateOutcome === "update-available" && !checking && !installing,
  );
  // When the last recorded check was taken (background poller or this page's own
  // button). Empty ⇒ no check has ever been recorded, and the line says so rather
  // than implying a recent one.
  const checkedAt = $derived(
    lastCheck === null ? "" : new Date(lastCheck.at).toLocaleTimeString(),
  );

  // The radio half comes from the shared store (installed once, at Notification Center
  // mount, from the host's `cellular_signal`). 这里过去写死 `defaultRadioSignal()`，于是
  // 真机上「关于本机」说「无蜂窝服务」而通知中心画着信号格 —— 一个事实两个来源。
  // `null` 是第三态：这一行**印一句话**，所以「宿主没答过」不能印成「本机无 SIM」——
  // 那是关于用户设备的断言，而这条路径上什么也没建立（REQ-A1539 ∕ F-SH-780）。
  let radio = $state<RadioSignal | null>(null);
  $effect(() => {
    const un = cellularRadio.subscribe((v) => (radio = v));
    return un;
  });
  const cellularValue = $derived(
    radio === null
      ? t("settings.cellularUnknown")
      : t(
          cellularStateKey(
            cellularService(
              normalizeCellular(readStoreValue(CELLULAR_KEY, defaultCellular())),
              radio,
            ),
          ),
        ),
  );

  const batteryLabel = $derived(
    sys.battery_level_pct === null
      ? "—"
      : `${Math.round(sys.battery_level_pct)}%${sys.battery_charging === true ? " · " + t("settings.aboutCharging") : ""}`,
  );

  const probeStamp = $derived(
    lastProbe === 0
      ? ""
      : new Date(lastProbe).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
  );
</script>

<div class="space-y-5">
  <!-- systemStatus aria-label: the live-status section's accessible name — a screen
       reader that lands on any row in this <section> hears "System status" before the
       row label, so the live readings are situated in their containing region rather
       than reading as bare "Battery 67%". (REQ-A284) -->
  <section class={GROUP} aria-label={t("a11y.systemStatus")}>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.aboutDevice")}</span>
      <span class={VALUE}>{AMOS_DEVICE_LABEL}</span>
    </div>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.aboutOs")}</span>
      <span class={VALUE}>{AMOS_OS_NAME}</span>
    </div>
    <div class={ROW}>
      <span class={LABEL}>{t("settings.aboutVersion")}</span>
      <span class={VALUE}>v{AMOS_UI_VERSION}</span>
    </div>
    <div class={ROW} data-testid="about-battery">
      <span class={LABEL}>{t("settings.aboutBattery")}</span>
      <!-- aria-live="polite" + aria-atomic="true": the visible label and the changing
           percentage both go to assistive tech as one utterance ("Battery 67%"). The
           label is duplicated in the aria text on purpose — when the user lands on this
           row they hear WHAT is changing and TO WHAT, not just the new number. (REQ-A284) -->
      <span class={VALUE} aria-live="polite" aria-atomic="true">
        <span class="sr-only">{t("settings.aboutBattery")}: </span>{batteryLabel}
      </span>
    </div>
    {#if probeStamp}
      <div class="px-4 pb-3" data-testid="about-probe">
        <!-- sr-only probeLabel: a screen-reader user who tabs onto the live timestamp hears
             "Last updated: 14:32:07" — without the prefix the bare time reads as a number
             out of context. (REQ-A284) -->
        <p class={HINT} aria-live="polite">
          <span class="sr-only">{t("a11y.probeLabel")}: </span>{t("settings.aboutProbe", { time: probeStamp })}
        </p>
      </div>
    {/if}
    <div class={ROW} data-testid="about-cellular">
      <span class={LABEL}>{t("settings.aboutCellular")}</span>
      <!-- Same polite live-region pattern: cellular signal can shift edge/4G/5G; the
           visible label + the new state announce together. (REQ-A284) -->
      <span class={VALUE} aria-live="polite" aria-atomic="true">
        <span class="sr-only">{t("settings.aboutCellular")}: </span>{cellularValue}
      </span>
    </div>
  </section>

  <!-- System update: the host's check against the `amos-ota` decision core.

       Two ways a decision is taken. The shell runs a slow **background check**
       (`osOtaWatcher`) so a user who never opens this page still learns an update
       exists; the button below takes a fresh decision **now**, with the live
       battery/network facts the host needs — the two share one fact-gathering helper
       (`readOtaFacts`). Both record into `amos.ota`, so the 「上次检查」 line quotes
       whichever check was last: a check taken here is a check (REQ-A1530 ∕ F-SH-773).

       Only the *install* is gated behind an explicit gesture: a background check is
       an offer, but a background download-and-verify is not something a user asked
       for. The outcome is a polite live region so a screen reader hears the verdict. -->
  <section class={GROUP} aria-label={t("settings.updateSection")} data-testid="about-update">
    <div class={ROW}>
      <span class={LABEL}>{t("settings.updateChannel")}</span>
      <span class={VALUE} data-testid="update-channel">{updateChannel}</span>
    </div>
    {#if updateChannelError}
      <div class={ROW} data-testid="update-channel-error">
        <span class={LABEL}>{t("settings.updateChannelError")}</span>
        <!-- The host's diagnostic, verbatim: it names the variable and the value. -->
        <span class={VALUE} data-testid="update-channel-error-value">{updateChannelError}</span>
      </div>
    {/if}
    <div class={ROW} data-testid="update-source">
      <span class={LABEL}>{t("settings.updateSource")}</span>
      <span class={VALUE}>{otaSource}</span>
    </div>
    <div class={ROW} data-testid="update-last-check">
      <span class={LABEL}>{t("settings.updateLastCheck")}</span>
      <!-- No recorded check yet is its own sentence, never a fabricated time. -->
      <span class={VALUE}>{checkedAt || t("settings.updateNeverChecked")}</span>
    </div>
    <div class={ROW}>
      <button
        type="button"
        onclick={checkForUpdate}
        disabled={checking}
        class="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white shadow-md transition hover:opacity-90 disabled:opacity-50"
      >
        {checking ? t("settings.updateChecking") : t("settings.updateCheck")}
      </button>
      {#if canInstall}
        <button
          type="button"
          onclick={installUpdate}
          disabled={installing}
          class="ml-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white shadow-md transition hover:opacity-90 disabled:opacity-50"
          data-testid="update-install"
        >
          {installing ? t("settings.updateInstalling") : t("settings.updateInstall")}
        </button>
      {/if}
    </div>
    <div class="px-4 pb-3" data-testid="update-outcome">
      <p class={HINT} aria-live="polite" aria-atomic="true">{updateHeadline}</p>
      {#if updateReason}
        <p class="mt-1 text-ios-footnote text-neutral-500 dark:text-neutral-400">{updateReason}</p>
      {/if}
      <p class="mt-2 text-ios-footnote opacity-60">{t("settings.updateNote")}</p>
    </div>
    {#if installResult}
      <div class="px-4 pb-3" data-testid="update-install-outcome">
        <p class={HINT} aria-live="polite" aria-atomic="true">{installHeadline}</p>
        {#if installDetail}
          <p class="mt-1 text-ios-footnote text-neutral-500 dark:text-neutral-400">{installDetail}</p>
        {/if}
        {#if installSignature}
          <p
            class="mt-1 text-ios-footnote {installSignature.kind === 'untrusted'
              ? 'text-danger'
              : 'text-neutral-500 dark:text-neutral-400'}"
            data-testid="update-install-signature"
          >
            {installSignature.kind === "untrusted"
              ? t("settings.updateInstallSignatureUntrusted", { key: installSignature.key })
              : t("settings.updateInstallSignaturePolicyOnly", { key: installSignature.key })}
          </p>
        {/if}
      </div>
    {/if}
  </section>
  {#if !connected}
    <p class="px-1 text-xs opacity-50">{t("settings.aboutOffline")}</p>
  {/if}
</div>

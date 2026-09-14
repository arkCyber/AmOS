<script lang="ts">
  // WindowPage.svelte — 「窗口与形态」sub page.
  //
  // The window host is the only authority on which *kind* of device this build
  // resolved (`amos_wm::form::FormFactor`) and what the shell may therefore do
  // (content columns, multiple windows, free resize, divider width, and whether a
  // split is live right now). This page reads that authority and shows it —
  // raw — instead of the UI guessing from the WebView's width, which is the very
  // mistake `docs/multi-window.md` §1.5 warns about (a phone and a tablet are one
  // build).
  //
  // Honesty rules (same as AboutPage's battery probe, REQ-A204):
  //   * no host (browser preview) → every value shows “—” and the page says why;
  //   * a `null` answer (host gone) → back to “—”, never the last reading;
  //   * updates are **pushed** by the host's `layout-changed` event (the host only
  //     emits on a real change), so nothing here polls or fabricates.
  //
  // The split **controls** (REQ-A224) drive the host commands the page previously
  // only read about: every wrapper in `lib/wm.ts` had tests and zero consumers, so
  // the feature was unreachable from the shell (`scripts/unwired-scan.mjs` listed
  // all of them). The controls do not decide *how* panes render — the host already
  // applies them to real OS windows via `apply_split_to_real` — they only let the
  // user ask. Rules kept: a command that answers `null` (host absent, refused, or
  // failed) **never** updates the readout, because a failed action must not look
  // like it happened; the failure is in the diagnostics ledger, and the page says
  // so instead of guessing.
  import { onMount } from "svelte";
  import {
    describeSplit,
    onLayoutChanged,
    splitActive,
    wmLayoutSnapshot,
    wmSplit,
    wmSplitCandidates,
    wmSplitExit,
    wmSplitMove,
    wmSplitSwap,
    wmWindows,
    type FormFactor,
    type LayoutSnapshot,
    type WmWindowsSnapshot,
  } from "../../lib/wm";
  import { bridged } from "../../lib/backend";
  import { t } from "../locale.svelte";
  import { GROUP, H2, HINT, LABEL, ROW, SUB, VALUE } from "./kit";

  let snap = $state<LayoutSnapshot | null>(null);
  let hasHost = $state(false);
  /** Window labels the host offers for a new split — never invented here. */
  let candidates = $state<string[]>([]);
  /** A command is in flight: further presses are ignored rather than queued. */
  let busy = $state(false);
  /** i18n key of the last action's honest outcome note (`null` = nothing to say). */
  let noteKey = $state<string | null>(null);
  /** The host's window list (`wm_windows`) — the debug card's own read. `null`
   * means "the host did not answer", never "the previous answer still stands". */
  let winSnap = $state<WmWindowsSnapshot | null>(null);

  /**
   * Re-read the host's window list.
   *
   * Runs on mount, on the host's own `layout-changed` push (a window was created,
   * focused or closed — exactly when the list changes) and on the card's 刷新
   * button. A failed/absent answer clears the readout to `null` instead of keeping
   * the previous list: a debug surface that shows a window which no longer exists
   * is worse than one that says "no answer" (`lib/backend.ts` logs the failure).
   */
  async function refreshWindows(): Promise<void> {
    winSnap = await wmWindows();
  }

  /**
   * Ask the host which windows it can offer for a split.
   *
   * A failed/absent answer **clears** the list instead of keeping the previous one:
   * offering 「进入分屏」 on a list we can no longer vouch for would be a fabricated
   * capability. The failure is already in the diagnostics ledger (`lib/backend.ts`).
   */
  async function refreshCandidates(): Promise<void> {
    candidates = (await wmSplitCandidates()) ?? [];
  }

  // Bounded re-probe while the page is visible, mirroring AboutPage's battery
  // probe (REQ-A204): a subscription alone cannot tell us the host *went away* —
  // no event ever arrives for a host that stopped existing, so the readout would
  // keep showing its last reading forever (the very staleness class REQ-A218 fixed
  // on the host side). Each tick re-reads the truth: `null` ⇒ back to “—”, and a
  // bridge that only appears later is picked up too.
  const PROBE_MS = 10_000;
  onMount(() => {
    let alive = true;
    const probe = async () => {
      hasHost = bridged();
      // `wmLayoutSnapshot` resolves to `null` (never rejects) when the host is
      // absent or answers with an error — `lib/backend.ts`'s `invoke` records the
      // failure in the diagnostics ledger.
      const s = await wmLayoutSnapshot();
      if (!alive) return;
      snap = s;
      // Candidates are only meaningful while no split is live (the host offers the
      // front two shown non-Launcher windows); re-read them with the same tick so a
      // newly opened app becomes enterable without an extra interaction.
      if (s && !splitActive(s)) await refreshCandidates();
      // The window list is the host's own state too — re-read it on the same tick
      // so the debug card can never show a window that has been gone for a whole
      // probe interval.
      await refreshWindows();
    };
    void probe();
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void probe();
    }, PROBE_MS);
    // …and the moment the page becomes visible again, re-read **immediately**
    // instead of waiting up to one whole interval: a hidden tab keeps no fresh
    // reading (its ticks are skipped), so coming back to it would otherwise show a
    // value up to `PROBE_MS` old.
    const onVisible = () => {
      if (document.visibilityState === "visible") void probe();
    };
    document.addEventListener("visibilitychange", onVisible);
    // Live pushes for the rest of the visit (the host emits only on real changes).
    let off: (() => void) | null = null;
    void onLayoutChanged((s) => {
      if (!alive) return;
      snap = s;
      // A push is the host saying something really changed — windows opened, closed,
      // or a split started/ended — so the candidate list is re-read with the same
      // freshness as the readout. Otherwise the controls could offer (or act on) a
      // list the host has since changed, for up to one whole probe interval.
      if (!splitActive(s)) void refreshCandidates();
      // A push is also the moment the window list itself can change (created,
      // focused, closed, a container surface torn down) — refresh it in the same
      // breath, so the debug card follows the same "push = read now" rule.
      void refreshWindows();
    }).then((f) => {
      off = f;
    });
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      off?.();
    };
  });

  /** The class the host reported, as localized text. */
  function formLabel(f: FormFactor | undefined): string {
    switch (f) {
      case "tablet":
        return t("wm.form.tablet");
      case "desktop":
        return t("wm.form.desktop");
      case "robot":
        return t("wm.form.robot");
      default:
        return t("wm.form.phone");
    }
  }

  /** A value is only shown when a host actually answered (never a stale/fake one). */
  const show = (v: string) => (snap ? v : t("wm.unavailable"));
  const yesNo = (v: boolean) => show(v ? t("wm.yes") : t("wm.no"));

  /**
   * Run one split command and adopt the host's answer as the new truth.
   *
   * * a snapshot answer → it *is* the host's post-action state: show it, drop any
   *   previous note;
   * * `null` (no host, refused, or failed) → keep the last authoritative snapshot
   *   and say the action did not take effect. Nothing is guessed, and the ledger
   *   has the detail;
   * * one command at a time, and `busy` is always released (a stuck flag would
   *   permanently disable the controls).
   */
  async function act(
    run: () => Promise<LayoutSnapshot | null>,
    after?: () => Promise<void>,
  ): Promise<void> {
    if (busy) return;
    busy = true;
    noteKey = null;
    try {
      const next = await run();
      if (next) {
        snap = next;
        if (after) await after();
      } else {
        noteKey = "wm.actionFailed";
      }
    } finally {
      busy = false;
    }
  }

  /** The host picks the axis (`auto`) from the real screen's aspect. */
  const enterSplit = () => {
    // Two windows are the host's own minimum; the control is disabled without them,
    // and this guard keeps the request honest even if it is somehow triggered.
    const [primary, secondary] = candidates;
    if (!primary || !secondary) return;
    void act(() => wmSplit(primary, secondary, "auto"));
  };
  const swapPanes = () => void act(() => wmSplitSwap());
  const exitSplit = () => void act(() => wmSplitExit(), refreshCandidates);
  const nudge = (delta: number) => void act(() => wmSplitMove(delta));

  /** May this class even be asked for a split? (`multi_window` is the host's own
   * capability answer; a phone answers `false`, and the host would refuse too.) */
  const canSplit = $derived(snap !== null && snap.multi_window);
  const live = $derived(snap !== null && splitActive(snap));
  /** Is there a window the host cannot place (a `legacy:*` container surface)? Then
   * the split control needs to say why it is missing from 可分屏窗口 — the debug card
   * right below shows it, and the user would otherwise read the absence as a bug. */
  const hasExternalWindow = $derived(winSnap?.windows.some((w) => w.external) ?? false);
</script>

<div class="flex flex-col gap-3 px-4 pb-6 pt-2">
  {#if !hasHost}
    <p class={HINT} data-testid="wm-no-host">{t("wm.noHost")}</p>
  {:else if !snap}
    <!-- Bridged, but the window host did not answer: a different fact from "no
         bridge at all", and stated as such (the "unknown authority vs empty
         authority" distinction the permission surface also makes). -->
    <p class={HINT} data-testid="wm-no-answer">{t("wm.noAnswer")}</p>
  {/if}

  <div class={GROUP}>
    <div class={ROW}>
      <span class={LABEL}>{t("wm.form")}</span>
      <span class={VALUE} data-testid="wm-form">{show(formLabel(snap?.form))}</span>
    </div>
    <div class={SUB}></div>
    <div class={ROW}>
      <span class={LABEL}>{t("wm.columns")}</span>
      <span class={VALUE} data-testid="wm-columns">{show(String(snap?.columns ?? 0))}</span>
    </div>
    <div class={SUB}></div>
    <div class={ROW}>
      <span class={LABEL}>{t("wm.multiWindow")}</span>
      <span class={VALUE} data-testid="wm-multi-window">{yesNo(snap?.multi_window ?? false)}</span>
    </div>
    <div class={SUB}></div>
    <div class={ROW}>
      <span class={LABEL}>{t("wm.freeResize")}</span>
      <span class={VALUE} data-testid="wm-free-resize">{yesNo(snap?.free_resize ?? false)}</span>
    </div>
    <div class={SUB}></div>
    <div class={ROW}>
      <span class={LABEL}>{t("wm.dividerGap")}</span>
      <span class={VALUE} data-testid="wm-divider-gap">
        {show(`${snap?.divider_gap ?? 0}px`)}
      </span>
    </div>
    <div class={SUB}></div>
    <div class={ROW}>
      <span class={LABEL}>{t("wm.split")}</span>
      <span class={VALUE} data-testid="wm-split">
        {show(snap && splitActive(snap) ? describeSplit(snap.split) : t("wm.none"))}
      </span>
    </div>
    <!-- The controls only exist where the host says multiple windows are allowed
         (a phone answers `false`, and a headless class refuses outright). -->
    {#if canSplit}
      <div class={SUB}></div>
      <div class="px-4 py-3">
        <p class={HINT} data-testid="wm-candidates">
          {t("wm.candidates", {
            list: candidates.length > 0 ? candidates.join(" · ") : t("wm.unavailable"),
          })}
        </p>
        {#if hasExternalWindow}
          <!-- A container surface is visible in the debug card below but can never be
               a pane (the container owns its geometry, REQ-A226) — say so exactly where
               the user would otherwise read the absence as a bug. -->
          <p class={HINT} data-testid="wm-candidates-note">{t("wm.candidatesNote")}</p>
        {/if}
        <div class="mt-2 flex flex-wrap gap-2">
          {#if live}
            <button
              type="button"
              data-testid="wm-swap"
              disabled={busy}
              onclick={swapPanes}
              class="rounded-full bg-black/5 px-4 py-1.5 text-sm active:scale-95 disabled:opacity-40 dark:bg-white/10"
            >
              {t("wm.swap")}
            </button>
            <button
              type="button"
              data-testid="wm-narrow"
              disabled={busy}
              onclick={() => nudge(-5)}
              class="rounded-full bg-black/5 px-4 py-1.5 text-sm active:scale-95 disabled:opacity-40 dark:bg-white/10"
            >
              {t("wm.narrow")}
            </button>
            <button
              type="button"
              data-testid="wm-wider"
              disabled={busy}
              onclick={() => nudge(5)}
              class="rounded-full bg-black/5 px-4 py-1.5 text-sm active:scale-95 disabled:opacity-40 dark:bg-white/10"
            >
              {t("wm.wider")}
            </button>
            <button
              type="button"
              data-testid="wm-exit-split"
              disabled={busy}
              onclick={exitSplit}
              class="rounded-full bg-black/5 px-4 py-1.5 text-sm active:scale-95 disabled:opacity-40 dark:bg-white/10"
            >
              {t("wm.exitSplit")}
            </button>
          {:else}
            <!-- Two windows are the host's own minimum for a split; without them the
                 button is inert rather than inviting a request that cannot succeed. -->
            <button
              type="button"
              data-testid="wm-enter-split"
              disabled={busy || candidates.length < 2}
              onclick={enterSplit}
              class="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95 disabled:opacity-40"
            >
              {t("wm.enterSplit")}
            </button>
          {/if}
        </div>
        {#if noteKey}
          <p class="mt-2 text-xs opacity-60" data-testid="wm-note">{t(noteKey)}</p>
        {/if}
      </div>
    {/if}
  </div>

  <p class={HINT}>{t("wm.hint")}</p>

  <!-- 「窗口管理器 (调试)」card (REQ-A225). `docs/gui-verify.md` A4 and
       `docs/android-compat.md` W4 verify the host through this list, and no Svelte
       surface read `wm_windows` before (only the LMK reconcile did), so the check
       was unperformable in the shipped UI. It shows the host's own words
       (`label [kind] state`), marks composited container surfaces that have no
       WebView, and never keeps a list the host did not just hand over. -->
  <section class={GROUP}>
    <div class="px-4 py-3">
      <div class="flex items-center justify-between gap-3">
        <span class={H2} data-testid="wm-debug-title">{t("wm.debugTitle")}</span>
        <button
          type="button"
          data-testid="wm-refresh-windows"
          onclick={() => void refreshWindows()}
          class="rounded-full bg-black/5 px-3 py-1 text-xs active:scale-95 dark:bg-white/10"
        >
          {t("wm.refresh")}
        </button>
      </div>
      {#if !hasHost}
        <p class={HINT} data-testid="wm-windows-no-host">{t("wm.noHost")}</p>
      {:else if !winSnap}
        <p class={HINT} data-testid="wm-windows-no-answer">{t("wm.noAnswer")}</p>
      {:else if winSnap.windows.length === 0}
        <p class={HINT} data-testid="wm-windows-empty">{t("wm.noWindows")}</p>
      {:else}
        <ul class="mt-2 space-y-1 font-mono text-[11px]" data-testid="wm-window-list">
          {#each winSnap.windows as w (w.label)}
            <li data-testid="wm-window-row">
              {w.label} [{w.kind}] {w.state}{w.external ? ` · ${t("wm.external")}` : ""}{w.focused
                ? ` ←${t("wm.focused")}`
                : ""}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </section>
</div>

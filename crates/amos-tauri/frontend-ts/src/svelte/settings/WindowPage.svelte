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
    wmDisplays,
    wmLayoutSnapshot,
    wmSplitCandidates,
    wmSplitExitWithDiag,
    wmSplitMoveWithDiag,
    wmSplitSwapWithDiag,
    wmSplitWithDiag,
    wmWindows,
    type DisplaySet,
    type FormFactor,
    type LayoutSnapshot,
    type WmReplyDiag,
    type WmWindowsSnapshot,
  } from "../../lib/wm";
  import { bridged } from "../../lib/backend";
  import {
    stageFailure,
    stageSetEnabled,
    stageSnapshot,
    type StageSnapshot,
  } from "../../lib/stage";
  import { stageToggleLabel } from "../../lib/stageKeys";
  import { amosWarn } from "../../lib/debugLog";
  import { t } from "../locale.svelte";
  import ToggleRow from "./ToggleRow.svelte";
  import { GROUP, H2, HINT, LABEL, ROW, SUB, VALUE } from "./kit";

  let snap = $state<LayoutSnapshot | null>(null);
  let hasHost = $state(false);
  /**
   * Window labels the host offers for a new split — never invented here.
   *
   * `null` means the host did not answer (`invoke` folds a thrown command into `null`),
   * never "the host has none": those are **two** answers and the card draws two different
   * sentences. It is the same discipline the three sibling reads on this page keep
   * (`winSnap` ∕ `displays` ∕ `stage`), each with its own `*-no-answer` line; an empty
   * list is the host's own "fewer than two of my windows are placeable" and gets its own
   * sentence too (`wm.candidatesEmpty`). Keeping the `null` in the type is what lets the
   * render tell them apart at all (REQ-A1660 ∕ F-SH-845).
   */
  let candidates = $state<string[] | null>(null);
  /** A command is in flight: further presses are ignored rather than queued. */
  let busy = $state(false);
  /** i18n key of the last action's honest outcome note (`null` = nothing to say). */
  let noteKey = $state<string | null>(null);
  /** The host's window list (`wm_windows`) — the debug card's own read. `null`
   * means "the host did not answer", never "the previous answer still stands". */
  let winSnap = $state<WmWindowsSnapshot | null>(null);
  /** The platform's displays (`wm_displays`, REQ-A690). `null` means "the host did not
   *  answer", never "the previous list still stands"; an empty set is the host saying the
   *  platform listed none. */
  let displays = $state<DisplaySet | null>(null);
  /**
   * Stage Manager's whole observable state (`stage_snapshot`, REQ-A1568). `null` means the
   * host did not answer — never "the mode is off", which is a host answer like any other and
   * is what the switch must show as *off* rather than as unavailable.
   */
  let stage = $state<StageSnapshot | null>(null);
  /**
   * The Stage toggle's own honest outcome note — i18n key plus the host's sentence when no
   * known code maps it (`lib/stage.ts::stageFailure`). A **separate** slot from `noteKey`:
   * the two are different panels, and one key cannot carry both a wm.* sentence and a
   * `{message}` placeholder.
   */
  let stageNote = $state<{ key: string; hostMessage?: string } | null>(null);

  /**
   * Re-read the platform's displays.
   *
   * Same honesty rule as the window list: a failed/absent answer clears the readout to
   * `null` rather than keeping a display that may have been unplugged, and an empty set is
   * shown as the host's own "no displays" answer instead of a fabricated single one. The
   * failure is already in the diagnostics ledger (`lib/backend.ts`).
   */
  async function refreshDisplays(): Promise<void> {
    displays = await wmDisplays();
  }

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
   * A failed/absent answer **clears** the list to `null` instead of keeping the previous
   * one: offering 「进入分屏」 on a list we can no longer vouch for would be a fabricated
   * capability. The failure is already in the diagnostics ledger (`lib/backend.ts`).
   *
   * It is deliberately **not** folded to `[]`: an empty list is the host's own answer
   * ("fewer than two of my windows are placeable"), which the card states as such, while
   * `null` is the host's silence, which the card states *differently* — the same
   * two-sentence split `wmWindows` ∕ `wmDisplays` ∕ `stageSnapshot` get (REQ-A1660).
   */
  async function refreshCandidates(): Promise<void> {
    candidates = await wmSplitCandidates();
  }

  /**
   * Re-read Stage Manager's state.
   *
   * Same honesty rule as every readout on this page: a failed/absent answer clears to `null`
   * (the switch then shows unavailable, not a remembered mode). It is re-read on the tick and
   * on every `layout-changed` push because the mode has **two other fronts** — the Window
   * menu row and the ⌃⌘S chord — and `stage_set_enabled` ends in `finish_layout`, so a change
   * made there arrives here as a push rather than as a page that disagrees with the shell.
   */
  async function refreshStage(): Promise<void> {
    stage = await stageSnapshot();
  }

  /**
   * Turn Stage Manager on or off.
   *
   * The state is adopted **only** from the host's answer (`busy` is released either way): a
   * switch that flips on a refused call would claim a mode the window manager never entered,
   * and the refusal is named through `lib/stage.ts::stageFailure` — the one place that maps
   * `amos.stage.*` to a sentence (the rail and the Window menu call it too).
   */
  async function toggleStage(): Promise<void> {
    if (busy || !stage) return;
    busy = true;
    stageNote = null;
    try {
      const next = await stageSetEnabled(!stage.enabled);
      if (next === null) {
        const { key, hostMessage } = stageFailure("stage_set_enabled");
        stageNote = { key, hostMessage };
        if (hostMessage) {
          amosWarn("settings", `${t(key)}: ${hostMessage}`, { command: "stage_set_enabled" });
        }
      } else {
        stage = next;
      }
    } finally {
      busy = false;
    }
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
      // The display set changes on hot-plug, which emits no shell event — the probe
      // is the only way to notice a display was added or removed.
      await refreshDisplays();
      // Stage Manager's mode can be changed from outside this page (Window menu / ⌃⌘S);
      // the push below usually catches that first, and this tick is what catches a host
      // that went away mid-session.
      await refreshStage();
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
      // …and the moment the Stage mode can have changed from another front: the host only
      // emits on a real change, so a push that follows the shell's ⌃⌘S is the switch's cue.
      void refreshStage();
    }).then((f) => {
      // REQ-A838: `null` = 推送订阅未建立，`off` 保持 null，卸载时无事可做。这里无妨：
      // 上面那次 `probe()` 已经读过一次快照，推送只是省掉轮询；但"没有推送"不能被读成
      // "宿主没有变化"，所以判定留在 `bridgeDiag(LAYOUT_CHANGED_EVENT)` 上。
      if (f === null) return;
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
   * The diag-aware variant is used here (REQ-A513 / F-SH-053): a `null` snapshot
   * is no longer silently dropped — the **reason** is read from the diagnostics
   * ledger and surfaced as an i18n note so the user sees "no bridge" / "host
   * refused" / "geometry not available" instead of a button that did nothing.
   * The page itself also adopts the snapshot only when the call was `ok`
   * — a refused action must not look like it happened.
   *
   * `after` is reserved for follow-up reads the caller wants regardless of the
   * outcome (the candidates list is refreshed after exit regardless of which
   * way the call resolved: the UI's own list is the page's, and the host's
   * "no, you have nothing to split" is the same fact as "you have two windows
   * again"). `busy` is always released (a stuck flag would permanently disable
   * the controls).
   */
  async function act(
    run: () => Promise<
      { ok: true; snapshot: LayoutSnapshot } | { ok: false; diag: WmReplyDiag }
    >,
    after?: () => Promise<void>,
  ): Promise<void> {
    if (busy) return;
    busy = true;
    noteKey = null;
    try {
      const r = await run();
      if (r.ok) {
        snap = r.snapshot;
        if (after) await after();
      } else {
        noteKey = diagNoteKey(r.diag);
      }
    } finally {
      busy = false;
    }
  }

  /**
   * Translate a diagnostics record into the i18n key the page will show.
   *
   * The split variants distinguish three outcomes:
   *   • `not-bridged` — there is no `__TAURI_INTERNALS__` at all (preview / no host)
   *   • `command-failed` — the bridge exists but the host command threw (Rust panic,
   *     serialisation error, …); the diagnostics ledger has the detail
   *   • `host-refused-null` — the bridge answered with `null`, which the host uses
   *     to mean "I understood the request and refused" (no geometry, layout torn
   *     down, another window already owns the pane)
   *
   * The first two are read from `lib/backend.ts`'s ledger (`noteDiag` writes them
   * directly); the third is reported by the split wrappers themselves, because
   * `lib/backend.ts`'s `invoke` records `ok: true` whenever the bridge returns
   * `null` without throwing — so reading the ledger after the fact would say
   * `ok: true` for a refused call.
   *
   * A Settings page that pretends the three are the same fact would mis-report
   * a transient host refusal as "the host is gone" (the user would give up and
   * restart the desktop).
   */
  function diagNoteKey(diag: WmReplyDiag): string {
    if (diag.ok) return "wm.actionFailed";
    if (diag.kind === "not-bridged") return "wm.hostUnavailable";
    return "wm.hostRefused";
  }

  /** The host picks the axis (`auto`) from the real screen's aspect. */
  const enterSplit = () => {
    // Two windows are the host's own minimum; the control is disabled without them,
    // and this guard keeps the request honest even if it is somehow triggered. The
    // `null` arm is the host's silence — there is no list to ask with at all.
    if (candidates === null) return;
    const [primary, secondary] = candidates;
    if (!primary || !secondary) return;
    void act(() => wmSplitWithDiag(primary, secondary, "auto"));
  };
  const swapPanes = () => void act(() => wmSplitSwapWithDiag());
  const exitSplit = () => void act(() => wmSplitExitWithDiag(), refreshCandidates);
  const nudge = (delta: number) => void act(() => wmSplitMoveWithDiag(delta));

  /**
   * WindowPage-local keyboard shortcuts (REQ-A224 §shortcuts).
   *
   * The split controls live on this page and the page is its own focused
   * surface, so binding a few keys here keeps the operation mouse-free without
   * leaking into the global shortcut registry (which the Keyboard settings
   * page owns and a chord on a per-page setting would silently double-bind).
   *
   * Mapping:
   *   Enter / Space     — same as clicking the primary button (enter / swap / exit)
   *   ArrowLeft         — narrow the split divider (`wm_split_move` -5)
   *   ArrowRight        — widen  the split divider (`wm_split_move` +5)
   *   Shift+ArrowLeft   — exit the split (Shift modifier is the same role
   *                       the file pickers use for "destructive")
   *   Escape            — exit the split
   *
   * Only fire while the page itself is the active element. We use the page's
   * own `<div data-testid="wm-page" tabindex="-1">` wrapper (added below) as
   * the guard so a typing user in another Settings field cannot accidentally
   * exit a split by pressing Escape in the IME picker.
   */
  let pageEl = $state<HTMLDivElement | null>(null);
  function onSplitKey(e: KeyboardEvent): void {
    if (busy || !snap) return;
    if (live) {
      if (e.key === "ArrowLeft" && !e.shiftKey) {
        e.preventDefault();
        nudge(-5);
      } else if (e.key === "ArrowRight" && !e.shiftKey) {
        e.preventDefault();
        nudge(5);
      } else if (e.key === "ArrowLeft" && e.shiftKey) {
        e.preventDefault();
        exitSplit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        exitSplit();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        swapPanes();
      }
    } else if (canSplit && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      enterSplit();
    }
  }
  $effect(() => {
    const el = pageEl;
    if (!el) return;
    el.addEventListener("keydown", onSplitKey);
    return () => el.removeEventListener("keydown", onSplitKey);
  });

  /** May this class even be asked for a split? (`multi_window` is the host's own
   * capability answer; a phone answers `false`, and the host would refuse too.) */
  const canSplit = $derived(snap !== null && snap.multi_window);
  /**
   * May this class be offered Stage Manager at all?
   *
   * The gate is the host's **class** (`form`), deliberately *not* `snap.rail_width > 0`: the
   * rail is only reserved while the mode is on, so that reading is 0 in exactly the state the
   * switch exists to leave — a flag gating the element it must read (and the host refuses the
   * enable itself on any class without a rail, `amos.stage.unsupported`).
   */
  const hasRail = $derived(snap?.form === "desktop");
  const live = $derived(snap !== null && splitActive(snap));
  /** Is there a window the host cannot place (a `legacy:*` container surface)? Then
   * the split control needs to say why it is missing from 可分屏窗口 — the debug card
   * right below shows it, and the user would otherwise read the absence as a bug. */
  const hasExternalWindow = $derived(winSnap?.windows.some((w) => w.external) ?? false);
</script>

<div
  bind:this={pageEl}
  class="flex flex-col gap-3 px-4 pb-6 pt-2 outline-none"
  tabindex="-1"
  data-testid="wm-page"
>
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
    <!-- Stage Manager (REQ-A1568). Only where the host says the class has a rail; the
         sentence under it names the same chord the Window menu row shows, read off
         `lib/stageKeys.ts`, so Settings and the menu cannot advertise different keys. -->
    {#if hasRail}
      <div class={SUB}></div>
      <ToggleRow
        label={t("wm.stage")}
        on={stage?.enabled ?? false}
        ontoggle={() => void toggleStage()}
        disabled={busy || !stage}
      />
      <div class="px-4 pb-3">
        <p class={HINT} data-testid="wm-stage-note">
          {t("wm.stageNote", { chord: stageToggleLabel() })}
        </p>
        <!-- The toggle's async outcome, in its own live region for the reason the split
             note gives: a refusal arrives after the press, and silence reads as nothing
             having happened. The switch itself never moves on a refusal. -->
        <p
          class="mt-1 text-xs opacity-60"
          data-testid="wm-stage-note-result"
          role="status"
          aria-live="polite"
        >{stageNote
            ? t(
                stageNote.key,
                stageNote.hostMessage ? { message: stageNote.hostMessage } : undefined,
              )
            : ""}</p>
      </div>
    {/if}
    {#if canSplit}
      <div class={SUB}></div>
      <div class="px-4 py-3">
        <!-- Two answers, two sentences: the host's silence is not a list, and an empty
             list is not the host's silence. The dash used to serve both (REQ-A1660). -->
        {#if candidates === null}
          <p class={HINT} data-testid="wm-candidates-no-answer">{t("wm.noAnswer")}</p>
        {:else}
          <p class={HINT} data-testid="wm-candidates">
            {t("wm.candidates", {
              list: candidates.length > 0 ? candidates.join(" · ") : t("wm.candidatesEmpty"),
            })}
          </p>
        {/if}
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
            <!-- Two windows are the host's own minimum for a split; without them — and
                 without any answer to act on at all — the button is inert rather than
                 inviting a request that cannot succeed. -->
            <button
              type="button"
              data-testid="wm-enter-split"
              disabled={busy || candidates === null || candidates.length < 2}
              onclick={enterSplit}
              class="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95 disabled:opacity-40"
            >
              {t("wm.enterSplit")}
            </button>
          {/if}
        </div>
        <!-- Per-page keyboard shortcut hint (REQ-A224 §shortcuts).
             The page is its own focusable surface (`tabindex="-1"`) so these
             keys only fire while the user is on it — a typing user in another
             Settings field cannot accidentally exit a split by pressing Escape
             in the IME picker. Kept here (not the topbar) because they are
             page-local and the topbar already carries the global chord hints. -->
        <p class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] opacity-60" data-testid="wm-split-kbd">
          {#if live}
            <span><kbd class="rounded bg-black/5 px-1 py-0.5 font-mono text-[10px] dark:bg-white/10">←</kbd> {t("wm.splitKbd.narrow")}</span>
            <span><kbd class="rounded bg-black/5 px-1 py-0.5 font-mono text-[10px] dark:bg-white/10">→</kbd> {t("wm.splitKbd.wider")}</span>
            <span><kbd class="rounded bg-black/5 px-1 py-0.5 font-mono text-[10px] dark:bg-white/10">Enter</kbd> {t("wm.splitKbd.swap")}</span>
            <span><kbd class="rounded bg-black/5 px-1 py-0.5 font-mono text-[10px] dark:bg-white/10">Esc</kbd> {t("wm.splitKbd.exit")}</span>
          {:else}
            <span><kbd class="rounded bg-black/5 px-1 py-0.5 font-mono text-[10px] dark:bg-white/10">Enter</kbd> {t("wm.splitKbd.enter")}</span>
          {/if}
        </p>
        <!-- The async outcome of the last split command (entered / refused / failed).
             A live region: the answer arrives after the press, so without one a screen
             reader gets silence and the user cannot tell a refusal from a no-op. The
             container is **always present** — a live region inserted at the same moment
             its text arrives is not reliably announced — and is empty when there is
             nothing to say. -->
        <p
          class="mt-2 text-xs opacity-60"
          data-testid="wm-note"
          role="status"
          aria-live="polite"
        >{noteKey ? t(noteKey) : ""}</p>
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
              <!-- REQ-A473: the identity, but only when it says something the label does
                   not — i.e. for an instance window (`files_2` → `· files #2`). A debug card
                   that repeats `notes` after `notes` is noise; one that hides *which
                   instance* this is would be missing the only thing the label no longer
                   tells you. -->
              {#if w.app && (w.app !== w.label || w.instance > 1)}
                · {w.app}{w.instance > 1 ? ` #${w.instance}` : ""}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </section>

  <!-- 「显示器 (调试)」card (REQ-A690). The host's snap rule already tiles a window
       within the display that holds its centre; this is the only surface that shows
       *which* displays the platform reported (their rects, usable work areas and DPI),
       so a multi-monitor setup can be verified without a debugger. Same honesty rules as
       the window card: never a list the host did not just hand over, and an empty set is
       the host's own answer, not a stand-in for one fabricated display. -->
  <section class={GROUP}>
    <div class="px-4 py-3">
      <div class="flex items-center justify-between gap-3">
        <span class={H2} data-testid="wm-displays-title">{t("wm.displaysTitle")}</span>
        <button
          type="button"
          data-testid="wm-refresh-displays"
          onclick={() => void refreshDisplays()}
          class="rounded-full bg-black/5 px-3 py-1 text-xs active:scale-95 dark:bg-white/10"
        >
          {t("wm.refresh")}
        </button>
      </div>
      {#if !hasHost}
        <p class={HINT} data-testid="wm-displays-no-host">{t("wm.noHost")}</p>
      {:else if !displays}
        <p class={HINT} data-testid="wm-displays-no-answer">{t("wm.noAnswer")}</p>
      {:else if displays.displays.length === 0}
        <p class={HINT} data-testid="wm-displays-empty">{t("wm.displaysEmpty")}</p>
      {:else}
        <ul class="mt-2 space-y-1 font-mono text-[11px]" data-testid="wm-display-list">
          {#each displays.displays as d, i (i)}
            <li data-testid="wm-display-row">
              {d.name ?? "—"}{d.primary ? ` · ${t("wm.displayPrimary")}` : ""} · {d.bounds.width}×{d
                .bounds.height}@({d.bounds.x},{d.bounds.y}) · ×{d.scale}
              <span class="opacity-60">
                · {t("wm.displayWorkArea")} {d.work_area.width}×{d.work_area.height}@({d.work_area
                  .x},{d.work_area.y})
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </section>
</div>

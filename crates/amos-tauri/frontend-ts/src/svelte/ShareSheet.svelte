<script lang="ts">
  /**
   * ShareSheet.svelte — the system share sheet overlay (REQ-A703).
   *
   * The visible half of the two-sided share contract. A producing surface (Files,
   * for now) calls `openShareSheet({ kind, value, title })`; this island lists the
   * handlers: the built-in destinations that accept the payload's kind (`lib/shareTargets`
   * — Notes / Mail), every shortcut whose `quickActions` includes `shareSheet` (toggled in
   * the Shortcuts editor), plus the built-in Copy. A built-in hands the content to its app's
   * deep-link channel as a draft; a shortcut runs with the payload as `input`, and the run is
   * recorded in the shared execution log.
   *
   * Renders nothing while closed, so it is safe to mount unconditionally in Shell.
   */
  import { executeShortcut } from "../lib/shortcuts";
  import { clipboardWrite } from "../lib/clipboard";
  import { builtinTargetsFor, type ShareTarget } from "../lib/shareTargets";
  import { closeShareSheet, sharePayload, shareTargets } from "./shareSheetState.svelte";
  import { t } from "./locale.svelte";

  const payload = $derived(sharePayload());
  const targets = $derived(shareTargets());
  // The always-present destinations (Notes / Mail). Filtered by the payload's kind, so
  // the sheet only offers an app that can take what is being shared.
  const builtins = $derived(payload === null ? [] : builtinTargetsFor(payload.kind));

  /** One-line preview of the shared content for the header. */
  const preview = $derived((() => {
    const v = payload?.value ?? "";
    const first = v.split("\n", 1)[0] ?? "";
    return first.length > 120 ? `${first.slice(0, 120)}…` : first;
  })());

  /** The target whose run is in flight, so a second one cannot start on top of it. */
  let running = $state<string | null>(null);
  /**
   * The sentence to show under the targets when the last gesture failed, or `null`.
   *
   * It holds the **composed** sentence, not a raw reason: both paths into it need different
   * framing (a shortcut's own error text vs. "the clipboard refused"), and the render point
   * below must not know which one it is looking at.
   */
  let failureNote = $state<string | null>(null);

  function dismiss(): void {
    closeShareSheet();
  }

  function onScrimKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && payload) dismiss();
  }

  /**
   * Copy the payload to the shared clipboard, under the rule `runTarget` states below.
   *
   * This row used to be `dismiss(); await clipboardWrite({ kind: "text", text: payload.value }, …)`
   * and had **two** defects stacked on each other (REQ-A1235):
   *
   *   1. `dismiss()` clears the shared payload, and `payload` above is a `$derived` over that
   *      state — so the very next line read `null.value` and **threw**. The click never reached
   *      the host at all: `clipboardWrite` was never called, so "Copy" has never copied anything.
   *      The `void` at the call site swallowed the rejection, and the sheet was already gone.
   *   2. Even with the value in hand, `ClipboardEntry | null` was discarded — and `null` is
   *      exactly the host refusing (a payload over `MAX_TEXT_LEN`, or no bridge). Closing the
   *      sheet *is* the success gesture, so a refusal would have looked identical to a copy.
   *
   * So: capture the text first, await the host, and only then decide. A refusal keeps the sheet
   * open and says why — the same stance, and the same render point, as a refused shortcut run.
   */
  async function copyTarget(): Promise<void> {
    if (!payload) return;
    const text = payload.value;
    failureNote = null;
    const entry = await clipboardWrite({ kind: "text", text }, "share-sheet");
    if (entry === null) {
      failureNote = t("shareSheet.copyFailed");
      return;
    }
    dismiss();
  }

  /**
   * Deliver the payload to a built-in app (Notes / Mail), under the same rule as
   * `runTarget` below: closing the sheet *is* the success gesture, so it happens only
   * when the hand-off was actually dispatched.
   *
   * The link channels are synchronous and cannot be refused at this distance (the target
   * app opens and prefills), so `deliver` answers `false` for exactly one thing — content
   * the target will not take (an empty draft). Reading it and *then* dismissing is the
   * order that matters: `dismiss()` clears the shared payload, so dismissing first would
   * tear the content out from under the delivery (the defect REQ-A1235 fixed on the Copy
   * row).
   */
  function runBuiltin(target: ShareTarget): void {
    if (!payload) return;
    failureNote = null;
    if (!target.deliver(payload)) {
      failureNote = t("shareSheet.deliverFailed", { target: t(target.titleKey) });
      return;
    }
    dismiss();
  }

  async function runTarget(id: string): Promise<void> {
    if (!payload) return;
    const input = payload.value;
    // The user tapped this handler deliberately, so it counts as the run's
    // confirmation — the same stance `ShortcutsApp.handleRun` takes.
    //
    // That stance includes the *failure* half, and the failure half is a **return
    // value**, not a throw: `executeShortcut` answers `{ success: false, error }`
    // for every gate it owns — an unknown id, a `requiresConfirmation` run with
    // no confirmation, the lock screen, the MDM blocks (device block, disabled
    // category, daily quota), a zero time budget, an execution timeout, a failed
    // action — and it `catch`es its own timeout throw, so it never raises for any
    // of them. Guarding only with `catch` therefore made a *refusal* walk out of
    // the same door as a success: the awaited call resolved, `dismiss()` ran, the
    // overlay closed, and the reason sat unread in the discarded result — a silent
    // no-op shaped exactly like success. Closing the sheet *is* the success
    // gesture, so it now happens only when `result.success`, and a refusal is
    // said in the surface that started it (REQ-A856, REQ-A1140).
    //
    // The `catch` is kept for the calls `executeShortcut` makes *outside* its own
    // `try` (`loadShortcuts`, `mdmManager.ensureInitialized`) — those can still
    // reject, and that rejection has no other receiver here.
    running = id;
    failureNote = null;
    try {
      const result = await executeShortcut(id, input, { confirmed: true });
      if (result.success) {
        dismiss();
      } else {
        failureNote = t("shortcuts.executionError", { error: result.error ?? "" });
      }
    } catch (err) {
      failureNote = t("shortcuts.executionError", { error: String(err) });
    } finally {
      running = null;
    }
  }
</script>

<svelte:window onkeydown={onScrimKey} />

{#if payload}
  <div class="absolute inset-0 z-[80] flex items-end justify-center">
    <!-- 点击空白关闭（内容区 pointer-events-auto 除外） -->
    <div
      class="absolute inset-0 bg-black/40"
      role="presentation"
      aria-hidden="true"
      onclick={(e) => { if (e.target === e.currentTarget) dismiss(); }}
      onkeydown={() => { /* no-op; Escape is handled on window */ }}
    ></div>
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("shareSheet.title")}
      data-testid="share-sheet"
      class="relative w-full max-w-md rounded-t-3xl bg-white p-4 pb-6 shadow-2xl dark:bg-neutral-900"
    >
      <div class="mb-3 flex items-center gap-3">
        <span class="text-2xl leading-none" aria-hidden="true">📤</span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {payload.title}
          </div>
          <div class="truncate text-xs text-neutral-500 dark:text-neutral-400">{preview}</div>
        </div>
        <button
          aria-label={t("shareSheet.close")}
          onclick={dismiss}
          data-testid="share-sheet-close"
          class="grid h-11 w-11 shrink-0 place-items-center rounded-full text-neutral-500 transition active:bg-black/5 dark:text-neutral-400 dark:active:bg-white/10"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      <div class="space-y-1" data-testid="share-sheet-targets">
        <button
          onclick={() => void copyTarget()}
          data-testid="share-target-copy"
          class="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition active:bg-black/5 dark:active:bg-white/10"
        >
          <span class="text-xl leading-none" aria-hidden="true">📋</span>
          <span class="min-w-0 flex-1 truncate text-sm text-neutral-900 dark:text-neutral-100">
            {t("shareSheet.copy")}
          </span>
        </button>

        {#each builtins as target (target.id)}
          <button
            onclick={() => runBuiltin(target)}
            disabled={running !== null}
            data-testid="share-target-{target.id}"
            class="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition active:bg-black/5 dark:active:bg-white/10 disabled:opacity-60"
          >
            <span class="text-xl leading-none" aria-hidden="true">{target.icon}</span>
            <span class="min-w-0 flex-1 truncate text-sm text-neutral-900 dark:text-neutral-100">
              {t(target.titleKey)}
            </span>
          </button>
        {/each}

        {#each targets as target (target.id)}
          <button
            onclick={() => void runTarget(target.id)}
            disabled={running !== null}
            data-testid="share-target-{target.id}"
            class="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition active:bg-black/5 dark:active:bg-white/10 disabled:opacity-60"
          >
            <span class="text-xl leading-none" aria-hidden="true">{target.icon}</span>
            <span class="min-w-0 flex-1 truncate text-sm text-neutral-900 dark:text-neutral-100">
              {target.name}
            </span>
          </button>
        {/each}
      </div>

      {#if failureNote}
        <p
          class="mt-2 px-3 text-xs text-red-600 dark:text-red-400"
          role="alert"
          data-testid="share-run-error"
        >
          {failureNote}
        </p>
      {/if}

      <!--
        The empty state is about the sheet having **no destination at all**, not about
        the shortcut half being empty (REQ-A1917). It used to test `targets.length === 0`
        — true when the shortcut library has nothing opted in — while the built-in rows
        above are offered for every payload kind (`builtinTargetsFor`), so the default
        configuration drew 「还没有快捷指令。打开「快捷指令」开启「出现在分享菜单」。」
        directly under working Notes and Mail rows: the screen asserting there is nowhere
        to share to, an inch below two places to share to, and pointing the user at
        shortcuts they do not need in order to share at all. The hint is the sheet's
        *empty* state, so it may only stand where the sheet really is empty.
      -->
      {#if builtins.length === 0 && targets.length === 0}
        <p class="mt-2 px-3 text-xs text-neutral-500 dark:text-neutral-400">
          {t("shareSheet.noTargets")}
        </p>
      {/if}
    </div>
  </div>
{/if}

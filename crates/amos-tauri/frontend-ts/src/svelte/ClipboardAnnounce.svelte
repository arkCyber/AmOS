<script lang="ts">
  // ClipboardAnnounce.svelte — the metadata-only "clipboard updated" toast for the
  // pure-Svelte shell (port of the React host's clipboard announce; see
  // react-removal-plan P1 "clipboard ingest/announce").
  //
  // The Rust side broadcasts `clipboard-changed` on **every** write — a Webview
  // copy or a container-originated ingest — carrying only
  // `{ seq, timestamp_ms, source }`. It deliberately does **not** carry the
  // content (a background window must not learn it by subscribing; the payload is
  // fetched via the foreground-gated `clipboard_read`). So this island can tell the
  // user a copy landed (e.g. made in the Android container) without ever leaking
  // the payload: it renders metadata only.
  import { onClipboardChanged, type ClipboardNotice } from "../lib/clipboard";
  import { t } from "./locale.svelte";

  /** How long a notice stays on screen before auto-dismissing. */
  const SHOW_MS = 3200;
  let notice = $state<ClipboardNotice | null>(null);
  let timer: number | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  $effect(() => {
    let alive = true;
    let unsub: (() => void) | null = null;
    void onClipboardChanged((n) => {
      if (!alive) return;
      notice = n;
      clearTimer();
      timer = window.setTimeout(() => {
        notice = null;
        timer = null;
      }, SHOW_MS);
    }).then((u) => {
      if (alive) unsub = u;
      else u();
    });
    return () => {
      alive = false;
      clearTimer();
      unsub?.();
    };
  });

  const dismiss = () => {
    notice = null;
    clearTimer();
  };
</script>

{#if notice}
  <div
    role="status"
    data-testid="clipboard-announce"
    class="absolute inset-x-3 bottom-20 z-[70] flex items-center gap-2 rounded-2xl bg-white/90 px-3 py-2 text-left shadow-lg ring-1 ring-black/10 backdrop-blur-md dark:bg-neutral-900/90 dark:ring-white/10"
  >
    <span class="text-base leading-none" aria-hidden="true">📋</span>
    <span class="min-w-0 flex-1 truncate text-xs text-neutral-800 dark:text-neutral-200">
      {t("clipboard.announce", { source: notice.source || "—" })}
    </span>
    <button
      aria-label={t("clipboard.announceDismiss")}
      onclick={dismiss}
      class="grid h-6 w-6 shrink-0 place-items-center rounded-full text-neutral-500 transition active:bg-black/5 dark:text-neutral-400 dark:active:bg-white/10"
    >
      <span aria-hidden="true">✕</span>
    </button>
  </div>
{/if}

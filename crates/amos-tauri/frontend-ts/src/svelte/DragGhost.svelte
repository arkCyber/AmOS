<script lang="ts">
  // DragGhost.svelte — the floating chip that follows the pointer during a cross-app
  // drag, and the owner of the shell-wide pointer listeners (REQ-A683).
  //
  // It is mounted once by `Shell.svelte` and renders nothing until a drag starts; on
  // start it attaches window-level `pointermove`/`pointerup`/`keydown` (capture phase,
  // so a pane's own handlers cannot swallow them) to track the pointer, find the pane
  // under it, and commit on release. The pane highlight is *not* drawn here: each
  // `AppPane` reads the session itself and marks itself, so there is one source of
  // truth for "am I the target".
  //
  // The chip is honest about the outcome: over an accepting pane it names the action;
  // over anything else it shows *why* nothing will happen (see `rejectionKey`). A drag
  // that would do nothing must not look like one that would.
  import { dragSession, cancelDrag, endDrag, moveDrag } from "./dragSession.svelte";
  import { payloadDetail, payloadLabelKey, rejectionKey } from "../lib/dragDrop";
  import { performDrop } from "./dropActions";
  import { appTitleKey } from "../lib/appMeta";
  import { t } from "./locale.svelte";

  const session = $derived(dragSession());
  const active = $derived(session !== null);

  /** The app id of the `[data-drop-app]` pane under (x, y), or `null`. */
  function paneAt(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const hit = el?.closest("[data-drop-app]") as HTMLElement | null;
    return hit?.dataset.dropApp ?? null;
  }

  /** The app's display name (falls back to the id for a store tile). */
  function appName(id: string): string {
    const key = appTitleKey(id);
    return key ? t(key) : id;
  }

  $effect(() => {
    if (!active) return;
    const onMove = (e: PointerEvent) => moveDrag(e.clientX, e.clientY, paneAt(e.clientX, e.clientY));
    const onUp = () => {
      const done = endDrag();
      if (done && done.resolution.kind === "accept") performDrop(done.payload, done.resolution.verb);
    };
    const onCancel = () => cancelDrag();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelDrag();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

{#if session}
  <div
    class="pointer-events-none fixed z-[90] max-w-[16rem] -translate-x-1/2 -translate-y-full rounded-2xl px-3 py-2 text-xs shadow-lg ring-1 backdrop-blur-md
      {session.resolution.kind === 'accept'
        ? 'bg-accent/90 text-white ring-white/25'
        : 'bg-neutral-900/85 text-white/80 ring-white/15'}"
    style:left="{session.x}px"
    style:top="{session.y - 12}px"
    role="status"
    aria-live="polite"
    data-testid="drag-ghost"
    data-drop-state={session.resolution.kind}
    data-drop-app={session.overAppId ?? ""}
  >
    <span class="font-semibold">{t(payloadLabelKey(session.payload))}</span>
    <span class="mx-1 opacity-60">·</span>
    <span class="opacity-90">{payloadDetail(session.payload)}</span>
    <div class="mt-0.5 text-[11px] opacity-80" data-testid="drag-ghost-hint">
      {#if session.resolution.kind === "accept"}
        {t("drag.dropOn", { app: appName(session.resolution.app) })}
      {:else if session.overAppId}
        {t(rejectionKey(session.resolution.reason))}
      {:else}
        {t("drag.dropHint")}
      {/if}
    </div>
  </div>
{/if}

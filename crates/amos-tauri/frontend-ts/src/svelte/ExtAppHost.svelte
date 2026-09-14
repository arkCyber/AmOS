<script lang="ts">
  // ExtAppHost.svelte — the **web-bundle runtime host**.
  //
  // An installed third-party app (`store:<manifest-id>`) is a bundle of static
  // files the appstore unpacked on disk. It runs here, in an iframe, at its OWN
  // origin on the `amos-app://` custom protocol — `amos-app://<id>/index.html`
  // (`http://amos-app.<id>/index.html` on Windows/Android). That is what makes a
  // real multi-page / ESM bundle work: its pages, scripts and styles are
  // same-origin with each other, so relative URLs and `fetch` of its own assets
  // need no special handling, and the Rust host (`serve_bundle`) already refuses
  // any path that would climb out of the bundle.
  //
  // Isolation is the frame's own origin, not a fake: the shell is
  // `tauri://localhost` / `http://tauri.localhost`, the bundle is
  // `amos-app://<id>` / `http://amos-app.<id>` — different scheme *and* host — so
  // a bundle can neither read the shell nor remove its own sandbox. See
  // `lib/bundleHost.ts` for the per-flag rationale.
  //
  // Every state is said out loud, and the URL always comes from the host (which
  // also checks the app really is installed and its entry really is servable).
  import {
    BUNDLE_FRAME_SANDBOX,
    fetchBundleEntry,
    type BundleHostFailure,
  } from "../lib/bundleHost";
  import { t } from "./locale.svelte";

  // The store manifest id (NOT the `store:` tile id), and the app's display name
  // for the frame's accessible title.
  let { mid, name }: { mid: string; name: string } = $props();

  type Load =
    | { kind: "loading" }
    | { kind: "ready"; url: string }
    | { kind: "failed"; reason: BundleHostFailure; detail: string };

  let load = $state<Load>({ kind: "loading" });

  const run = async () => {
    load = { kind: "loading" };
    const result = await fetchBundleEntry(mid);
    load =
      result.kind === "ok"
        ? { kind: "ready", url: result.entry.url }
        : { kind: "failed", reason: result.reason, detail: result.detail };
  };
  // Re-runs when the shell switches to another installed app.
  $effect(() => {
    void mid;
    void run();
  });

  // One source of truth for the failure state: `fetchBundleEntry` already reports
  // "offline" when there is no bridge at all, so there is no second, non-reactive
  // `bridged()`-derived copy of the same decision to disagree with it (that copy
  // was a constant, since `bridged()` is a plain function read).
  const failed = $derived(load.kind === "failed" ? load : null);
</script>

{#if load.kind === "ready"}
  <iframe
    data-testid="ext-app-frame"
    title={name}
    src={load.url}
    sandbox={BUNDLE_FRAME_SANDBOX}
    referrerpolicy="no-referrer"
    class="h-full w-full border-0 bg-white dark:bg-neutral-900"
  ></iframe>
{:else if failed}
  <div
    data-testid="ext-app-failed"
    class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center"
  >
    <span class="text-3xl" aria-hidden="true">🧩</span>
    <p class="text-sm font-semibold">{t(`bundle.failed.${failed.reason}`)}</p>
    <!-- The host's own words (e.g. "no web install dir (set …)") — the difference
         between a misconfigured build and "that app is broken". -->
    <p class="max-w-full break-words font-mono text-[11px] opacity-60" data-testid="ext-app-detail">
      {failed.detail}
    </p>
    <button
      type="button"
      class="mt-2 cursor-pointer rounded-full bg-black/5 px-3 py-1.5 text-xs font-medium transition active:scale-95 dark:bg-white/10"
      onclick={() => void run()}
      data-testid="ext-app-reload">{t("bundle.reload")}</button
    >
  </div>
{:else}
  <div
    data-testid="ext-app-loading"
    class="flex h-full items-center justify-center text-sm opacity-60"
  >
    {t("bundle.loading")}
  </div>
{/if}

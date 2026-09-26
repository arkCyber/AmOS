<script lang="ts">
  // PwaHubApp.svelte — 「Web 应用」: the System UI's view of the **system PWA index**.
  //
  // It is the one consumer of `amos-app://index/apps.json` (docs/pwa-index.md):
  // every tile is a **declaration the system ships**, not a download, and each one
  // shows the `[[mcp_tools]]` it hands the AI daemon. That second half is the point
  // of the screen — it is the human-readable, auditable answer to "what can the
  // agent actually call on this device?", which no other surface shows.
  //
  // Honest states, never a blank frame: the index may be genuinely empty (a build
  // that ships no index dir says so — `BUILTIN_MANIFESTS` is empty on purpose),
  // the bridge may be absent (not running inside AmOS), or the gateway may refuse
  // (and it answers with its reason as text, which we show verbatim).
  import {
    fetchPwaIndex,
    openRemotePwa,
    pwaAllTools,
    pwaEntryGlyph,
    pwaEntryIconUrl,
    type PwaEntry,
    type PwaIndexDoc,
    type PwaIndexFailure,
    type PwaRemoteFailure,
  } from "../lib/pwaIndex";
  import { t } from "./locale.svelte";
  import { currentFormFactor } from "../lib/formAuthority.svelte";
  import { pwaHubCols } from "../lib/formLayout";

  type Load =
    | { kind: "loading" }
    | { kind: "ok"; doc: PwaIndexDoc }
    | { kind: "failed"; reason: PwaIndexFailure; detail: string };

  let load = $state<Load>({ kind: "loading" });
  /** The protocol base the host told us to use (shown in the footer, for diagnosis). */
  let base = $state<string | null>(null);
  let selectedId = $state<string | null>(null);

  // The PWA picker scales with the device class (REQ-A293): iOS keeps 4 columns on
  // the phone; iPadOS widens to 6 so the screen real estate is actually used;
  // the desktop class widens further to `DESKTOP_MAX_COLS` (matching the launcher
  // and the photo gallery) so a Mac window does not look like an iPad stretched out.
  // `null` from `currentFormFactor()` is the "no host yet" state — we keep the most
  // conservative answer (the phone's 4) so a preview build stays usable.
  const cols = $derived(pwaHubCols(currentFormFactor() ?? "phone"));

  const run = async () => {
    load = { kind: "loading" };
    const result = await fetchPwaIndex();
    if (result.kind === "ok") {
      // One answer carries both the document and the base it came from — so the
      // icons and the diagnosed base below share that single source of truth.
      base = result.base;
      load = { kind: "ok", doc: result.doc };
    } else {
      load = { kind: "failed", reason: result.reason, detail: result.detail };
    }
  };
  $effect(() => {
    void run();
  });

  const doc = $derived(load.kind === "ok" ? load.doc : null);
  const toolCount = $derived(doc ? pwaAllTools(doc).length : 0);
  const selected = $derived(
    doc && selectedId !== null ? (doc.apps.find((a) => a.id === selectedId) ?? null) : null,
  );

  /** The icon a tile would request, or `null` when the entry declares none. */
  const iconFor = (entry: PwaEntry): string | null =>
    base === null ? null : pwaEntryIconUrl(base, entry);

  const failureKey = (reason: PwaIndexFailure): string => `pwa.failed.${reason}`;

  // ── 「从 URL 添加」 (REQ-A560) ──────────────────────────────────────────────
  //
  // `pwa_open_remote` (Gap 6) had no caller at all: implemented and tested in the
  // `amos-appstore` domain, registered by name in the unwired ledger — so the only way to
  // put a *remote* manifest into this index was to edit the index directory by hand.
  // This is the missing screen. It shows the host's own refusal verbatim (which host was
  // not allow-listed / which env var is unset / which feature the build lacks) instead of a
  // generic failure, and on success it **reloads the index** — the new tile is the proof.
  type RemoteState =
    | { kind: "idle" }
    | { kind: "failed"; reason: PwaRemoteFailure; detail: string }
    | { kind: "added"; name: string };

  let remoteUrl = $state("");
  let remote = $state<RemoteState>({ kind: "idle" });
  let remoteBusy = $state(false);

  const addRemote = async () => {
    if (remoteBusy) return;
    remoteBusy = true;
    remote = { kind: "idle" };
    const result = await openRemotePwa(remoteUrl);
    if (result.kind === "ok") {
      remote = { kind: "added", name: result.app.name };
      remoteUrl = "";
      // Re-read the index: the manifest was persisted by the host, and a tile that has not
      // appeared yet is not something we may claim.
      await run();
    } else {
      remote = { kind: "failed", reason: result.reason, detail: result.detail };
    }
    remoteBusy = false;
  };
</script>

<div
  class="flex h-full flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-4 text-neutral-900 dark:text-neutral-100"
  data-testid="pwa-hub"
>
  <header class="flex items-baseline justify-between gap-2">
    <h1 class="text-[17px] font-semibold tracking-tight">{t("app.pwa")}</h1>
    {#if doc}
      <span class="text-xs opacity-60" data-testid="pwa-count"
        >{t("pwa.count", { n: doc.apps.length })}</span
      >
    {/if}
  </header>

  <!-- Add-from-URL (REQ-A560): the one route a *remote* manifest has into this index.
       Placed outside the load-state branches on purpose — an empty index is exactly when a
       user needs it, and hiding it behind "there are already apps" would only serve the demo
       case. The refusal text below is the host's own sentence, shown verbatim. -->
  <form
    class="flex flex-col gap-1.5"
    onsubmit={(e) => {
      e.preventDefault();
      void addRemote();
    }}
  >
    <div class="flex gap-2">
      <input
        type="url"
        bind:value={remoteUrl}
        placeholder={t("pwa.remotePlaceholder")}
        aria-label={t("pwa.remoteTitle")}
        autocomplete="off"
        spellcheck="false"
        class="min-w-0 flex-1 rounded-xl border border-black/10 bg-white/60 px-3 py-1.5 font-mono text-[11px] outline-none placeholder:opacity-50 focus:border-black/30 dark:border-white/10 dark:bg-black/20 dark:focus:border-white/30"
        data-testid="pwa-remote-url"
      />
      <button
        type="submit"
        disabled={remoteBusy}
        class="cursor-pointer rounded-xl bg-black/5 px-3 py-1.5 text-xs font-medium transition active:scale-95 disabled:opacity-50 dark:bg-white/10"
        data-testid="pwa-remote-add">{t(remoteBusy ? "pwa.remoteBusy" : "pwa.remoteAdd")}</button
      >
    </div>
    {#if remote.kind === "added"}
      <p class="text-[11px] text-emerald-600 dark:text-emerald-400" data-testid="pwa-remote-added">
        {t("pwa.remoteAdded", { name: remote.name })}
      </p>
    {:else if remote.kind === "failed"}
      <p class="text-[11px] text-amber-600 dark:text-amber-400" data-testid="pwa-remote-error">
        {t(`pwa.failed.${remote.reason}`)}
      </p>
      <!-- Which host was not allow-listed, which env var is unset, which feature this build
           lacks — the operator can act on the host's sentence and not on a generic "failed". -->
      <p class="break-words font-mono text-[10px] opacity-60" data-testid="pwa-remote-detail">
        {remote.detail}
      </p>
    {/if}
  </form>

  {#if load.kind === "loading"}
    <p class="py-8 text-center text-sm opacity-60" data-testid="pwa-loading">{t("pwa.loading")}</p>
  {:else if load.kind === "failed"}
    <div class="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4" data-testid="pwa-failed">
      <p class="text-sm font-semibold">{t(failureKey(load.reason))}</p>
      <!-- The gateway answers a refusal with its reason *as text*; showing it is the
           difference between "misconfigured gateway" and "that app does not exist". -->
      <p class="mt-1 break-words font-mono text-[11px] opacity-70" data-testid="pwa-failed-detail">
        {load.detail}
      </p>
      <button
        type="button"
        class="mt-3 cursor-pointer rounded-full bg-black/5 px-3 py-1.5 text-xs font-medium transition active:scale-95 dark:bg-white/10"
        onclick={() => void run()}
        data-testid="pwa-reload">{t("pwa.reload")}</button
      >
    </div>
  {:else if doc && doc.apps.length === 0}
    <div class="py-10 text-center" data-testid="pwa-empty">
      <span class="text-3xl" aria-hidden="true">📦</span>
      <p class="mt-2 text-sm font-semibold">{t("pwa.empty")}</p>
      <p class="mt-1 text-xs opacity-60">{t("pwa.emptyHint")}</p>
    </div>
  {:else if doc}
    <p class="text-xs opacity-60" data-testid="pwa-tools-total">
      {t("pwa.toolsTotal", { n: toolCount })}
    </p>


    <div class="grid gap-4" style={`grid-template-columns: repeat(${cols}, minmax(0, 1fr));`} data-testid="pwa-grid">
      {#each doc.apps as entry (entry.id)}
        <button
          type="button"
          class="flex flex-col items-center gap-2 rounded-2xl p-2 transition active:scale-95 {selectedId ===
          entry.id
            ? 'bg-black/5 dark:bg-white/10'
            : ''}"
          onclick={() => (selectedId = selectedId === entry.id ? null : entry.id)}
          data-testid="pwa-tile"
          data-app-id={entry.id}
        >
          {#if iconFor(entry)}
            <img
              src={iconFor(entry) ?? ""}
              alt=""
              class="h-14 w-14 rounded-2xl object-cover shadow"
              data-testid="pwa-icon"
            />
          {:else}
            <!-- No icon declared → the entry's own glyph, never a placeholder image. -->
            <span
              class="grid h-14 w-14 place-items-center rounded-2xl bg-black/5 text-2xl dark:bg-white/10"
              aria-hidden="true">{pwaEntryGlyph(entry.name)}</span
            >
          {/if}
          <span class="w-full truncate text-center text-[11px] font-medium">{entry.name}</span>
        </button>
      {/each}
    </div>

    {#if selected}
      <section
        class="rounded-2xl border border-black/10 bg-black/[0.03] p-4 dark:border-white/10 dark:bg-white/5"
        data-testid="pwa-detail"
      >
        <h2 class="text-sm font-semibold" data-testid="pwa-detail-name">{selected.name}</h2>
        <p class="mt-0.5 font-mono text-[11px] opacity-60">{selected.id} · {selected.version}</p>
        {#if selected.description}
          <p class="mt-2 text-xs opacity-80">{selected.description}</p>
        {/if}
        <p class="mt-2 break-all text-[11px] opacity-60">
          {t("pwa.entry", { url: selected.display.url })}
        </p>

        {#if selected.allowedDomains.length > 0}
          <p class="mt-1 text-[11px] opacity-60" data-testid="pwa-domains">
            {t("pwa.domains", { n: selected.allowedDomains.length })}
            {selected.allowedDomains.join(", ")}
          </p>
        {/if}

        <h3 class="mt-3 text-xs font-semibold">
          {t("pwa.tools", { n: selected.mcpTools.length })}
        </h3>
        {#if selected.mcpTools.length === 0}
          <p class="mt-1 text-[11px] opacity-60" data-testid="pwa-no-tools">{t("pwa.noTools")}</p>
        {:else}
          <ul class="mt-1 flex flex-col gap-2" data-testid="pwa-tool-list">
            {#each selected.mcpTools as tool (tool.name)}
              <li class="rounded-xl bg-white/60 p-2 dark:bg-black/20">
                <p class="font-mono text-[11px] font-semibold">{tool.name}</p>
                <p class="mt-0.5 text-[11px] opacity-70">{tool.description}</p>
                <p class="mt-0.5 font-mono text-[10px] opacity-50">
                  {t("pwa.toolArgs", { n: tool.inputSchema.required.length })} · {tool.action}
                </p>
              </li>
            {/each}
          </ul>
        {/if}

        <!-- The declared entry is a remote site. AmOS has no capability to open one
             (no external browser, no remote-URL webview), and saying nothing here
             would be the same lie as a button that does nothing. -->
        <p class="mt-3 text-[11px] opacity-60" data-testid="pwa-launch-pending">
          {t("pwa.launchPending")}
        </p>
      </section>
    {/if}
  {/if}

  {#if base}
    <footer
      class="mt-auto pt-2 text-center font-mono text-[10px] opacity-40"
      data-testid="pwa-base">{base}</footer
    >
  {/if}
</div>


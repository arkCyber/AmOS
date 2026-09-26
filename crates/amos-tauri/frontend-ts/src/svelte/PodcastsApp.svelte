<script lang="ts">
  // PodcastsApp.svelte — the Podcasts screen. Svelte 5 (runes).
  //
  // It is a **library and state manager**, not a player. Decoding and rendering audio is
  // the platform player's job (`PlayerApp`), and this build has no cross-app handoff to
  // it — so this screen deliberately has **no play button** rather than a button that
  // does nothing. What it does own is everything the engine records about an episode:
  // the playhead, the finished flag, the playback rate and the download state, plus the
  // subscription lifecycle.
  //
  // Every rule about absence lives in `lib/podcast.ts` and is unit-tested there; this
  // component owns only the wiring and the drawing. The rule that matters: a value the
  // host did not measure prints as `—`, never as `0:00`, `0s` or the epoch.
  //
  // Three things are kept distinct in the UI on purpose, because folding any two of them
  // together would state a fact the host never established:
  //   * a feed that is subscribed but has **never been fetched** (`podcast_feed` answers
  //     `null` on a *successful* call) — "we have not looked";
  //   * a feed whose cached snapshot has **no episodes** — "there are none";
  //   * a call that **failed** (the diag ledger says so) — "we could not read it".
  import { bridged, bridgeDiag } from "../lib/backend";
  import {
    downloadLabelKey,
    durationLabel,
    episodeProgress,
    episodeState,
    feedTotals,
    formatInstant,
    hasDownloadRecord,
    podcastAdd,
    podcastBackendName,
    podcastDownload,
    podcastFeed,
    podcastRefresh,
    podcastRemoveDownload,
    podcastSetPlayed,
    podcastSetPosition,
    podcastSetSpeed,
    podcastSubscribe,
    podcastSubscriptions,
    podcastUnsubscribe,
    refreshSummary,
    speedOptions,
    unplayableReasonKey,
    type EpisodeView,
    type FeedView,
    type RefreshOutcome,
    type RefreshSummary,
    type Subscription,
  } from "../lib/podcast";
  import { t } from "./locale.svelte";

  const online = $derived(bridged());

  let backend = $state<string | null>(null);
  /** `null` = the list has not been read; `[]` = read, and empty. */
  let subs = $state<Subscription[] | null>(null);
  let subsError = $state<string | null>(null);
  let selected = $state<string | null>(null);
  let view = $state<FeedView | null>(null);
  /** The selected feed is subscribed but has no cached snapshot yet. */
  let neverFetched = $state(false);
  let detailError = $state<string | null>(null);
  let busy = $state<string | null>(null);
  /** The last refused write, as a localized sentence. */
  let actionError = $state<string | null>(null);
  /** A non-error outcome worth saying (e.g. "already queued"). */
  let notice = $state<string | null>(null);
  let report = $state<RefreshSummary | null>(null);
  let reportRows = $state<RefreshOutcome[]>([]);
  let urlInput = $state("");
  let titleInput = $state("");
  let addOpen = $state(false);

  const GROUP =
    "rounded-[14px] bg-white/70 p-4 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const MUTED = "text-[13px] text-neutral-500 dark:text-neutral-400";
  const LABEL = "text-[13px] font-medium text-neutral-600 dark:text-neutral-300";
  const BTN =
    "rounded-full px-3 py-1.5 text-[13px] font-medium text-neutral-700 hover:bg-neutral-200 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/20";
  const BTN_ACCENT =
    "rounded-full bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600";

  /**
   * The wire code behind a `null` reply, or `""` when the call never reached the host.
   *
   * `invoke` folds a rejection into `null` (REQ-A296), so the code is only visible in the
   * per-command diagnostic ledger — the same route `StoreApp` takes.
   */
  function codeOf(command: string): string {
    const diag = bridgeDiag(command);
    if (!diag.ok && diag.kind === "command-failed" && typeof diag.detail === "object" && diag.detail) {
      return (diag.detail as { code?: string }).code ?? "";
    }
    return "";
  }

  /** A refused call's message: a localized line for the codes we know by name, and a
   *  neutral sentence otherwise — never the host's own English, path-shaped reason. */
  function messageFor(command: string, fallbackKey: string): string {
    const code = codeOf(command);
    switch (code) {
      case "amos.podcast.url_invalid":
        return t("podcast.errorUrlInvalid");
      case "amos.podcast.url_scheme_unsupported":
        return t("podcast.errorUrlScheme");
      case "amos.podcast.fetch_failed":
        return t("podcast.errorFetch");
      case "amos.podcast.parse_failed":
        return t("podcast.errorParse");
      case "amos.podcast.feed_rejected":
        return t("podcast.errorFeedRejected");
      case "amos.podcast.unknown_feed":
        return t("podcast.errorUnknownFeed");
      case "amos.podcast.subscription_limit":
        return t("podcast.errorSubLimit");
      case "amos.podcast.store_failed":
        return t("podcast.errorStore");
      case "amos.podcast.download_failed":
        return t("podcast.errorDownload");
      case "amos.podcast.no_audio":
        return t("podcast.errorNoAudio");
      case "amos.podcast.download_no_dir":
        return t("podcast.errorNoDir");
      case "amos.podcast.download_unsupported":
        return t("podcast.errorNoTransport");
      case "amos.podcast.episode_id_empty":
      case "amos.podcast.episode_id_too_long":
      case "amos.podcast.rpc_failed":
        return t("podcast.errorRpc");
      default:
        return t(fallbackKey);
    }
  }

  /** The name to draw for a subscription row: the user's own name wins over the feed's.
   *  These are two different facts (`custom_title` = what they typed, `title` = what the
   *  feed calls itself and what a refresh rewrites), so the choice lives here and nowhere
   *  else. Mirrors `Subscription::display_title` in `amos-podcast`. */
  function subTitle(s: Subscription): string {
    if (s.custom_title !== null && s.custom_title !== undefined && s.custom_title !== "") {
      return s.custom_title;
    }
    if (s.title !== null && s.title !== "") return s.title;
    if (s.feed_id === selected && view !== null) return view.title;
    return s.feed_id;
  }

  async function loadBackend(): Promise<void> {
    backend = await podcastBackendName();
  }

  async function loadSubs(): Promise<void> {
    const list = await podcastSubscriptions();
    if (list === null) {
      // A list that could not be read is **not** an empty list: 「还没有订阅」 would be a
      // claim about the user's data made from a failed call.
      subsError = messageFor("podcast_subscriptions", "podcast.subsUnreadable");
      return;
    }
    subsError = null;
    subs = list;
    if (selected === null && list.length > 0) await selectFeed(list[0]!.feed_id);
  }

  async function selectFeed(feedId: string): Promise<void> {
    selected = feedId;
    view = null;
    neverFetched = false;
    detailError = null;
    const v = await podcastFeed(feedId);
    if (v === null) {
      // Two different nulls. `podcast_feed` **succeeded** and answered null ⇒ the feed is
      // subscribed with no snapshot yet. It failed ⇒ we could not read it. The diag
      // ledger is the only place that distinguishes them (REQ-A296).
      if (bridgeDiag("podcast_feed").ok) {
        neverFetched = true;
      } else {
        detailError = messageFor("podcast_feed", "podcast.feedUnreadable");
      }
      return;
    }
    view = v;
  }

  async function reloadDetail(): Promise<void> {
    if (selected === null) return;
    await selectFeed(selected);
  }

  /** Re-fetch one feed, or all of them. A failure is shown per feed, so a batch with one
   *  dead feed never reads as a plain success. */
  async function doRefresh(feedId: string | null): Promise<void> {
    busy = feedId ?? "*";
    actionError = null;
    notice = null;
    const rows = await podcastRefresh(feedId ?? undefined);
    busy = null;
    if (rows === null) {
      report = null;
      reportRows = [];
      actionError = messageFor("podcast_refresh", "podcast.refreshFailed");
      return;
    }
    reportRows = rows;
    report = refreshSummary(rows);
    await loadSubs();
    if (feedId !== null) await reloadDetail();
  }

  async function doSubscribe(): Promise<void> {
    const url = urlInput.trim();
    if (url === "") return;
    busy = "add";
    actionError = null;
    notice = null;
    // With a title the user wants the offline path (store it, do not fetch it yet); without
    // one they asked to subscribe, which fetches first so an unreachable feed is never
    // written to the list.
    const title = titleInput.trim();
    const sub = title === "" ? await podcastSubscribe(url) : await podcastAdd(url, title);
    busy = null;
    if (sub === null) {
      actionError = messageFor(
        title === "" ? "podcast_subscribe" : "podcast_add",
        "podcast.subscribeFailed",
      );
      return;
    }
    urlInput = "";
    titleInput = "";
    addOpen = false;
    await loadSubs();
    await selectFeed(sub.feed_id);
  }

  async function doUnsubscribe(feedId: string): Promise<void> {
    busy = feedId;
    actionError = null;
    notice = null;
    const r = await podcastUnsubscribe(feedId);
    busy = null;
    if (r === null) {
      actionError = messageFor("podcast_unsubscribe", "podcast.unsubscribeFailed");
      return;
    }
    // Say what was actually cleaned up rather than a bare "done": how many playheads went,
    // and whether a cached episode list was dropped. A feed that was subscribed but never
    // fetched drops no cache, so the second sentence is a fact, not a decoration.
    const droppedCache = r.dropped_cached_episodes
      ? ` ${t("podcast.unsubscribedCacheDropped")}`
      : "";
    notice = t("podcast.unsubscribed", { n: r.cleared_progress_records }) + droppedCache;
    if (selected === feedId) {
      selected = null;
      view = null;
      neverFetched = false;
    }
    await loadSubs();
  }

  async function doSetPlayed(ep: EpisodeView, played: boolean): Promise<void> {
    if (selected === null) return;
    actionError = null;
    notice = null;
    const r = await podcastSetPlayed(selected, ep.episode.id, played);
    // `invoke` answers `null` for both success and refusal here, so the verdict is read
    // from the ledger — a refused write must not leave the button looking applied.
    if (r === null && !bridgeDiag("podcast_set_played").ok) {
      actionError = messageFor("podcast_set_played", "podcast.writeRefused");
      return;
    }
    await reloadDetail();
  }

  async function doSetSpeed(ep: EpisodeView, speed: number): Promise<void> {
    if (selected === null) return;
    actionError = null;
    notice = null;
    const stored = await podcastSetSpeed(selected, ep.episode.id, speed);
    if (stored === null) {
      actionError = messageFor("podcast_set_speed", "podcast.writeRefused");
      return;
    }
    // The engine clamps, so the reply is the rate that was **stored** — showing the one
    // that was asked for would put a number on screen the engine does not hold.
    notice = t("podcast.speedStored", { rate: stored.toFixed(2) });
    await reloadDetail();
  }

  async function doSetPosition(ep: EpisodeView, positionSecs: number): Promise<void> {
    if (selected === null) return;
    actionError = null;
    notice = null;
    const r = await podcastSetPosition(selected, ep.episode.id, positionSecs, null);
    if (r === null && !bridgeDiag("podcast_set_position").ok) {
      actionError = messageFor("podcast_set_position", "podcast.writeRefused");
      return;
    }
    await reloadDetail();
  }

  async function doToggleDownload(ep: EpisodeView): Promise<void> {
    if (selected === null) return;
    actionError = null;
    notice = null;
    const queued = hasDownloadRecord(ep.download);
    if (queued) {
      const r = await podcastRemoveDownload(selected, ep.episode.id);
      if (r === null) {
        actionError = messageFor("podcast_remove_download", "podcast.writeRefused");
        return;
      }
      if (!r) {
        // `false` is a refusal to change anything, not a failure — and it needs its own
        // sentence, or the button looks identical before and after the tap (F-SH-777).
        notice = t("podcast.dlNotRecorded");
        return;
      }
      notice = t("podcast.dlForgotten");
      await reloadDetail();
      return;
    }
    // The download is performed by the host: the reply is the state it reached, so the
    // notice names what actually happened instead of implying a request was merely filed.
    const dl = await podcastDownload(selected, ep.episode.id);
    if (dl === null) {
      actionError = messageFor("podcast_download", "podcast.writeRefused");
      return;
    }
    switch (dl.state) {
      case "done":
        notice = t("podcast.dlDone");
        break;
      case "failed":
        // A transport failure is data the host recorded, not a refused command: say why.
        notice = t("podcast.dlFailed", { reason: dl.reason });
        break;
      default:
        // `queued` / `downloading`: already in hand, so nothing was re-fetched.
        notice = t("podcast.dlAlready");
    }
    await reloadDetail();
  }

  $effect(() => {
    if (!online) return;
    void loadBackend();
    void loadSubs();
  });

  const totals = $derived(view === null ? null : feedTotals(view));

  /** `last_refreshed` is `null` until the feed has actually been fetched — the epoch is a
   *  real instant and must never stand in for "we have not looked". */
  function refreshedLabel(s: Subscription): string {
    const d = formatInstant(s.last_refreshed);
    return d ?? t("podcast.neverRefreshed");
  }

  function episodeStateLabel(ep: EpisodeView): string {
    switch (episodeState(ep)) {
      case "played":
        return t("podcast.state.played");
      case "in-progress":
        return t("podcast.state.inProgress");
      default:
        return t("podcast.state.unplayed");
    }
  }
</script>

<div class="flex h-full flex-col gap-3 overflow-hidden p-4">
  <header class="flex items-end justify-between">
    <h1 class="text-[22px] font-semibold text-neutral-900 dark:text-neutral-50">
      {t("app.podcast")}
    </h1>
    <span class={MUTED} data-testid="podcast-backend">
      {backend === null ? "" : t("podcast.backend", { name: backend })}
    </span>
  </header>

  {#if !online}
    <p
      class="shrink-0 rounded-[11px] bg-amber-50 px-4 py-3 text-[13px] text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/20"
      role="status"
      data-testid="podcast-offline"
    >
      {t("podcast.offline")}
    </p>
  {:else}
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <button
        type="button"
        class={BTN_ACCENT}
        disabled={busy !== null || (subs !== null && subs.length === 0)}
        onclick={() => void doRefresh(null)}
        data-testid="podcast-refresh-all"
      >
        {busy === "*" ? t("podcast.refreshing") : t("podcast.refreshAll")}
      </button>
      <button type="button" class={BTN} onclick={() => (addOpen = !addOpen)} data-testid="podcast-add-toggle">
        {t("podcast.addFeed")}
      </button>
    </div>
  {/if}

  {#if actionError}
    <p
      class="shrink-0 rounded-[11px] bg-rose-50 px-3 py-2 text-[13px] text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/20"
      role="alert"
      data-testid="podcast-error"
    >
      {actionError}
    </p>
  {/if}
  {#if notice}
    <p
      class="shrink-0 rounded-[11px] bg-black/5 px-3 py-2 text-[13px] text-neutral-700 dark:bg-white/10 dark:text-neutral-200"
      role="status"
      data-testid="podcast-notice"
    >
      {notice}
    </p>
  {/if}

  {#if addOpen && online}
    <section class={GROUP}>
      <div class={LABEL}>{t("podcast.addFeed")}</div>
      <div class="mt-2 flex flex-col gap-2">
        <input
          class="w-full rounded-[9px] bg-black/5 px-3 py-2 text-[13px] text-neutral-900 outline-none placeholder:text-neutral-400 dark:bg-white/10 dark:text-neutral-100"
          placeholder={t("podcast.urlPlaceholder")}
          bind:value={urlInput}
          data-testid="podcast-url-input"
        />
        <input
          class="w-full rounded-[9px] bg-black/5 px-3 py-2 text-[13px] text-neutral-900 outline-none placeholder:text-neutral-400 dark:bg-white/10 dark:text-neutral-100"
          placeholder={t("podcast.titlePlaceholder")}
          bind:value={titleInput}
          data-testid="podcast-title-input"
        />
        <p class={MUTED}>{t("podcast.addHint")}</p>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class={BTN}
            onclick={() => {
              addOpen = false;
              urlInput = "";
              titleInput = "";
            }}>{t("podcast.cancel")}</button
          >
          <button
            type="button"
            class={BTN_ACCENT}
            disabled={busy !== null || urlInput.trim() === ""}
            onclick={() => void doSubscribe()}
            data-testid="podcast-subscribe"
          >
            {t("podcast.subscribe")}
          </button>
        </div>
      </div>
    </section>
  {/if}

  {#if report !== null && reportRows.length > 0}
    <section class={GROUP} data-testid="podcast-report">
      <div class={LABEL}>{t("podcast.refreshReport")}</div>
      {#if report.anyFailed}
        <p class="mt-1 text-[13px] text-amber-700 dark:text-amber-300">
          {t("podcast.refreshPartial", { ok: report.ok, total: report.total })}
        </p>
      {:else}
        <p class="mt-1 text-[13px] text-neutral-600 dark:text-neutral-300">
          {t("podcast.refreshAllOk", { total: report.total })}
        </p>
      {/if}
      {#if report.keptCache > 0}
        <p class={MUTED}>{t("podcast.refreshKept", { n: report.keptCache })}</p>
      {/if}
      {#if report.anyFailed}
        <ul class="mt-2 flex flex-col divide-y divide-black/5 dark:divide-white/10">
          {#each reportRows.filter((r) => r.error !== null) as r (r.feed_id)}
            <li class="py-2 text-[12px]" data-testid="podcast-report-row">
              <div class="font-medium text-neutral-800 dark:text-neutral-100">{r.feed_id}</div>
              <div class="text-rose-600 dark:text-rose-300">
                {r.error?.code ?? ""} · {r.error?.message ?? ""}
              </div>
              {#if r.kept_previous_cache}
                <div class={MUTED}>{t("podcast.refreshKeptRow")}</div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if subsError !== null}
    <p class={MUTED} data-testid="podcast-subs-unreadable">{subsError}</p>
  {:else if subs !== null && subs.length === 0}
    <p class={MUTED} data-testid="podcast-empty">{t("podcast.noSubs")}</p>
  {/if}

  <div class="flex min-h-0 flex-1 gap-3">
    {#if subs !== null && subs.length > 0}
      <nav
        class="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto"
        aria-label={t("podcast.subscriptions")}
      >
        {#each subs as s (s.feed_id)}
          <button
            type="button"
            class="rounded-[11px] px-3 py-2 text-left text-[13px] {s.feed_id === selected
              ? 'bg-violet-600/10 ring-1 ring-violet-500/30 dark:bg-violet-500/15'
              : 'hover:bg-black/5 dark:hover:bg-white/10'}"
            onclick={() => void selectFeed(s.feed_id)}
            data-testid="podcast-sub-row"
          >
            <div class="truncate font-medium text-neutral-800 dark:text-neutral-100">
              {subTitle(s)}
            </div>
            <div class="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
              {refreshedLabel(s)}
            </div>
          </button>
        {/each}
      </nav>
    {/if}

    <section class="min-h-0 flex-1 overflow-y-auto">
      {#if selected === null}
        <p class={MUTED}>{t("podcast.pickFeed")}</p>
      {:else if detailError !== null}
        <p class="text-[13px] text-rose-600 dark:text-rose-300" data-testid="podcast-detail-error">
          {detailError}
        </p>
      {:else if neverFetched}
        <!-- "We have not looked" — which is not "there are no episodes". -->
        <div class={GROUP} data-testid="podcast-never-fetched">
          <p class="text-[14px] text-neutral-700 dark:text-neutral-200">
            {t("podcast.neverFetched")}
          </p>
          <button
            type="button"
            class="mt-2 {BTN_ACCENT}"
            disabled={busy !== null}
            onclick={() => void doRefresh(selected)}>{t("podcast.refreshOne")}</button
          >
        </div>
      {:else if view !== null}
        <!-- Bound once: a closure inside this branch (`onclick`) loses the `view !== null`
             narrowing, so reading `view.feed_id` inside one is a type error — and the id
             cannot change under the branch without re-rendering it anyway. -->
        {@const feedId = view.feed_id}
        <div class="flex flex-col gap-3">
          <header class={GROUP}>
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h2 class="truncate text-[17px] font-semibold text-neutral-900 dark:text-neutral-50">
                  {view.title}
                </h2>
                <div class={MUTED}>{view.author}</div>
              </div>
              <div class="flex shrink-0 gap-2">
                <button
                  type="button"
                  class={BTN}
                  disabled={busy !== null}
                  onclick={() => void doRefresh(feedId)}
                  data-testid="podcast-refresh-one">{t("podcast.refreshOne")}</button
                >
                <button
                  type="button"
                  class={BTN}
                  disabled={busy !== null}
                  onclick={() => void doUnsubscribe(feedId)}
                  data-testid="podcast-unsubscribe">{t("podcast.unsubscribe")}</button
                >
              </div>
            </div>
            {#if view.description !== ""}
              <p class="mt-2 text-[13px] text-neutral-600 dark:text-neutral-300">
                {view.description}
              </p>
            {/if}
            {#if totals !== null}
              <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-neutral-500 dark:text-neutral-400">
                <span>{t("podcast.countEpisodes", { n: totals.episodes })}</span>
                <span>{t("podcast.countPlayed", { n: totals.played })}</span>
                <span>
                  {#if totals.knownRuntimeSecs === null}
                    <!-- Not one episode states a duration: a total would be invented. -->
                    {t("podcast.runtimeUnknown")}
                  {:else}
                    {t("podcast.runtime", {
                      time: durationLabel(totals.knownRuntimeSecs),
                      covered: totals.runtimeCovering,
                      total: totals.episodes,
                    })}
                  {/if}
                </span>
                <span>{t("podcast.updatedAt", { time: formatInstant(view.fetched_at) ?? "—" })}</span>
              </div>
            {/if}
            {#if view.truncated}
              <p class="mt-2 text-[12px] text-amber-700 dark:text-amber-300" data-testid="podcast-truncated">
                {t("podcast.truncated")}
              </p>
            {/if}
          </header>

          {#if view.episodes.length === 0}
            <p class={MUTED} data-testid="podcast-no-episodes">{t("podcast.noEpisodes")}</p>
          {:else}
            <ul class="flex flex-col gap-2" data-testid="podcast-episodes">
              {#each view.episodes as ep (ep.episode.id)}
                {@const frac = episodeProgress(ep)}
                {@const unplayable = unplayableReasonKey(ep)}
                <li class={GROUP} data-testid="podcast-episode">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="truncate text-[14px] font-medium text-neutral-800 dark:text-neutral-100">
                        {ep.episode.title || t("podcast.untitled")}
                      </div>
                      <div class="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-neutral-500 dark:text-neutral-400">
                        <span data-testid="podcast-episode-duration">{durationLabel(ep.episode.duration_secs)}</span>
                        <span>{formatInstant(ep.episode.published) ?? t("podcast.undated")}</span>
                        <span data-testid="podcast-episode-state">{episodeStateLabel(ep)}</span>
                      </div>
                    </div>
                    <div class="flex shrink-0 items-center gap-1">
                      <!-- Queueing an episode with no enclosure would record a status the
                           screen draws as progress that can never move; forgetting an
                           existing record stays available. -->
                      <button
                        type="button"
                        class={BTN}
                        disabled={busy !== null || (!hasDownloadRecord(ep.download) && unplayable !== null)}
                        onclick={() => void doToggleDownload(ep)}
                        data-testid="podcast-download-toggle"
                      >
                        {hasDownloadRecord(ep.download) ? t("podcast.dl.forget") : t("podcast.dl.queue")}
                      </button>
                      <button
                        type="button"
                        class={BTN}
                        disabled={busy !== null}
                        onclick={() => void doSetPlayed(ep, !ep.played)}
                        data-testid="podcast-played-toggle"
                      >
                        {ep.played ? t("podcast.markUnplayed") : t("podcast.markPlayed")}
                      </button>
                    </div>
                  </div>

                  {#if unplayable !== null}
                    <p class="mt-1 text-[12px] text-amber-700 dark:text-amber-300" data-testid="podcast-no-audio">
                      {t(unplayable)}
                    </p>
                  {/if}

                  {#if hasDownloadRecord(ep.download)}
                    <p class={MUTED} data-testid="podcast-download-state">
                      {t(downloadLabelKey(ep.download))}
                    </p>
                  {/if}

                  <!-- The progress bar only exists when a bar would mean something: `frac`
                       is `null` when no duration is known (feed's or player's), which is not
                       the same as "not started" (`0`). It also only appears once there is a
                       playhead, so a feed read for the first time draws no empty rails. -->
                  {#if frac !== null && ep.position_secs !== null}
                    <div class="mt-2 h-[3px] w-full rounded-full bg-black/10 dark:bg-white/15" role="img" aria-label={episodeStateLabel(ep)}>
                      <div class="h-[3px] rounded-full bg-violet-500" style="width: {Math.round(frac * 100)}%"></div>
                    </div>
                  {/if}

                  <div class="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-neutral-500 dark:text-neutral-400">
                    <span data-testid="podcast-playhead">{t("podcast.playhead", { time: durationLabel(ep.position_secs) })}</span>
                    {#if ep.observed_duration_secs !== null && ep.episode.duration_secs !== null && ep.observed_duration_secs !== ep.episode.duration_secs}
                      <!-- The feed's claim and the player's measurement are two facts; the
                           screen shows both rather than silently preferring one. -->
                      <span data-testid="podcast-duration-mismatch">
                        {t("podcast.durationMismatch", {
                          feed: durationLabel(ep.episode.duration_secs),
                          measured: durationLabel(ep.observed_duration_secs),
                        })}
                      </span>
                    {/if}
                    <label class="flex items-center gap-1">
                      <span>{t("podcast.speed")}</span>
                      <select
                        class="rounded bg-black/5 px-1 py-0.5 dark:bg-white/10"
                        value={String(ep.speed)}
                        disabled={busy !== null}
                        onchange={(e) => void doSetSpeed(ep, Number((e.currentTarget as HTMLSelectElement).value))}
                        data-testid="podcast-speed"
                      >
                        {#each speedOptions(ep.speed) as rate (rate)}
                          <option value={String(rate)}>{rate}x</option>
                        {/each}
                      </select>
                    </label>
                    <button
                      type="button"
                      class={BTN}
                      disabled={busy !== null}
                      onclick={() => void doSetPosition(ep, 0)}
                      data-testid="podcast-rewind"
                    >
                      {t("podcast.resetPlayhead")}
                    </button>
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </section>
  </div>

  <p class={MUTED} data-testid="podcast-boundary">{t("podcast.boundary")}</p>
</div>

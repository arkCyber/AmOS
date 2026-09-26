/**
 * Podcasts — the domain core behind `PodcastsApp.svelte`.
 *
 * Two things live here, and they are deliberately apart:
 *
 *  1. **The bridge seam** — thin wrappers over the `podcast_*` Tauri commands. They return
 *     the Rust payloads unchanged (shapes are documented below) or `null` when there is no
 *     host, exactly like every other wrapper in `lib/backend.ts`.
 *
 *  2. **The pure formatting / aggregation rules** — the only place the *frontend* is allowed
 *     to decide what an absent value looks like.
 *
 * # The one rule this module exists to keep
 *
 * **An unknown is never rendered as a measured zero.** The Rust side models absence as
 * `Option`/`null` throughout (`Episode::duration_secs`, `Episode::published`,
 * `EpisodeView::position_secs`, `Subscription::last_refreshed`), and that distinction has to
 * survive the WebView or it was pointless: a feed that never stated a duration and an
 * episode that is `0:00` long are different facts. So every formatter here takes
 * `number | null` and answers `null` (which the screen prints as `—`) rather than `"0:00"`,
 * `"0s"` or the epoch.
 *
 * The two aggregates below (`refreshSummary`, `feedTotals`) follow the same rule from the
 * other direction: a partial sum is **not** a total, so a member that could not be measured
 * withholds the figure rather than being folded in as `0`.
 */
import { invoke } from "./backend";

/** The playback-rate band the engine clamps to — the same numbers as `amos_podcast`'s
 *  `MIN_SPEED` / `MAX_SPEED`. Mirrored rather than re-derived so the slider's limits and
 *  the engine's clamp cannot drift. */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4.0;

/**
 * Episode download state — the serde spelling of `amos_podcast::DownloadState`.
 *
 * That enum is **internally tagged** (`#[serde(tag = "state", rename_all = "snake_case")]`),
 * so a unit variant reaches the WebView as `{"state":"absent"}` — an object, never the bare
 * `"Absent"`. Typing this as a string union made every comparison in the screen false, which
 * is how a row with nothing recorded came to draw a *forget* button over a *not downloaded*
 * state line. The payload each variant carries is kept: the variant alone cannot say how far
 * a download got, and discarding it here would put it beyond the screen's reach.
 */
export type DownloadState =
  | { state: "absent" }
  | { state: "queued" }
  | { state: "downloading"; received: number; total: number | null }
  | { state: "done"; path: string; bytes: number }
  | { state: "failed"; reason: string };

export interface Episode {
  id: string;
  title: string;
  description: string;
  /** `null` when the feed declares no enclosure URL — there is nothing to play. */
  audio_url: string | null;
  /** `null` when the feed did not state one — **not** a zero-length episode. */
  duration_secs: number | null;
  /** Unix seconds, or `null` when the feed did not date it. */
  published: number | null;
}

/** One episode plus what the three other stores hold about it. */
export interface EpisodeView {
  episode: Episode;
  /** The stored playhead, or `null` when this episode has never been played. */
  position_secs: number | null;
  /** The duration the *player* measured, kept apart from the feed's stated one. */
  observed_duration_secs: number | null;
  played: boolean;
  speed: number;
  download: DownloadState;
}

/** One feed's whole screen payload. */
export interface FeedView {
  feed_id: string;
  title: string;
  author: string;
  description: string;
  link: string;
  /** `null` when the feed declares no artwork. */
  image_url: string | null;
  /** The feed declared more episodes than the parser collected. */
  truncated: boolean;
  /** When this snapshot was fetched, unix seconds. */
  fetched_at: number;
  /** The last successful refresh, or `null` when it has **never** been fetched. */
  last_refreshed: number | null;
  episodes: EpisodeView[];
}

export interface Subscription {
  feed_id: string;
  url: string;
  /** The **feed's own** name as last read (the URL before any fetch). */
  title: string | null;
  /** The **user's own** name, typed in the Add form. `null` = they never named it.
   *  A refresh rewrites `title` (feeds rename themselves) and must never erase this —
   *  see `subTitle`, which is the only reader that may pick between them. */
  custom_title?: string | null;
  /** `null` = never fetched. Not `Some(0)`; the epoch is a real instant. */
  last_refreshed: number | null;
  subscribed_at: number;
}

export interface RefreshError {
  /** The stable wire code, e.g. `amos.podcast.fetch_failed`. */
  code: string;
  message: string;
}

/** One feed's refresh outcome. A failure is **data**: refreshing many feeds reports the
 *  ones that failed without discarding the ones that succeeded. */
export interface RefreshOutcome {
  feed_id: string;
  title: string | null;
  fetched_at: number | null;
  episode_count: number | null;
  /** Whether the episode list was capped — `null` when the refresh failed and so
   *  observed nothing, like every other field on this row. */
  truncated: boolean | null;
  error: RefreshError | null;
  /** `true` only when a snapshot existed *and* survived this failure. */
  kept_previous_cache: boolean;
}

/** What `podcast_unsubscribe` cleaned up. There is no "was the row removed" field: a feed
 *  that is not subscribed is refused (the call resolves `null`), so a report only exists
 *  for a removal that happened. */
export interface UnsubscribeReport {
  /** Whether a **cached** episode list existed and was dropped — `false` for a feed stored
   *  by `podcast_add` and never fetched. */
  dropped_cached_episodes: boolean;
  cleared_progress_records: number;
}

/* -------------------------------------------------------------------------
 * Bridge wrappers. `null` = no host answered (offline / refused).
 * ------------------------------------------------------------------------- */

/** The backend in use (`"mock"` or `"http"`), so the screen can say which. */
export async function podcastBackendName(): Promise<string | null> {
  return invoke<string>("podcast_backend_name");
}

/** The subscribed feeds. `null` means the list could not be read — which is not `[]`. */
export async function podcastSubscriptions(): Promise<Subscription[] | null> {
  return invoke<Subscription[]>("podcast_subscriptions");
}

/** Fetch a feed and subscribe to it. */
export async function podcastSubscribe(url: string): Promise<Subscription | null> {
  return invoke<Subscription>("podcast_subscribe", { url });
}

/** Store a subscription without fetching it (the explicit offline path). */
export async function podcastAdd(url: string, title?: string): Promise<Subscription | null> {
  return invoke<Subscription>("podcast_add", { url, title: title ?? null });
}

/** Re-fetch one feed, or every subscribed feed when `feedId` is omitted. */
export async function podcastRefresh(feedId?: string): Promise<RefreshOutcome[] | null> {
  return invoke<RefreshOutcome[]>("podcast_refresh", { feedId: feedId ?? null });
}

/** One feed's screen payload. `null` covers both "no host" and "subscribed but never
 *  fetched" — the caller distinguishes them with `podcastSubscriptions`. */
export async function podcastFeed(feedId: string): Promise<FeedView | null> {
  return invoke<FeedView>("podcast_feed", { feedId });
}

export async function podcastUnsubscribe(feedId: string): Promise<UnsubscribeReport | null> {
  return invoke<UnsubscribeReport>("podcast_unsubscribe", { feedId });
}

export async function podcastSetPosition(
  feedId: string,
  episodeId: string,
  positionSecs: number,
  observedDurationSecs: number | null = null,
): Promise<null> {
  return invoke<null>("podcast_set_position", {
    feedId,
    episodeId,
    positionSecs,
    observedDurationSecs,
  });
}

/** Set an episode's playback rate; resolves with the rate actually **stored**
 *  (clamped), not the one asked for. `null` on refusal. */
export async function podcastSetSpeed(
  feedId: string,
  episodeId: string,
  speed: number,
): Promise<number | null> {
  return invoke<number>("podcast_set_speed", { feedId, episodeId, speed });
}

export async function podcastSetPlayed(
  feedId: string,
  episodeId: string,
  played: boolean,
): Promise<null> {
  return invoke<null>("podcast_set_played", { feedId, episodeId, played });
}

/**
 * Download one episode now. Resolves to its terminal state: `done` with the written file,
 * `failed` with the transport's reason, or the existing `queued`/`downloading`/`done` when it
 * was already in hand (the host does not re-fetch bytes we have). `null` when no host answered.
 *
 * A transport failure is **data** — it comes back as `{state:"failed"}`, not as a thrown error,
 * so the row renders the reason and a retry rather than the whole action reading as refused.
 */
export async function podcastDownload(
  feedId: string,
  episodeId: string,
): Promise<DownloadState | null> {
  return invoke<DownloadState>("podcast_download", { feedId, episodeId });
}

/** Forget a download record; the file it named is the caller's to delete. */
export async function podcastRemoveDownload(
  feedId: string,
  episodeId: string,
): Promise<boolean | null> {
  return invoke<boolean>("podcast_remove_download", { feedId, episodeId });
}

/* -------------------------------------------------------------------------
 * Pure rules.
 * ------------------------------------------------------------------------- */

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

/**
 * A duration in seconds as `h:mm:ss` / `m:ss`, or `null` when it is **unknown**.
 *
 * `null` in, `null` out: a feed that declares no duration has an *unknown* length, and the
 * screen prints `—` for it. Returning `"0:00"` here would claim a measurement the feed never
 * made — the exact fold the Rust model's `Option<u64>` exists to prevent. Mirrors
 * `amos_podcast::format_duration`.
 */
export function formatDuration(secs: number | null | undefined): string | null {
  if (typeof secs !== "number" || !Number.isFinite(secs) || secs < 0) return null;
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

/** Like {@link formatDuration} but already rendered for a screen: `—` when unknown. */
export function durationLabel(secs: number | null | undefined): string {
  return formatDuration(secs) ?? "—";
}

/**
 * Fraction played in `[0,1]`, or `null` when **no duration is known**.
 *
 * The distinction the progress bar needs: `null` means "we cannot say how far along this
 * is" (draw no bar), while `0` means "we know the length and it has not started". Mirrors
 * `amos_podcast::progress_fraction` exactly, including its treatment of a measured
 * non-positive duration (a live stream): a finite playhead against it is `0`, not `null`.
 */
export function progressFraction(
  positionSecs: number | null,
  durationSecs: number | null,
): number | null {
  // An **unknown** duration and a **measured non-positive** one are different facts and end
  // differently, mirroring the Rust `let d = duration_secs?;` that precedes its own
  // zero-length branch: no duration at all means the fraction is unknowable (`null`), while
  // a known length of zero (a live stream) means there is nothing to be a fraction *of* —
  // that is `0`, not `null` (REQ-A1571 / F-SH-797).
  if (durationSecs === null) return null;
  if (!Number.isFinite(durationSecs) || durationSecs <= 0) {
    return positionSecs !== null && Number.isFinite(positionSecs) ? 0 : null;
  }
  const p = positionSecs ?? 0;
  if (!Number.isFinite(p)) return null;
  return Math.min(1, Math.max(0, p / durationSecs));
}

/**
 * The length to use for a progress bar: the player's own measurement when it has one, else
 * the feed's claim, else `null`.
 *
 * The player's figure wins because a feed's `<itunes:duration>` is frequently wrong or
 * rounded; the two are never averaged or silently merged, and the screen may still show
 * both (see `PodcastsApp`'s "the feed says X, the player measured Y" line).
 */
export function effectiveDurationSecs(ep: EpisodeView): number | null {
  return ep.observed_duration_secs ?? ep.episode.duration_secs;
}

/** How far through an episode the stored playhead is, or `null` when unknowable. */
export function episodeProgress(ep: EpisodeView): number | null {
  return progressFraction(ep.position_secs, effectiveDurationSecs(ep));
}

export type EpisodeState = "played" | "in-progress" | "unplayed";

/**
 * Which of the three states an episode is in.
 *
 * `unplayed` requires a **stored** playhead to be absent (or zero) — it is not inferred from
 * a missing bar, which would also be the shape of an unknown duration.
 */
export function episodeState(ep: EpisodeView): EpisodeState {
  if (ep.played) return "played";
  const p = ep.position_secs;
  return p !== null && Number.isFinite(p) && p > 0 ? "in-progress" : "unplayed";
}

/**
 * An unix-seconds instant as a local `YYYY-MM-DD`, or `null` when it is **unknown**.
 *
 * `null` for an absent instant is the whole point: `Subscription::last_refreshed` is `None`
 * until the feed has actually been fetched, and rendering that as the epoch (or as today)
 * would say "we looked, at the beginning of time". The screen prints `—`/「从未刷新」.
 */
export function formatInstant(secs: number | null | undefined): string | null {
  if (typeof secs !== "number" || !Number.isFinite(secs)) return null;
  const d = new Date(secs * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export interface RefreshSummary {
  total: number;
  ok: number;
  failed: number;
  /** Feeds whose previous snapshot survived the failure — the only ones the UI may offer
   *  to keep showing. */
  keptCache: number;
  /** `true` when at least one feed failed, so a caller cannot show a bare "done". */
  anyFailed: boolean;
  /** The distinct wire codes that failed, for a grouped message. */
  codes: string[];
}

/**
 * Summarize a batch of refresh outcomes.
 *
 * `anyFailed` exists so "refreshed 3 feeds" can never be printed over a batch where one
 * failed — the count of successes is not the count of feeds. The per-feed rows carry the
 * detail; this is only for the status line.
 */
export function refreshSummary(rows: readonly RefreshOutcome[]): RefreshSummary {
  let ok = 0;
  let keptCache = 0;
  const codes = new Set<string>();
  for (const r of rows) {
    if (r.error === null) {
      ok++;
    } else {
      codes.add(r.error.code);
      if (r.kept_previous_cache) keptCache++;
    }
  }
  const failed = rows.length - ok;
  return {
    total: rows.length,
    ok,
    failed,
    keptCache,
    anyFailed: failed > 0,
    codes: [...codes],
  };
}

export interface FeedTotals {
  /** Episodes in the cached snapshot. */
  episodes: number;
  /** How many have a stored playhead (any non-null position). */
  started: number;
  played: number;
  /** Total runtime of the episodes whose duration is **known**, or `null` when not one of
   *  them states a duration. A partial sum is not a total, so this is withheld rather than
   *  reported small. */
  knownRuntimeSecs: number | null;
  /** How many episodes the runtime above actually covers. */
  runtimeCovering: number;
  /** Episodes stating no duration — the reason the runtime covers a subset. */
  runtimeUnknown: number;
}

/**
 * Totals for a feed's header strip.
 *
 * `knownRuntimeSecs` is `null` — never `0` — when no episode states a duration, and it is
 * always accompanied by `runtimeCovering` / `runtimeUnknown` so the screen can say "over N
 * of M episodes" instead of presenting a partial sum as the feed's total length.
 */
export function feedTotals(view: FeedView): FeedTotals {
  let started = 0;
  let played = 0;
  let known = 0;
  let covering = 0;
  for (const ep of view.episodes) {
    if (ep.position_secs !== null) started++;
    if (ep.played) played++;
    const d = ep.episode.duration_secs;
    if (typeof d === "number" && Number.isFinite(d) && d >= 0) {
      known += d;
      covering++;
    }
  }
  return {
    episodes: view.episodes.length,
    started,
    played,
    knownRuntimeSecs: covering > 0 ? known : null,
    runtimeCovering: covering,
    runtimeUnknown: view.episodes.length - covering,
  };
}

/** The label key for each download state, keyed by the wire tag. A total map rather than
 *  a `switch` with a `default`: a new variant is then a compile error instead of a row
 *  that silently draws "not downloaded". */
const DOWNLOAD_LABEL_KEYS: Record<DownloadState["state"], string> = {
  absent: "podcast.dl.absent",
  queued: "podcast.dl.queued",
  downloading: "podcast.dl.downloading",
  done: "podcast.dl.done",
  failed: "podcast.dl.failed",
};

/** The i18n key for a download state's label. */
export function downloadLabelKey(state: DownloadState): string {
  return DOWNLOAD_LABEL_KEYS[state.state];
}

/** The rates the speed picker offers, slowest first. */
const SPEED_OPTIONS = [MIN_SPEED, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, MAX_SPEED] as const;

/**
 * The options a rate picker must offer so it can show `stored`.
 *
 * The engine **clamps** a rate into `0.25..4.0`; it does not snap it to this list (the CLI
 * takes any number, e.g. `speed <feed> <episode> 1.1`). A `<select>` whose `value` matches no
 * `<option>` renders with nothing selected, so the stored rate would simply not be on screen
 * — the picker would be unable to show a rate the engine really holds.
 */
export function speedOptions(stored: number): number[] {
  if (!Number.isFinite(stored) || SPEED_OPTIONS.includes(stored as (typeof SPEED_OPTIONS)[number])) {
    return [...SPEED_OPTIONS];
  }
  return [...SPEED_OPTIONS, stored].sort((a, b) => a - b);
}

/**
 * Whether a download **record** exists for this episode — every state but `absent`.
 *
 * The one place that question is answered, because three things depend on the same answer
 * and must not disagree: the button's label, the action it performs, and whether the state
 * line is drawn at all. Hand-rolling `ep.download !== "Absent"` at each site (against a
 * field that is an object) is what made all three wrong at once.
 */
export function hasDownloadRecord(state: DownloadState): boolean {
  return state.state !== "absent";
}

/**
 * Why an episode cannot be played, or `null` when it can.
 *
 * Answers an i18n key rather than a sentence so the reason is localized at the screen, and
 * names the *established* cause (no enclosure URL in the feed) rather than guessing at a
 * device or transport failure.
 */
export function unplayableReasonKey(ep: EpisodeView): string | null {
  return ep.episode.audio_url === null || ep.episode.audio_url === ""
    ? "podcast.noAudio"
    : null;
}

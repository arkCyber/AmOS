/**
 * `lib/podcast.ts` — the frontend's half of the "an unknown is never a measured zero" rule.
 *
 * Every case here is one of two shapes:
 *
 *  * an **absence** must survive as an absence — a feed that states no duration, an episode
 *    that has never been played, a subscription that has never been fetched. Each has a
 *    negative control beside it (a real `0`, a real instant) so "always answer `null`" or
 *    "always answer `0`" cannot pass;
 *  * an **aggregate** must not manufacture a total from members it could not measure.
 *
 * The Rust side models these as `Option` on purpose (see `crates/amos-podcast/src/lib.rs`);
 * a formatter that folds one into `0`/`0:00`/the epoch throws that distinction away at the
 * last step, which is the step the user actually reads.
 */
import { describe, expect, test } from "vitest";
import {
  downloadLabelKey,
  durationLabel,
  effectiveDurationSecs,
  episodeProgress,
  episodeState,
  feedTotals,
  formatDuration,
  formatInstant,
  hasDownloadRecord,
  progressFraction,
  refreshSummary,
  speedOptions,
  unplayableReasonKey,
  MAX_SPEED,
  MIN_SPEED,
  type DownloadState,
  type Episode,
  type EpisodeView,
  type FeedView,
  type RefreshOutcome,
} from "../lib/podcast";

function ep(over: Partial<Episode> = {}): Episode {
  return {
    id: "e1",
    title: "An episode",
    description: "",
    audio_url: "https://cdn.example/e1.mp3",
    duration_secs: 1800,
    published: 1_700_000_000,
    ...over,
  };
}

function view(over: Partial<EpisodeView> = {}, base: Partial<Episode> = {}): EpisodeView {
  return {
    episode: ep(base),
    position_secs: null,
    observed_duration_secs: null,
    played: false,
    speed: 1,
    download: { state: "absent" },
    ...over,
  };
}

function feed(eps: EpisodeView[], over: Partial<FeedView> = {}): FeedView {
  return {
    feed_id: "https://feeds.example/f.xml",
    title: "A feed",
    author: "",
    description: "",
    link: "",
    image_url: null,
    truncated: false,
    fetched_at: 1_700_000_000,
    last_refreshed: 1_700_000_000,
    episodes: eps,
    ...over,
  };
}

describe("formatDuration — an unknown length is not 0:00", () => {
  test("a stated duration renders, h:mm:ss only past an hour", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(59)).toBe("0:59");
    expect(formatDuration(600)).toBe("10:00");
    expect(formatDuration(2755)).toBe("45:55");
    expect(formatDuration(3661)).toBe("1:01:01");
  });

  test("null (the feed stated no duration) is null, not 0:00", () => {
    // The discriminating pair: a real zero-length episode formats, an unknown does not.
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(0)).toBe("0:00");
  });

  test("a negative or non-finite value is not a duration", () => {
    expect(formatDuration(-1)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("the screen-facing label is an em dash for an unknown", () => {
    expect(durationLabel(null)).toBe("—");
    expect(durationLabel(0)).toBe("0:00");
  });
});

describe("progressFraction — 'we cannot say' is not 'not started'", () => {
  test("with a duration the fraction is clamped into [0,1]", () => {
    expect(progressFraction(0, 100)).toBe(0);
    expect(progressFraction(50, 100)).toBe(0.5);
    expect(progressFraction(180, 100)).toBe(1); // past the end: clamped, not > 1
    expect(progressFraction(-5, 100)).toBe(0);
  });

  test("an unknown duration yields null, never 0", () => {
    expect(progressFraction(600, null)).toBeNull();
    expect(progressFraction(null, null)).toBeNull();
    // The positive control: the same playhead against a known duration is a real number,
    // so a function that always answered null would fail here.
    expect(progressFraction(600, 1200)).toBe(0.5);
  });

  test("a measured non-positive duration (a live stream) is 0, not null — we do know the length is none", () => {
    expect(progressFraction(600, 0)).toBe(0);
    expect(progressFraction(600, -1)).toBe(0);
    // ...but no playhead at all against it is still unknowable.
    expect(progressFraction(null, 0)).toBeNull();
  });

  test("a non-finite playhead with a real duration is null", () => {
    expect(progressFraction(Number.NaN, 100)).toBeNull();
  });
});

describe("the player's measurement and the feed's claim stay two facts", () => {
  test("the measured duration wins for the bar, and the feed's is untouched", () => {
    const e = view({ observed_duration_secs: 2755 }, { duration_secs: 2760 });
    expect(effectiveDurationSecs(e)).toBe(2755);
    expect(e.episode.duration_secs).toBe(2760);
  });

  test("with no measurement the feed's claim is used; with neither, null", () => {
    expect(effectiveDurationSecs(view({}, { duration_secs: 1800 }))).toBe(1800);
    expect(effectiveDurationSecs(view({}, { duration_secs: null }))).toBeNull();
  });

  test("episodeProgress follows whichever duration is available", () => {
    const e = view({ position_secs: 100, observed_duration_secs: 200 }, { duration_secs: 400 });
    expect(episodeProgress(e)).toBe(0.5);
    // Unmeasurable end to end ⇒ null, so no bar is drawn.
    expect(episodeProgress(view({ position_secs: 100 }, { duration_secs: null }))).toBeNull();
  });
});

describe("episodeState — three states, and 'unplayed' is not inferred from a missing bar", () => {
  test("a stored playhead is in progress; a finished flag wins", () => {
    expect(episodeState(view({ position_secs: 100 }))).toBe("in-progress");
    expect(episodeState(view({ position_secs: 100, played: true }))).toBe("played");
    expect(episodeState(view())).toBe("unplayed");
  });

  test("an unknown duration does not make an episode 'in progress'", () => {
    // The trap: a null fraction is also the shape of "never played", and this must not be
    // read as progress.
    const e = view({ position_secs: null }, { duration_secs: null });
    expect(episodeState(e)).toBe("unplayed");
    expect(episodeProgress(e)).toBeNull();
  });

  test("a stored 0.0 playhead is unplayed, not in progress", () => {
    expect(episodeState(view({ position_secs: 0 }))).toBe("unplayed");
  });
});

describe("feedTotals — a partial sum is not a total", () => {
  test("with no stated duration the runtime is withheld, not reported as 0", () => {
    const t = feedTotals(feed([view({}, { duration_secs: null }), view({}, { duration_secs: null })]));
    expect(t.knownRuntimeSecs).toBeNull();
    expect(t.runtimeCovering).toBe(0);
    expect(t.runtimeUnknown).toBe(2);
  });

  test("a partial sum is reported together with how much it covers", () => {
    const t = feedTotals(
      feed([view({}, { duration_secs: 600 }), view({}, { duration_secs: null })]),
    );
    expect(t.knownRuntimeSecs).toBe(600);
    expect(t.runtimeCovering).toBe(1);
    expect(t.runtimeUnknown).toBe(1);
    expect(t.episodes).toBe(2);
  });

  test("the positive control: a feed where every episode states one sums to a real total", () => {
    const t = feedTotals(feed([view({}, { duration_secs: 600 }), view({}, { duration_secs: 900 })]));
    expect(t.knownRuntimeSecs).toBe(1500);
    expect(t.runtimeCovering).toBe(2);
    expect(t.runtimeUnknown).toBe(0);
  });

  test("a genuinely empty feed is 0 episodes and no runtime — not a runtime of 0", () => {
    const t = feedTotals(feed([]));
    expect(t.episodes).toBe(0);
    expect(t.knownRuntimeSecs).toBeNull();
  });

  test("started / played count stored state, not inferred flags", () => {
    const t = feedTotals(
      feed([
        view({ position_secs: 0 }),
        view({ position_secs: 120 }),
        view({ played: true }),
        view(),
      ]),
    );
    expect(t.started).toBe(2);
    expect(t.played).toBe(1);
  });
});

describe("formatInstant — 'never fetched' is not the epoch", () => {
  test("a real instant renders as a local date", () => {
    // 2023-11-14T22:13:20Z — the local calendar day may differ by zone, so assert the shape.
    expect(formatInstant(1_700_000_000)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("null (never refreshed) is null, while 0 is a real instant", () => {
    expect(formatInstant(null)).toBeNull();
    expect(formatInstant(undefined)).toBeNull();
    expect(formatInstant(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatInstant(0)).not.toBeNull();
  });

  test("a non-finite instant is refused", () => {
    expect(formatInstant(Number.NaN)).toBeNull();
    expect(formatInstant(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("refreshSummary — a batch with a failure is never a plain success", () => {
  const ok = (): RefreshOutcome => ({
    feed_id: "a",
    title: "A",
    fetched_at: 1,
    episode_count: 2,
    truncated: false,
    error: null,
    kept_previous_cache: false,
  });
  const bad = (code: string, kept: boolean): RefreshOutcome => ({
    feed_id: "b",
    title: null,
    fetched_at: null,
    episode_count: null,
    // A failed refresh observed nothing, so the observation is absent — the same
    // `null` its sibling fields carry, not a measured `false`.
    truncated: null,
    error: { code, message: "nope" },
    kept_previous_cache: kept,
  });

  test("all-success reports no failure", () => {
    const s = refreshSummary([ok(), ok()]);
    expect(s).toMatchObject({ total: 2, ok: 2, failed: 0, anyFailed: false, keptCache: 0 });
  });

  test("one dead feed flips anyFailed and is counted apart from the successes", () => {
    const s = refreshSummary([ok(), bad("amos.podcast.fetch_failed", true)]);
    expect(s.ok).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.anyFailed).toBe(true);
    expect(s.keptCache).toBe(1);
    expect(s.codes).toEqual(["amos.podcast.fetch_failed"]);
  });

  test("a failure with no previous cache is not counted as kept", () => {
    const s = refreshSummary([bad("amos.podcast.parse_failed", false)]);
    expect(s.keptCache).toBe(0);
    expect(s.anyFailed).toBe(true);
  });

  test("an empty batch has nothing to report as a failure", () => {
    const s = refreshSummary([]);
    expect(s).toMatchObject({ total: 0, ok: 0, failed: 0, anyFailed: false });
  });

  test("distinct codes are de-duplicated and reported in first-seen order", () => {
    const s = refreshSummary([
      bad("amos.podcast.fetch_failed", false),
      bad("amos.podcast.parse_failed", false),
      bad("amos.podcast.fetch_failed", false),
    ]);
    expect(s.codes).toEqual(["amos.podcast.fetch_failed", "amos.podcast.parse_failed"]);
  });
});

describe("unplayableReasonKey — names the established cause", () => {
  test("a missing enclosure URL is the reason, and a present one has none", () => {
    expect(unplayableReasonKey(view({}, { audio_url: null }))).toBe("podcast.noAudio");
    expect(unplayableReasonKey(view({}, { audio_url: "" }))).toBe("podcast.noAudio");
    expect(unplayableReasonKey(view())).toBeNull();
  });
});

describe("download state — the tag is read, and every variant has a label", () => {
  const states: DownloadState[] = [
    { state: "absent" },
    { state: "queued" },
    { state: "downloading", received: 5, total: null },
    { state: "done", path: "/p/e1.mp3", bytes: 1024 },
    { state: "failed", reason: "interrupted" },
  ];

  test("only `absent` means there is no record", () => {
    expect(states.map(hasDownloadRecord)).toEqual([false, true, true, true, true]);
  });

  test("each variant maps to its own label — none is left to a default", () => {
    expect(states.map(downloadLabelKey)).toEqual([
      "podcast.dl.absent",
      "podcast.dl.queued",
      "podcast.dl.downloading",
      "podcast.dl.done",
      "podcast.dl.failed",
    ]);
  });
});

describe("the speed band mirrors the engine's", () => {
  test("the constants the screen offers are inside the band the engine clamps to", () => {
    expect(MIN_SPEED).toBe(0.25);
    expect(MAX_SPEED).toBe(4);
    expect(MIN_SPEED).toBeLessThan(1);
    expect(MAX_SPEED).toBeGreaterThan(1);
  });

  test("the picker can show a stored rate the engine clamped but did not snap", () => {
    // A rate already offered is not duplicated, and the band's own ends stay put.
    expect(speedOptions(1)).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]);
    expect(speedOptions(MIN_SPEED)).toEqual(speedOptions(1));
    // 1.1 is legal (the CLI clamps, it does not snap), so it has to be selectable.
    expect(speedOptions(1.1)).toEqual([0.25, 0.5, 0.75, 1, 1.1, 1.25, 1.5, 2, 3, 4]);
    // An unreadable rate offers no bogus option.
    expect(speedOptions(Number.NaN)).toEqual(speedOptions(1));
  });
});

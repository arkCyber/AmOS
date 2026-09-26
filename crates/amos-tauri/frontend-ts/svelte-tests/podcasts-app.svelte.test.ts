/**
 * PodcastsApp.svelte — the three "no data" states are three different facts.
 *
 * The screen can have nothing to draw for three reasons, and folding any two of them
 * together makes it state something the host never established:
 *
 *  1. the feed is subscribed but `podcast_feed` **succeeded and answered `null`** — we have
 *     never looked at it (no cached snapshot);
 *  2. the call **failed** — we could not read it;
 *  3. the snapshot is real and has zero episodes — there are none.
 *
 * (1) and (2) both reach the component as a `null` reply, so the only thing that separates
 * them is the per-command diagnostic ledger (`bridgeDiag("podcast_feed").ok`) — the same
 * route `StoreApp` takes (REQ-A296). The two cases below are that discriminating pair: the
 * same `null` with a *successful* call must draw the "never fetched" card, and with a
 * *rejected* call must draw the refusal instead. A third case pins (3), so an "empty" reply
 * cannot be smuggled into either.
 *
 * The feed's episode list is also the place the absent-vs-zero rule becomes visible: an
 * episode the feed left undated and un-timed must print 「—」 / "No date", never `0:00`
 * and never the epoch.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import PodcastsApp from "../src/svelte/PodcastsApp.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";
import type { EpisodeView, FeedView } from "../src/lib/podcast";

const FEED = "https://feeds.amos.dev/rust-weekly.xml";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  setLocale("zh");
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const settle = () => new Promise((r) => setTimeout(r, 30));

/** A `Subscription` wire row (the shape `podcast_subscriptions` returns). */
const sub = (lastRefreshed: number | null) => ({
  feed_id: FEED,
  url: FEED,
  title: null,
  last_refreshed: lastRefreshed,
  subscribed_at: 1_700_000_000,
});

/**
 * Install a host whose `podcast_feed` answers `reply`, and which either resolves or rejects.
 *
 * `rejects` is what makes the two `null` cases separable: a rejected invoke is recorded in
 * the ledger as `command-failed`, a resolved `null` as `ok` (REQ-A296).
 */
function installHost(reply: unknown, opts: { rejects?: boolean } = {}) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "podcast_backend_name") return "mock";
      if (cmd === "podcast_subscriptions") return [sub(1_700_000_000)];
      if (cmd === "podcast_feed") {
        if (opts.rejects) throw { code: "amos.podcast.store_failed" };
        return reply;
      }
      return null;
    },
    listen: async () => () => {},
  };
}

/** Typed by the wire types rather than `unknown[]`: this fixture is a statement about what
 *  the host sends, and the shape it once got wrong (`download`, spelled `"Absent"` while the
 *  host sends `{"state":"absent"}`) is pinned behaviourally by the tests below. */
const feedView = (episodes: EpisodeView[]): FeedView => ({
  feed_id: FEED,
  title: "Rust Weekly",
  author: "Amos Demo",
  description: "",
  link: "",
  image_url: null,
  truncated: false,
  fetched_at: 1_700_000_000,
  last_refreshed: 1_700_000_000,
  episodes,
});

describe("PodcastsApp.svelte — a null reply is read, not assumed", () => {
  test("a successful call that answered null means 'never fetched', not 'unreadable'", async () => {
    installHost(null); // subscribed, and the host says there is no snapshot yet
    const h = render(PodcastsApp);
    await settle();

    expect(h.container.querySelector("[data-testid='podcast-never-fetched']")).not.toBeNull();
    // The refusal sentence must be absent: nothing failed here.
    expect(h.container.querySelector("[data-testid='podcast-detail-error']")).toBeNull();
    // And it must not be drawn as an empty feed either.
    expect(h.container.querySelector("[data-testid='podcast-no-episodes']")).toBeNull();
  });

  test("the same null from a rejected call is a refusal, and says so", async () => {
    installHost(null, { rejects: true });
    const h = render(PodcastsApp);
    await settle();

    expect(h.container.querySelector("[data-testid='podcast-detail-error']")).not.toBeNull();
    expect(txt(h)).toContain(zh["podcast.errorStore"]);
    // Not the "we have not looked" card — we did look, and it failed.
    expect(h.container.querySelector("[data-testid='podcast-never-fetched']")).toBeNull();
  });

  test("a real snapshot with no episodes says 'there are none'", async () => {
    installHost(feedView([]));
    const h = render(PodcastsApp);
    await settle();

    expect(h.container.querySelector("[data-testid='podcast-no-episodes']")).not.toBeNull();
    expect(h.container.querySelector("[data-testid='podcast-never-fetched']")).toBeNull();
  });

  test("the subscription row shows 'never refreshed' rather than the epoch", async () => {
    // `last_refreshed: null` is a subscription that has never been fetched; formatting it as
    // the epoch would claim a refresh at the beginning of time.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "podcast_subscriptions") return [sub(null)];
        if (cmd === "podcast_feed") return feedView([]);
        return "mock";
      },
      listen: async () => () => {},
    };
    const h = render(PodcastsApp);
    await settle();

    expect(txt(h)).toContain(zh["podcast.neverRefreshed"]);
    expect(txt(h)).not.toContain("1970");
  });
});

describe("PodcastsApp.svelte — absent episode fields print as absent", () => {
  test("an undated, length-less episode prints em dashes, not 0:00 or the epoch", async () => {
    installHost(
      feedView([
        {
          episode: {
            id: "e1",
            title: "No metadata at all",
            description: "",
            audio_url: null,
            duration_secs: null,
            published: null,
          },
          position_secs: null,
          observed_duration_secs: null,
          played: false,
          speed: 1,
          download: { state: "absent" },
        },
      ]),
    );
    const h = render(PodcastsApp);
    await settle();

    const dur = h.container.querySelector("[data-testid='podcast-episode-duration']");
    expect(dur?.textContent?.trim()).toBe("—");
    expect(txt(h)).toContain(zh["podcast.undated"]);
    expect(txt(h)).not.toContain("1970");
    // The feed never stated a duration, so no progress rail may be drawn.
    expect(txt(h)).toContain(zh["podcast.runtimeUnknown"]);
    // A missing enclosure URL is given its own reason instead of a dead tap.
    expect(h.container.querySelector("[data-testid='podcast-no-audio']")).not.toBeNull();
    // …and the queue button is withheld: recording a download for an episode with no
    // bytes to move would draw as progress that can never advance.
    const dl = h.container.querySelector(
      "[data-testid='podcast-download-toggle']",
    ) as HTMLButtonElement;
    expect(dl.disabled).toBe(true);
  });

  test("an episode the feed left untitled is named in the reader's locale", async () => {
    // The host sends `""` for a feed item with no `<title>`. The domain no longer
    // mints an English "Untitled" for it (that value was written into the cached
    // feed, so it read as English in every locale); the placeholder is the
    // screen's, drawn from the dictionary. The same fixture under `en` must draw
    // the English word — proving the label tracks the locale, not a constant.
    const untitled: EpisodeView = {
      episode: {
        id: "e1",
        title: "",
        description: "",
        audio_url: "https://cdn.amos.dev/a.mp3",
        duration_secs: 600,
        published: null,
      },
      position_secs: null,
      observed_duration_secs: null,
      played: false,
      speed: 1,
      download: { state: "absent" },
    };
    installHost(feedView([untitled]));
    const zhView = render(PodcastsApp);
    await settle();
    expect(txt(zhView)).toContain(zh["podcast.untitled"]);
    cleanup();

    const { en } = await import("../src/i18n/locales/en");
    setLocale("en");
    installHost(feedView([untitled]));
    const enView = render(PodcastsApp);
    await settle();
    expect(txt(enView)).toContain(en["podcast.untitled"]);
    // The two dictionaries differ, so the pair above is not one constant read twice.
    expect(zh["podcast.untitled"]).not.toBe(en["podcast.untitled"]);
  });

  test("the queue button is offered for a playable episode, withheld for one with no audio", async () => {
    const ep = (id: string, audio: string | null) => ({
      episode: {
        id,
        title: id,
        description: "",
        audio_url: audio,
        duration_secs: 600,
        published: null,
      },
      position_secs: null,
      observed_duration_secs: null,
      played: false,
      speed: 1,
      download: { state: "absent" },
    });
    installHost(
      feedView([ep("playable", "https://cdn.amos.dev/a.mp3"), ep("silent", null)]),
    );
    const h = render(PodcastsApp);
    await settle();

    const buttons = [
      ...h.container.querySelectorAll("[data-testid='podcast-download-toggle']"),
    ] as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    // Positive control: the playable one really is tappable, so "always disabled" fails.
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].disabled).toBe(true);
  });

  /**
   * The field the screen reads is `{"state":"absent"}`, not `"Absent"` — the domain enum is
   * internally tagged. Comparing the field itself against a variant name is false for every
   * row, so nothing recorded drew a *forget* button ("取消缓存") over a *no download recorded*
   * state line ("未记录下载"): the button and the line on the same row disagreed, and the tap
   * removed a record that was never there.
   */
  test("the button follows the record it actually has: queue when none, forget when one", async () => {
    const ep = (id: string, download: EpisodeView["download"]): EpisodeView => ({
      episode: {
        id,
        title: id,
        description: "",
        audio_url: `https://cdn.amos.dev/${id}.mp3`,
        duration_secs: 600,
        published: null,
      },
      position_secs: null,
      observed_duration_secs: null,
      played: false,
      speed: 1,
      download,
    });
    installHost(
      feedView([ep("fresh", { state: "absent" }), ep("queued", { state: "queued" })]),
    );
    const h = render(PodcastsApp);
    await settle();

    const buttons = [
      ...h.container.querySelectorAll("[data-testid='podcast-download-toggle']"),
    ] as HTMLButtonElement[];
    expect(buttons[0].textContent?.trim()).toBe(zh["podcast.dl.queue"]);
    expect(buttons[1].textContent?.trim()).toBe(zh["podcast.dl.forget"]);

    // The state line belongs to the row that has a record, and only that row.
    const states = [...h.container.querySelectorAll("[data-testid='podcast-download-state']")];
    expect(states).toHaveLength(1);
    expect(states[0].textContent?.trim()).toBe(zh["podcast.dl.queued"]);
    expect(txt(h)).not.toContain(zh["podcast.dl.absent"]);
  });

  test("a stated duration formats and a played episode shows its state", async () => {
    installHost(
      feedView([
        {
          episode: {
            id: "e1",
            title: "Ownership in depth",
            description: "",
            audio_url: "https://cdn.amos.dev/rw-3.mp3",
            duration_secs: 2760,
            published: 1_700_000_000,
          },
          position_secs: 600,
          observed_duration_secs: 2755,
          played: false,
          speed: 1.5,
          download: { state: "queued" },
        },
      ]),
    );
    const h = render(PodcastsApp);
    await settle();

    expect(
      h.container.querySelector("[data-testid='podcast-episode-duration']")?.textContent?.trim(),
    ).toBe("46:00");
    expect(txt(h)).toContain(zh["podcast.state.inProgress"]);
    // The feed's claim and the player's measurement are both shown, not merged.
    expect(h.container.querySelector("[data-testid='podcast-duration-mismatch']")).not.toBeNull();
    // The download state is drawn from the stored value.
    expect(h.container.querySelector("[data-testid='podcast-download-state']")).not.toBeNull();
    // An unmeasured field is not silently zeroed: the playhead is the stored 600s.
    expect(txt(h)).toContain("10:00");
  });
});

describe("PodcastsApp.svelte — a refused write is never rendered as applied", () => {
  test("a refused 'mark finished' tells the user and keeps the previous state", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "podcast_backend_name") return "mock";
        if (cmd === "podcast_subscriptions") return [sub(1_700_000_000)];
        if (cmd === "podcast_feed") {
          return feedView([
            {
              episode: {
                id: "e1",
                title: "An episode",
                description: "",
                audio_url: "https://cdn.example/e1.mp3",
                duration_secs: 600,
                published: null,
              },
              position_secs: null,
              observed_duration_secs: null,
              played: false,
              speed: 1,
              download: { state: "absent" },
            },
          ]);
        }
        if (cmd === "podcast_set_played") throw { code: "amos.podcast.rpc_failed" };
        return null;
      },
      listen: async () => () => {},
    };
    const h = render(PodcastsApp);
    await settle();

    const toggle = h.container.querySelector(
      "[data-testid='podcast-played-toggle']",
    ) as HTMLButtonElement;
    // Before the tap the episode is unfinished.
    expect(toggle.textContent?.trim()).toBe(zh["podcast.markPlayed"]);
    await fireEvent.click(toggle);
    await settle();

    // The refusal is reported...
    expect(txt(h)).toContain(zh["podcast.errorRpc"]);
    // ...and the button still offers the action rather than claiming it happened.
    const after = h.container.querySelector(
      "[data-testid='podcast-played-toggle']",
    ) as HTMLButtonElement;
    expect(after.textContent?.trim()).toBe(zh["podcast.markPlayed"]);
  });
});

describe("PodcastsApp.svelte — the user's own name outranks the feed's", () => {
  test("a stored custom name is drawn, not the feed's own title", async () => {
    // `custom_title` is what the user typed in the Add form; `title` is what the feed
    // calls itself (and what a refresh rewrites). Two facts — the row must show the
    // first when there is one, or the user's name silently becomes the feed's.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "podcast_backend_name") return "mock";
        if (cmd === "podcast_subscriptions") {
          return [
            { ...sub(1_700_000_000), feed_id: FEED, title: "Rust Weekly", custom_title: "我的 Rust 周报" },
            {
              ...sub(1_700_000_000),
              feed_id: "https://feeds.amos.dev/systems-cast.xml",
              title: "Systems Cast",
              custom_title: null,
            },
          ];
        }
        if (cmd === "podcast_feed") return null;
        return null;
      },
      listen: async () => () => {},
    };
    const h = render(PodcastsApp);
    await settle();

    const rows = [...h.container.querySelectorAll("[data-testid='podcast-sub-row']")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("我的 Rust 周报");
    // The feed's own name must not win while a custom one exists.
    expect(rows[0].textContent).not.toContain("Rust Weekly");
    // Positive control: with no custom name the feed's own title is what shows.
    expect(rows[1].textContent).toContain("Systems Cast");
  });
});

describe("PodcastsApp.svelte — the boundary is stated, not implied", () => {
  test("the screen states its boundary: it moves the bytes, the system player plays them", async () => {
    installHost(feedView([]));
    const h = render(PodcastsApp);
    await settle();
    expect(txt(h)).toContain(zh["podcast.boundary"]);
    // There is no play button, because there is nothing here that could play.
    expect(txt(h)).not.toContain("▶");
  });

  test("offline, the screen says so rather than drawing an empty library", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const h = render(PodcastsApp);
    await settle();
    expect(h.container.querySelector("[data-testid='podcast-offline']")).not.toBeNull();
    // An unreadable library must not be drawn as "you have none" (REQ-A1455's rule).
    expect(h.container.querySelector("[data-testid='podcast-empty']")).toBeNull();
  });
});

/**
 * The unsubscribe report carries two independent facts — the playheads that went and
 * whether a cached episode list was dropped — and the screen used to print only the first.
 * A feed that was subscribed but never fetched drops no cache, so the second sentence is
 * the thing that separates "cleared everything" from "cleared a playhead that existed".
 */
describe("PodcastsApp.svelte — the unsubscribe notice reports the cache, not just the playheads", () => {
  const installUnsubHost = (report: Record<string, unknown>) => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "podcast_subscriptions") return [sub(1_700_000_000)];
        if (cmd === "podcast_feed") return feedView([]);
        if (cmd === "podcast_unsubscribe") return { feed_id: FEED, ...report };
        return "mock";
      },
      listen: async () => () => {},
    };
  };

  test("a dropped cache is disclosed alongside the playhead count", async () => {
    installUnsubHost({
      dropped_cached_episodes: true,
      cleared_progress_records: 2,
    });
    const h = render(PodcastsApp);
    await settle();
    await fireEvent.click(
      h.container.querySelector("[data-testid='podcast-unsubscribe']") as HTMLButtonElement,
    );
    await settle();

    expect(txt(h)).toContain(zh["podcast.unsubscribed"].replace("{n}", "2"));
    expect(txt(h)).toContain(zh["podcast.unsubscribedCacheDropped"]);
  });

  test("a feed with no cached list drops no cache, and says only what it dropped", async () => {
    installUnsubHost({
      dropped_cached_episodes: false,
      cleared_progress_records: 0,
    });
    const h = render(PodcastsApp);
    await settle();
    await fireEvent.click(
      h.container.querySelector("[data-testid='podcast-unsubscribe']") as HTMLButtonElement,
    );
    await settle();

    // Positive control on the same element: the playhead sentence is still drawn…
    expect(txt(h)).toContain(zh["podcast.unsubscribed"].replace("{n}", "0"));
    // …and the cache sentence is not, because nothing was cached to drop.
    expect(txt(h)).not.toContain(zh["podcast.unsubscribedCacheDropped"]);
  });
});

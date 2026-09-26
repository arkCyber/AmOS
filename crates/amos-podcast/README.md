# amos-podcast — the podcast domain core (RSS/Atom, subscriptions, playheads)

The podcast engine: an RSS 2.0 / Atom parser, a `FeedProvider` seam, a bounded
subscription list, a fetched-episode cache, per-episode playheads and an
offline-download registry. Part of **[Amos](../../README.md)**.
Design record: [`docs/podcast.md`](../../docs/podcast.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- **A real XML parser, not string matching.** `feed.rs` parses RSS 2.0 and Atom
  with `quick-xml` under a bounded depth (`MAX_XML_DEPTH`), a bounded document
  size (`MAX_XML_BYTES`) and a per-field text ceiling — a hostile feed cannot
  exhaust memory, and a feed with more items than `MAX_EPISODES_PER_FEED` is
  **flagged truncated**, never silently cut.
- **One seam to the outside.** `provider.rs` defines `FeedProvider`; the domain
  performs **no network I/O of its own**. `MockFeedProvider` serves a fixed
  catalog offline (the default — the workspace builds and tests with zero
  network); `HttpFeedProvider` is a real `ureq` fetcher behind the `live`
  feature.
- **Fetch-before-store.** `PodcastManager::subscribe` fetches first, so the
  subscription list never shows a feed that was never reachable.
  `add_subscription` is the explicit "store now, fetch later" path.
- **Honest absence, everywhere.** `Episode::duration_secs` and
  `Episode::published` are `Option` — a feed that omits a duration must not read
  as `0:00`. `Subscription::last_refreshed: Option<i64>` distinguishes "never
  fetched" from "fetched at the epoch". `ProgressStore::position` returns
  `Option<f64>` so "never played" is not "played and abandoned at 0".
- **Four bounded stores.** Subscriptions (cap 500, **refused** past the cap — a
  subscription is user data, not a cache); the episode cache (cap 500 feeds,
  LRU-evicted); progress (cap 5000, least-recently-updated evicted); downloads
  (cap 2000). Every store writes atomically (staging file + `fsync` + `rename`).

## Layout

| file | what |
|---|---|
| `src/feed.rs` | RSS 2.0 / Atom parser, duration & date parsing, entity handling |
| `src/model.rs` | domain types + total normalizers + bounds |
| `src/provider.rs` | `FeedProvider` seam, `MockFeedProvider`, `HttpFeedProvider` (`live`) |
| `src/manager.rs` | `PodcastManager<P>`: the operations the CLI/bridge drive |
| `src/store.rs` | the subscription list (bounded, refuses past the cap) |
| `src/library.rs` | the fetched-episode cache (bounded, LRU) |
| `src/progress.rs` | per-episode playhead / speed / finished state |
| `src/download.rs` | the offline-download registry (state + retry policy) |
| `src/persist.rs` | atomic JSON I/O shared by the stores |
| `src/error.rs` | `PodcastError` + bounded error detail |

## Build & test

```bash
cargo test -p amos-podcast
cargo test -p amos-podcast --features live
cargo clippy -p amos-podcast --all-targets -- -D warnings
cargo fmt -p amos-podcast -- --check
```

## Examples

```bash
# The whole domain loop against the offline mock: subscribe → play → refresh → unsubscribe.
cargo run -p amos-podcast --example offline_feed
```

| example | shows |
|---|---|
| `offline_feed` | fetch-before-store, the cached snapshot's `fetched_at`, an absent-vs-zero playhead, a measured-vs-stated duration, and what an unsubscribe cleans up — all in memory, no network |

## Honest boundaries

- **This crate is not a player.** It models playback *progress*; decoding and
  rendering audio is the platform player's job (the Tauri `PlayerApp`).
- **Downloaded bytes are moved by the caller.** `DownloadRegistry` records state
  and the scheduling/retry *policy*; it does not itself open sockets or files.
- **Real HTTP is behind the `live` feature and off by default.** Without it the
  env-var that selects `HttpFeedProvider` is ignored and the mock is used.
- **Timestamps are caller-supplied.** Every store takes `now: i64` rather than
  reading a clock, so a test asserts on `last_refreshed` without sleeping.

## Related

- [`docs/podcast.md`](../../docs/podcast.md) — the design record and UI contract.
- [`crates/amos-podcast-cli`](../amos-podcast-cli/README.md) — the terminal front end.
- [`crates/amos-appstore`](../amos-appstore/README.md) — the same provider-seam shape.

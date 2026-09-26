# amos-podcast-cli — the podcast terminal front end

A thin headless CLI over [`amos_podcast::PodcastManager`](../amos-podcast/README.md): subscribe,
refresh, browse the cached episodes, and track playheads / playback speed / download state from a
terminal. Part of **[Amos](../../README.md)**.

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- **The same engine the GUI drives.** Every subcommand calls the domain crate's
  `PodcastManager`; the Tauri bridge exposes the *same* operations to the WebView. A bug fixed
  here is fixed in both.
- **Offline by default.** The default backend is the deterministic `MockFeedProvider`, so the
  binary runs with zero network. `--live` (a `--features live` build) switches to
  `HttpFeedProvider`; a non-`live` build **refuses** `--live` loudly rather than silently
  handing back the demo feed.
- **Fetched-before-stored.** `subscribe` fetches first, so a feed that cannot be reached is
  never written to the subscription list. `add` is the explicit "store now, fetch later" path,
  and `subscriptions` shows such a row as `NEVER refreshed` — not as an empty feed.
- **Absence reads as absence.** An episode the feed gave no duration for prints `—`, never
  `0:00`; an episode never played prints `playhead —`, never `0s`.
- **A dead feed does not stop the others.** `refresh` with no argument refreshes every
  subscription and reports each result; a failure is named, and the previous cache is left
  intact.

```bash
$ amos-podcast-cli subscribe https://feeds.amos.dev/rust-weekly.xml
$ amos-podcast-cli episodes  https://feeds.amos.dev/rust-weekly.xml
$ amos-podcast-cli play      https://feeds.amos.dev/rust-weekly.xml rw-3 600 --duration 2755
$ amos-podcast-cli refresh
$ amos-podcast-cli unsubscribe https://feeds.amos.dev/rust-weekly.xml
```

## Layout

| file | what |
|---|---|
| `src/lib.rs` | `parse_args` (argv -> `Op`), `dispatch` (op -> lines, generic over `FeedProvider`), rendering |
| `src/main.rs` | the binary: parse, dispatch, print |
| `examples/podcast_embed_commands.rs` | the command set driven from a program, sharing one `--dir` |

## Build & test

```bash
cargo test -p amos-podcast-cli
cargo test -p amos-podcast-cli --features live
cargo clippy -p amos-podcast-cli --all-targets -- -D warnings
cargo fmt -p amos-podcast-cli -- --check
```

## Examples

```bash
# Subscribe → list → episodes → play → progress → unsubscribe, all from the library API.
cargo run -p amos-podcast-cli --example podcast_embed_commands
```

| example | shows |
|---|---|
| `podcast_embed_commands` | feeding argv vectors to `run` as data, sharing one `--dir` so state carries between invocations exactly as separate shell calls would |

## Honest boundaries

- **Not a player.** The CLI records a playhead; it never decodes or plays audio. `play` records
  that the player observed `--duration`, it does not measure it.
- **`--dir` is the whole persistence story.** Without it (or `$AMOS_PODCAST_DIR`) every store is
  in memory and reset each run.
- **`unsubscribe` does not delete downloaded files.** It drops the subscription, the cached feed
  and the playheads; the files a `Done` download named are the caller's to remove.
- **`--live` is off by default and feature-gated**, so the default build cannot accidentally
  touch the network.

## Related

- [`crates/amos-podcast`](../amos-podcast/README.md) — the domain engine this drives.
- [`docs/podcast.md`](../../docs/podcast.md) — the design record.
- [`crates/amos-appstore-cli`](../amos-appstore-cli/README.md) — the same CLI shape over the app store.

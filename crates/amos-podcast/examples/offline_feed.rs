//! `offline_feed` — the whole domain loop against the deterministic mock
//! provider, with **no network and no disk**.
//!
//! ```bash
//! cargo run -p amos-podcast --example offline_feed
//! ```
//!
//! It walks: subscribe (fetch-before-store) → list episodes → record a playhead
//! → refresh a cached feed → unsubscribe (and what that cleans up). Every store
//! is in memory (`PodcastPaths::default()`), so running it leaves nothing behind.

use amos_podcast::{
    episode_uid, format_duration, progress_fraction, MockFeedProvider, PodcastManager, PodcastPaths,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // All four stores are in memory: `None` paths mean nothing is written.
    let mut amos = PodcastManager::new(MockFeedProvider::new(), PodcastPaths::default());
    println!("provider: {}", amos.provider_name());

    // 1. Subscribe. `subscribe` fetches *before* it stores, so a subscription is
    //    never a dead row pointing at a feed that cannot be reached.
    let url = "https://feeds.amos.dev/rust-weekly.xml";
    let sub = amos.subscribe(url, 1_700_000_000).await?;
    println!(
        "subscribed: {} (last_refreshed={:?})",
        sub.title, sub.last_refreshed
    );

    // 2. The cached snapshot carries the time it was fetched — a screen can say
    //    how old it is instead of implying it is live.
    let (first_id, first_title, first_duration, fetched_at, episode_count) = {
        let cached = amos.episodes(&sub.feed_id).expect("just cached");
        let first = &cached.feed.episodes[0];
        (
            first.id.clone(),
            first.title.clone(),
            first.duration_secs,
            cached.fetched_at,
            cached.feed.episodes.len(),
        )
    };
    println!("cached at t={fetched_at}, {episode_count} episodes");
    println!("newest: {first_title}");

    let uid = episode_uid(&sub.feed_id, &first_id);

    // 3. Absent vs. zero: nothing is recorded for this episode, so the playhead
    //    is `None` — not `0.0`. The two read differently on screen.
    println!(
        "before playing: position = {:?}",
        amos.progress().position(&uid)
    );

    // 4. A playhead update records the position *and* the duration the player
    //    observed (which may disagree with the feed's stated duration).
    amos.progress_mut()
        .set_position(&uid, 600.0, Some(2755.0), 1_700_000_100)?;
    let pos = amos.progress().position(&uid).expect("we just set it");
    let frac = progress_fraction(pos, Some(2755.0)).expect("a duration is known");
    println!(
        "after playing:  position = {pos:.0}s ({:.0}%)",
        frac * 100.0
    );

    // The player's measured duration is kept apart from the feed's stated one,
    // so a feed that lies still yields an honest "time remaining". `None` (the
    // feed stated no duration) prints as `—`, never `0:00`.
    println!(
        "feed says {}; the player measured 45:55",
        format_duration(first_duration).unwrap_or_else(|| "—".into())
    );

    // 5. Refresh re-fetches into the cache; on failure the previous cache is
    //    left intact rather than the list going blank.
    let refreshed = amos.refresh(&sub.feed_id, 1_700_001_000).await?;
    println!(
        "refreshed: {} at t={} ({} episodes)",
        refreshed.title, refreshed.fetched_at, refreshed.episode_count
    );

    // 6. Unsubscribe reports what it cleaned up, so the UI can say so.
    let gone = amos.unsubscribe(&sub.feed_id)?;
    println!(
        "unsubscribed: subscription={} cache={} progress records cleared={}",
        gone.removed_subscription, gone.dropped_cached_episodes, gone.cleared_progress_records
    );

    Ok(())
}

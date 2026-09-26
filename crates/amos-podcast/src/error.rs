//! `error.rs` — the podcast domain's typed failure surface.
//!
//! Every failure that crosses the crate boundary is one of these variants, with a
//! **stable name** a caller can branch on rather than a string it must parse. The
//! embedded detail strings are *diagnostics* — they are bounded before they are
//! stored (see [`bounded_detail`]) because a hostile or merely broken feed can
//! hand us an arbitrarily long server message, and an error chain is not a place
//! to grow unbounded memory.
//!
//! `FetchFailed` vs `ParseFailed` are deliberately separate: "the bytes never
//! arrived" (network) and "the bytes arrived but are not a feed" (grammar) need
//! different recovery — retry the first, drop the source for the second — and one
//! folded `FeedError` would hide that.

use thiserror::Error;

/// Result alias used throughout the crate.
pub type Result<T> = std::result::Result<T, PodcastError>;

/// Upper bound on a diagnostic detail string carried by an error.
///
/// An upstream HTTP error page or XML parser complaint can be megabytes; keeping
/// only the head means an error path can never be an amplification/holding vector
/// while still naming what went wrong.
pub const MAX_DETAIL_BYTES: usize = 512;

/// Truncate `s` to at most [`MAX_DETAIL_BYTES`] bytes on a UTF-8 char boundary,
/// replacing anything longer with a marked prefix. Total: never panics, works on
/// any input (including a lone multi-byte char at the boundary).
pub fn bounded_detail(s: &str) -> String {
    if s.len() <= MAX_DETAIL_BYTES {
        return s.to_string();
    }
    let mut end = MAX_DETAIL_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = s[..end].to_string();
    out.push('…');
    out
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PodcastError {
    /// The feed URL is empty, whitespace-only, or longer than the ceiling.
    #[error("feed url is empty or too long")]
    UrlInvalid,

    /// The feed URL parsed but is not `http`/`https` (e.g. `file:`, `ftp:`).
    ///
    /// Refused rather than fetched: a subscription URL is attacker-influenceable
    /// (it comes from a share sheet or a pasted link), so allowing `file:` would
    /// let a feed reference turn into a local-file read.
    #[error("feed url must be http or https")]
    UrlSchemeUnsupported,

    /// The network/transport half failed (DNS, TLS, status, timeout).
    #[error("feed fetch failed: {0}")]
    FetchFailed(String),

    /// The bytes arrived but do not parse as an RSS or Atom feed.
    #[error("feed parse failed: {0}")]
    ParseFailed(String),

    /// The document parsed but carried no feed the domain can represent.
    #[error("feed has no usable channel/feed element")]
    FeedNotRecognized,

    /// A feed with no episodes is not "an empty podcast" to be stored silently —
    /// it is reported so the caller decides whether to keep the subscription.
    #[error("feed has no episodes")]
    FeedEmpty,

    /// The referenced subscription id is not in the store.
    #[error("unknown subscription: {0}")]
    UnknownFeed(String),

    /// The subscription file already holds [`crate::store::MAX_SUBSCRIPTIONS`]
    /// and this add would exceed it (refused, never silently evicted).
    #[error("subscription list is full")]
    SubscriptionLimitReached,

    /// A read of a store file failed for a reason other than "absent", so a
    /// write that would replace the bytes never read is refused
    /// ([`crate::store::SubscriptionStore`] ∕ [`crate::progress::ProgressStore`]).
    #[error("podcast store read failed: {0}")]
    StoreReadFailed(String),

    /// A write of a store file failed.
    #[error("podcast store write failed: {0}")]
    StoreWriteFailed(String),

    /// The download was refused before any bytes moved (unknown episode, or a
    /// feed whose enclosure URL is absent — an episode with no audio).
    #[error("episode has no downloadable audio")]
    NoAudio,

    /// A download attempt failed at the transport.
    #[error("download failed: {0}")]
    DownloadFailed(String),

    /// The active provider has no transport for episode bytes, so a download
    /// cannot even be attempted.
    ///
    /// Distinct from [`Self::DownloadFailed`] on purpose: `DownloadFailed` means
    /// the transport *tried* and the bytes did not arrive (retry may help);
    /// this means there was never a transport to try (retrying changes nothing).
    /// The default [`FeedProvider::fetch_episode`] returns it, so a provider that
    /// only knows how to read feeds says so instead of silently moving no bytes.
    ///
    /// [`FeedProvider::fetch_episode`]: crate::provider::FeedProvider::fetch_episode
    #[error("this provider cannot fetch episode audio")]
    DownloadUnsupported,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_detail_passes_short_strings_through_unchanged() {
        assert_eq!(bounded_detail("nope"), "nope");
        assert_eq!(bounded_detail(""), "");
    }

    #[test]
    fn bounded_detail_truncates_on_a_char_boundary() {
        // Each "é" is 2 bytes; 300 of them is 600 bytes > 512, so the cut at 512
        // lands mid-char unless the boundary walk works.
        let s = "é".repeat(300);
        let out = bounded_detail(&s);
        assert!(out.len() <= MAX_DETAIL_BYTES + 3, "len was {}", out.len());
        assert!(out.ends_with('…'));
        // Must remain valid UTF-8 (it is a String, so this is guaranteed) and
        // must not have split a char: re-decoding round-trips.
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }

    #[test]
    fn bounded_detail_never_exceeds_bound_plus_marker() {
        for n in [0usize, 1, 511, 512, 513, 4096] {
            let out = bounded_detail(&"x".repeat(n));
            assert!(out.len() <= MAX_DETAIL_BYTES + 3);
        }
    }
}

//! `model.rs` — the podcast domain types, their bounds, and their total
//! normalizers.
//!
//! # Honest absence
//!
//! Three fields in this module carry a meaningful `None`, and every one of them
//! is a place where a lazier model would fold an *unknown* into a *measured
//! zero* — the defect this repo keeps finding on its UI surfaces:
//!
//! * [`Episode::duration_secs`] — `None` is "the feed did not state a duration",
//!   not "a zero-length episode". A player that renders `None` as `0:00` claims
//!   an episode is empty.
//! * [`Episode::published`] — `None` is "the feed did not state a date", not the
//!   epoch.
//! * [`Subscription::last_refreshed`] — `None` is "never fetched since
//!   subscribing" (an **absent observation**), distinct from `Some(0)`. The UI's
//!   "no episodes" and "we have not looked yet" are different sentences and only
//!   this field distinguishes them.
//!
//! # Bounds
//!
//! Everything a feed can hand us is untrusted text. Free-text is truncated to a
//! per-field ceiling on a char boundary ([`bounded`]), and collections have hard
//! caps ([`MAX_EPISODES_PER_FEED`]) so a hostile feed cannot exhaust memory. The
//! normalizers are **total** — they never panic and never throw, degrading a
//! malformed document to a smaller well-formed one.

use serde::{Deserialize, Serialize};

/// Ceiling on a feed/episode id string.
pub const MAX_ID_BYTES: usize = 512;
/// Ceiling on a display title.
pub const MAX_TITLE_BYTES: usize = 512;
/// Ceiling on a description / summary / free-text body.
pub const MAX_TEXT_BYTES: usize = 4096;
/// Ceiling on a URL (feed, audio enclosure, image).
pub const MAX_URL_BYTES: usize = 2048;
/// Ceiling on an author / category label.
pub const MAX_AUTHOR_BYTES: usize = 256;
/// Hard cap on how many episodes one feed may contribute.
///
/// Real podcasts rarely exceed a few thousand; a feed that does is either
/// hostile or a data dump, and the list UI pages at tens per screen. The parser
/// stops collecting past this bound (it does not *fail*), so a truncated view is
/// reported by [`Feed::truncated`] rather than silently.
pub const MAX_EPISODES_PER_FEED: usize = 2000;

/// Truncate `s` to at most `max` bytes on a UTF-8 char boundary.
///
/// Total: never panics, returns the input unchanged when it already fits.
pub fn bounded(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Collapse whitespace runs (including newlines/tabs a pretty-printed feed puts
/// inside a title) to single spaces and trim. A feed's `<title>\n  Foo\n</title>`
/// must display as `Foo`, not as a two-line string.
pub fn normalize_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(ch);
        }
    }
    out
}

/// Normalize + bound a free-text field in one step.
pub fn clean_text(s: &str, max: usize) -> String {
    bounded(&normalize_whitespace(s), max)
}

/// Drop everything between `<` and the next `>` — a deliberately **non-nesting**
/// tag stripper, not an HTML parser.
///
/// This is what a summary line needs and nothing more: it cannot be fooled into
/// executing anything, and an unclosed `<` consumes only the remainder (which is
/// discarded anyway).
pub fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        if in_tag {
            if ch == '>' {
                in_tag = false;
            }
        } else if ch == '<' {
            in_tag = true;
        } else {
            out.push(ch);
        }
    }
    out
}

/// Decode the five predefined XML entities, decimal `&#NN;` and hex `&#xNN;`.
///
/// An unknown entity is left literal (`&bogus;` stays `&bogus;`) — dropping it
/// silently would edit the feed's words. A bare `&` not forming an entity is
/// kept as-is.
pub fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '&' {
            out.push(ch);
            continue;
        }
        let mut entity = String::new();
        let mut closed = false;
        while let Some(&c) = chars.peek() {
            if c == ';' {
                chars.next();
                closed = true;
                break;
            }
            // An entity is short; a stray '&' must not swallow the body.
            if entity.len() >= 10 || c == '&' || c == '<' || c.is_whitespace() {
                break;
            }
            entity.push(c);
            chars.next();
        }
        if closed {
            out.push_str(&decode_entity(&entity));
        } else {
            out.push('&');
            out.push_str(&entity);
        }
    }
    out
}

/// Strip markup, decode entities, collapse whitespace — the summary-line shape.
///
/// Feed descriptions routinely carry HTML (`<p>…</p>`, `<a href=…>`), and a
/// podcast screen renders them as *text*, so the tags must not be shown.
pub fn strip_markup(s: &str) -> String {
    normalize_whitespace(&decode_entities(&strip_tags(s)))
}

fn decode_entity(entity: &str) -> String {
    match entity {
        "amp" => "&".to_string(),
        "lt" => "<".to_string(),
        "gt" => ">".to_string(),
        "quot" => "\"".to_string(),
        "apos" => "'".to_string(),
        "nbsp" => " ".to_string(),
        other => {
            if let Some(num) = other.strip_prefix('#') {
                let code =
                    if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        num.parse::<u32>().ok()
                    };
                if let Some(code) = code {
                    if let Some(ch) = char::from_u32(code) {
                        return ch.to_string();
                    }
                }
            }
            // Unknown entity: leave it visible rather than dropping silently.
            format!("&{other};")
        }
    }
}

/// One episode (RSS `<item>` / Atom `<entry>`).
///
/// `#[serde(default)]` is load-bearing for the persisted cache: a row written
/// before a field existed (or a hand-edited one) must deserialize to that
/// field's default and then be judged by [`normalize_episode`], not fail the
/// whole file's parse. Without it a single unknown/missing key folds *every*
/// episode list in the cache to empty (see [`crate::persist::load_json`]).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Episode {
    /// Feed-provided identity (`<guid>` / Atom `<id>`), or a deterministic
    /// fallback built from the title + enclosure URL when the feed omits one.
    /// Unique **within its feed**.
    pub id: String,
    /// The episode's name, or `""` when the feed did not give one — an absent
    /// title, **not** a name the feed chose. The placeholder shown for it is the
    /// renderer's job (it holds the locale); the domain deliberately does not
    /// mint one, because this value is written into the persisted feed cache and
    /// an English word baked in here reads as English in every locale.
    pub title: String,
    pub description: String,
    /// The enclosure audio URL. `None` = the episode has no audio to play (a
    /// text-only item); this is not a download failure.
    pub audio_url: Option<String>,
    /// Duration in whole seconds. `None` = the feed did not state one — an
    /// unknown, never a zero.
    pub duration_secs: Option<u64>,
    /// Publish time in unix seconds. `None` = the feed did not state one.
    pub published: Option<i64>,
}

/// A parsed podcast feed.
///
/// `#[serde(default)]` — see [`Episode`]: a cached feed missing a key must
/// degrade to an empty field, not fold the whole library to empty.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Feed {
    pub title: String,
    pub author: String,
    pub description: String,
    /// The channel's human page (`<link>` / Atom alternate link). Empty when
    /// absent.
    pub link: String,
    pub image_url: Option<String>,
    pub episodes: Vec<Episode>,
    /// `true` when the feed declared more episodes than
    /// [`MAX_EPISODES_PER_FEED`] and the parser stopped collecting. The UI must
    /// say so rather than presenting a truncation as the whole list.
    #[serde(default)]
    pub truncated: bool,
}

/// A stored subscription (the user's "I follow this").
///
/// `#[serde(default)]` is the store's safety net: this is the one store whose
/// rows are the user's own data (a subscription cannot be re-derived by a
/// refresh), so a row that predates a field must degrade to that field's default
/// — and then be dropped by [`normalize_subscription`] if it has no usable
/// identity — rather than fold the entire list to empty over one missing key.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Subscription {
    /// Stable id = the normalized feed URL (see [`normalize_feed_url`]).
    pub feed_id: String,
    /// The **feed's own** name, as last seen (captured at subscribe / refresh).
    /// Never blank: a feed that has not been read yet falls back to the URL, so
    /// the list always has something to draw.
    pub title: String,
    /// The **user's own** name for this subscription, from the Add form's
    /// "custom name" field. `None` = they never named it. Kept apart from
    /// `title` because the two are different facts: a refresh rewrites `title`
    /// (the feed can rename itself) and must not erase what the user typed.
    /// `#[serde(default)]` so a file written before this field existed still
    /// loads instead of folding to `Corrupt`.
    #[serde(default)]
    pub custom_title: Option<String>,
    pub url: String,
    /// When the user subscribed, unix seconds.
    pub subscribed_at: i64,
    /// Last **successful** refresh, unix seconds. `None` = never fetched since
    /// subscribing (an absent observation) — distinct from `Some(0)`.
    pub last_refreshed: Option<i64>,
    /// Optional user tag (e.g. a folder name). `None` = untagged.
    pub category: Option<String>,
}

impl Subscription {
    /// The name to draw for this row: the user's own name if they gave one,
    /// otherwise the feed's. The rule lives here so the CLI, the bridge and the
    /// frontend's `subTitle` cannot drift apart — a refresh rewrites `title`
    /// (feeds rename themselves) and must never erase a user's own name.
    pub fn display_title(&self) -> &str {
        match &self.custom_title {
            Some(t) if !t.is_empty() => t,
            _ => &self.title,
        }
    }
}

/// Where a download attempt stands. A superset of "in flight" / "done":
/// [`DownloadState::Failed`] carries a reason so the UI can say *why* and offer
/// a retry, and [`DownloadState::Absent`] (the default) is "never requested",
/// not "failed".
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DownloadState {
    /// Never requested.
    #[default]
    Absent,
    /// Queued, not yet started.
    Queued,
    /// In flight; `received`/`total` bytes for a progress bar (`total` is
    /// `None` when the server did not state a length).
    Downloading { received: u64, total: Option<u64> },
    /// Complete at `path`.
    Done { path: String, bytes: u64 },
    /// Failed with a bounded reason; retryable.
    Failed { reason: String },
}

/// Playback progress for one episode.
///
/// `#[serde(default)]` — see [`Episode`]: a record missing a key degrades to the
/// neutral value ([`normalize_progress`] then clamps it) instead of taking the
/// whole progress store with it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EpisodeProgress {
    /// Last known playhead, seconds. Never negative.
    pub position_secs: f64,
    /// The duration the *player* observed, seconds. `None` = never measured —
    /// distinct from the feed's stated duration and from zero. Kept so a
    /// computed remaining time is honest even when the feed lies.
    pub observed_duration_secs: Option<f64>,
    /// `true` once the user reached the end. Derived state, stored so a finished
    /// episode stays finished across restarts (the playhead alone cannot say
    /// this — a user can seek back to 0 after finishing).
    pub played: bool,
    /// Playback rate (1.0 = normal). Clamped to [`MIN_SPEED`]..=[`MAX_SPEED`].
    pub speed: f64,
    /// When this record was last written, unix seconds — the LRU key.
    pub updated_at: i64,
}

impl Default for EpisodeProgress {
    fn default() -> Self {
        EpisodeProgress {
            position_secs: 0.0,
            observed_duration_secs: None,
            played: false,
            speed: 1.0,
            updated_at: 0,
        }
    }
}

/// Slowest supported playback rate.
pub const MIN_SPEED: f64 = 0.25;
/// Fastest supported playback rate.
pub const MAX_SPEED: f64 = 4.0;

/// Fraction played in `[0,1]`, or `None` when no duration is known.
///
/// The whole point: an unknown duration yields `None`, never `0.0`. A progress
/// bar that renders `None` as empty is honest; one that renders `0.0` says the
/// episode has not started.
pub fn progress_fraction(position_secs: f64, duration_secs: Option<f64>) -> Option<f64> {
    let d = duration_secs?;
    if !(d.is_finite() && d > 0.0) || !position_secs.is_finite() {
        return if position_secs.is_finite() {
            Some(0.0)
        } else {
            None
        };
    }
    Some((position_secs / d).clamp(0.0, 1.0))
}

/// Normalize a raw URL into a feed id, refusing anything unsafe to fetch.
///
/// `http`/`https` only: a subscription URL is attacker-influenceable (share
/// sheet, pasted link, a QR code), so `file:`/`data:`/`ftp:` are refused here,
/// at the single entry point, rather than at each fetch site.
pub fn normalize_feed_url(raw: &str) -> crate::error::Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_URL_BYTES {
        return Err(crate::error::PodcastError::UrlInvalid);
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(crate::error::PodcastError::UrlSchemeUnsupported);
    }
    Ok(trimmed.to_string())
}

/// Deterministic episode identity when the feed omits a `<guid>`/`<id>`.
///
/// Built from normalized title + enclosure URL so re-parsing the same feed
/// yields the same id (a progress record keyed on it survives a refresh). An
/// episode with neither is still given an id from its position, which is the
/// best a feed with no identity permits — and the caller can detect that shape
/// from the `#` marker.
pub fn synthetic_episode_id(index: usize, title: &str, audio_url: Option<&str>) -> String {
    let t = normalize_whitespace(title);
    if let Some(url) = audio_url {
        if !url.is_empty() {
            return format!("url:{url}");
        }
    }
    if !t.is_empty() {
        return format!("title:{t}");
    }
    format!("#{index}")
}

/// Total normalizer for an episode read back from storage.
pub fn normalize_episode(raw: &Episode, index: usize) -> Episode {
    // The parser hands back text in its **encoded** form (`&amp;` stays
    // `&amp;`); a display field decodes it here, in the model layer, so a title
    // reads `The & Show` rather than `The &amp; Show`.
    let title = clean_text(&decode_entities(&raw.title), MAX_TITLE_BYTES);
    let audio_url = raw
        .audio_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty() && u.len() <= MAX_URL_BYTES)
        .map(str::to_string);
    let id = {
        let trimmed = raw.id.trim();
        if trimmed.is_empty() {
            synthetic_episode_id(index, &title, audio_url.as_deref())
        } else {
            bounded(trimmed, MAX_ID_BYTES)
        }
    };
    Episode {
        id,
        title,
        description: clean_text(&strip_markup(&raw.description), MAX_TEXT_BYTES),
        audio_url,
        duration_secs: raw.duration_secs.filter(|d| *d > 0),
        published: raw.published,
    }
}

/// Total normalizer for a feed read back from storage (or a cache).
///
/// Episodes keep their order, duplicates are dropped (first wins), and the
/// result is capped at [`MAX_EPISODES_PER_FEED`].
pub fn normalize_feed(raw: Feed) -> Feed {
    let mut episodes = Vec::with_capacity(raw.episodes.len().min(MAX_EPISODES_PER_FEED));
    let mut seen = std::collections::HashSet::new();
    let mut truncated = raw.truncated;
    for (i, ep) in raw.episodes.iter().enumerate() {
        if episodes.len() >= MAX_EPISODES_PER_FEED {
            truncated = true;
            break;
        }
        let ep = normalize_episode(ep, i);
        if !seen.insert(ep.id.clone()) {
            continue;
        }
        episodes.push(ep);
    }
    Feed {
        title: clean_text(&decode_entities(&raw.title), MAX_TITLE_BYTES),
        author: clean_text(&decode_entities(&raw.author), MAX_AUTHOR_BYTES),
        description: clean_text(&strip_markup(&raw.description), MAX_TEXT_BYTES),
        link: clean_text(&decode_entities(&raw.link), MAX_URL_BYTES),
        image_url: raw
            .image_url
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty() && u.len() <= MAX_URL_BYTES)
            .map(str::to_string),
        episodes,
        truncated,
    }
}

/// Total normalizer for a subscription. Returns `None` when the row has no
/// usable identity (no URL) — a row that cannot be refreshed is dropped rather
/// than kept as a dead entry the UI must special-case.
///
/// `feed_id` is **always** the normalized URL, never the stored one: the id is
/// the key the manager fetches by, so an id that disagrees with the URL would
/// make "refresh this subscription" fetch a different feed than the row shows.
/// A stored id is therefore treated as a hint that is re-derived, not trusted.
pub fn normalize_subscription(raw: &Subscription) -> Option<Subscription> {
    let url = normalize_feed_url(&raw.url).ok()?;
    Some(Subscription {
        feed_id: url.clone(),
        title: {
            let t = clean_text(&raw.title, MAX_TITLE_BYTES);
            if t.is_empty() {
                url.clone()
            } else {
                t
            }
        },
        custom_title: raw
            .custom_title
            .as_deref()
            .map(|t| clean_text(t, MAX_TITLE_BYTES))
            .filter(|t| !t.is_empty()),
        url,
        subscribed_at: raw.subscribed_at,
        last_refreshed: raw.last_refreshed,
        category: raw
            .category
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(|c| bounded(c, MAX_AUTHOR_BYTES)),
    })
}

/// Total normalizer for a progress record: clamps the playhead, speed and the
/// observed duration into range; a non-finite number becomes the neutral value.
pub fn normalize_progress(raw: &EpisodeProgress) -> EpisodeProgress {
    let position = if raw.position_secs.is_finite() && raw.position_secs >= 0.0 {
        raw.position_secs
    } else {
        0.0
    };
    let observed = raw
        .observed_duration_secs
        .filter(|d| d.is_finite() && *d > 0.0);
    // A record claiming both "played" and a playhead is fine, but a record at
    // position 0 that is *not* marked played stays at the start (no phantom
    // resume). Clamp the playhead to the observed duration when we have one.
    let position = match observed {
        Some(d) => position.min(d),
        None => position,
    };
    let speed = if raw.speed.is_finite() {
        raw.speed.clamp(MIN_SPEED, MAX_SPEED)
    } else {
        1.0
    };
    EpisodeProgress {
        position_secs: position,
        observed_duration_secs: observed,
        played: raw.played,
        speed,
        updated_at: raw.updated_at,
    }
}

/// The global key for an episode's progress/download record: `"<feed_id>::<episode_id>"`.
///
/// Episode ids are only unique *within* a feed, so a bare episode id would let
/// two subscriptions' identically-named episodes share one progress record.
pub fn episode_uid(feed_id: &str, episode_id: &str) -> String {
    format!("{feed_id}::{episode_id}")
}

/// Format a duration in seconds as `H:MM:SS` or `M:SS`; `None` yields an em
/// dash placeholder is the *caller's* job — this returns `None` so the caller
/// cannot accidentally print `0:00`.
pub fn format_duration(secs: Option<u64>) -> Option<String> {
    let s = secs?;
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    if h > 0 {
        Some(format!("{h}:{m:02}:{sec:02}"))
    } else {
        Some(format!("{m}:{sec:02}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_never_splits_a_char() {
        let s = "é".repeat(10); // 20 bytes
        let out = bounded(&s, 5); // 5 is mid-char
        assert!(out.is_char_boundary(out.len()));
        assert!(out.len() <= 5);
    }

    #[test]
    fn normalize_whitespace_collapses_and_trims() {
        assert_eq!(normalize_whitespace("  a\n\t b  c "), "a b c");
        assert_eq!(normalize_whitespace("\n \t"), "");
        assert_eq!(normalize_whitespace("solo"), "solo");
    }

    #[test]
    fn strip_markup_drops_tags_and_decodes_entities() {
        assert_eq!(
            strip_markup("<p>Hello &amp; welcome</p>"),
            "Hello & welcome"
        );
        assert_eq!(strip_markup("a <b>bold</b> word"), "a bold word");
        assert_eq!(strip_markup("&#65;&#x42;"), "AB");
        // An unknown entity stays visible; a stray '&' is not swallowed.
        assert_eq!(strip_markup("fish &chips"), "fish &chips");
        assert_eq!(strip_markup("&bogus;"), "&bogus;");
        // An unclosed tag does not panic and consumes to the end.
        assert_eq!(strip_markup("keep <unclosed rest"), "keep");
    }

    #[test]
    fn progress_fraction_is_none_without_a_duration() {
        assert_eq!(progress_fraction(30.0, None), None);
        assert_eq!(progress_fraction(30.0, Some(0.0)), Some(0.0));
        assert_eq!(progress_fraction(30.0, Some(60.0)), Some(0.5));
        assert_eq!(progress_fraction(90.0, Some(60.0)), Some(1.0));
        assert_eq!(progress_fraction(0.0, Some(60.0)), Some(0.0));
        // Non-finite position degrades to None rather than a bogus bar.
        assert_eq!(progress_fraction(f64::NAN, Some(60.0)), None);
    }

    #[test]
    fn normalize_feed_url_refuses_non_http() {
        assert!(normalize_feed_url("https://x/feed").is_ok());
        assert!(normalize_feed_url("  http://x/f  ").is_ok());
        assert_eq!(
            normalize_feed_url("file:///etc/passwd"),
            Err(crate::error::PodcastError::UrlSchemeUnsupported)
        );
        assert_eq!(
            normalize_feed_url("ftp://x/f"),
            Err(crate::error::PodcastError::UrlSchemeUnsupported)
        );
        assert_eq!(
            normalize_feed_url("   "),
            Err(crate::error::PodcastError::UrlInvalid)
        );
    }

    #[test]
    fn normalize_episode_backfills_a_missing_id_deterministically() {
        let raw = Episode {
            id: "  ".into(),
            title: "Ep 1".into(),
            description: "".into(),
            audio_url: Some(" https://cdn/e1.mp3 ".into()),
            duration_secs: Some(0),
            published: None,
        };
        let a = normalize_episode(&raw, 0);
        let b = normalize_episode(&raw, 0);
        assert_eq!(a.id, b.id);
        assert_eq!(a.id, "url:https://cdn/e1.mp3");
        assert_eq!(a.audio_url.as_deref(), Some("https://cdn/e1.mp3"));
        // duration 0 is not a stated duration → None, not Some(0).
        assert_eq!(a.duration_secs, None);
    }

    /// An episode the feed left untitled keeps that **absence** in the domain
    /// layer; the name shown for it belongs to the renderer, which has the
    /// locale. The old fabricated `"Untitled"` was written into the cached feed
    /// (`normalize_feed` runs on both parse and load), so no screen could ever
    /// localize it — a Chinese-locale list read the English word. The sibling
    /// `description` already degrades to `""`; `title` now matches it.
    #[test]
    fn normalize_episode_keeps_an_absent_title_absent() {
        let untitled = Episode {
            id: "e1".into(),
            title: "".into(),
            description: "".into(),
            audio_url: None,
            duration_secs: None,
            published: None,
        };
        assert_eq!(normalize_episode(&untitled, 0).title, "");

        // Positive control: a feed that *does* name the episode is untouched.
        let titled = Episode {
            title: "The & Show".into(),
            ..untitled
        };
        assert_eq!(normalize_episode(&titled, 0).title, "The & Show");
    }

    #[test]
    fn normalize_feed_dedupes_and_caps() {
        let mk = |id: &str| Episode {
            id: id.into(),
            title: "t".into(),
            description: "".into(),
            audio_url: None,
            duration_secs: None,
            published: None,
        };
        let feed = Feed {
            title: "T".into(),
            episodes: vec![mk("a"), mk("a"), mk("b")],
            ..Default::default()
        };
        let n = normalize_feed(feed);
        assert_eq!(n.episodes.len(), 2);
        assert_eq!(n.episodes[0].id, "a");
        assert_eq!(n.episodes[1].id, "b");
        assert!(!n.truncated);
    }

    #[test]
    fn normalize_feed_marks_truncation_past_the_cap() {
        let eps: Vec<Episode> = (0..MAX_EPISODES_PER_FEED + 5)
            .map(|i| Episode {
                id: format!("e{i}"),
                title: "t".into(),
                description: "".into(),
                audio_url: None,
                duration_secs: None,
                published: None,
            })
            .collect();
        let n = normalize_feed(Feed {
            episodes: eps,
            ..Default::default()
        });
        assert_eq!(n.episodes.len(), MAX_EPISODES_PER_FEED);
        assert!(n.truncated);
    }

    #[test]
    fn normalize_subscription_drops_rows_without_a_url() {
        let raw = Subscription {
            feed_id: "x".into(),
            title: "T".into(),
            custom_title: None,
            url: "".into(),
            subscribed_at: 0,
            last_refreshed: None,
            category: None,
        };
        assert!(normalize_subscription(&raw).is_none());

        let ok = Subscription {
            url: "https://x/feed".into(),
            title: "".into(),
            ..raw
        };
        let n = normalize_subscription(&ok).unwrap();
        // A blank title falls back to the URL rather than rendering empty.
        assert_eq!(n.title, "https://x/feed");
        assert_eq!(n.feed_id, "https://x/feed");
    }

    #[test]
    fn normalize_progress_clamps_and_filters_non_finite() {
        let p = normalize_progress(&EpisodeProgress {
            position_secs: f64::NAN,
            observed_duration_secs: Some(-3.0),
            played: false,
            speed: 99.0,
            updated_at: 5,
        });
        assert_eq!(p.position_secs, 0.0);
        assert_eq!(p.observed_duration_secs, None);
        assert_eq!(p.speed, MAX_SPEED);

        let p = normalize_progress(&EpisodeProgress {
            position_secs: 500.0,
            observed_duration_secs: Some(120.0),
            played: false,
            speed: f64::INFINITY,
            updated_at: 1,
        });
        assert_eq!(p.position_secs, 120.0); // clamped to the observed duration
        assert_eq!(p.speed, 1.0);
    }

    #[test]
    fn episode_uid_separates_feeds() {
        assert_eq!(episode_uid("f1", "e1"), "f1::e1");
        assert_ne!(episode_uid("f1", "e1"), episode_uid("f2", "e1"));
    }

    #[test]
    fn format_duration_is_none_for_unknown() {
        assert_eq!(format_duration(None), None);
        assert_eq!(format_duration(Some(0)).as_deref(), Some("0:00"));
        assert_eq!(format_duration(Some(65)).as_deref(), Some("1:05"));
        assert_eq!(format_duration(Some(3725)).as_deref(), Some("1:02:05"));
    }
}

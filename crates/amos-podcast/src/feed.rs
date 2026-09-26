//! `feed.rs` — RSS 2.0 and Atom parsing.
//!
//! Feed XML is the only untrusted text format this crate consumes, so it is
//! parsed with a real XML parser ([`quick_xml`]) rather than string splitting,
//! and the parser is written to be **total under hostile input**:
//!
//! * nesting deeper than [`MAX_XML_DEPTH`] is a refusal, not unbounded stack;
//! * an element's accumulated text is capped ([`MAX_TEXT_BYTES`]) so a single
//!   runaway CDATA block cannot grow memory;
//! * the episode list is capped ([`MAX_EPISODES_PER_FEED`]) and the cap is
//!   *reported* ([`Feed::truncated`]) rather than passed off as the whole feed;
//! * a parse error is a typed [`PodcastError::ParseFailed`] carrying a bounded
//!   detail — never a panic.
//!
//! Two grammars are recognized, distinguished by the root element: `rss` (and
//! the RDF variant `rdf:rdf`) uses `<channel>/<item>`, `feed` uses
//! `<entry>`. Both use the `itunes:` extension namespace for duration/image
//! (matched by qualified name, since the local part `duration` would otherwise
//! collide with unrelated elements).
//!
//! Entities are decoded here, by the crate, in [`crate::model::decode_entities`]
//! — not by the XML parser's own unescape — so attribute *and* text values pass
//! through exactly one decoder and the behaviour is the one under test.

use crate::error::{bounded_detail, PodcastError, Result};
use crate::model::{
    bounded, clean_text, decode_entities, normalize_whitespace, synthetic_episode_id, Episode,
    Feed, MAX_AUTHOR_BYTES, MAX_EPISODES_PER_FEED, MAX_TEXT_BYTES, MAX_TITLE_BYTES, MAX_URL_BYTES,
};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

/// Maximum element nesting accepted. Real feeds nest a handful of levels; a
/// document deeper than this is malformed or hostile.
pub const MAX_XML_DEPTH: usize = 64;

/// Maximum document size accepted, in bytes. A feed is a text index, not a
/// media container; a multi-megabyte "feed" is a data dump or an attack.
pub const MAX_XML_BYTES: usize = 8 * 1024 * 1024;

/// One element on the parse stack: its lowercased qualified name, its
/// attributes (already entity-decoded, lowercased keys), and the text seen so
/// far under it.
struct Frame {
    qname: String,
    attrs: Vec<(String, String)>,
    text: String,
}

impl Frame {
    fn from_start(e: &BytesStart<'_>) -> Frame {
        let qname = String::from_utf8_lossy(e.name().as_ref()).to_ascii_lowercase();
        let mut attrs = Vec::new();
        for attr in e.attributes().flatten() {
            let key = String::from_utf8_lossy(attr.key.as_ref()).to_ascii_lowercase();
            let value = decode_entities(&String::from_utf8_lossy(attr.value.as_ref()));
            attrs.push((key, value));
        }
        Frame {
            qname,
            attrs,
            text: String::new(),
        }
    }

    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// Append text **raw** (entities left encoded), capped at
    /// [`MAX_TEXT_BYTES`] so a runaway text node cannot grow without bound.
    ///
    /// Entities stay encoded here on purpose: the model layer decides per field
    /// whether to decode first (`title`) or strip markup first
    /// (`description`), and decoding here would erase the distinction between
    /// `<p>` (a tag, from CDATA) and `&lt;p&gt;` (literal text, from an escaped
    /// body) — stripping the former is right, stripping the latter edits the
    /// feed's words.
    fn push_text(&mut self, bytes: &[u8]) {
        if self.text.len() >= MAX_TEXT_BYTES {
            return;
        }
        let s = String::from_utf8_lossy(bytes);
        let remaining = MAX_TEXT_BYTES.saturating_sub(self.text.len());
        if s.len() <= remaining {
            self.text.push_str(&s);
        } else {
            let mut end = remaining;
            while end > 0 && !s.is_char_boundary(end) {
                end -= 1;
            }
            self.text.push_str(&s[..end]);
        }
    }
}

/// Accumulates one `<item>`/`<entry>`.
#[derive(Default)]
struct EpisodeBuilder {
    guid: String,
    title: String,
    description: String,
    audio_url: Option<String>,
    /// Set when an `<enclosure>`/`<link rel="enclosure">` explicitly declared a
    /// non-audio type; a later audio-typed enclosure overrides it.
    audio_is_confirmed: bool,
    duration_raw: String,
    published_raw: String,
}

fn in_item(stack: &[Frame]) -> bool {
    stack
        .iter()
        .any(|f| f.qname == "item" || f.qname == "entry")
}

fn is_container(qname: &str) -> bool {
    matches!(qname, "item" | "entry")
}

/// Parse a feed document (RSS 2.0 / Atom) into a [`Feed`].
pub fn parse_feed(xml: &str) -> Result<Feed> {
    if xml.len() > MAX_XML_BYTES {
        return Err(PodcastError::ParseFailed(format!(
            "document exceeds {MAX_XML_BYTES} bytes"
        )));
    }
    // A leading UTF-8 BOM makes the first event a text node and the root
    // unrecognized; strip it before the parser sees it.
    let xml = xml.strip_prefix('\u{feff}').unwrap_or(xml);

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut stack: Vec<Frame> = Vec::new();
    let mut feed = Feed::default();
    let mut current: Option<EpisodeBuilder> = None;
    let mut saw_root = false;
    let mut recognized = false;
    let mut buf: Vec<u8> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Err(e) => {
                return Err(PodcastError::ParseFailed(bounded_detail(&e.to_string())));
            }
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => {
                if stack.len() >= MAX_XML_DEPTH {
                    return Err(PodcastError::ParseFailed("xml nesting too deep".into()));
                }
                let frame = Frame::from_start(&e);
                if !saw_root {
                    saw_root = true;
                    recognized = matches!(frame.qname.as_str(), "rss" | "feed" | "rdf:rdf");
                }
                if is_container(&frame.qname) && current.is_none() {
                    current = Some(EpisodeBuilder::default());
                }
                stack.push(frame);
            }
            Ok(Event::Empty(e)) => {
                let frame = Frame::from_start(&e);
                if !saw_root {
                    saw_root = true;
                    recognized = matches!(frame.qname.as_str(), "rss" | "feed" | "rdf:rdf");
                }
                // An empty element has no children: its own qname is the leaf and
                // the *current stack* is its parent context.
                handle_leaf(&frame, false, &stack, &mut feed, &mut current);
            }
            Ok(Event::Text(e)) => {
                if let Some(top) = stack.last_mut() {
                    top.push_text(e.as_ref());
                }
            }
            Ok(Event::CData(e)) => {
                if let Some(top) = stack.last_mut() {
                    top.push_text(e.as_ref());
                }
            }
            // quick-xml splits `&amp;` out of the surrounding text as a
            // `GeneralRef`. Re-attach it **in its encoded form** so the model
            // layer sees the same bytes a compact writer would have produced
            // (see `Frame::push_text` for why the encoding is preserved).
            Ok(Event::GeneralRef(e)) => {
                if let Some(top) = stack.last_mut() {
                    let name = String::from_utf8_lossy(&e);
                    top.push_text(format!("&{name};").as_bytes());
                }
            }
            Ok(Event::End(_)) => {
                let frame = match stack.pop() {
                    Some(f) => f,
                    // A close tag with no open tag: malformed. Refuse rather than
                    // guess at structure.
                    None => {
                        return Err(PodcastError::ParseFailed("unbalanced close tag".into()));
                    }
                };
                if is_container(&frame.qname) {
                    if let Some(builder) = current.take() {
                        push_episode(&mut feed, builder);
                    }
                } else {
                    handle_leaf(&frame, true, &stack, &mut feed, &mut current);
                }
            }
            // Decl / Comment / PI / DocType carry no domain content.
            Ok(_) => {}
        }
        buf.clear();
    }

    if !recognized {
        return Err(PodcastError::FeedNotRecognized);
    }

    let feed = crate::model::normalize_feed(feed);
    if feed.episodes.is_empty() {
        return Err(PodcastError::FeedEmpty);
    }
    Ok(feed)
}

fn push_episode(feed: &mut Feed, builder: EpisodeBuilder) {
    if feed.episodes.len() >= MAX_EPISODES_PER_FEED {
        feed.truncated = true;
        return;
    }
    let audio = builder.audio_url;
    let id = if !builder.guid.trim().is_empty() {
        bounded(builder.guid.trim(), MAX_URL_BYTES)
    } else {
        synthetic_episode_id(feed.episodes.len(), &builder.title, audio.as_deref())
    };
    feed.episodes.push(Episode {
        id,
        title: clean_text(&builder.title, MAX_TITLE_BYTES),
        description: clean_text(&builder.description, MAX_TEXT_BYTES),
        audio_url: audio,
        duration_secs: parse_duration(&builder.duration_raw),
        published: parse_date(&builder.published_raw),
    });
}

fn handle_leaf(
    frame: &Frame,
    _is_end: bool,
    stack: &[Frame],
    feed: &mut Feed,
    current: &mut Option<EpisodeBuilder>,
) {
    // The parent context is the remaining stack (an empty element's parent is
    // the whole current stack; a closed element's parent is the stack minus it,
    // which is what `stack` already is at the call site).
    let item = in_item(stack);
    let channel = !item
        && stack
            .iter()
            .any(|f| f.qname == "channel" || f.qname == "feed");
    // The channel/feed element **itself**. RSS 2.0 requires `<image>` to carry its own
    // `<title>`, `<link>` and (for `<textInput>`) `<description>`/`<name>`, and those names
    // collide with the channel's own fields — so a channel field must be read from a direct
    // child, or `<image><title>` silently becomes the show's title. `channel` (any ancestor)
    // stays the right test for a value that is legitimately nested, like Atom's
    // `<author><name>`; `image_url` likewise comes from inside `<image>`.
    let channel_direct = !item
        && matches!(
            stack.last().map(|f| f.qname.as_str()),
            Some("channel") | Some("feed")
        );
    let text = frame.text.trim();

    match frame.qname.as_str() {
        "title" => {
            if item {
                if let Some(b) = current.as_mut() {
                    if b.title.is_empty() {
                        b.title = text.to_string();
                    }
                }
            } else if channel_direct {
                feed.title = text.to_string();
            }
        }
        "description" | "summary" | "content" | "subtitle" | "itunes:summary"
        | "itunes:subtitle" => {
            if item {
                if let Some(b) = current.as_mut() {
                    if b.description.is_empty() {
                        b.description = text.to_string();
                    }
                }
            } else if channel_direct {
                feed.description = text.to_string();
            }
        }
        "link" => {
            // RSS `<link>URL</link>`; Atom `<link href=… rel=…/>`.
            let href = frame.attr("href").unwrap_or(text);
            let rel = frame.attr("rel").unwrap_or("alternate");
            if item {
                if rel == "enclosure" {
                    if let Some(b) = current.as_mut() {
                        let ty = frame.attr("type").unwrap_or("");
                        offer_audio(b, href, ty);
                    }
                }
            } else if channel_direct && feed.link.is_empty() && rel == "alternate" {
                feed.link = bounded(href, MAX_URL_BYTES);
            }
        }
        "id" | "guid" => {
            if item {
                if let Some(b) = current.as_mut() {
                    if b.guid.is_empty() {
                        b.guid = text.to_string();
                    }
                }
            }
        }
        "enclosure" => {
            if item {
                if let Some(b) = current.as_mut() {
                    let url = frame.attr("url").unwrap_or("");
                    let ty = frame.attr("type").unwrap_or("");
                    offer_audio(b, url, ty);
                }
            }
        }
        "pubdate" | "published" | "updated" | "dc:date" => {
            if item {
                if let Some(b) = current.as_mut() {
                    // Prefer a stated *published* date over Atom's `updated`.
                    let prefer =
                        matches!(frame.qname.as_str(), "pubdate" | "published" | "dc:date");
                    if b.published_raw.is_empty() || prefer {
                        b.published_raw = text.to_string();
                    }
                }
            }
        }
        "itunes:duration" | "duration" => {
            if item {
                if let Some(b) = current.as_mut() {
                    if b.duration_raw.is_empty() {
                        b.duration_raw = text.to_string();
                    }
                }
            }
        }
        "itunes:author" | "author" | "dc:creator" => {
            if item {
                // Atom nests `<author><name>…</name></author>`; the name leaf is
                // handled below, so ignore the wrapper here.
                if frame.qname == "author" && frame.attr("href").is_none() && text.is_empty() {
                    return;
                }
            }
            if channel_direct && feed.author.is_empty() {
                feed.author = bounded(text, MAX_AUTHOR_BYTES);
            }
        }
        "name" => {
            // Atom `<author><name>` is the only `<name>` that names the show, and it is
            // never a direct child of the feed — so this is the one arm that must look at
            // its **parent** rather than at `channel_direct`. RSS's `<textInput>` also
            // carries a `<name>`, and that one is the query parameter, not an author.
            let under_author =
                !item && matches!(stack.last().map(|f| f.qname.as_str()), Some("author"));
            if under_author && feed.author.is_empty() {
                feed.author = bounded(text, MAX_AUTHOR_BYTES);
            }
        }
        "url" | "logo" | "icon" | "itunes:image" => {
            let href = frame.attr("href").unwrap_or(text);
            if channel && !item && feed.image_url.is_none() && !href.is_empty() {
                feed.image_url = Some(bounded(href, MAX_URL_BYTES));
            }
        }
        _ => {}
    }
}

fn offer_audio(b: &mut EpisodeBuilder, url: &str, ty: &str) {
    let url = url.trim();
    if url.is_empty() {
        return;
    }
    let is_audio = ty.is_empty() || ty.to_ascii_lowercase().starts_with("audio");
    // An explicitly-audio enclosure always wins; a typeless one only fills an
    // empty slot (so a later `type="audio/mpeg"` corrects an earlier guess).
    if is_audio && (!b.audio_is_confirmed || b.audio_url.is_none()) {
        b.audio_url = Some(bounded(url, MAX_URL_BYTES));
        b.audio_is_confirmed = !ty.is_empty();
    }
}

/// Parse an `itunes:duration` value: whole seconds (`"3600"`), or a clock
/// (`"62"`, `"1:02"`, `"1:02:03"`). Returns `None` for anything else — an
/// unparseable duration is unknown, not zero.
pub fn parse_duration(raw: &str) -> Option<u64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(secs) = s.parse::<u64>() {
        return (secs > 0).then_some(secs);
    }
    let parts: Vec<&str> = s.split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut total: u64 = 0;
    for (i, part) in parts.iter().enumerate() {
        let v: u64 = part.trim().parse().ok()?;
        // Hours only ever lead; a trailing field is always seconds.
        let place = parts.len() - 1 - i;
        total = total.checked_add(v.checked_mul(60u64.checked_pow(place as u32)?)?)?;
    }
    (total > 0).then_some(total)
}

/// Parse an RSS `pubDate` (RFC 2822) or an Atom `published`/`updated`
/// (RFC 3339) into unix seconds. Returns `None` when the value is neither — an
/// absent date, not the epoch.
pub fn parse_date(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(s) {
        return Some(dt.timestamp());
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp());
    }
    if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return Some(ndt.and_utc().timestamp());
    }
    None
}

/// **What a feed is called.** The one rule for naming a show, so that a surface
/// cannot invent a second answer: markup stripped from the feed's raw `title`
/// (the cache keeps that raw text on purpose — see
/// [`crate::model::normalize_feed`]), whitespace collapsed, falling back to
/// `fallback_url` when the feed names itself nothing.
///
/// Callers: [`crate::manager::PodcastManager::subscribe`] /
/// `refresh` (which store the result on the subscription), the Tauri bridge's
/// `feed_view`, and the CLI's `subscriptions` / `episodes` lines. A screen that
/// reads the cache's raw `title` instead draws the markup the sidebar stripped.
pub fn display_title(feed: &Feed, fallback_url: &str) -> String {
    let t = normalize_whitespace(&strip_markup_local(&feed.title));
    if t.is_empty() {
        fallback_url.to_string()
    } else {
        t
    }
}

fn strip_markup_local(s: &str) -> String {
    crate::model::strip_markup(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>  The &amp; Show  </title>
    <link>https://example.com/</link>
    <description>A show about &lt;things&gt;.</description>
    <itunes:author>Jane Doe</itunes:author>
    <image><url>https://example.com/cover.png</url></image>
    <item>
      <title>Episode One</title>
      <guid>ep-1</guid>
      <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
      <enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg" length="123"/>
      <pubDate>Wed, 02 Oct 2002 13:00:00 GMT</pubDate>
      <itunes:duration>1:02:03</itunes:duration>
    </item>
    <item>
      <title>Episode Two</title>
      <guid>ep-2</guid>
      <enclosure url="https://cdn.example.com/2.mp3" type="audio/mpeg"/>
      <itunes:duration>3600</itunes:duration>
    </item>
  </channel>
</rss>"#;

    const ATOM: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <title>Atom Cast</title>
  <subtitle>Subtitled</subtitle>
  <link href="https://atom.example.com/" rel="alternate"/>
  <logo>https://atom.example.com/logo.png</logo>
  <author><name>Alex</name></author>
  <entry>
    <title>First</title>
    <id>tag:atom,2020:1</id>
    <summary>Summary one</summary>
    <link rel="enclosure" type="audio/ogg" href="https://cdn.example.com/a.ogg"/>
    <published>2003-12-13T18:30:02Z</published>
    <itunes:duration>65</itunes:duration>
  </entry>
</feed>"#;

    #[test]
    fn parses_rss_with_extensions_and_entities() {
        let f = parse_feed(RSS).expect("rss parses");
        assert_eq!(f.title, "The & Show");
        assert_eq!(f.author, "Jane Doe");
        assert_eq!(f.description, "A show about <things>.");
        assert_eq!(f.link, "https://example.com/");
        assert_eq!(
            f.image_url.as_deref(),
            Some("https://example.com/cover.png")
        );
        assert_eq!(f.episodes.len(), 2);

        let e0 = &f.episodes[0];
        assert_eq!(e0.id, "ep-1");
        assert_eq!(e0.title, "Episode One");
        assert_eq!(e0.description, "Hello world");
        assert_eq!(
            e0.audio_url.as_deref(),
            Some("https://cdn.example.com/1.mp3")
        );
        assert_eq!(e0.duration_secs, Some(3723));
        assert_eq!(e0.published, Some(1033563600));
        assert!(!f.truncated);
    }

    #[test]
    fn parses_atom() {
        let f = parse_feed(ATOM).expect("atom parses");
        assert_eq!(f.title, "Atom Cast");
        assert_eq!(f.author, "Alex");
        assert_eq!(f.description, "Subtitled");
        assert_eq!(f.link, "https://atom.example.com/");
        assert_eq!(
            f.image_url.as_deref(),
            Some("https://atom.example.com/logo.png")
        );
        assert_eq!(f.episodes.len(), 1);
        let e = &f.episodes[0];
        assert_eq!(e.id, "tag:atom,2020:1");
        assert_eq!(e.description, "Summary one");
        assert_eq!(
            e.audio_url.as_deref(),
            Some("https://cdn.example.com/a.ogg")
        );
        assert_eq!(e.duration_secs, Some(65));
        assert_eq!(e.published, Some(1071340202));
    }

    /// RSS 2.0 **requires** `<image>` to carry its own `<url>`, `<title>` and `<link>`, and
    /// allows a `<textInput>` with its own `<title>`, `<description>`, `<name>` and `<link>`.
    /// Those children share their names with the channel's own fields, so a channel field
    /// must come from the channel **itself** — not from any descendant of it.
    #[test]
    fn a_channel_field_is_not_overwritten_by_a_named_child_of_image_or_textinput() {
        // No channel-level author, so the `<name>` inside `<textInput>` has an empty slot
        // to fill if the ancestor rule lets it through.
        let xml = r#"<rss version="2.0">
  <channel>
    <title>Real Show</title>
    <link>https://example.com/</link>
    <description>The actual channel description</description>
    <image>
      <url>https://example.com/cover.png</url>
      <title>Cover art</title>
      <link>https://img.example.com/</link>
    </image>
    <textInput>
      <title>Search this show</title>
      <description>Find an episode</description>
      <name>q</name>
      <link>https://search.example.com/</link>
    </textInput>
    <item>
      <title>One</title>
      <guid>e1</guid>
      <enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg"/>
    </item>
  </channel>
</rss>"#;
        let f = parse_feed(xml).expect("parses");
        assert_eq!(f.title, "Real Show", "the image's title is not the feed's");
        assert_eq!(
            f.link, "https://example.com/",
            "the image's / textInput's link is not the feed's"
        );
        assert_eq!(
            f.description, "The actual channel description",
            "the textInput's description is not the feed's"
        );
        assert_eq!(f.author, "", "the textInput's <name> is not an author");
        assert_eq!(
            f.image_url.as_deref(),
            Some("https://example.com/cover.png"),
            "the channel image url still comes from inside <image>"
        );
    }

    /// The positive control for the rule above: a channel's **own** direct children are
    /// still read, so the tightening cannot be satisfied by reading nothing.
    #[test]
    fn the_channels_own_direct_children_are_still_read() {
        let xml = r#"<rss version="2.0" xmlns:itunes="x">
  <channel>
    <title>Real Show</title>
    <link>https://example.com/</link>
    <description>About things</description>
    <itunes:author>Jane</itunes:author>
    <image>
      <url>https://example.com/cover.png</url>
      <title>Cover art</title>
    </image>
    <item>
      <title>One</title>
      <guid>e1</guid>
      <enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg"/>
    </item>
  </channel>
</rss>"#;
        let f = parse_feed(xml).expect("parses");
        assert_eq!(f.title, "Real Show");
        assert_eq!(f.link, "https://example.com/");
        assert_eq!(f.description, "About things");
        assert_eq!(f.author, "Jane");
    }

    /// An `itunes:author` on an **episode** is the episode's, not the show's. With no
    /// channel-level author the feed must answer "unknown" rather than borrow the first
    /// episode's guest — the screen prints this field as the show's author.
    #[test]
    fn an_episode_author_is_not_promoted_to_the_feed_author() {
        let xml = r#"<rss version="2.0" xmlns:itunes="x">
  <channel>
    <title>Interview Show</title>
    <item>
      <title>One</title>
      <guid>e1</guid>
      <itunes:author>Guest Bob</itunes:author>
      <enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg"/>
    </item>
  </channel>
</rss>"#;
        let f = parse_feed(xml).expect("parses");
        assert_eq!(
            f.author, "",
            "the feed states no author; the first episode's guest is not it"
        );
    }

    #[test]
    fn refuses_a_document_that_is_not_a_feed() {
        assert_eq!(
            parse_feed("<html><body>hi</body></html>"),
            Err(PodcastError::FeedNotRecognized)
        );
    }

    #[test]
    fn refuses_unbalanced_close_tags() {
        let bad = "<rss><channel></title></channel></rss>";
        assert!(matches!(parse_feed(bad), Err(PodcastError::ParseFailed(_))));
    }

    #[test]
    fn a_feed_with_no_episodes_is_reported_not_stored() {
        let empty = "<rss><channel><title>x</title></channel></rss>";
        assert_eq!(parse_feed(empty), Err(PodcastError::FeedEmpty));
    }

    #[test]
    fn depth_is_bounded() {
        let mut xml = String::from("<rss>");
        for _ in 0..(MAX_XML_DEPTH + 5) {
            xml.push_str("<a>");
        }
        let res = parse_feed(&xml);
        assert!(matches!(res, Err(PodcastError::ParseFailed(_))));
    }

    #[test]
    fn strips_a_bom_and_still_recognizes_the_root() {
        let with_bom = format!("\u{feff}{RSS}");
        assert!(parse_feed(&with_bom).is_ok());
    }

    #[test]
    fn an_explicitly_audio_enclosure_beats_a_typeless_one() {
        let xml = r#"<rss><channel><title>t</title>
          <item><title>e</title><id>1</id>
            <enclosure url="https://cdn/x" />
            <enclosure url="https://cdn/y.mp3" type="audio/mpeg" />
          </item></channel></rss>"#;
        let f = parse_feed(xml).unwrap();
        assert_eq!(
            f.episodes[0].audio_url.as_deref(),
            Some("https://cdn/y.mp3")
        );
    }

    #[test]
    fn duration_parser_handles_the_three_shapes_and_rejects_junk() {
        assert_eq!(parse_duration("3600"), Some(3600));
        assert_eq!(parse_duration("1:02:03"), Some(3723));
        assert_eq!(parse_duration("02:03"), Some(123));
        assert_eq!(parse_duration("0"), None);
        assert_eq!(parse_duration(""), None);
        assert_eq!(parse_duration("1:2:3:4"), None);
        assert_eq!(parse_duration("nope"), None);
    }

    #[test]
    fn date_parser_handles_rfc2822_and_rfc3339() {
        assert_eq!(
            parse_date("Wed, 02 Oct 2002 13:00:00 GMT"),
            Some(1033563600)
        );
        assert_eq!(parse_date("2003-12-13T18:30:02Z"), Some(1071340202));
        assert_eq!(parse_date(""), None);
        assert_eq!(parse_date("not a date"), None);
    }

    #[test]
    fn a_truncated_feed_is_flagged_not_silently_cut() {
        let mut xml = String::from("<rss><channel><title>t</title>");
        for i in 0..(MAX_EPISODES_PER_FEED + 3) {
            xml.push_str(&format!(
                "<item><title>e{i}</title><id>{i}</id><enclosure url=\"https://c/{i}\" type=\"audio/mpeg\"/></item>"
            ));
        }
        xml.push_str("</channel></rss>");
        let f = parse_feed(&xml).unwrap();
        assert_eq!(f.episodes.len(), MAX_EPISODES_PER_FEED);
        assert!(f.truncated);
    }
}

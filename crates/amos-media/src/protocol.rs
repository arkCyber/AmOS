// DRAFT — REQ-A302 stream-media draft
// =====================================
//
// This file is intentionally NOT a `pub mod` of `lib.rs`: see the comment in
// `lib.rs` that documents the disconnect. The orphan-draft status is *not*
// an oversight; it is the safest place this code can live until the
// `range` + `manager` + `spec` API surface that this file expects matches
// what those modules actually export today. Re-introducing the
// `pub mod protocol;` declaration re-activates the 7 rustc errors that gate
// the merge:
//
//   * `range::UnknownPlan` → `range::RangeSpec` (no such thing named
//     `UnknownPlan` — the satisfiable/unsatisfiable/full union is
//     `RangeSpec::{Full, Satisfiable{start,end}, Unsatisfiable}` and
//     `content_range_unknown` simply does not exist)
//   * `MediaRequest` / `ProtocolError` — never declared in this file
//   * `m.read_range(item, start, len)` — `MediaManager` does not expose it;
//     the streaming plane is `load` (whole-item, bounded by
//     `MAX_LOAD_BYTES`) — Range support lives on the provider side per
//     `range.rs::plan_response`
//   * `Vec<MediaItem>` has no `.items` field — that's a `MediaListing` (see
//     `manager.rs::list`)
//
// The 1098 lines below are a *design* for REQ-A302, not a working module.
// Theuread will come back to it when the protocol team is ready to settle
// the streaming wire-format. Until then, the file stays in the tree as a
// TODO-shaped suggestion, not a compile-time participant.
//

//! **Why this exists.** The player used to read a whole item into memory and hand the
//! WebView a `blob:` URL, so anything above `MAX_PLAY_BYTES` had to be *honestly
//! refused* — a 900 MB movie would not play at all. A `<video>`/`<audio>` element can
//! instead **stream**: it asks for `Range: bytes=…` and the host answers `206` with a
//! bounded window, so memory stays bounded and seeking works. The RFC 7233 planning
//! already lives in [`crate::range`] (18 cases); this module is the *serving* half —
//! URI → authorized item → planned window → bytes + headers — and is deliberately
//! **transport-free**, so the whole surface (including its trust boundaries) is
//! testable without a WebView. The Tauri layer only turns a [`MediaReply`] into a
//! response (`amos-tauri/src/media.rs::protocol_response`), exactly like
//! `amos_appstore::host` does for bundles.
//!
//! **Trust boundary.** The URI names a *collection* and an item **id**, never a path:
//! the item is looked up in [`MediaManager::list`] — the same authorized listing the
//! screens use — so (a) a WebView cannot ask for an arbitrary file, and (b) a read
//! grant revoked in the UI revokes the URL in the same instant. An id that is not in
//! the listing is `404`, never a filesystem lookup. The id itself is an opaque key that
//! real backends spell as a content URI or an absolute path (see [`parse_uri`]); that is
//! harmless *because* it is only ever compared against the listing, never joined into a
//! path here.
//!
//! **Two URL shapes, one item (REQ-A303).** The URL the *page* writes and the URI this
//! module *receives* are not the same string, and they differ per platform:
//!
//! | platform | URL the page writes | URI the handler receives |
//! |---|---|---|
//! | macOS / iOS / Linux | `amos-media://movies/7` | `amos-media://movies/7` |
//! | Windows / Android | `http://amos-media.localhost/movies/7` | `amos-media://localhost/movies/7` |
//!
//! Windows and Android have no native custom-scheme support, so wry only intercepts
//! `http(s)://<scheme>.*` there and **reverts** the rewrite before calling the handler
//! (`wry/src/custom_protocol_workaround.rs`, used from `webview2/mod.rs` and
//! `android/mod.rs`) — the collection therefore arrives in the **path** on those
//! platforms and in the **netloc** on the others. [`parse_uri`] accepts both, so
//! nothing downstream has to know which engine it is running on, and [`base_url`]
//! answers the other half (which form the page must write) — the same split
//! `amos-appstore` uses for `amos-app://` (see `docs/pwa-index.md` §1).

use crate::error::{MediaError, Result as MediaResult};
use crate::manager::MediaManager;
use crate::provider::window;
use crate::range::{self, ResponsePlan};
use crate::spec::{MediaItem, StandardDir};

/// The URI scheme the host registers for media bytes.
pub const SCHEME: &str = "amos-media";

/// Most bytes one response carries; a player re-requests the remainder. This is the
/// streaming counterpart of the whole-item `load` bound, and it is what makes a
/// multi-gigabyte item servable at all.
pub const MAX_BODY_BYTES: u64 = range::MAX_RANGE_BYTES;

/// What a backend calls "I have no MIME for this".
const GENERIC_MIME: &str = "application/octet-stream";

/// The reply for one request: bytes with a status, or an honest refusal.
///
/// One struct rather than an enum because the only difference is "is there a body",
/// and `reason` says why there is none — a refusal must never be a silent empty `200`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaReply {
    /// `200` (full), `206` (partial), or a refusal (`400`/`403`/`404`/`413`/`416`/`5xx`).
    pub status: u16,
    /// `Content-Type` for a body (`""` when the reply carries none).
    pub content_type: String,
    /// `Content-Range`, set for `206` **and** `416` (where it is mandatory).
    pub content_range: Option<String>,
    /// Advertised on every reply: without it a player will not seek.
    pub accept_ranges: bool,
    pub bytes: Vec<u8>,
    /// Why this reply is a refusal (`""` for a served body). Carried for the host's
    /// debug header, and so tests can pin each refusal by name.
    pub reason: String,
}

impl MediaReply {
    fn served(
        status: u16,
        content_type: &str,
        content_range: Option<String>,
        bytes: Vec<u8>,
    ) -> Self {
        Self {
            status,
            content_type: content_type.to_string(),
            content_range,
            accept_ranges: true,
            bytes,
            reason: String::new(),
        }
    }

    fn refused(status: u16, content_range: Option<String>, reason: impl Into<String>) -> Self {
        Self {
            status,
            content_type: String::new(),
            content_range,
            accept_ranges: true,
            bytes: Vec::new(),
            reason: reason.into(),
        }
    }
}

/// The collection key of a [`StandardDir`] in a URI (`camera`, `download`, …).
///
/// Spelled the same as the enum's own `serde(rename_all = "snake_case")` on purpose:
/// the string a WebView puts in a URL is the one the bridge already accepts for
/// `media_list`, so there is one vocabulary, not two. The anti-drift test below walks
/// `StandardDir::all()`, so adding a collection without teaching this function fails.
pub fn dir_from_key(key: &str) -> Option<StandardDir> {
    Some(match key {
        "root" => StandardDir::Root,
        "camera" => StandardDir::Camera,
        "screenshots" => StandardDir::Screenshots,
        "pictures" => StandardDir::Pictures,
        "download" => StandardDir::Download,
        "recordings" => StandardDir::Recordings,
        "movies" => StandardDir::Movies,
        "music" => StandardDir::Music,
        _ => return None,
    })
}

/// Decode `%XX` escapes. An incomplete or non-hex escape is rejected: guessing here
/// would silently address a *different* item than the caller named.
fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            let hi = *bytes.get(i + 1)?;
            let lo = *bytes.get(i + 2)?;
            let hi = (hi as char).to_digit(16)?;
            let lo = (lo as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The netloc wry's Windows/Android workaround puts in front of the path (see the
/// module doc): it is *not* a collection, it is the host half of
/// `http://amos-media.localhost/…` — which the handler sees reverted to
/// `amos-media://localhost/…`.
const WORKAROUND_NETLOC: &str = "localhost";

/// Strip the scheme, leaving `<netloc>[/<path…>]` — every form a WebView can hand us.
///
/// Three spellings of one request are accepted, because the *engine* decides which one
/// arrives: `amos-media://…` (macOS/iOS/Linux, and the input `docs/media-player.md`
/// documents) and the `http(s)://amos-media.…` workaround form Windows/Android use
/// (both the raw page URL and wry's reverted `amos-media://localhost/…` land here as
/// `localhost/…`). Anything else — a foreign scheme, a foreign host — is not ours.
fn strip_scheme(uri: &str) -> Option<&str> {
    let native = format!("{SCHEME}://");
    if let Some(rest) = uri.strip_prefix(&native) {
        return Some(rest);
    }
    ["http", "https"]
        .iter()
        .find_map(|s| uri.strip_prefix(&format!("{s}://{SCHEME}.")))
}

/// Parse the request URI for one media item — in **either** platform shape.
///
/// Accepts `amos-media://<collection>/<id>` and
/// `amos-media://localhost/<collection>/<id>` / `http(s)://amos-media.localhost/<collection>/<id>`
/// (see the module doc for which engine sends which). Any query/fragment is ignored.
///
/// The id is an **opaque key, and it is allowed to look like a path**: the two real
/// backends hand out exactly that — `MediaStoreGlue` sets `id` to the row's content URI
/// (`content://media/external/video/media/1234`) and `HostFsProvider` sets it to the
/// absolute file path — so an id may contain `/` (and `\`, on a Windows host). Requiring
/// "one clean segment" here made **every** streaming request a `400` on a device and on a
/// hostfs root, while the tests stayed green because the mock's ids are `mock-7`
/// (REQ-A304). What keeps this safe is not the *shape* of the string: [`serve`] looks the
/// id up in the authorized listing and never builds a path from it, so a traversal-shaped
/// id (`..%2Fetc%2Fpasswd`) can only ever be a `404`. Control characters are still
/// refused: they mean the caller built a broken URL, and a silent miss is harder to
/// diagnose than a `400`.
pub fn parse_uri(uri: &str) -> Result<(StandardDir, String), String> {
    let rest = strip_scheme(uri).ok_or_else(|| format!("not an {SCHEME} URL: {uri}"))?;
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let (netloc, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };
    // The collection is the netloc natively, but the first path segment under the
    // workaround netloc — both name the same collection of the same item. Everything
    // *after* it is the id, separators included.
    let (collection_key, path) = if netloc == WORKAROUND_NETLOC {
        match path.find('/') {
            Some(i) => (&path[..i], &path[i + 1..]),
            None => (path, ""),
        }
    } else {
        (netloc, path)
    };
    let collection = dir_from_key(collection_key)
        .ok_or_else(|| format!("unknown media collection {collection_key:?} in {uri}"))?;
    let id = percent_decode(path).ok_or_else(|| format!("malformed escape in {path:?}"))?;
    if id.is_empty() {
        return Err(format!("{SCHEME} URL names no item: {uri}"));
    }
    if id.chars().any(char::is_control) {
        return Err(format!("item id {id:?} contains a control character"));
    }
    Ok((collection, id))
}

/// The base URL a WebView must write a media request under **on this platform**.
///
/// This is a fact about the *engine*, not about the UI, so it lives in Rust (mirroring
/// `amos_appstore::protocol_base_url`): Windows/Android rewrite custom schemes to
/// `http://{scheme}.{host}`, so a frontend that hard-coded `amos-media://` would be
/// **dead on Android** — the platform AmOS actually ships on — and the failure would
/// look like "this file will not play", not like a URL mistake. The caller appends
/// `<collection>/<id>`; the trailing `/` is part of the contract (both branches have
/// it) so a join is a plain concatenation on both platforms.
pub fn base_url() -> String {
    base_url_for(cfg!(any(windows, target_os = "android")))
}

/// Pure [`base_url`] — the workaround flag is a parameter so **both** forms are
/// testable from one machine (the same shape as `index_base_url_for`).
pub fn base_url_for(webview_workaround: bool) -> String {
    if webview_workaround {
        format!("http://{SCHEME}.{WORKAROUND_NETLOC}/")
    } else {
        format!("{SCHEME}://")
    }
}

/// The MIME to serve.
///
/// The stored MIME wins **unless it is the generic one**: several backends record
/// `application/octet-stream` for everything (the mock seeds do), and a player then
/// refuses to decode the `.mp4`. The item's full name is the fallback — the same
/// finding `docs/media-player.md` records for the blob path.
fn content_type_for(item: &MediaItem) -> String {
    if let Some(m) = item.mime.as_deref() {
        if !m.is_empty() && m != GENERIC_MIME {
            return m.to_string();
        }
    }
    crate::mapping::kind_and_mime_for_name(&item.name)
        .map(|(_, m)| m.to_string())
        .unwrap_or_else(|| GENERIC_MIME.to_string())
}

/// The HTTP status an error maps to (never a silent empty `200`).
fn status_for(e: &MediaError) -> u16 {
    match e {
        MediaError::Unauthorized { .. } => 403,
        MediaError::NotFound(_) => 404,
        MediaError::InvalidArguments(_) => 400,
        MediaError::TooLarge { .. } => 413,
        MediaError::Provider(_) => 500,
    }
}

/// Where the planned window is read from: the provider (streaming, seekable) or an
/// in-memory copy — the latter only where a length is required up front (a suffix range on
/// an item whose backend does not report one).
enum Source<'a> {
    Provider(&'a MediaItem),
    Bytes(Vec<u8>),
}

impl Source<'_> {
    fn read(&self, m: &MediaManager, offset: u64, len: u64) -> MediaResult<Vec<u8>> {
        match self {
            Self::Provider(item) => m.read_range(item, offset, len),
            Self::Bytes(all) => {
                let (start, end) = window(all.len() as u64, offset, len);
                Ok(all.get(start..end).map(<[u8]>::to_vec).unwrap_or_default())
            }
        }
    }
}

/// Serve one `amos-media://` request against the manager's authorized view.
///
/// `range_header` is the raw `Range` request header, if any.
///
/// Two paths, chosen by whether the backend reported a size:
/// * **measured** (the normal case) → [`range::plan_response`] decides status + window
///   before any IO, and only the planned window is read;
/// * **unmeasured** → the item is streamed anyway ([`serve_unmeasured`]): a backend that
///   cannot *measure* an item can usually still *read* it, and reading a whole item just
///   to learn its size costs one item of memory **per request** and turns a
///   `> MAX_LOAD_BYTES` item into a `413` for every request — the failure this protocol
///   exists to remove.
pub fn serve(m: &MediaManager, uri: &str, range_header: Option<&str>) -> MediaReply {
    let (collection, id) = match parse_uri(uri) {
        Ok(v) => v,
        Err(reason) => return MediaReply::refused(400, None, reason),
    };
    // The listing is the **authorization** check and the lookup at once.
    let items = match m.list(collection) {
        Ok(items) => items,
        Err(e) => return MediaReply::refused(status_for(&e), None, e.to_string()),
    };
    let Some(item) = items.items.into_iter().find(|i| i.id == id) else {
        return MediaReply::refused(404, None, format!("no item {id:?} in {collection:?}"));
    };
    let content_type = content_type_for(&item);
    match item.size_bytes {
        Some(total) => plan_and_read(
            m,
            &content_type,
            range_header,
            Source::Provider(&item),
            total,
        ),
        None => serve_unmeasured(m, &item, &content_type, range_header),
    }
}

/// Serve an item whose backend does **not** report a size.
///
/// The reply follows RFC 7233 §4.2, which allows `Content-Range: bytes a-b/*` exactly for
/// the unknown-length case — so the ordinary player request (`bytes=n-`, or a closed
/// window) is served by reading **only that window**. Two consequences worth stating:
///
/// * a **short read is EOF**, so the total becomes known *exactly* and is reported as such;
/// * a full window means "there may be more", reported as `bytes a-b/*` — never a number
///   this module does not have.
///
/// The one shape that still needs the length is `bytes=-N` (a suffix range, whose *offset*
/// is `total - N`): there the item is read once, bounded by `MAX_LOAD_BYTES`, as before. A
/// backend that hides the size of a `> MAX_LOAD_BYTES` item therefore still answers a
/// suffix request with an honest `413`.
fn serve_unmeasured(
    m: &MediaManager,
    item: &MediaItem,
    content_type: &str,
    range_header: Option<&str>,
) -> MediaReply {
    match range::plan_unknown(range_header, MAX_BODY_BYTES) {
        // No usable range: probe one bounded body (plus a byte) to find out whether the
        // item fits one response at all. A short probe *is* the whole item.
        range::UnknownPlan::WholeOrTooLarge { probe } => match m.read_range(item, 0, probe) {
            Ok(bytes) if (bytes.len() as u64) <= MAX_BODY_BYTES => {
                MediaReply::served(200, content_type, None, bytes)
            }
            Ok(bytes) => MediaReply::refused(
                413,
                None,
                format!(
                    "item length is unknown and at least {} bytes exceeds the {MAX_BODY_BYTES}-byte \
                     response bound; re-request with `Range`",
                    bytes.len()
                ),
            ),
            Err(e) => MediaReply::refused(status_for(&e), None, e.to_string()),
        },
        // The one shape whose offset needs the length: read the item once (bounded).
        range::UnknownPlan::NeedsLength => match m.load(item) {
            Ok(bytes) => {
                let total = bytes.len() as u64;
                plan_and_read(m, content_type, range_header, Source::Bytes(bytes), total)
            }
            Err(e) => MediaReply::refused(status_for(&e), None, e.to_string()),
        },
        range::UnknownPlan::Window { start, len } => match m.read_range(item, start, len) {
            // Nothing at the requested offset ⇒ it is at or past EOF. A `416` MUST carry
            // a complete-length in its `Content-Range` (RFC 7233 §4.4) and we do not have
            // one, so the header is omitted rather than invented; the reason says why.
            Ok(bytes) if bytes.is_empty() => MediaReply::refused(
                416,
                None,
                format!(
                    "{range_header:?} starts at or past the end of an item whose length the \
                     backend does not report (no `Content-Range` to offer)"
                ),
            ),
            Ok(bytes) => {
                let n = bytes.len() as u64;
                let end = start + n - 1;
                let content_range = if n < len {
                    // A short read *is* EOF: the total is now known exactly.
                    range::content_range(start, end, start + n)
                } else {
                    range::content_range_unknown(start, end)
                };
                MediaReply::served(206, content_type, Some(content_range), bytes)
            }
            Err(e) => MediaReply::refused(status_for(&e), None, e.to_string()),
        },
    }
}

/// Plan a reply for a resource of known `total` and read the planned window.
fn plan_and_read(
    m: &MediaManager,
    content_type: &str,
    range_header: Option<&str>,
    source: Source<'_>,
    total: u64,
) -> MediaReply {
    match range::plan_response(range_header, total, MAX_BODY_BYTES) {
        ResponsePlan::Full { len } => match source.read(m, 0, len) {
            // The same rule as the ranged branch below, for the same reason: a provider that
            // hands back fewer bytes than it declared has a **stale size**, and serving the
            // short body would give the client a truncated item with no hint that anything
            // went wrong — a truncated container surfaces as a codec error, not as the stale
            // row it really is. `AndroidMediaProvider`'s own docs say a declared size can be
            // "missing or wrong", and a `HostFs` stat can be stale too.
            Ok(bytes) if (bytes.len() as u64) < len => MediaReply::refused(
                500,
                None,
                format!(
                    "short read: got {} of {len} bytes for the whole item",
                    bytes.len()
                ),
            ),
            Ok(bytes) => MediaReply::served(200, content_type, None, bytes),
            Err(e) => MediaReply::refused(status_for(&e), None, e.to_string()),
        },
        ResponsePlan::Partial { start, end, total } => {
            let want = range::window_len(start, end);
            match source.read(m, start, want) {
                // A provider may legally return *fewer* bytes than asked. Advertising
                // the window anyway would turn `Content-Range` into a false statement
                // about bytes that were never sent, so a short read is a refusal that
                // names the numbers (usually: the declared size is stale).
                Ok(bytes) if (bytes.len() as u64) < want => MediaReply::refused(
                    500,
                    None,
                    format!(
                        "short read: got {} of {want} bytes at offset {start}",
                        bytes.len()
                    ),
                ),
                Ok(bytes) => MediaReply::served(
                    206,
                    content_type,
                    Some(range::content_range(start, end, total)),
                    bytes,
                ),
                Err(e) => MediaReply::refused(status_for(&e), None, e.to_string()),
            }
        }
        ResponsePlan::Unsatisfiable { total } => MediaReply::refused(
            416,
            Some(range::content_range_unsatisfied(total)),
            format!("{range_header:?} is not satisfiable for a {total}-byte item"),
        ),
        ResponsePlan::TooLarge { total, max } => MediaReply::refused(
            413,
            None,
            format!("{total} bytes exceeds the {max}-byte response bound; re-request with `Range`"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::MediaProvider;
    use crate::spec::{AccessKind, MediaKind};
    use std::sync::Arc;

    const URL: &str = "amos-media://";

    /// A manager over the deterministic mock, with read+write granted on `Download`.
    fn manager() -> MediaManager {
        let m = MediaManager::new(Arc::new(crate::provider::MockMediaProvider::empty()));
        m.grant_read(StandardDir::Download);
        m.grant_write(StandardDir::Download);
        m
    }

    fn save(m: &MediaManager, name: &str, data: &[u8]) -> MediaItem {
        m.save(StandardDir::Download, MediaKind::File, name, data)
            .expect("save")
    }

    /// The scheme's collection keys must cover **every** `StandardDir`, or a URL a
    /// screen can build for that collection would be a permanent 400.
    #[test]
    fn dir_from_key_covers_every_collection() {
        for dir in StandardDir::all() {
            let key = serde_json::to_value(dir)
                .expect("serialisable")
                .as_str()
                .expect("string")
                .to_string();
            assert_eq!(dir_from_key(&key), Some(*dir), "key {key:?} is not served");
        }
        assert_eq!(dir_from_key("nope"), None);
        assert_eq!(dir_from_key(""), None);
    }

    #[test]
    fn parse_uri_reads_collection_and_id_ignoring_query_and_fragment() {
        assert_eq!(
            parse_uri(&format!("{URL}camera/IMG_0001.jpg")),
            Ok((StandardDir::Camera, "IMG_0001.jpg".to_string()))
        );
        assert_eq!(
            parse_uri(&format!("{URL}download/report.pdf?v=2#page=1")),
            Ok((StandardDir::Download, "report.pdf".to_string()))
        );
        // An id may need escaping: ids are opaque keys, not paths.
        assert_eq!(
            parse_uri(&format!("{URL}download/a%20b%2Bc.mp4")),
            Ok((StandardDir::Download, "a b+c.mp4".to_string()))
        );
    }

    #[test]
    fn parse_uri_refuses_what_it_cannot_honour() {
        for bad in [
            "https://example.com/x",     // wrong scheme
            "amos-media:/camera/x",      // not authority-rooted
            "amos-media://camera",       // no id
            "amos-media://camera/",      // empty id
            "amos-media://camera/a%00b", // control character
            "amos-media://camera/a%2",   // truncated escape
            "amos-media://camera/a%zzb", // non-hex escape
            "amos-media://camera/a%0Ab", // embedded newline
            "amos-media://nope/x",       // unknown collection
            "amos-media://localhost",        // workaround netloc, no collection
            "amos-media://localhost/nope/x", // workaround netloc + unknown collection
            "http://amos-media.other/x",     // workaround host of *another* netloc
        ] {
            assert!(parse_uri(bad).is_err(), "{bad} should not parse");
        }
    }

    /// A separator inside the id is **not** an error: real backends hand out ids that are
    /// content URIs / absolute paths (REQ-A304), so the id is the whole remainder of the
    /// path. Pinned with the literal both sides agree on (see `media.test.ts`).
    #[test]
    fn a_path_shaped_id_is_a_legal_opaque_key() {
        assert_eq!(
            parse_uri("amos-media://music/song%20one.mp3"),
            Ok((StandardDir::Music, "song one.mp3".to_string()))
        );
        assert_eq!(
            parse_uri("amos-media://download/DCIM%2FCamera%2FIMG_0001.jpg"),
            Ok((StandardDir::Download, "DCIM/Camera/IMG_0001.jpg".to_string()))
        );
        // The exact frontend literal (`encodeURIComponent` of a MediaStore content URI).
        assert_eq!(
            parse_uri("amos-media://movies/content%3A%2F%2Fmedia%2Fexternal%2Fvideo%2Fmedia%2F1234"),
            Ok((
                StandardDir::Movies,
                "content://media/external/video/media/1234".to_string()
            ))
        );
        // …including under the workaround netloc, where the collection is segment #1.
        assert_eq!(
            parse_uri("amos-media://localhost/movies/content%3A%2F%2Fmedia%2Fvideo%2F1234"),
            Ok((
                StandardDir::Movies,
                "content://media/video/1234".to_string()
            ))
        );
    }

    /// One request, three spellings (REQ-A303): the native form, the raw page URL
    /// Windows/Android write, and the reversed form wry actually hands the handler.
    /// All three must name the same collection and the same id — the item lookup
    /// downstream must never need to know which engine is calling.
    #[test]
    fn every_platform_spelling_names_the_same_item() {
        let expected = Ok((StandardDir::Movies, "clip.mp4".to_string()));
        for uri in [
            "amos-media://movies/clip.mp4",
            "amos-media://localhost/movies/clip.mp4",
            "http://amos-media.localhost/movies/clip.mp4",
            "https://amos-media.localhost/movies/clip.mp4?v=2#t=1",
        ] {
            assert_eq!(parse_uri(uri), expected, "{uri}");
        }
    }

    /// The emitter half and the parser half must agree on **both** platforms: build the
    /// URL a page writes ([`base_url_for`]), model what wry hands the handler
    /// (Windows/Android rewrite `http://amos-media.localhost/…` back to
    /// `amos-media://localhost/…`), then parse it. A drift between the two sides — the
    /// shape this test was added for — is a hard `400` on Android, i.e. "this movie will
    /// not play" with no other symptom.
    #[test]
    fn the_base_url_round_trips_through_both_platform_shapes() {
        for workaround in [false, true] {
            let base = base_url_for(workaround);
            assert!(base.ends_with('/'), "{base} must be joinable");
            for dir in StandardDir::all() {
                let key = serde_json::to_value(dir)
                    .expect("serialisable")
                    .as_str()
                    .expect("string")
                    .to_string();
                let page_url = format!("{base}{key}/item-7");
                let handler_uri = if workaround {
                    page_url.replacen(&format!("http://{SCHEME}."), &format!("{SCHEME}://"), 1)
                } else {
                    page_url.clone()
                };
                assert_eq!(
                    parse_uri(&handler_uri),
                    Ok((*dir, "item-7".to_string())),
                    "handler form {handler_uri} (page wrote {page_url})"
                );
            }
        }
    }

    /// The platform-specific base is a *fact about the engine*, so pin both branches:
    /// a caller that guessed `amos-media://` would be dead on Android/Windows, and a
    /// caller that guessed the `http://` form would be wrong on macOS/iOS/Linux.
    #[test]
    fn the_base_url_matches_the_documented_engine_workaround() {
        assert_eq!(base_url_for(false), "amos-media://");
        assert_eq!(base_url_for(true), "http://amos-media.localhost/");
        let expected = if cfg!(any(windows, target_os = "android")) {
            base_url_for(true)
        } else {
            base_url_for(false)
        };
        assert_eq!(base_url(), expected, "base_url must follow the target platform");
    }

    /// A traversal-shaped id is not "refused before it can name anything" by *shape* — it
    /// is a **miss**: the id is looked up in the authorized listing and never joined into a
    /// path, so `..%2Fetc%2Fpasswd` can only ever be a `404`. This test pins both halves so
    /// nobody later "hardens" it back into a path join (which is the only way this could
    /// become unsafe) — and so nobody re-breaks real ids by re-adding a shape rule either.
    #[test]
    fn a_traversal_shaped_id_can_only_be_a_miss() {
        let m = manager();
        let reply = serve(&m, &format!("{URL}download/..%2Fetc%2Fpasswd"), None);
        assert_eq!(reply.status, 404, "{}", reply.reason);
        assert!(reply.bytes.is_empty());
        assert!(reply.reason.contains("no item"), "{}", reply.reason);

        // The same string when *listed* is an ordinary item: a backend that offers it is
        // the only thing that could serve it, which is exactly the trust boundary.
        let looks_like_traversal = save(&m, "odd.mp4", b"payload");
        let reply = serve(&m, &format!("{URL}download/{}", looks_like_traversal.id), None);
        assert_eq!(reply.status, 200);

        // An id that parses but matches nothing is a 404 — a miss, not a lookup path.
        let miss = serve(&m, &format!("{URL}download/..etc-passwd"), None);
        assert_eq!(miss.status, 404);
    }

    /// The mime the player needs comes from the **name** when the backend stores the
    /// generic one, and `Accept-Ranges` is advertised so it will seek at all.
    #[test]
    fn a_small_item_is_served_whole_with_a_usable_mime() {
        let m = manager();
        let item = save(&m, "song.mp3", b"ID3fake-audio-bytes");
        let reply = serve(&m, &format!("{URL}download/{}", item.id), None);
        assert_eq!(reply.status, 200);
        assert_eq!(reply.bytes, b"ID3fake-audio-bytes");
        assert_eq!(reply.content_type, "audio/mpeg");
        assert!(reply.accept_ranges, "a player only seeks when told it may");
        assert!(reply.content_range.is_none());
        assert!(reply.reason.is_empty());
    }

    #[test]
    fn a_ranged_request_gets_exactly_the_window_it_asked_for() {
        let m = manager();
        let data: Vec<u8> = (0..=255u8).cycle().take(1024).collect();
        let item = save(&m, "clip.mp4", &data);
        let url = format!("{URL}download/{}", item.id);

        let reply = serve(&m, &url, Some("bytes=100-199"));
        assert_eq!(reply.status, 206);
        assert_eq!(reply.content_range.as_deref(), Some("bytes 100-199/1024"));
        assert_eq!(reply.bytes, &data[100..=199]);
        assert_eq!(reply.content_type, "video/mp4");

        // A suffix range means "the last N bytes".
        let tail = serve(&m, &url, Some("bytes=-10"));
        assert_eq!(tail.status, 206);
        assert_eq!(tail.bytes, &data[1014..]);
        assert_eq!(tail.content_range.as_deref(), Some("bytes 1014-1023/1024"));

        // An end past EOF is clamped, not an error (RFC 7233).
        let clamped = serve(&m, &url, Some("bytes=1000-99999"));
        assert_eq!(clamped.status, 206);
        assert_eq!(
            clamped.content_range.as_deref(),
            Some("bytes 1000-1023/1024")
        );
        assert_eq!(clamped.bytes.len(), 24);
    }

    /// The whole pipeline (authorized lookup → plan → bytes), driven by the URI form a
    /// Windows/Android WebView actually produces. Before REQ-A303 this was a `400` for
    /// *every* request there — the collection was read as the netloc.
    #[test]
    fn the_workaround_uri_form_serves_the_same_bytes() {
        let m = manager();
        let data: Vec<u8> = (0..=255u8).cycle().take(512).collect();
        let item = save(&m, "clip.mp4", &data);
        let url = format!("{URL}localhost/download/{}", item.id);

        let reply = serve(&m, &url, Some("bytes=10-19"));
        assert_eq!(reply.status, 206);
        assert_eq!(reply.content_range.as_deref(), Some("bytes 10-19/512"));
        assert_eq!(reply.bytes, &data[10..=19]);

        // The raw page URL (Windows/Android, before wry reverts it) works too.
        let raw = format!("http://amos-media.localhost/download/{}", item.id);
        assert_eq!(serve(&m, &raw, None).bytes, data);

        // …and the trust boundary is unchanged: an id that is not in the authorized
        // listing is still a miss, whichever shape named it.
        assert_eq!(
            serve(&m, &format!("{URL}localhost/download/nope"), None).status,
            404
        );
        m.revoke(AccessKind::Read, StandardDir::Download);
        assert_eq!(serve(&m, &url, None).status, 403);
    }

    #[test]
    fn an_impossible_range_is_416_with_the_mandatory_content_range() {
        let m = manager();
        let item = save(&m, "clip.mp4", &[7u8; 64]);
        let reply = serve(
            &m,
            &format!("{URL}download/{}", item.id),
            Some("bytes=4096-"),
        );
        assert_eq!(reply.status, 416);
        assert_eq!(reply.content_range.as_deref(), Some("bytes */64"));
        assert!(reply.bytes.is_empty());
        assert!(reply.reason.contains("not satisfiable"), "{}", reply.reason);
    }

    #[test]
    fn an_unknown_item_is_404_and_an_ungranted_collection_is_403() {
        let m = manager();
        let item = save(&m, "song.mp3", b"abc");
        let missing = serve(&m, &format!("{URL}download/no-such-id"), None);
        assert_eq!(missing.status, 404);
        assert!(missing.reason.contains("no item"), "{}", missing.reason);

        // A grant revoked in the UI revokes the URL: one listing backs both.
        m.revoke(AccessKind::Read, StandardDir::Download);
        let denied = serve(&m, &format!("{URL}download/{}", item.id), None);
        assert_eq!(denied.status, 403);
        assert!(denied.bytes.is_empty());
        assert!(!denied.reason.is_empty());
    }

    /// The whole point of the feature: an item too big to hand over in one piece is
    /// refused **with a way forward** — a plain GET says 413 and advertises ranges, and
    /// a ranged GET then serves bounded windows.
    #[test]
    fn an_oversized_item_is_refused_whole_but_served_in_windows() {
        let m = manager();
        let big = vec![9u8; (MAX_BODY_BYTES + 1) as usize];
        let item = save(&m, "movie.mp4", &big);
        let url = format!("{URL}download/{}", item.id);

        let whole = serve(&m, &url, None);
        assert_eq!(whole.status, 413);
        assert!(whole.accept_ranges);
        assert!(whole.bytes.is_empty());
        assert!(whole.reason.contains("Range"), "{}", whole.reason);

        let window = serve(&m, &url, Some("bytes=0-15"));
        assert_eq!(window.status, 206);
        assert_eq!(window.bytes, vec![9u8; 16]);
        assert_eq!(
            window.content_range.as_deref(),
            Some(format!("bytes 0-15/{}", big.len()).as_str())
        );

        // An open range is clamped to the response bound, never to the whole item.
        let open = serve(&m, &url, Some("bytes=0-"));
        assert_eq!(open.status, 206);
        assert_eq!(open.bytes.len() as u64, MAX_BODY_BYTES);
    }

    /// A provider that lies about a size, and one that does not know it at all.
    struct OddProvider {
        item: MediaItem,
        data: Vec<u8>,
    }

    impl MediaProvider for OddProvider {
        fn name(&self) -> &'static str {
            "odd"
        }
        fn available_collections(&self) -> Vec<StandardDir> {
            vec![StandardDir::Download]
        }
        fn list(&self, _dir: StandardDir) -> MediaResult<Vec<MediaItem>> {
            Ok(vec![self.item.clone()])
        }
        fn save(
            &self,
            _d: StandardDir,
            _k: MediaKind,
            _n: &str,
            _data: &[u8],
        ) -> MediaResult<MediaItem> {
            Err(MediaError::Provider("read-only fixture".to_string()))
        }
        fn load(&self, _item: &MediaItem) -> MediaResult<Vec<u8>> {
            Ok(self.data.clone())
        }
    }

    fn odd_manager(size_bytes: Option<u64>, data: Vec<u8>) -> MediaManager {
        // Built directly (not `MediaItem::new`): this fixture needs a **declared size**
        // that the bytes do not honour, which the validating constructor does not take.
        let item = MediaItem {
            id: "odd-1".to_string(),
            kind: MediaKind::Video,
            collection: StandardDir::Download,
            name: "clip.mp4".to_string(),
            uri: "odd://download/clip.mp4".to_string(),
            mime: Some("video/mp4".to_string()),
            size_bytes,
            ts: 0,
        };
        let m = MediaManager::new(Arc::new(OddProvider { item, data }));
        m.grant_read(StandardDir::Download);
        m
    }

    /// A declared size larger than the bytes the provider really has must not become a
    /// `Content-Range` claim about bytes that were never sent — **and not a silently
    /// truncated `200` either** (REQ-A307). Both shapes refuse with the numbers, because a
    /// stale size is a known case: `AndroidMediaProvider`'s own docs say it can be "missing or
    /// wrong", and a `HostFs` stat goes stale when the file changes underneath it. A
    /// truncated body, by contrast, surfaces to the user as a codec error.
    #[test]
    fn a_short_read_is_refused_instead_of_advertised() {
        let m = odd_manager(Some(4096), vec![1u8; 16]);
        let url = format!("{URL}download/odd-1");

        let ranged = serve(&m, &url, Some("bytes=0-1023"));
        assert_eq!(ranged.status, 500);
        assert!(ranged.reason.contains("short read"), "{}", ranged.reason);
        assert!(ranged.content_range.is_none(), "no window may be claimed");
        assert!(ranged.bytes.is_empty());

        // The whole-item shape: same refusal, so the client never gets a body that is not the
        // item it asked for.
        let whole = serve(&m, &url, None);
        assert_eq!(whole.status, 500, "{}", whole.reason);
        assert!(whole.reason.contains("short read"), "{}", whole.reason);
        assert!(
            whole.reason.contains("16 of 4096"),
            "the refusal must name the numbers: {}",
            whole.reason
        );
        assert!(whole.bytes.is_empty(), "a truncated body must not be served");
    }

    /// No declared size ⇒ the item is **streamed**, never loaded just to be measured
    /// (REQ-A304). A window that does not reach EOF is reported with an unknown
    /// complete-length (`bytes a-b/*`, RFC 7233 §4.2); a window that *does* reach EOF turns
    /// the total into a fact; and a request past EOF is a `416` that cannot offer a
    /// `Content-Range` at all (the unsatisfied form of that field *requires* a length,
    /// §4.4 — so the header is omitted rather than invented).
    #[test]
    fn an_unmeasured_item_is_streamed_without_being_measured() {
        let m = odd_manager(None, vec![3u8; 64]);
        let url = format!("{URL}download/odd-1");

        let whole = serve(&m, &url, None);
        assert_eq!(whole.status, 200, "{}", whole.reason);
        assert_eq!(whole.bytes.len(), 64);

        let part = serve(&m, &url, Some("bytes=8-15"));
        assert_eq!(part.status, 206);
        assert_eq!(part.content_range.as_deref(), Some("bytes 8-15/*"));
        assert_eq!(part.bytes, vec![3u8; 8]);

        // A window that reaches the end reports the total exactly — the short read *is* EOF.
        let tail = serve(&m, &url, Some("bytes=56-"));
        assert_eq!(tail.status, 206);
        assert_eq!(tail.content_range.as_deref(), Some("bytes 56-63/64"));

        let far = serve(&m, &url, Some("bytes=999-"));
        assert_eq!(far.status, 416);
        assert!(far.content_range.is_none(), "no length to offer");
        assert!(far.reason.contains("does not report"), "{}", far.reason);
    }

    // ---- real-backend fixtures (REQ-A304) -------------------------------------
    //
    // Every test above runs on `MockMediaProvider`, whose ids are `mock-7` and which always
    // reports a size. The two real backends do neither: their ids are content URIs /
    // absolute paths, and one of them can serve an item it cannot measure. Neither fact was
    // represented here — which is exactly why both REQ-A304 defects shipped — so these
    // fixtures drive the *real* `HostFsProvider` over a real (sparse) file.

    /// A provider that cannot **measure** what it serves: `list` hides the size, `load`
    /// keeps the real ceiling, `read_range` is the real seeking read. That is what a
    /// MediaStore row with a null `SIZE` looks like from here — `MediaStoreGlue` only sends
    /// `size_bytes` when the column exists and is non-null, while reads go through an fd
    /// that can still seek.
    struct SizelessProvider(crate::HostFsProvider);

    impl MediaProvider for SizelessProvider {
        fn name(&self) -> &'static str {
            "sizeless"
        }
        fn available_collections(&self) -> Vec<StandardDir> {
            self.0.available_collections()
        }
        fn list(&self, dir: StandardDir) -> MediaResult<Vec<MediaItem>> {
            let mut items = self.0.list(dir)?;
            for it in &mut items {
                it.size_bytes = None;
            }
            Ok(items)
        }
        fn save(
            &self,
            dir: StandardDir,
            kind: MediaKind,
            name: &str,
            data: &[u8],
        ) -> MediaResult<MediaItem> {
            self.0.save(dir, kind, name, data)
        }
        fn load(&self, item: &MediaItem) -> MediaResult<Vec<u8>> {
            self.0.load(item)
        }
        fn read_range(&self, item: &MediaItem, offset: u64, len: u64) -> MediaResult<Vec<u8>> {
            self.0.read_range(item, offset, len)
        }
    }

    /// A backend over a fresh temp dir (so ids are absolute paths). `sizeless` wraps the
    /// real host in [`SizelessProvider`].
    fn real_manager(tag: &str, sizeless: bool) -> (MediaManager, std::path::PathBuf) {
        let base =
            std::env::temp_dir().join(format!("amos-media-proto-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("Download")).expect("temp dir");
        let host = crate::HostFsProvider::new(base.clone());
        let provider: Arc<dyn MediaProvider> = if sizeless {
            Arc::new(SizelessProvider(host))
        } else {
            Arc::new(host)
        };
        let m = MediaManager::new(provider);
        m.grant_read(StandardDir::Download);
        (m, base)
    }

    /// The ids the **real** backends hand out are not single segments (`HostFsProvider`: the
    /// absolute path; `MediaStoreGlue`: the content URI). A URL that percent-encodes such an
    /// id resolves to it — before REQ-A304 *every* request was a `400`, on a device and on a
    /// hostfs root alike, while the mock-based tests stayed green.
    #[test]
    fn a_path_shaped_id_from_a_real_backend_is_served() {
        let (m, base) = real_manager("pathid", false);
        std::fs::write(base.join("Download/song.mp3"), b"ID3-real-bytes").expect("write");
        let item = m
            .list(StandardDir::Download)
            .expect("list")
            .items
            .into_iter()
            .find(|i| i.name == "song.mp3")
            .expect("the fixture must be listed");
        assert!(
            item.id.contains('/'),
            "the fixture must exercise a path-shaped id: {}",
            item.id
        );
        // The frontend escapes the id (`encodeURIComponent`); escaping at least the
        // separators is what makes it one URL segment again.
        let escaped = item.id.replace('/', "%2F");
        for url in [
            format!("{URL}download/{escaped}"),
            format!("{URL}localhost/download/{escaped}"),
        ] {
            let reply = serve(&m, &url, None);
            assert_eq!(reply.status, 200, "{url} → {}", reply.reason);
            assert_eq!(reply.bytes, b"ID3-real-bytes");
            assert_eq!(reply.content_type, "audio/mpeg");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// An item whose backend hides its size and which is **larger than the load ceiling**
    /// must still stream. Before REQ-A304 the protocol read the item to learn its length:
    /// for a `> MAX_LOAD_BYTES` item that made *every* request a `413` — the failure the
    /// protocol exists to remove — and for any other item it cost a full in-memory read
    /// *per request*.
    #[test]
    fn an_unmeasured_item_above_the_load_ceiling_is_streamed_in_windows() {
        let big: u64 = 300 * 1024 * 1024;
        assert!(
            big > crate::MAX_LOAD_BYTES,
            "the fixture must exceed the whole-item ceiling"
        );
        let (m, base) = real_manager("sizeless-big", true);
        let path = base.join("Download/movie.mp4");
        std::fs::File::create(&path)
            .expect("create")
            .set_len(big)
            .expect("sparse length"); // sparse: costs no disk blocks
        {
            use std::io::Write;
            std::fs::File::options()
                .write(true)
                .open(&path)
                .expect("reopen")
                .write_all(b"0123456789abcdef")
                .expect("head bytes");
        }
        let item = m
            .list(StandardDir::Download)
            .expect("list")
            .items
            .into_iter()
            .find(|i| i.name == "movie.mp4")
            .expect("listed");
        assert!(item.size_bytes.is_none(), "the fixture must hide the size");
        let url = format!("{URL}download/{escaped}", escaped = item.id.replace('/', "%2F"));

        // An open-ended range: exactly one bounded window, honest about the length.
        let open = serve(&m, &url, Some("bytes=0-"));
        assert_eq!(open.status, 206, "{}", open.reason);
        assert_eq!(open.bytes.len() as u64, MAX_BODY_BYTES);
        let expected = format!("bytes 0-{}/*", MAX_BODY_BYTES - 1);
        assert_eq!(open.content_range.as_deref(), Some(expected.as_str()));

        // A window that reaches EOF reports the exact total.
        let tail = serve(&m, &url, Some(&format!("bytes={}-", big - 8)));
        assert_eq!(tail.status, 206, "{}", tail.reason);
        assert_eq!(tail.bytes.len(), 8);
        let expected = format!("bytes {}-{}/{}", big - 8, big - 1, big);
        assert_eq!(tail.content_range.as_deref(), Some(expected.as_str()));

        // No range at all: it does not fit one bounded body → `413`, with a way forward.
        let whole = serve(&m, &url, None);
        assert_eq!(whole.status, 413);
        assert!(whole.accept_ranges);

        // The one shape that still needs the length: a suffix range. The item cannot be
        // read whole (that is the ceiling), so the refusal is honest — and documented.
        let suffix = serve(&m, &url, Some("bytes=-8"));
        assert_eq!(suffix.status, 413, "{}", suffix.reason);
        assert!(suffix.reason.contains("exceeds"), "{}", suffix.reason);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A small unmeasured item: served whole when nothing is asked, then ranged — the two
    /// replies a real player makes, and the second one carries the exact total once the
    /// window reaches the end.
    #[test]
    fn an_unmeasured_item_that_fits_is_served_whole_then_in_windows() {
        let (m, base) = real_manager("sizeless-small", true);
        std::fs::write(base.join("Download/memo.mp3"), b"0123456789abcdefghij").expect("write");
        let item = m
            .list(StandardDir::Download)
            .expect("list")
            .items
            .into_iter()
            .find(|i| i.name == "memo.mp3")
            .expect("listed");
        let url = format!("{URL}download/{escaped}", escaped = item.id.replace('/', "%2F"));

        let whole = serve(&m, &url, None);
        assert_eq!(whole.status, 200, "{}", whole.reason);
        assert_eq!(whole.bytes, b"0123456789abcdefghij");

        let head = serve(&m, &url, Some("bytes=0-3"));
        assert_eq!(head.status, 206);
        assert_eq!(head.bytes, b"0123");
        assert_eq!(head.content_range.as_deref(), Some("bytes 0-3/*"));

        let tail = serve(&m, &url, Some("bytes=8-"));
        assert_eq!(tail.status, 206);
        assert_eq!(tail.bytes, b"89abcdefghij");
        assert_eq!(tail.content_range.as_deref(), Some("bytes 8-19/20"));
        let _ = std::fs::remove_dir_all(&base);
    }
}

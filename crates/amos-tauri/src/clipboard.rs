//! Global system clipboard service (multi-window / cross-container).
//!
//! A *real* OS-style clipboard in the AmOS Rust core: any window can copy
//! multi-format content into one shared buffer and any **foreground** window can
//! paste it back out, so a Webview app and a legacy Android container app share
//! the same clipboard.
//!
//! * **Multi-format** — one copy may carry plain text, HTML, an image and/or a
//!   URI list; the pasting app picks the flavour it understands
//!   ([`ClipboardPayload`]). Image bytes travel base64 over JSON IPC.
//! * **History** — a bounded, most-recent-first stack; a redundant consecutive
//!   duplicate is coalesced instead of piling up.
//! * **Foreground-read permission** — reading/pasting/clearing is only granted to
//!   the focused window ([`require_foreground`]); a background app can *write*
//!   but never steal another window's copy.
//! * **Native/container seam** — writes mirror to a pluggable [`ClipboardNative`]
//!   transport (e.g. the Android container's `ClipboardManager`), and an ingest
//!   path lets the container feed native copies back in (`clipboard_glue`,
//!   feature `android`).
//!
//! Commands: `clipboard_write`, `clipboard_read`, `clipboard_history`,
//! `clipboard_clear`.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::wm::WmState;

/// Maximum number of clipboard-history entries retained.
pub const HISTORY_LIMIT: usize = 32;
/// Upper bound on a single copied text/plain payload (1 MiB).
const MAX_TEXT_LEN: usize = 1 << 20;
/// Upper bound on a single copied HTML payload (2 MiB).
const MAX_HTML_LEN: usize = 2 << 20;
/// Upper bound on an image payload's base64 size.
const MAX_IMAGE_B64_LEN: usize = 24 << 20;
/// Upper bound on the number of URIs in a single copy.
const MAX_URIS: usize = 64;

/// One copy operation's payload. The OS clipboard is multi-format: one copy can
/// carry several representations, and the pasting app picks the richest one it
/// understands. Serialized to the WebView / from the container over JSON.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClipboardPayload {
    /// Plain text — the universal fallback every app can paste.
    Text { text: String },
    /// Rich text: HTML plus its plain-text fallback.
    Html { html: String, plain: String },
    /// Raster image (`data_b64` = base64 bytes, `mime` e.g. `image/png`).
    Image { mime: String, data_b64: String },
    /// A list of file/content URIs (e.g. copied attachments) + display text.
    Uris { uris: Vec<String>, text: String },
}

impl ClipboardPayload {
    /// The `Content-Type` for this representation, when it has one.
    pub fn mime(&self) -> Option<&str> {
        match self {
            ClipboardPayload::Text { .. } => Some("text/plain"),
            ClipboardPayload::Html { .. } => Some("text/html"),
            ClipboardPayload::Image { mime, .. } => Some(mime.as_str()),
            ClipboardPayload::Uris { .. } => Some("text/uri-list"),
        }
    }

    /// A plain-text rendering of this payload, if it is text-bearing. Returns
    /// `None` for binary-only content (images) so nothing text-like is faked.
    pub fn plain_text(&self) -> Option<String> {
        match self {
            ClipboardPayload::Text { text } => Some(text.clone()),
            ClipboardPayload::Html { plain, .. } => Some(plain.clone()),
            ClipboardPayload::Uris { text, uris } => {
                if !text.trim().is_empty() {
                    Some(text.clone())
                } else {
                    Some(uris.join("\n"))
                }
            }
            ClipboardPayload::Image { .. } => None,
        }
    }

    /// Decode an image payload's base64 into raw bytes (lazy, one-shot).
    pub fn image_bytes(&self) -> Result<Vec<u8>, String> {
        match self {
            ClipboardPayload::Image { data_b64, .. } => base64::engine::general_purpose::STANDARD
                .decode(data_b64)
                .map_err(|e| format!("clipboard image base64 decode failed: {e}")),
            other => Err(format!("not an image payload: {other:?}")),
        }
    }

    /// Sanity-check a payload before it enters the shared buffer (bounds + shape)
    /// so one app can't flood or corrupt the buffer another app will paste.
    fn validate(&self) -> Result<(), String> {
        match self {
            ClipboardPayload::Text { text } => {
                if text.len() > MAX_TEXT_LEN {
                    return Err(format!("clipboard text exceeds {MAX_TEXT_LEN} bytes"));
                }
                if text.trim().is_empty() {
                    return Err("clipboard text must not be empty".to_string());
                }
                Ok(())
            }
            ClipboardPayload::Html { html, plain } => {
                if html.len() > MAX_HTML_LEN {
                    return Err(format!("clipboard html exceeds {MAX_HTML_LEN} bytes"));
                }
                if html.trim().is_empty() {
                    return Err("clipboard html must not be empty".to_string());
                }
                let _ = plain; // fallback text is allowed to be empty
                Ok(())
            }
            ClipboardPayload::Image { mime, data_b64 } => {
                if mime.trim().is_empty() {
                    return Err("clipboard image requires a mime type".to_string());
                }
                if data_b64.len() > MAX_IMAGE_B64_LEN {
                    return Err("clipboard image payload too large".to_string());
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data_b64)
                    .map_err(|e| format!("clipboard image base64 invalid: {e}"))?;
                if bytes.is_empty() {
                    return Err("clipboard image payload is empty".to_string());
                }
                Ok(())
            }
            ClipboardPayload::Uris { uris, text } => {
                if uris.is_empty() || uris.len() > MAX_URIS {
                    return Err(format!("clipboard needs 1..={MAX_URIS} uris"));
                }
                if uris.iter().any(|u| u.trim().is_empty()) {
                    return Err("clipboard uris must not be empty".to_string());
                }
                if text.len() > MAX_TEXT_LEN {
                    return Err(format!("clipboard uri text exceeds {MAX_TEXT_LEN} bytes"));
                }
                Ok(())
            }
        }
    }
}

/// A single immutable snapshot of one copy operation in the shared buffer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClipboardEntry {
    /// Monotonic sequence number (1-based, newest is highest).
    pub seq: u64,
    /// Label of the window / surface that produced this copy.
    pub source: String,
    /// Label of the window that wrote it (empty for system/container copies).
    pub owner: String,
    pub timestamp_ms: u64,
    pub payload: ClipboardPayload,
}

impl ClipboardEntry {
    pub fn plain_text(&self) -> Option<String> {
        self.payload.plain_text()
    }

    /// Decode an image payload into raw bytes (see [`ClipboardPayload::image_bytes`]).
    pub fn image_bytes(&self) -> Result<Vec<u8>, String> {
        self.payload.image_bytes()
    }
}

/// Lightweight, **non-sensitive** event payload broadcast on every clipboard write.
///
/// The full content is deliberately *not* included here: broadcasting it would let
/// any background window learn clipboard contents by merely subscribing, which
/// would bypass the foreground-read permission. Interested windows instead receive
/// this notice and call [`GlobalClipboard::by_seq`] (via `clipboard_read`, which is
/// foreground-gated) to fetch the actual payload when they really paste.
#[derive(Clone, Debug, Serialize)]
pub struct ClipboardNotice {
    pub seq: u64,
    pub timestamp_ms: u64,
    /// Label of the window/surface that produced the copy (not sensitive).
    pub source: String,
}

impl From<&ClipboardEntry> for ClipboardNotice {
    fn from(e: &ClipboardEntry) -> Self {
        Self {
            seq: e.seq,
            timestamp_ms: e.timestamp_ms,
            source: e.source.clone(),
        }
    }
}

/// In-memory, most-recent-first clipboard state. Kept separate from the Tauri
/// wrapper so the whole policy is unit-testable without a GUI.
#[derive(Default)]
struct ClipboardCore {
    history: VecDeque<ClipboardEntry>,
    next_seq: u64,
}

impl ClipboardCore {
    fn write(
        &mut self,
        source: &str,
        owner: &str,
        timestamp_ms: u64,
        payload: ClipboardPayload,
    ) -> ClipboardEntry {
        self.next_seq += 1;
        let entry = ClipboardEntry {
            seq: self.next_seq,
            source: source.to_string(),
            owner: owner.to_string(),
            timestamp_ms,
            payload,
        };
        // Coalesce a redundant re-copy of the *same* top payload so hammering
        // copy doesn't grow history; otherwise keep it as a distinct entry.
        if let Some(top) = self.history.front() {
            if top.payload == entry.payload {
                self.history.pop_front();
            }
        }
        self.history.push_front(entry.clone());
        self.history.truncate(HISTORY_LIMIT);
        entry
    }

    fn latest(&self) -> Option<&ClipboardEntry> {
        self.history.front()
    }

    fn history(&self, limit: usize) -> Vec<ClipboardEntry> {
        self.history.iter().take(limit).cloned().collect()
    }

    fn by_seq(&self, seq: u64) -> Option<ClipboardEntry> {
        self.history.iter().find(|e| e.seq == seq).cloned()
    }

    fn clear(&mut self) -> usize {
        let n = self.history.len();
        self.history.clear();
        n
    }
}

/// Shared, lock-protected global clipboard. Managed by Tauri (as `Arc`) and also
/// referenced by the native ingest bus so container-originated copies land here.
#[derive(Default)]
pub struct GlobalClipboard {
    inner: Mutex<ClipboardCore>,
}

impl GlobalClipboard {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ClipboardCore>, String> {
        self.inner.lock().map_err(|e| e.to_string())
    }

    /// Validate + store a payload as the newest clipboard entry.
    pub fn write(
        &self,
        source: &str,
        owner: &str,
        payload: ClipboardPayload,
    ) -> Result<ClipboardEntry, String> {
        payload.validate()?;
        let mut core = self.lock()?;
        Ok(core.write(source, owner, now_ms(), payload))
    }

    /// Convenience: copy plain text into the clipboard.
    pub fn write_plain(
        &self,
        source: &str,
        owner: &str,
        text: impl Into<String>,
    ) -> Result<ClipboardEntry, String> {
        self.write(source, owner, ClipboardPayload::Text { text: text.into() })
    }

    /// The newest entry, if any (cloned for callers).
    pub fn latest(&self) -> Option<ClipboardEntry> {
        self.lock().ok()?.latest().cloned()
    }

    /// The newest entry's plain-text rendering, if any — used for AI-context
    /// injection and shell previews.
    pub fn latest_text(&self) -> Option<String> {
        self.latest()?.plain_text()
    }

    /// A bounded history snapshot, newest first.
    pub fn history(&self, limit: Option<usize>) -> Vec<ClipboardEntry> {
        let core = match self.lock() {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };
        core.history(limit.unwrap_or(HISTORY_LIMIT).min(HISTORY_LIMIT))
    }

    /// Look up one entry by its sequence number.
    pub fn by_seq(&self, seq: u64) -> Option<ClipboardEntry> {
        self.lock().ok()?.by_seq(seq)
    }

    /// Clear the whole history, returning how many entries were removed.
    pub fn clear(&self) -> usize {
        match self.lock() {
            Ok(mut c) => c.clear(),
            Err(_) => 0,
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- Foreground read permission -------------------------------------------

/// The label of the currently focused window, per the window manager.
pub fn foreground_label(wm: &WmState) -> Result<String, String> {
    let snap = wm.snapshot()?;
    let fid = snap
        .focused
        .ok_or_else(|| "clipboard read denied: no focused window".to_string())?;
    snap.windows
        .iter()
        .find(|w| w.id == fid)
        .map(|w| w.label.clone())
        .ok_or_else(|| "clipboard read denied: focused window not tracked".to_string())
}

/// Enforce the OS privacy rule: reading/pasting the shared buffer is only granted
/// to the window that is currently *focused*. A background window can always
/// *write* (copy), but must never silently drain another window's clipboard.
pub fn require_foreground(wm: &WmState, caller: &str) -> Result<(), String> {
    let fg = foreground_label(wm)?;
    if fg == caller {
        Ok(())
    } else {
        Err(format!(
            "clipboard read denied: '{caller}' is not the foreground window (foreground='{fg}')"
        ))
    }
}

// ---- Native / container transport seam ------------------------------------

/// Platform transport for the clipboard: mirrors an outgoing (Rust-side) entry
/// onto the OS/container clipboard. Implemented by the Android container glue
/// (feature `android`); a default is a no-op so desktop/CI stays clean.
pub trait ClipboardNative: Send + Sync {
    fn name(&self) -> &'static str;
    /// Push an outgoing entry to the platform clipboard (best-effort).
    fn push_out(&self, entry: &ClipboardEntry) -> Result<(), String>;
}

static NATIVE_SINK: OnceLock<Arc<dyn ClipboardNative>> = OnceLock::new();

/// Install the platform transport. Called once at boot when a real transport
/// (Android container) is present; a second install is an error.
pub fn set_native_sink(sink: Arc<dyn ClipboardNative>) -> Result<(), String> {
    NATIVE_SINK
        .set(sink)
        .map_err(|_| "clipboard native sink is already installed".to_string())
}

/// Best-effort mirror of an outgoing entry onto the platform clipboard.
pub fn mirror_to_native(entry: &ClipboardEntry) {
    if let Some(sink) = NATIVE_SINK.get() {
        if let Err(e) = sink.push_out(entry) {
            tracing::warn!("[{}] clipboard push failed: {e}", sink.name());
        }
    }
}

/// Whether a platform transport is installed (for boot logs / diagnostics).
pub fn has_native_sink() -> bool {
    NATIVE_SINK.get().is_some()
}

// ---- Native ingest bus (container → shared buffer) ------------------------

/// Shared buffer the native (Android-container) side writes container-originated
/// copies into. Armed once at boot with the *same* `Arc<GlobalClipboard>` that is
/// managed by Tauri, mirroring the `android_glue` bus pattern.
static INGEST_BUS: OnceLock<Arc<GlobalClipboard>> = OnceLock::new();

/// Arm the ingest bus. Exactly-once; fails if already armed.
pub fn arm_ingest(clipboard: Arc<GlobalClipboard>) -> Result<(), String> {
    INGEST_BUS
        .set(clipboard)
        .map_err(|_| "clipboard ingest bus is already armed".to_string())
}

/// An installed "announce" hook: broadcasts a metadata-only `clipboard-changed`
/// notice. Installed once at boot so **container-originated** ingests notify
/// foreground UIs exactly like Webview-initiated writes (which emit via their own
/// `AppHandle`). Notifier is optional — when absent the announce is a no-op.
type Notifier = Arc<dyn Fn(&ClipboardEntry) + Send + Sync>;
static NOTIFIER: OnceLock<Notifier> = OnceLock::new();

/// Install the announce hook. Exactly-once; a second install is an error.
pub fn set_notifier<F>(f: F) -> Result<(), String>
where
    F: Fn(&ClipboardEntry) + Send + Sync + 'static,
{
    NOTIFIER
        .set(Arc::new(f))
        .map_err(|_| "clipboard notifier is already installed".to_string())
}

/// Push a metadata-only notice for `entry` through the installed notifier (no-op
/// when none is installed, e.g. host/CI or headless tests).
fn announce(entry: &ClipboardEntry) {
    if let Some(f) = NOTIFIER.get() {
        f(entry);
    }
}

/// A container-originated plain-text copy lands in the shared buffer as the
/// newest entry and, when armed + a notifier is installed, foreground UIs are told
/// a new copy is available via a metadata-only `clipboard-changed` notice. Honest
/// no-op when the bus isn't armed (no fabricated data).
pub fn ingest_native_text(source: &str, text: &str) -> bool {
    let Some(clip) = INGEST_BUS.get() else {
        return false;
    };
    match clip.write_plain(source, "", text) {
        Ok(entry) => {
            announce(&entry);
            true
        }
        Err(_) => false,
    }
}

// ---- Tauri commands ---------------------------------------------------------

/// Tauri command: copy multi-format content into the system clipboard. Allowed
/// from any window (copy is never the attack). Returns the stored entry.
#[tauri::command]
pub fn clipboard_write(
    app: tauri::AppHandle,
    state: State<'_, Arc<GlobalClipboard>>,
    window: tauri::WebviewWindow,
    payload: ClipboardPayload,
    source: Option<String>,
) -> Result<ClipboardEntry, String> {
    let caller = window.label().to_string();
    let src = source.unwrap_or_else(|| caller.clone());
    let entry = state.write(&src, &caller, payload)?;
    // Best-effort sync to the platform (container) clipboard + notify UIs with a
    // metadata-only notice (full content is fetched via foreground-gated read).
    mirror_to_native(&entry);
    let _ = app.emit("clipboard-changed", ClipboardNotice::from(&entry));
    Ok(entry)
}

/// Tauri command: paste the newest (or a specific `seq`) entry. Foreground-only.
#[tauri::command]
pub fn clipboard_read(
    state: State<'_, Arc<GlobalClipboard>>,
    wm: State<'_, WmState>,
    window: tauri::WebviewWindow,
    seq: Option<u64>,
) -> Result<Option<ClipboardEntry>, String> {
    require_foreground(wm.inner(), window.label())?;
    let entry = match seq {
        Some(s) => state.by_seq(s),
        None => state.latest(),
    };
    Ok(entry)
}

/// Tauri command: browse the clipboard history. Foreground-only.
#[tauri::command]
pub fn clipboard_history(
    state: State<'_, Arc<GlobalClipboard>>,
    wm: State<'_, WmState>,
    window: tauri::WebviewWindow,
    limit: Option<usize>,
) -> Result<Vec<ClipboardEntry>, String> {
    require_foreground(wm.inner(), window.label())?;
    Ok(state.history(limit))
}

/// Tauri command: clear the whole clipboard history. Foreground-only.
#[tauri::command]
pub fn clipboard_clear(
    state: State<'_, Arc<GlobalClipboard>>,
    wm: State<'_, WmState>,
    window: tauri::WebviewWindow,
) -> Result<usize, String> {
    require_foreground(wm.inner(), window.label())?;
    Ok(state.clear())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_clip() -> GlobalClipboard {
        GlobalClipboard::new()
    }

    #[test]
    fn text_write_read_round_trip() {
        let c = test_clip();
        let e = c.write_plain("notes", "notes", "hello world").unwrap();
        assert_eq!(e.seq, 1);
        assert_eq!(e.source, "notes");
        assert_eq!(e.owner, "notes");
        assert_eq!(c.latest_text().as_deref(), Some("hello world"));
        assert_eq!(c.by_seq(1), Some(e));
    }

    #[test]
    fn newest_is_on_top_and_history_is_most_recent_first() {
        let c = test_clip();
        c.write_plain("a", "a", "first").unwrap();
        c.write_plain("b", "b", "second").unwrap();
        assert_eq!(c.latest_text().as_deref(), Some("second"));
        let h = c.history(None);
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].plain_text().as_deref(), Some("second"));
        assert_eq!(h[1].plain_text().as_deref(), Some("first"));
    }

    #[test]
    fn redundant_same_copy_is_coalesced_not_appended() {
        let c = test_clip();
        c.write_plain("a", "a", "dup").unwrap();
        c.write_plain("a", "a", "dup").unwrap();
        assert_eq!(c.history(None).len(), 1, "identical top copy coalesced");
        assert_eq!(c.by_seq(2).unwrap().seq, 2, "still advances the seq");
    }

    #[test]
    fn history_is_bounded() {
        let c = test_clip();
        for i in 0..(HISTORY_LIMIT + 10) {
            c.write_plain("a", "a", format!("item-{i}")).unwrap();
        }
        let h = c.history(None);
        assert_eq!(h.len(), HISTORY_LIMIT);
        assert_eq!(h[0].plain_text().as_deref(), Some("item-41"));
    }

    #[test]
    fn html_keeps_plain_fallback_and_image_has_no_text() {
        let c = test_clip();
        c.write(
            "a",
            "a",
            ClipboardPayload::Html {
                html: "<b>hi</b>".to_string(),
                plain: "hi".to_string(),
            },
        )
        .unwrap();
        assert_eq!(c.latest_text().as_deref(), Some("hi"));

        c.write(
            "a",
            "a",
            ClipboardPayload::Image {
                mime: "image/png".to_string(),
                data_b64: "aGVsbG8=".to_string(), // "hello"
            },
        )
        .unwrap();
        let img = c.latest().unwrap();
        assert_eq!(img.plain_text(), None, "image has no text");
        assert_eq!(img.image_bytes().unwrap(), b"hello");
    }

    #[test]
    fn validation_rejects_bad_payloads() {
        let c = test_clip();
        assert!(c.write_plain("a", "a", "   ").is_err(), "blank text");
        assert!(
            c.write(
                "a",
                "a",
                ClipboardPayload::Uris {
                    uris: vec![],
                    text: String::new(),
                }
            )
            .is_err(),
            "empty uris"
        );
        assert!(
            c.write(
                "a",
                "a",
                ClipboardPayload::Image {
                    mime: "".to_string(),
                    data_b64: "aGVsbG8=".to_string(),
                }
            )
            .is_err(),
            "image without mime"
        );
        assert!(c.history(None).is_empty());
    }

    #[test]
    fn clear_empties_history() {
        let c = test_clip();
        c.write_plain("a", "a", "x").unwrap();
        c.write_plain("b", "b", "y").unwrap();
        assert_eq!(c.clear(), 2);
        assert!(c.latest().is_none());
    }

    #[test]
    fn image_bytes_on_non_image_is_err() {
        let c = test_clip();
        c.write_plain("a", "a", "text").unwrap();
        let entry = c.latest().unwrap();
        assert!(entry.image_bytes().is_err());
    }

    // ---- permission policy against a real WmState (launcher focused) ----

    fn fresh_wm() -> WmState {
        WmState::new()
    }

    #[test]
    fn foreground_grants_read_to_focused_launcher() {
        let wm = fresh_wm();
        assert_eq!(foreground_label(&wm).unwrap(), "main");
        assert!(require_foreground(&wm, "main").is_ok());
    }

    #[test]
    fn background_window_is_denied_read() {
        let wm = fresh_wm();
        assert!(
            require_foreground(&wm, "settings").is_err(),
            "non-focused window must not read the clipboard"
        );
    }

    #[test]
    fn ingest_and_native_sink_defaults_are_honest_noops() {
        assert!(!ingest_native_text("android:container", "from android"));
        assert!(!has_native_sink());
        let c = test_clip();
        assert!(c.latest().is_none(), "nothing fabricated");
    }

    #[test]
    fn write_notice_is_metadata_only_and_carries_no_payload() {
        let c = test_clip();
        let e = c.write_plain("notes", "notes", "s3cr3t").unwrap();
        let n = ClipboardNotice::from(&e);
        let v = serde_json::to_value(&n).unwrap();
        let obj = v.as_object().expect("notice serializes to an object");
        assert_eq!(
            obj.len(),
            3,
            "notice must carry only seq/timestamp_ms/source — never content"
        );
        assert!(
            !obj.contains_key("payload"),
            "content must not be broadcast"
        );
        assert_eq!(obj["seq"].as_u64(), Some(e.seq));
        assert_eq!(obj["source"].as_str(), Some("notes"));
    }
}

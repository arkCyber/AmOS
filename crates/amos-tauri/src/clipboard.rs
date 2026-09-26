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
//! * **Bounded delivery** — a window opts in with `clipboard_subscribe` (its label is injected
//!   by Tauri, never caller-supplied) and then receives at most [`CLIPBOARD_EVENTS_PER_SEC`]
//!   `clipboard-changed` notices per second; a JS copy loop can not flood the WebView
//!   (F-CLB-002). A `Uris` copy is capped at [`MAX_RECIPIENTS_PER_COPY`] entries.
//!
//! Commands: `clipboard_write`, `clipboard_read`, `clipboard_history`,
//! `clipboard_clear`, `clipboard_subscribe`.

use std::collections::{HashMap, VecDeque};
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

/// Maximum number of URIs — "recipients"/files attached to a single copy — one
/// `clipboard_write` may carry.
///
/// The `Uris` flavour is the only payload whose size is a **list** rather than a
/// string, so it is the one place a caller could hand in an unbounded collection
/// (each URI is re-validated, serialized into the history entry, mirrored out, and
/// re-broadcast). A real multi-select copy is a handful of files, so 64 is generous
/// while keeping the validation work and the retained entry bounded (F-CLB-002's
/// sibling: the copy itself must not be able to DoS the bridge).
pub const MAX_RECIPIENTS_PER_COPY: usize = 64;
/// Upper bound on the number of URIs in a single copy (the validator's spelling of
/// [`MAX_RECIPIENTS_PER_COPY`]).
const MAX_URIS: usize = MAX_RECIPIENTS_PER_COPY;

/// Maximum `clipboard-changed` notices a **single subscribed window** may receive per
/// second.
///
/// A tight JS loop calling `clipboard_write` would otherwise emit one WebView event per
/// call, so a copy that fails to coalesce into the history still floods the renderer
/// (F-CLB-002). 100/s is far above any human copy cadence and far below the rate that
/// would starve the WebView's event loop.
pub const CLIPBOARD_EVENTS_PER_SEC: u32 = 100;

/// Hard cap on the number of windows tracked by the clipboard event bus.
///
/// Each shell window subscribes with its **own** label (injected by Tauri, never
/// caller-supplied), so the registry is bounded by the window manager's own window count;
/// this constant is the backstop that turns a hypothetical leak into an audited eviction
/// instead of unbounded growth.
pub const MAX_CLIPBOARD_SUBSCRIBERS: usize = 32;
/// Upper bound on a clipboard `source` label the WebView hands in via
/// `clipboard_write` (the label is mirrored into every clipboard history entry
/// and broadcast on `clipboard-changed`, so a paste-sized label would inflate
/// every subsequent notice).
const MAX_CLIPBOARD_SOURCE_BYTES: usize = 256;

/// (Policy helper, pure) Validate a clipboard `source` label before it is stored.
///
/// Two refusals, both deliberate:
/// - **Empty** — a blank label makes a history row indistinguishable from a
///   WebView that simply forgot to pass one (`source=""` and "no source given"
///   would render the same). The default is the caller's window label, so an
///   empty string here is always an explicit, and meaningless, value.
/// - **Over the cap** — the label is mirrored into every history entry and every
///   `clipboard-changed` notice, so an unbounded one inflates all of them.
///
/// Extracted so the boundary is unit-testable without a live Tauri `AppHandle`.
fn check_source(src: &str) -> Result<(), String> {
    if src.is_empty() {
        return Err("clipboard source must not be empty".to_string());
    }
    if src.len() > MAX_CLIPBOARD_SOURCE_BYTES {
        return Err(format!(
            "clipboard source too long: {} bytes (max {MAX_CLIPBOARD_SOURCE_BYTES})",
            src.len()
        ));
    }
    Ok(())
}

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

/// Opaque handle a window receives from `clipboard_subscribe`, identifying its
/// subscription for the lifetime of the process (ids are never reused).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct SubscriptionId(
    /// Monotonic id; `0` is never handed out (the `next` counter starts at 1).
    pub u64,
);

/// Per-window event accounting: a token bucket (100 notices/s, burst 100) plus the
/// subscription's identity. Kept as a plain struct so the whole policy is testable without a
/// running Tauri app or a wall clock.
struct Subscriber {
    id: u64,
    /// Tokens available now (filled at continuous [`CLIPBOARD_EVENTS_PER_SEC`]).
    tokens: f64,
    /// Wall-clock ms of the last refill/consume.
    last_ms: u64,
}

/// The clipboard event bus: which windows asked to hear `clipboard-changed`, and how much
/// each of them has been told recently.
#[derive(Default)]
struct EventBus {
    next_id: u64,
    subs: HashMap<String, Subscriber>,
    /// Notices dropped because a window was over budget (diagnostics; never silent).
    dropped: u64,
    /// Subscriptions dropped because the registry was at [`MAX_CLIPBOARD_SUBSCRIBERS`].
    evicted: u64,
}

impl EventBus {
    /// Register (or refresh) `label`, returning its stable subscription id.
    ///
    /// Idempotent per label: the same window re-subscribing keeps its id and its bucket, so a
    /// JS loop cannot inflate the registry. A **new** label while the registry is full evicts the
    /// least-recently-seen subscription (counted in `evicted`) rather than growing unbounded.
    fn subscribe(&mut self, label: &str, now: u64) -> SubscriptionId {
        if let Some(s) = self.subs.get_mut(label) {
            s.last_ms = now;
            return SubscriptionId(s.id);
        }
        if self.subs.len() >= MAX_CLIPBOARD_SUBSCRIBERS {
            if let Some(oldest) = self
                .subs
                .iter()
                .min_by_key(|(_, s)| s.last_ms)
                .map(|(k, _)| k.clone())
            {
                self.subs.remove(&oldest);
                self.evicted += 1;
            }
        }
        self.next_id += 1;
        let id = self.next_id;
        self.subs.insert(
            label.to_string(),
            Subscriber {
                id,
                tokens: CLIPBOARD_EVENTS_PER_SEC as f64,
                last_ms: now,
            },
        );
        SubscriptionId(id)
    }

    /// Refill `label`'s bucket to `now` and consume one token if there is one.
    fn allow(&mut self, label: &str, now: u64) -> bool {
        let cap = CLIPBOARD_EVENTS_PER_SEC as f64;
        let Some(s) = self.subs.get_mut(label) else {
            return false;
        };
        let elapsed = now.saturating_sub(s.last_ms);
        s.tokens = (s.tokens + elapsed as f64 * cap / 1_000.0).min(cap);
        s.last_ms = now;
        if s.tokens >= 1.0 {
            s.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Consume a token for **every** subscribed window, returning the labels that are still
    /// within budget this instant. Over-budget windows are counted in `dropped`.
    fn take_allowed(&mut self, now: u64) -> Vec<String> {
        let labels: Vec<String> = self.subs.keys().cloned().collect();
        let mut allowed = Vec::new();
        for label in labels {
            if self.allow(&label, now) {
                allowed.push(label);
            } else {
                self.dropped += 1;
            }
        }
        allowed
    }

    fn is_empty(&self) -> bool {
        self.subs.is_empty()
    }
}

/// The process-wide event bus (one registry for the whole app).
static EVENT_BUS: OnceLock<Mutex<EventBus>> = OnceLock::new();

fn event_bus() -> &'static Mutex<EventBus> {
    EVENT_BUS.get_or_init(|| Mutex::new(EventBus::default()))
}

fn lock_bus() -> std::sync::MutexGuard<'static, EventBus> {
    // Poison-recover: a panic while counting events is not a statement about the user's
    // clipboard, and the commands must not deadlock on it (same rule as `GlobalClipboard::read`).
    event_bus().lock().unwrap_or_else(|p| p.into_inner())
}

/// Register `label` for `clipboard-changed` notices and return its subscription id.
///
/// Infallible by construction: `label` is the **calling window's own** label, injected by Tauri
/// (see [`clipboard_subscribe`]), never a caller-supplied string — so there is no unbounded input
/// to reject. The registry is bounded by [`MAX_CLIPBOARD_SUBSCRIBERS`] with an audited eviction.
pub fn subscribe_window(label: &str) -> SubscriptionId {
    lock_bus().subscribe(label, now_ms())
}

/// A snapshot of the event bus's counters (diagnostics / tests).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ClipboardBusStats {
    pub subscribers: usize,
    pub dropped: u64,
    pub evicted: u64,
}

/// Read the bus counters (never fabricates: all-zero when nothing subscribed).
pub fn bus_stats() -> ClipboardBusStats {
    let b = lock_bus();
    ClipboardBusStats {
        subscribers: b.subs.len(),
        dropped: b.dropped,
        evicted: b.evicted,
    }
}

/// Deliver one `clipboard-changed` notice with per-window throttling.
///
/// * **No window has subscribed** → the legacy global broadcast (`app.emit`), so a shell that
///   never calls `clipboard_subscribe` keeps working exactly as before.
/// * **At least one window subscribed** → each subscribed window gets `emit_to` **iff** its token
///   bucket allows it this instant; an over-budget window is counted in `bus_stats().dropped`
///   rather than flooded. The notice is metadata-only either way ([`ClipboardNotice`]).
fn broadcast_changed(app: &tauri::AppHandle, entry: &ClipboardEntry) {
    let notice = ClipboardNotice::from(entry);
    let labels = {
        let mut bus = lock_bus();
        if bus.is_empty() {
            None
        } else {
            Some(bus.take_allowed(now_ms()))
        }
    };
    match labels {
        None => {
            if let Err(e) = app.emit("clipboard-changed", notice) {
                tracing::warn!(
                    target: "amos::clipboard",
                    event = "clipboard-changed",
                    error = %e,
                    "clipboard-changed notice could not be delivered to the UI"
                );
            }
        }
        Some(labels) => {
            for label in labels {
                if let Err(e) = app.emit_to(label.as_str(), "clipboard-changed", notice.clone()) {
                    tracing::warn!(
                        target: "amos::clipboard",
                        event = "clipboard-changed",
                        window = %label,
                        error = %e,
                        "clipboard-changed notice could not be delivered to the subscribed window"
                    );
                }
            }
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

    /// A read-only guard that **tolerates poison**: a panic in another thread is not a
    /// statement about the user's clipboard, so reads still see what is there. Writes keep
    /// going through [`Self::lock`] and refuse on poison — pushing more changes into a core
    /// someone else's panic may have left half-updated is the case that *should* fail loudly.
    fn read(&self) -> std::sync::MutexGuard<'_, ClipboardCore> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
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
    ///
    /// A poisoned lock is *not* an empty clipboard: the core is still there, so reads go
    /// through [`Self::read`] instead of reporting "nothing was ever copied".
    pub fn latest(&self) -> Option<ClipboardEntry> {
        self.read().latest().cloned()
    }

    /// The newest entry's plain-text rendering, if any — used for AI-context
    /// injection and shell previews.
    pub fn latest_text(&self) -> Option<String> {
        self.latest()?.plain_text()
    }

    /// A bounded history snapshot, newest first.
    pub fn history(&self, limit: Option<usize>) -> Vec<ClipboardEntry> {
        // Poison-tolerant like the other accessors: an empty *history* would be a claim about
        // the user's clipboard, and a panic elsewhere is not that claim.
        let core = self.read();
        core.history(limit.unwrap_or(HISTORY_LIMIT).min(HISTORY_LIMIT))
    }

    /// Look up one entry by its sequence number.
    pub fn by_seq(&self, seq: u64) -> Option<ClipboardEntry> {
        self.read().by_seq(seq)
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
    check_source(&src)?;
    let entry = state.write(&src, &caller, payload)?;
    // Best-effort sync to the platform (container) clipboard + notify UIs with a
    // metadata-only, per-window-throttled notice (full content is fetched via the
    // foreground-gated read).
    mirror_to_native(&entry);
    broadcast_changed(&app, &entry);
    Ok(entry)
}

/// Tauri command: subscribe the **calling window** to `clipboard-changed` notices.
///
/// The window label is injected by Tauri rather than accepted as a string, so a caller cannot
/// subscribe (or forge a subscription for) another window — the parameter is the identity, not
/// an argument. Idempotent: re-subscribing returns the same [`SubscriptionId`]. The subscription
/// only controls *delivery* — the payload is still fetched through the foreground-gated
/// `clipboard_read`, so subscribing never widens read access.
#[tauri::command]
pub fn clipboard_subscribe(window: tauri::WebviewWindow) -> SubscriptionId {
    subscribe_window(window.label())
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
    fn the_mirror_text_cap_matches_this_crates_text_cap() {
        // `amos-clipboard`'s `MAX_MIRROR_TEXT` doc claims "the kernel's own text cap
        // (`amos-tauri`'s `MAX_TEXT_LEN`) is the same 1 MiB, so a copy the host
        // accepts is a copy the wire must be able to carry" — but nothing bound the
        // two. If `MAX_TEXT_LEN` were raised above the wire cap, a copy the host
        // accepts would silently fail to mirror to the guest (accepted locally,
        // refused on the wire); the reverse is merely an unused headroom. Pin them.
        assert_eq!(
            MAX_TEXT_LEN,
            amos_clipboard::proto::MAX_MIRROR_TEXT,
            "amos-tauri MAX_TEXT_LEN ({MAX_TEXT_LEN}) drifted from amos_clipboard::proto::MAX_MIRROR_TEXT ({})",
            amos_clipboard::proto::MAX_MIRROR_TEXT
        );
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

    /// P1-1 from the bridge audit: the source-length boundary was enforced but
    /// **untested**, so a future edit to "truncate instead of refuse" would have
    /// gone green. The cap is inclusive; empty is refused outright (the caller's
    /// window label is the default, so `""` is always an explicit blank).
    #[test]
    fn a_clipboard_source_is_refused_when_empty_or_over_the_cap() {
        assert!(
            check_source("notes").is_ok(),
            "a normal label passes through"
        );
        let at_cap = "x".repeat(MAX_CLIPBOARD_SOURCE_BYTES);
        assert!(check_source(&at_cap).is_ok(), "exactly the cap is allowed");

        let over = "x".repeat(MAX_CLIPBOARD_SOURCE_BYTES + 1);
        let err = check_source(&over).expect_err("one past the cap is refused");
        assert!(err.contains("too long"), "unexpected message: {err}");

        assert!(
            check_source("").is_err(),
            "an empty source is refused, not silently stored as a blank origin"
        );
    }

    #[test]
    fn ingest_and_native_sink_defaults_are_honest_noops() {
        assert!(!ingest_native_text("android:container", "from android"));
        assert!(!has_native_sink());
        let c = test_clip();
        assert!(c.latest().is_none(), "nothing fabricated");
    }

    /// The body of a `pub fn <name>(…) { … }` in this file, as source text.
    fn command_body<'a>(src: &'a str, fname: &str) -> &'a str {
        let marker = format!("pub fn {fname}(");
        let start = src
            .find(&marker)
            .unwrap_or_else(|| panic!("{fname} must exist"));
        let end = src[start..]
            .find("\n}")
            .map(|o| start + o)
            .unwrap_or(src.len());
        &src[start..end]
    }

    /// The single statement in `body` that calls `require_foreground`, trimmed.
    ///
    /// Returns the *statement*, not the match: `let _ = require_foreground(…)` and
    /// `require_foreground(…)?` both contain the call, and only one of them denies.
    fn gate_statement<'a>(body: &'a str, fname: &str) -> &'a str {
        let at = body.find("require_foreground(").unwrap_or_else(|| {
            panic!(
                "{fname} must gate its read through require_foreground — a background window \
                 draining the foreground's clipboard is the F-CLB-001 privacy failure"
            )
        });
        let tail = &body[at..];
        let semi = tail.find(';').unwrap_or(tail.len());
        tail[..semi].trim()
    }

    /// The audit that every clipboard **read** command is foreground-gated. This is a
    /// source-level pin so the negative control is a host test: deleting
    /// `require_foreground(…)` from `clipboard_history` makes this fail (TODO 5.3).
    ///
    /// **Presence is not propagation.** The first version of this pin asked only whether the
    /// call's *name* appeared anywhere in the body, so `let _ = require_foreground(…)` — the
    /// refusal computed and then dropped — left it green (measured: 21/21 passed with the gate
    /// neutralized) while a background window could drain the foreground's clipboard, which is
    /// exactly the F-CLB-001 privacy failure this row's `Test Protection` column cites. The
    /// guard is therefore pinned as the body's own statement: the call **is** the statement and
    /// its refusal is propagated with `?`, not merely mentioned.
    #[test]
    fn every_read_command_propagates_require_foreground() {
        const SRC: &str = include_str!("clipboard.rs");
        for fname in ["clipboard_read", "clipboard_history", "clipboard_clear"] {
            let stmt = gate_statement(command_body(SRC, fname), fname);
            assert!(
                stmt.starts_with("require_foreground("),
                "{fname}'s gate must *be* the statement, not a value handed to something else \
                 (a discarded `Result` denies nothing): got `{stmt}`"
            );
            assert!(
                stmt.ends_with(")?"),
                "{fname} must propagate the gate's refusal with `?` — computing it and dropping \
                 it leaves a background window able to read: got `{stmt}`"
            );
        }
        // …and the contrast that makes it meaningful: **write** is deliberately not gated
        // (copying from a background app is not the attack).
        assert!(
            !command_body(SRC, "clipboard_write").contains("require_foreground("),
            "clipboard_write must stay writable from any window"
        );
    }

    /// The URIs flavour is the only list-shaped payload; its cap is what keeps a caller from
    /// handing in an unbounded collection (each entry re-validated, retained and mirrored).
    #[test]
    fn uris_over_the_recipients_cap_are_refused_at_validation() {
        let c = test_clip();
        let over: Vec<String> = (0..=MAX_RECIPIENTS_PER_COPY)
            .map(|i| format!("content://file/{i}"))
            .collect();
        let err = c
            .write(
                "a",
                "a",
                ClipboardPayload::Uris {
                    uris: over,
                    text: String::new(),
                },
            )
            .expect_err("one past the cap must be refused");
        assert!(err.contains("uris"), "{err}");
        assert!(c.latest().is_none(), "nothing was stored by the refusal");

        // Exactly the cap is accepted — the boundary is inclusive.
        let at_cap: Vec<String> = (0..MAX_RECIPIENTS_PER_COPY)
            .map(|i| format!("content://file/{i}"))
            .collect();
        assert!(c
            .write(
                "a",
                "a",
                ClipboardPayload::Uris {
                    uris: at_cap,
                    text: String::new(),
                },
            )
            .is_ok());
    }

    /// An image payload past the base64 cap is refused at validation, before any decode work.
    #[test]
    fn image_payload_over_cap_is_rejected_at_validation() {
        let c = test_clip();
        let too_big = "A".repeat(MAX_IMAGE_B64_LEN + 4);
        let err = c
            .write(
                "a",
                "a",
                ClipboardPayload::Image {
                    mime: "image/png".to_string(),
                    data_b64: too_big,
                },
            )
            .expect_err("oversized image must be refused");
        assert!(err.contains("too large"), "{err}");
        assert!(c.latest().is_none());
    }

    /// With no transport installed, mirroring an outgoing copy is a silent no-op — never a panic
    /// and never a fabricated push.
    #[test]
    fn mirror_to_native_when_no_sink_is_noop_no_error() {
        let entry = ClipboardEntry {
            seq: 1,
            source: "a".to_string(),
            owner: "a".to_string(),
            timestamp_ms: 0,
            payload: ClipboardPayload::Text {
                text: "x".to_string(),
            },
        };
        mirror_to_native(&entry); // must not panic
        assert!(!has_native_sink(), "no sink was ever installed");
    }

    /// Subscribing is idempotent per window (a JS loop cannot inflate the registry), and the
    /// registry is bounded with an **audited** eviction rather than unbounded growth.
    #[test]
    fn subscribe_is_idempotent_and_bounded() {
        let mut bus = EventBus::default();
        let first = bus.subscribe("main", 0);
        let again = bus.subscribe("main", 5);
        assert_eq!(first, again, "re-subscribing keeps the same id");
        assert_eq!(bus.subs.len(), 1);

        for i in 0..(MAX_CLIPBOARD_SUBSCRIBERS + 5) {
            bus.subscribe(&format!("w{i}"), 100 + i as u64);
        }
        assert_eq!(bus.subs.len(), MAX_CLIPBOARD_SUBSCRIBERS, "hard cap holds");
        assert!(
            bus.evicted >= 5,
            "every eviction is counted, none is silent: {}",
            bus.evicted
        );
    }

    /// The per-window token bucket: a burst of [`CLIPBOARD_EVENTS_PER_SEC`] is allowed, the rest
    /// is dropped, and a second later the bucket has refilled.
    #[test]
    fn the_event_throttle_caps_a_window_at_the_configured_rate() {
        let mut bus = EventBus::default();
        bus.subscribe("main", 0);
        let mut allowed = 0;
        for _ in 0..(CLIPBOARD_EVENTS_PER_SEC + 10) {
            if bus.allow("main", 0) {
                allowed += 1;
            }
        }
        assert_eq!(
            allowed, CLIPBOARD_EVENTS_PER_SEC as usize,
            "exactly one second's worth of burst"
        );
        // One second later the bucket is full again.
        assert!(
            bus.allow("main", 1_000),
            "the bucket refills at the configured rate"
        );
    }

    /// A flood is delivered to the subscribed windows only up to the budget; the surplus is
    /// **counted**, not delivered and not silently forgotten (F-CLB-002).
    #[test]
    fn a_flood_is_capped_and_the_dropped_notices_are_counted() {
        let mut bus = EventBus::default();
        bus.subscribe("main", 0);
        bus.subscribe("settings", 0);
        let mut allowed = 0usize;
        for _ in 0..400 {
            allowed += bus.take_allowed(0).len();
        }
        assert_eq!(
            allowed,
            CLIPBOARD_EVENTS_PER_SEC as usize * 2,
            "each window gets one second's budget, no more"
        );
        assert!(
            bus.dropped >= 200,
            "the surplus is counted: {}",
            bus.dropped
        );
        // A window that never subscribed is never a target.
        assert!(!bus.take_allowed(0).contains(&"ghost".to_string()));
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

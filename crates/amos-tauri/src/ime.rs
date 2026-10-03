//! Tauri <-> input-method (IME) bridge — the System UI's on-screen pinyin
//! keyboard. The engine itself is `amos-ime`; this module owns the *session
//! state*, the `ime_*` commands and the profile file.
//!
//! **One engine, one buffer per window** (REQ-A258). The WebView sends one tap at
//! a time (`ime_key` / `ime_backspace`), and the desktop shell opens one real
//! `WebviewWindow` per app while `Shell.svelte` mounts the keyboard overlay in
//! **every** window (`docs/multi-window.md` §6). So the two halves of "session"
//! have different scopes and must be split:
//!
//! * the **dictionary + the L0 learner + the fuzzy preferences** are process-wide
//!   ([`PinyinCore`] behind an `Arc`) — one user, one corpus, one set of pinned
//!   words, and the profile file is written once;
//! * the **in-flight pinyin buffer** (plus its "just committed" hint and its undo
//!   code) belongs to the window it was typed in.
//!
//! Before the split there was a single buffer for the whole process, so window A's
//! candidate bar showed what was typed in window B and a commit in B consumed A's
//! composition (`docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` G1). Every command now takes
//! the caller as `tauri::WebviewWindow` (the `clipboard.rs` precedent — the host
//! injects it, the JS side passes nothing) and files its buffer under that label.
//!
//! Persistence: `amos-ime.json` next to the blocklist/SMS stores (atomic write:
//! temp + rename). Missing file = first run (defaults); a **corrupt** file is
//! logged and the defaults are kept — a settings file must never crash the
//! keyboard, but the failure is never hidden from the operator. Writes are
//! best-effort *after* the in-memory change, exactly like the blocklist: the
//! command's success is about this session, and a failed flush is logged rather
//! than reported as a typing failure.
//!
//! `docs/input-method.md` documents the design and its honest boundaries.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use amos_ime::{
    CandidateKind, FuzzyPair, FuzzyPrefs, ImeProfile, L0Data, PinyinCore, PinyinInput,
    MAX_CANDIDATES,
};
use serde::Serialize;

use crate::error::{AmosError, ErrorCode};

/// File name inside the app data dir.
pub const IME_FILE: &str = "amos-ime.json";

/// Candidates a single query returns (the keyboard pages through this list).
pub const CANDIDATE_LIMIT: usize = MAX_CANDIDATES;

/// Candidate kind of a **联想** suggestion (next-word prediction).
///
/// A third kind next to `amos-ime`'s `"dict"` / `"sentence"`: the keyboard styles
/// them differently, and — the reason it is explicit rather than inferred from
/// "the buffer happens to be empty" — it is what makes a suggestion pick a
/// *different* operation from a buffer commit (nothing is learned).
pub const PREDICT_KIND: &str = "predict";

/// How many windows may hold a composition buffer at once.
///
/// The desktop shell opens one window per app and a label is never reused after
/// its window closes, so a long session would otherwise grow this map forever
/// (Power of 10 #3: bounded resources). At the cap, sessions with **nothing to
/// lose** (empty buffer, no undo hint) are dropped first; only if every window is
/// mid-composition is the least-recently-used one evicted — and that loss is
/// logged, never silent.
pub const MAX_IME_SESSIONS: usize = 64;

/// Maximum bytes the WebView may hand to one [`crate::ime::ime_key`] call.
///
/// Only ASCII letters compose, but the call accepts an arbitrary string and
/// scans it char-by-char; bounding the **input** prevents a paste / malicious
/// caller from forcing the engine to iterate a 4 MiB string and to grow the
/// buffer beyond [`MAX_INPUT_CHARS`]. `64` covers a 64-character latin-alphabet
/// paste (rare but legal for romanisation workflows), well above any one-finger
/// tap. The command seam is the right place to refuse — same rule as
/// `real_dial::MAX_DIAL_CHARS`.
pub const MAX_KEY_CHARS: usize = 64;

/// Maximum bytes in one `ime_fuzzy_toggle` pair name / `ime_fuzzy_preset` preset
/// name coming from the WebView.
///
/// Real pair keys are ≤7 ASCII chars (`"z_zh"`, `"n_l"`, …); real preset names
/// are 11 chars (`"permissive"`). The cap is well above any legitimate value
/// but tight enough that a paste / runaway JS loop cannot turn every fuzzy
/// change into an O(n) string compare over a multi-kilobyte buffer.
pub const MAX_IME_NAME_BYTES: usize = 64;

/// Maximum length of one window's pinyin buffer in characters.
///
/// Pinyin words are at most 6 letters (`zhuang`), the longest valid sentence
/// search is bounded by the engine's `MAX_INPUT`. A 64-letter buffer is far
/// past what any human would type; anything longer is almost certainly a loop
/// or a hostile caller, and silently accepting it would (a) make candidate
/// generation slow on every keystroke and (b) defeat the log line that says
/// "you hit the cap" if such a thing ever needed reporting.
pub const MAX_INPUT_CHARS: usize = 64;

/// The IME bridge: **one** shared engine + learner, **one** buffer per window.
///
/// `Clone` is cheap and shares the *whole* inner state (one `Arc<Mutex<_>>`), which
/// is what lets the Android system IME (`crate::android_ime`) drive the very same
/// engine, learner and profile file as the WebView's on-screen keyboard — one
/// process, one dictionary, one set of pinned words (REQ-A1880). See
/// [`install_shared`] / [`shared_or_boot`].
#[derive(Clone)]
pub struct ImeBridge {
    inner: Arc<Mutex<ImeInner>>,
}

/// The pseudo-window the Android `InputMethodService` types in.
///
/// The bridge files a composition buffer per window (REQ-A258) and the service is
/// one target at a time, so it needs exactly one stable label. It is a *real*
/// entry in the same map as the WebView's labels, so the service's half-typed code
/// can never be consumed by a WebView window (or vice versa) — the two surfaces
/// are separate buffers over the same engine. The `:` prefix keeps it out of the
/// way of `WebviewWindow::label()` values, which are DOM-ish names.
/// `cfg(test)` is here so the desktop `cargo test` (no `android` feature) still
/// compiles the sharing tests below; a desktop *release* build has no Android
/// service to label, so the constant would otherwise be dead code.
#[cfg(any(feature = "android", test))]
pub const ANDROID_WINDOW: &str = "android-ime";

/// The process-wide bridge the Android IME service shares with the Tauri app.
///
/// Set once by [`install_shared`] when the System UI boots (so the service gets the
/// *same* instance, path and learner), or lazily by [`shared_or_boot`] when the
/// service is bound before the Activity ever ran.
static SHARED: std::sync::OnceLock<ImeBridge> = std::sync::OnceLock::new();

/// Publish `bridge` as the shared instance and answer with the instance that is
/// **actually** shared.
///
/// First writer wins; a later call is a no-op. But it still returns the winner,
/// because the losers are not always installing "the same thing": the platform can
/// cold-start this process for the bound `InputMethodService` before the System UI
/// Activity ever runs (`AmosImeService.onCreate` → `nativeAttach` →
/// [`shared_or_boot`]), so the host's own [`ImeBridge::boot`] is then the late
/// arrival. Returning the winner lets it **adopt** the service's engine; managing
/// the fresh boot instead would leave two learners behind one `amos-ime.json`, each
/// `persist` overwriting the other's picks — exactly the split this singleton exists
/// to prevent.
pub fn install_shared(bridge: ImeBridge) -> ImeBridge {
    // `get_or_init` is first-writer-wins *and* answers with the winner, with no
    // panic path: when the slot is empty `bridge` moves in and is what we return;
    // when an earlier caller already installed one, `bridge` is dropped unused and
    // the earlier instance comes back (the losing boot was a private learner that
    // nothing ever drove).
    SHARED.get_or_init(|| bridge).clone()
}

/// The shared bridge, booting a fallback configured at `profile` if none was
/// installed.
///
/// The fallback is the honest answer to "the IME service was bound but the System
/// UI Activity never started": the service still needs an engine, and it still
/// wants the profile to persist. `profile` is the bridge's profile path
/// (see [`file_in`]); `None` keeps the fallback in memory only. Never panics.
///
/// Only the Android service has a reason to reach for a bridge it did not already
/// have (the Tauri commands get theirs injected by the host), so this is
/// `android`-gated.
#[cfg(feature = "android")]
pub fn shared_or_boot(profile: Option<PathBuf>) -> ImeBridge {
    SHARED
        .get_or_init(|| {
            let bridge = ImeBridge::boot();
            match profile {
                Some(path) => bridge.configure(path),
                None => tracing::warn!(
                    target: "amos::ime",
                    "android IME booted without a profile path — learning will not persist"
                ),
            }
            bridge
        })
        .clone()
}

struct ImeInner {
    /// The process-wide engine + learner every window composes against.
    core: Arc<PinyinCore>,
    path: Option<PathBuf>,
    /// The per-window buffers, keyed by `WebviewWindow::label()`.
    windows: HashMap<String, WindowSession>,
    /// Monotonic counter behind [`WindowSession::touched`] (deterministic LRU).
    seq: u64,
    /// **Cumulative** count of profile-flush failures, surfaced as a field on
    /// [`ImeStateOut`] so the operator can see that the learner is in-memory only
    /// (the same observability rule the on-disk log sink makes visible — REQ-A87
    /// / F-IME-032). It is on `ImeInner` rather than `ImeBridge` so reads inside
    /// `state_of` (which already holds the lock) do not have to re-acquire it,
    /// and writes from `persist()` (which is the *only* mutator) are the same
    /// ordering story as the engine it serialises behind. Zero on a fresh boot.
    persist_failures: AtomicU64,
}

struct WindowSession {
    input: PinyinInput,
    /// The pinyin code of the most recent **dictionary** commit **in this
    /// window** — the only kind of pick the L0 learner records, so it is also the
    /// only one "forget" can undo. `None` after a sentence commit (nothing was
    /// learned) or a forget.
    last_pick_code: Option<String>,
    touched: u64,
}

/// Serializable mirror of one candidate (`kind` is `"dict"` / `"sentence"`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ImeCandidateOut {
    pub text: String,
    pub kind: String,
}

/// Serializable mirror of the whole session — what every `ime_*` command answers.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ImeStateOut {
    /// The raw pinyin typed so far (empty when not composing).
    pub input: String,
    /// The candidate list for `input` (bounded by [`CANDIDATE_LIMIT`]).
    pub candidates: Vec<ImeCandidateOut>,
    /// `true` while a non-empty buffer is being composed.
    pub composing: bool,
    /// `true` iff every fuzzy pair is off.
    pub strict: bool,
    /// The current fuzzy-pair preferences.
    pub fuzzy: FuzzyPrefs,
    /// Distinct pinyin codes in the embedded dictionary.
    pub dict_entries: usize,
    /// User-pinned codes in the learner.
    pub learned_pins: usize,
    /// `(code, word)` pairs still earning promotion in the learner.
    pub learned_pending: usize,
    /// The last committed text, if any.
    pub last_committed: Option<String>,
    /// The code of the last **dictionary** commit, when undoing it is possible
    /// (the keyboard offers "forget this word" only while this is set — undoing a
    /// sentence composition would be a button that does nothing).
    pub last_pick_code: Option<String>,
    /// **Cumulative** count of profile-flush failures since this bridge booted
    /// (REQ-A2091 / F-IME-032). `0` means every persist attempt since boot landed;
    /// a non-zero value is the learner being in-memory only and the operator
    /// has not been told — the same honesty rule the on-disk log sink pays for
    /// (`logfile.rs::LogSinkReport.lost_bytes`). Frontend renders this as a
    /// health-readout line in Settings, so a stuck `amos-ime.json` is visible
    /// rather than a word that "the keyboard forgot".
    pub persist_failures: u64,
}

/// Reply of `ime_commit`: what was inserted (if anything) + the new session state.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ImeCommitOut {
    /// The committed text, or `None` when the index was out of range.
    pub committed: Option<String>,
    pub state: ImeStateOut,
}

/// The profile path inside `data_dir` (the single place setup + tests resolve it).
pub fn file_in(data_dir: &Path) -> PathBuf {
    data_dir.join(IME_FILE)
}

/// Monotonic per-process sequence for staging-file names.
///
/// The same fix as `amos_appstore::atomic`'s `STAGING_SEQ`, for the same reason:
/// two writers in **one** process sharing a temp path can interleave into a single
/// inode and `rename` each other's half-written bytes into place. Here that would
/// publish a *torn* profile, and the next boot would log "unreadable — keeping
/// defaults": the user's pinned words and fuzzy preferences would be silently gone.
static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

/// The unique staging path for one write: a hidden sibling in the **same**
/// directory (a cross-filesystem `rename` would silently degrade to a copy).
fn staging_path(path: &Path) -> PathBuf {
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let name = path.file_name().map_or_else(
        || IME_FILE.to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    dir.join(format!(
        ".{name}.tmp.{}.{}",
        std::process::id(),
        STAGING_SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Best-effort cleanup of a staging file. A leftover temp file is the next
/// writer's mystery, not theirs to inherit — and a real failure is reported
/// rather than swallowed (a missing one is simply already gone).
fn remove_staging(tmp: &Path) {
    if let Err(e) = std::fs::remove_file(tmp) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(
                target: "amos::ime",
                tmp = %tmp.display(),
                error = %e,
                "IME staging file could not be removed"
            );
        }
    }
}

/// Move a profile that **exists but cannot be read back** out of the way, so the next
/// [`ImeBridge::persist`] writes a fresh profile beside it rather than over the one copy
/// of the user's learned words and fuzzy preferences.
///
/// `rename` is a directory operation, so it still succeeds when the file's *contents* are
/// unreadable. Answers `None` when there is nothing to move (no regular file) or the rename
/// was refused (read-only directory); the caller says which in its warning.
fn preserve_unreadable_state(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let kept = path.with_extension(format!("corrupt-{nonce}"));
    std::fs::rename(path, &kept).ok().map(|()| kept)
}

/// Log a profile that is present but unusable, keeping its bytes aside. The two warnings
/// name *which* happened: kept under a `corrupt-*` sibling, or could not be moved.
fn keep_profile_aside(path: &Path, reason: &str) {
    match preserve_unreadable_state(path) {
        Some(kept) => tracing::warn!(
            target: "amos::ime",
            path = %path.display(),
            kept = %kept.display(),
            "IME profile {reason}; kept beside the original and keeping defaults"
        ),
        None => tracing::warn!(
            target: "amos::ime",
            path = %path.display(),
            "IME profile {reason}; could not be moved aside, keeping defaults"
        ),
    }
}

/// Build the serializable state from one window's session + the shared core.
///
/// **One candidate list, two sources** (REQ-A260): while a code is being composed
/// the list is the engine's candidates for that buffer; with an empty buffer it is
/// the 联想 suggestions for what *this* window has committed. One index space
/// either way, so the keyboard's pager and its commit index mean exactly one thing
/// (the suggestion carries `"predict"` so the UI can label it).
///
/// `persist_failures` is a snapshot of the bridge's cumulative profile-flush
/// failure count (REQ-A2091 / F-IME-032). It is read **before** the borrow on
/// `inner` ends — `state_of` is the one place the field flows onto the wire, and
/// routing the value through the call instead of borrowing the whole `ImeInner`
/// keeps the lock window as small as it was before the counter existed (the
/// earlier shape only held `session` and `core` while the bridge was already
/// inside the call).
fn state_of(persist_failures: u64, session: &WindowSession, core: &PinyinCore) -> ImeStateOut {
    let input = &session.input;
    let candidates = if input.is_composing() {
        input
            .candidates(CANDIDATE_LIMIT)
            .into_iter()
            .map(|c| ImeCandidateOut {
                text: c.text,
                kind: c.kind.key().to_string(),
            })
            .collect()
    } else {
        input
            .predictions(CANDIDATE_LIMIT)
            .into_iter()
            .map(|text| ImeCandidateOut {
                text,
                kind: PREDICT_KIND.to_string(),
            })
            .collect()
    };
    ImeStateOut {
        input: input.input().to_string(),
        candidates,
        composing: input.is_composing(),
        strict: input.is_strict(),
        fuzzy: input.prefs(),
        dict_entries: core.dict_entries(),
        learned_pins: core.learned_pins(),
        learned_pending: core.learned_pending(),
        last_committed: input.last_committed().map(str::to_string),
        last_pick_code: session.last_pick_code.clone(),
        persist_failures,
    }
}

/// The per-window bookkeeping around the map: lookup-or-create, the bound, and the
/// touch order. Split out so the whole policy is testable without a window.
impl ImeInner {
    /// A mutable borrow of `window`'s session, creating it on first use.
    ///
    /// `make_room` runs **before** the insert, so the cap holds even on creation —
    /// and `Entry::or_insert_with` makes the lookup total, with no "this cannot
    /// happen" panic path in a keystroke.
    fn session(&mut self, window: &str) -> &mut WindowSession {
        self.seq += 1;
        let seq = self.seq;
        if !self.windows.contains_key(window) {
            self.make_room();
        }
        let session = self
            .windows
            .entry(window.to_string())
            .or_insert_with(|| WindowSession {
                input: PinyinInput::with_core(Arc::clone(&self.core)),
                last_pick_code: None,
                touched: seq,
            });
        session.touched = seq;
        session
    }

    /// Keep [`MAX_IME_SESSIONS`] as a real bound.
    ///
    /// First drop every session that holds nothing a user could miss — an empty
    /// buffer, no undo code and no "just committed" hint. Only if *every* window is
    /// mid-typing is the least-recently-used one evicted, and that one is logged:
    /// it really can lose a half-typed sentence.
    fn make_room(&mut self) {
        if self.windows.len() < MAX_IME_SESSIONS {
            return;
        }
        self.windows.retain(|_, s| {
            s.input.is_composing()
                || s.input.last_committed().is_some()
                || s.last_pick_code.is_some()
        });
        if self.windows.len() < MAX_IME_SESSIONS {
            return;
        }
        let Some(oldest) = self
            .windows
            .iter()
            .min_by_key(|(_, s)| s.touched)
            .map(|(label, _)| label.clone())
        else {
            return;
        };
        let composing = self
            .windows
            .get(&oldest)
            .is_some_and(|s| s.input.is_composing());
        self.windows.remove(&oldest);
        tracing::warn!(
            target: "amos::ime",
            window = %oldest,
            composing,
            cap = MAX_IME_SESSIONS,
            "IME session cap reached — dropped the least recently used window's buffer"
        );
    }
}

impl ImeBridge {
    /// Boot with the strict defaults and no learner state.
    pub fn boot() -> Self {
        Self::from_profile(FuzzyPrefs::strict(), L0Data::default())
    }

    /// Boot from a known profile (tests / restoring a snapshot).
    pub fn from_profile(fuzzy: FuzzyPrefs, l0: L0Data) -> Self {
        let core = PinyinCore::new(fuzzy);
        core.import_l0(&l0);
        Self {
            inner: Arc::new(Mutex::new(ImeInner {
                core: Arc::new(core),
                path: None,
                windows: HashMap::new(),
                seq: 0,
                persist_failures: AtomicU64::new(0),
            })),
        }
    }

    /// Point the bridge at its profile file and load it (once per path). Three outcomes,
    /// not two: an **absent** file is a first run; a file that is **present but
    /// unreadable** (corrupt / truncated / non-UTF-8 / permission, or a *newer* schema
    /// this build cannot parse) is **moved aside** as `<name>.corrupt-<nonce>` before the
    /// defaults are kept, so the next [`Self::persist`] — a whole-file tmp+rename — writes
    /// a fresh profile beside it instead of over the user's learned words (REQ-A1933).
    pub fn configure(&self, path: PathBuf) {
        let mut inner = self.lock();
        if inner.path.as_deref() == Some(path.as_path()) {
            return;
        }
        inner.path = Some(path.clone());
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            // No file yet is the ordinary first run, not an incident.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                keep_profile_aside(&path, &format!("could not be read: {e}"));
                return;
            }
        };
        match ImeProfile::from_json(&text) {
            Ok(profile) => {
                inner.core.set_prefs(profile.fuzzy());
                let accepted = inner.core.import_l0(&profile.l0());
                tracing::info!(
                    target: "amos::ime",
                    path = %path.display(),
                    pins = accepted,
                    "IME profile loaded"
                );
            }
            Err(e) => keep_profile_aside(&path, &format!("is unreadable: {e}")),
        }
    }

    /// The current state of `window`'s composition (the keyboard pulls this when it
    /// mounts).
    pub fn snapshot(&self, window: &str) -> ImeStateOut {
        let mut inner = self.lock();
        let core = Arc::clone(&inner.core);
        // The counter is read before the mutable borrow on `session` starts, so the
        // compiler's NLL checker sees a clean serial pair of borrows rather than
        // the two overlapping it would reject (an `AtomicU64::load` is a `&self`
        // call on the field, which keeps `inner` borrowed for the rest of the
        // expression).
        let persist_failures = inner.persist_failures.load(Ordering::Relaxed);
        let session = inner.session(window);
        state_of(persist_failures, session, &core)
    }

    /// Feed one tap's worth of characters into `window`'s buffer (only ASCII
    /// letters land in it). Deliberately **not** persisted: a half-typed code is
    /// not user state.
    ///
    /// A tap that starts a new word also closes **that window's** previous commit's
    /// undo window (the engine drops its hint, and the code it would have forgotten
    /// is no longer the "last pick").
    ///
    /// The buffer is bounded at [`MAX_INPUT_CHARS`]: when a paste / runaway loop
    /// would push it past the cap the call is **dropped silently** (a single
    /// pinyin sentence never legitimately reaches 64 chars) and the existing
    /// buffer is left intact. The dropped count is logged once per window so a
    /// stuck key handler is visible.
    pub fn key(&self, window: &str, ch: &str) -> ImeStateOut {
        let mut inner = self.lock();
        let core = Arc::clone(&inner.core);
        // Counter read before the mutable borrow on `session` starts; the
        // persist-failures count is a snapshot of the bridge's lifetime
        // observability, not of this call.
        let persist_failures = inner.persist_failures.load(Ordering::Relaxed);
        let session = inner.session(window);
        let before = session.input.input().len();
        if before >= MAX_INPUT_CHARS {
            // A buffer already at the cap will not absorb any new letters.
            // Silent drop, but log so a stuck keyboard is visible: the WebView
            // may have entered a loop that hammers ime_key.
            tracing::warn!(
                target: "amos::ime",
                window = %window,
                input_len = before,
                cap = MAX_INPUT_CHARS,
                "IME buffer at cap — refusing further letters for this window"
            );
            return state_of(persist_failures, session, &core);
        }
        // Take only the letters that fit (the JS side already enforces
        // MAX_KEY_CHARS, but a leftover in-flight caller could still exceed).
        let remaining = MAX_INPUT_CHARS.saturating_sub(before);
        let mut accepted = 0usize;
        for c in ch.chars().take(remaining) {
            if session.input.type_char(c) {
                accepted += 1;
            }
        }
        if accepted > 0 {
            session.last_pick_code = None;
        }
        state_of(persist_failures, session, &core)
    }

    /// Drop one buffered character from `window`. Not persisted (same reason as
    /// [`Self::key`]).
    pub fn backspace(&self, window: &str) -> ImeStateOut {
        let mut inner = self.lock();
        let core = Arc::clone(&inner.core);
        let persist_failures = inner.persist_failures.load(Ordering::Relaxed);
        let session = inner.session(window);
        session.input.backspace();
        state_of(persist_failures, session, &core)
    }

    /// Abandon `window`'s in-flight buffer. Not persisted.
    pub fn clear(&self, window: &str) -> ImeStateOut {
        let mut inner = self.lock();
        let core = Arc::clone(&inner.core);
        let persist_failures = inner.persist_failures.load(Ordering::Relaxed);
        let session = inner.session(window);
        session.input.clear();
        state_of(persist_failures, session, &core)
    }

    /// Commit candidate `index` **in `window`**: the inserted text (or `None` for an
    /// out-of-range index) plus the new state. A real commit changes the learner, so
    /// it is flushed to the profile — the learner is process-wide, so one window's
    /// pick is every window's.
    ///
    /// Two sources, one index space (REQ-A260): with a non-empty buffer this is the
    /// engine's candidate list; with an empty buffer the list on screen is the 联想
    /// suggestions, and picking one inserts it **without** teaching the learner (a
    /// list the user picked from is not a word the user typed — the same rule the
    /// sentence composition follows).
    pub fn commit(&self, window: &str, index: usize) -> ImeCommitOut {
        let (committed, state) = {
            let mut inner = self.lock();
            let core = Arc::clone(&inner.core);
            let persist_failures = inner.persist_failures.load(Ordering::Relaxed);
            let session = inner.session(window);
            if session.input.is_composing() {
                // The code and the candidate *kind* must be read **before** the
                // commit consumes the buffer, and only a dictionary pick is
                // learnable — a sentence composition teaches the dictionary nothing,
                // so it must not offer an "undo" that would be a no-op. (This re-runs
                // the candidate query once; it is a dictionary lookup plus, for long
                // buffers, the segmenter — microseconds, and it keeps the engine's
                // API unchanged.)
                let code = session.input.input().to_string();
                let learnable = session
                    .input
                    .candidates(CANDIDATE_LIMIT)
                    .get(index)
                    .is_some_and(|c| c.kind == CandidateKind::Dict);
                let committed = session.input.commit(index);
                session.last_pick_code = if committed.is_some() && learnable {
                    Some(code)
                } else {
                    None
                };
                (committed, state_of(persist_failures, session, &core))
            } else {
                let committed = session.input.commit_prediction(index, CANDIDATE_LIMIT);
                // A suggestion carries no pinyin code, so there is nothing the
                // learner could have learned and nothing "forget" could undo.
                session.last_pick_code = None;
                (committed, state_of(persist_failures, session, &core))
            }
        };
        if committed.is_some() {
            self.persist();
        }
        ImeCommitOut { committed, state }
    }

    /// Forget the word **this window** just committed — undo its learned pin — and
    /// clear its commit hint. A no-op on the learner when the last commit was a
    /// sentence composition (it never taught anything); the hint is cleared either
    /// way, because the user acted on it.
    pub fn forget_last(&self, window: &str) -> ImeStateOut {
        let state = {
            let mut inner = self.lock();
            let core = Arc::clone(&inner.core);
            let persist_failures = inner.persist_failures.load(Ordering::Relaxed);
            let session = inner.session(window);
            if let Some(code) = session.last_pick_code.take() {
                session.input.forget(&code);
            }
            session.input.clear_hint();
            state_of(persist_failures, session, &core)
        };
        self.persist();
        state
    }

    /// Flip one fuzzy pair by its stable key. Unknown pairs are an error.
    ///
    /// The preference is a **device** setting, so it applies to every window — and
    /// every in-flight buffer is abandoned, because the ranking rules they were
    /// ranked under really did change (`docs/input-method.md`). The answer is the
    /// calling window's state.
    pub fn fuzzy_toggle(&self, window: &str, pair: &str) -> Result<ImeStateOut, String> {
        let pair =
            FuzzyPair::from_key(pair).ok_or_else(|| format!("unknown fuzzy pair: {pair}"))?;
        let state = self.apply_prefs(window, |core| {
            core.toggle_fuzzy(pair);
        });
        self.persist();
        Ok(state)
    }

    /// Apply a named fuzzy preset (`"strict"` / `"permissive"`). Same scope rule as
    /// [`Self::fuzzy_toggle`].
    pub fn fuzzy_preset(&self, window: &str, preset: &str) -> Result<ImeStateOut, String> {
        let prefs =
            FuzzyPrefs::preset(preset).ok_or_else(|| format!("unknown fuzzy preset: {preset}"))?;
        let state = self.apply_prefs(window, |core| {
            core.set_prefs(prefs);
        });
        self.persist();
        Ok(state)
    }

    /// Change the process-wide preferences and abandon every window's buffer.
    fn apply_prefs(&self, window: &str, change: impl FnOnce(&PinyinCore)) -> ImeStateOut {
        let mut inner = self.lock();
        let core = Arc::clone(&inner.core);
        change(&core);
        // The engine was swapped, so a buffer ranked under the old rules must not
        // survive (the rule the single-window engine always had — now applied to
        // every window at once, because the setting is device-wide). The "just
        // committed" hint is left alone: it is still a true statement about what
        // was committed.
        let mut abandoned = 0usize;
        for session in inner.windows.values_mut() {
            if session.input.is_composing() {
                abandoned += 1;
            }
            session.input.clear();
        }
        if abandoned > 0 {
            tracing::info!(
                target: "amos::ime",
                windows = abandoned,
                "fuzzy preferences changed — in-flight compositions abandoned"
            );
        }
        // Read the counter **after** the `values_mut` borrow ends (the loop has
        // already drained into `abandoned`) and **before** `inner.session(window)`
        // opens the next mutable borrow. NLL keeps these serial.
        let persist_failures = inner.persist_failures.load(Ordering::Relaxed);
        let session = inner.session(window);
        state_of(persist_failures, session, &core)
    }

    /// Forget **everything** the learner knows (all pins and counters) and flush.
    /// The learner is process-wide, so one call clears it for every window.
    pub fn clear_learning(&self, window: &str) -> ImeStateOut {
        let state = {
            let mut inner = self.lock();
            let core = Arc::clone(&inner.core);
            // `import_l0` replaces the whole L0 layer, so an empty snapshot is the
            // engine's own "forget all" — no per-code loop that could miss one.
            core.import_l0(&L0Data::default());
            let persist_failures = inner.persist_failures.load(Ordering::Relaxed);
            let session = inner.session(window);
            state_of(persist_failures, session, &core)
        };
        self.persist();
        state
    }

    /// How many windows currently hold a buffer (bounded by [`MAX_IME_SESSIONS`]).
    #[cfg(test)]
    fn open_window_count(&self) -> usize {
        self.lock().windows.len()
    }

    fn lock(&self) -> MutexGuard<'_, ImeInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Flush the profile atomically (temp file + rename). Best-effort: a failure is
    /// logged, never reported as a failed keystroke/commit. The **cumulative**
    /// failure count, however, is surfaced on [`ImeStateOut`] (REQ-A2091 /
    /// F-IME-032) so the operator can see the learner is in-memory only — a
    /// silent loss of the user's pinned words would be exactly the honesty
    /// boundary P0-3 forbids.
    ///
    /// The counter is incremented on **any** of the four stages a profile write
    /// can fail at: serialization, parent-dir creation, temp-file write, or
    /// rename. The `create_dir_all` failure does not return early — the write
    /// below will fail with the same cause and that one *is* counted — so the
    /// two calls are kept distinct on the trace side (different warning
    /// sentences) and merged on the counter side (one operator-visible failure,
    /// not two, when the cause is the same).
    fn persist(&self) {
        let (path, profile) = {
            let inner = self.lock();
            let Some(path) = inner.path.clone() else {
                return; // no file configured (tests / host before setup)
            };
            let profile = ImeProfile::new(inner.core.prefs(), inner.core.export_l0());
            (path, profile)
        };
        let payload = match profile.to_json() {
            Ok(payload) => payload,
            Err(e) => {
                tracing::warn!(target: "amos::ime", error = %e, "IME profile serialize failed");
                self.bump_persist_failures();
                return;
            }
        };
        if let Some(dir) = path.parent() {
            // A directory we cannot create is worth saying out loud: the write below
            // will fail too, and the operator should see *why*.
            if let Err(e) = std::fs::create_dir_all(dir) {
                tracing::warn!(
                    target: "amos::ime",
                    dir = %dir.display(),
                    error = %e,
                    "IME profile directory could not be created"
                );
            }
        }
        let tmp = staging_path(&path);
        if let Err(e) = std::fs::write(&tmp, payload.as_bytes()) {
            tracing::warn!(target: "amos::ime", error = %e, "IME profile write failed");
            remove_staging(&tmp);
            self.bump_persist_failures();
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, &path) {
            tracing::warn!(target: "amos::ime", error = %e, "IME profile rename failed");
            remove_staging(&tmp);
            self.bump_persist_failures();
        }
    }

    /// Increment the cumulative persist-failure counter by one.
    ///
    /// `Ordering::Relaxed` is the right ordering: the counter is an observability
    /// field (the next `state_of` reads the latest value), and `persist()` is the
    /// only mutator. Nothing else in the bridge synchronises against this
    /// counter, so a stronger ordering would pay for no correctness.
    ///
    /// `pub(crate)` so the unit tests can drive the counter without staging a
    /// real `amos-ime.json` write failure (a `#[cfg(test)]` accessor would do
    /// the same, but the wire shape — that the counter is the one the user
    /// sees — is the same one this exposes).
    pub(crate) fn bump_persist_failures(&self) {
        let inner = self.lock();
        inner.persist_failures.fetch_add(1, Ordering::Relaxed);
    }

    /// The cumulative count of profile-flush failures since boot. `0` when every
    /// persist since boot landed; the operator-visible truth is "the in-memory
    /// learner has been written N times less than it should have been".
    pub fn persist_failures(&self) -> u64 {
        self.lock().persist_failures.load(Ordering::Relaxed)
    }
}

impl Default for ImeBridge {
    fn default() -> Self {
        Self::boot()
    }
}

/* ---- Tauri commands (the System UI's on-screen keyboard) -------------------- */

/// The current state of the calling window's composition (the keyboard pulls this
/// when it mounts).
///
/// `window` is injected by the host from the caller's `WebviewWindow` — the JS side
/// never sends it (`clipboard.rs` precedent, REQ-A258).
#[tauri::command]
pub fn ime_status(
    window: tauri::WebviewWindow,
    bridge: tauri::State<'_, ImeBridge>,
) -> Result<ImeStateOut, String> {
    Ok(bridge.snapshot(window.label()))
}

/// Feed a tap's characters from the keyboard into the calling window's buffer
/// (only ASCII letters compose).
#[tauri::command]
pub fn ime_key(
    window: tauri::WebviewWindow,
    ch: String,
    bridge: tauri::State<'_, ImeBridge>,
) -> Result<ImeStateOut, String> {
    // `ch` is a string from the JS side — paste / a buggy keyboard could hand us
    // arbitrarily long input, so cap it before it reaches the buffer (the
    // engine itself only accepts ASCII letters, but iterating a 4 MiB string
    // would still be wasted work and a denial-of-service vector).
    if ch.len() > MAX_KEY_CHARS {
        return Err(format!(
            "ime_key payload too long: {} chars (max {MAX_KEY_CHARS})",
            ch.len()
        ));
    }
    Ok(bridge.key(window.label(), &ch))
}

/// Delete the last buffered pinyin letter in the calling window.
#[tauri::command]
pub fn ime_backspace(
    window: tauri::WebviewWindow,
    bridge: tauri::State<'_, ImeBridge>,
) -> Result<ImeStateOut, String> {
    Ok(bridge.backspace(window.label()))
}

/// Abandon the calling window's composition (Esc / hide keyboard).
#[tauri::command]
pub fn ime_clear(
    window: tauri::WebviewWindow,
    bridge: tauri::State<'_, ImeBridge>,
) -> Result<ImeStateOut, String> {
    Ok(bridge.clear(window.label()))
}

/// Commit candidate `index` in the calling window and return the inserted text +
/// the new state.
#[tauri::command]
pub fn ime_commit(
    window: tauri::WebviewWindow,
    index: usize,
    bridge: tauri::State<'_, ImeBridge>,
) -> Result<ImeCommitOut, String> {
    Ok(bridge.commit(window.label(), index))
}

/// Toggle one fuzzy pair (`"z_zh"`, `"n_l"`, …). Device-wide: every window's
/// in-flight composition is abandoned (the ranking rules changed).
#[tauri::command]
pub fn ime_fuzzy_toggle(
    window: tauri::WebviewWindow,
    pair: String,
    bridge: tauri::State<'_, ImeBridge>,
) -> Result<ImeStateOut, String> {
    if pair.len() > MAX_IME_NAME_BYTES {
        return Err(format!(
            "ime_fuzzy_toggle pair too long: {} bytes (max {MAX_IME_NAME_BYTES})",
            pair.len()
        ));
    }
    bridge.fuzzy_toggle(window.label(), &pair)
}

/// Apply a fuzzy preset (`"strict"` / `"permissive"`). Same scope rule as
/// `ime_fuzzy_toggle`.
#[tauri::command]
pub fn ime_fuzzy_preset(
    window: tauri::WebviewWindow,
    preset: String,
    bridge: tauri::State<'_, ImeBridge>,
) -> Result<ImeStateOut, String> {
    if preset.len() > MAX_IME_NAME_BYTES {
        return Err(format!(
            "ime_fuzzy_preset name too long: {} bytes (max {MAX_IME_NAME_BYTES})",
            preset.len()
        ));
    }
    bridge.fuzzy_preset(window.label(), &preset)
}

/// Forget everything the learner has learned (all pins + counters). The learner is
/// shared by every window, so this is a device-wide reset.
#[tauri::command]
pub fn ime_learning_clear(
    window: tauri::WebviewWindow,
    bridge: tauri::State<'_, ImeBridge>,
) -> Result<ImeStateOut, String> {
    Ok(bridge.clear_learning(window.label()))
}

/// Undo the word the **calling window** just committed (drop its learned pin) and
/// clear its commit hint. The keyboard only offers this while a dictionary pick is
/// the last commit, so a sentence composition never lands here.
#[tauri::command]
pub fn ime_forget_last(
    window: tauri::WebviewWindow,
    bridge: tauri::State<'_, ImeBridge>,
) -> Result<ImeStateOut, String> {
    Ok(bridge.forget_last(window.label()))
}

/* ---- The Android system IME's in-app entry point ---------------------------- */

/// The Kotlin glue object that answers the platform's input-method state.
///
/// **Dotted**, because it is handed to `glue_class` → `ClassLoader#loadClass`, which
/// takes a binary name — the slashed JNI form `find_class` wants would not load (the
/// `BLE_CLASS` convention; REQ-A1866 / F-AND-017 is the round that paid for it).
#[cfg(feature = "android")]
pub(crate) const SYSTEM_IME_GLUE_CLASS: &str = "com.amos.ai.glue.ImeSettingsGlue";

/// What the **platform** says about AmOS's own input method.
///
/// The fields are `Option` on purpose. `enabled` / `selected` are answers the platform
/// may never have given, and `false` is itself a platform **statement** ("this keyboard
/// is not enabled" / "another keyboard is in force"). Folding "we could not ask" into
/// `false` would put that sentence in the platform's mouth — the family `nfc_status`
/// paid for, where five distinct failures all reached the screen as "this device has no
/// NFC hardware" (REQ-A775 / F-AND-007).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SystemImeStatus {
    /// Can this build ask the platform at all — an Android build with a bound `Context`
    /// and the glue class on the app's loader?
    pub available: bool,
    /// Why not, in the host's own words (`""` when `available`). Invariant:
    /// `available == reason.is_empty()`, the same one `RecordingCaptureStatus` keeps.
    pub reason: String,
    /// Is AmOS's keyboard in the platform's **enabled** list? `None` = not asked.
    pub enabled: Option<bool>,
    /// Is AmOS's keyboard the platform's **current** one? `None` = not asked.
    pub selected: Option<bool>,
    /// The platform's current keyboard id — what `selected` was compared against.
    /// `None` = not asked; `Some("")` is the platform reporting *no* keyboard selected.
    pub current_id: Option<String>,
}

/// The four records `ImeSettings.ok(…)` writes, as this side reads them.
///
/// Every field is a **measurement**: the struct cannot be built unless all three fact
/// records were present, which is what makes the `Option`s on [`SystemImeStatus`]
/// honest — their absence means the Kotlin half wrote `unavailable`, not that a parser
/// defaulted them.
#[derive(Debug, PartialEq)]
pub(crate) struct PlatformImeFacts {
    pub current_id: String,
    pub ours_enabled: bool,
    pub ours_selected: bool,
}

/// Read the line/tab wire `ImeSettings` writes (`ImeSettingsTest.kt` pins those exact
/// bytes; this is the other end of the same contract).
///
/// A record is `<name>\t<value>` up to the next newline; the value is everything after
/// the first tab. Unknown records are ignored so a future Kotlin field is additive, but
/// the three facts are **required** on `ok` — a missing one is an error, never a
/// default (see [`PlatformImeFacts`]).
pub(crate) fn parse_platform_ime_facts(wire: &str) -> Result<PlatformImeFacts, String> {
    let mut state = None;
    let mut current = None;
    let mut enabled = None;
    let mut selected = None;
    let mut why = None;
    for line in wire.lines() {
        let Some((name, value)) = line.split_once('\t') else {
            continue;
        };
        match name {
            "state" => state = Some(value),
            "current" => current = Some(value),
            "ours_enabled" => enabled = Some(value),
            "ours_selected" => selected = Some(value),
            "why" => why = Some(value),
            _ => {}
        }
    }
    match state {
        Some("ok") => {
            let (Some(current), Some(enabled), Some(selected)) = (current, enabled, selected)
            else {
                return Err(
                    "the platform's answer was missing a current/enabled/selected record"
                        .to_string(),
                );
            };
            Ok(PlatformImeFacts {
                current_id: current.to_string(),
                ours_enabled: parse_flag(enabled, "ours_enabled")?,
                ours_selected: parse_flag(selected, "ours_selected")?,
            })
        }
        Some("unavailable") => Err(format!(
            "Android could not be asked: {}",
            why.unwrap_or("no reason given")
        )),
        Some(other) => Err(format!("the platform answer's state was {other:?}")),
        None => Err("the platform's answer had no state record".to_string()),
    }
}

/// A `0`/`1` flag. Anything else is an error rather than a `false`: an unreadable field
/// is not a measurement of "no".
fn parse_flag(value: &str, name: &str) -> Result<bool, String> {
    match value {
        "1" => Ok(true),
        "0" => Ok(false),
        other => Err(format!("the {name} record was {other:?}, not 0 or 1")),
    }
}

/// The one place a platform answer — or this build's inability to ask — becomes the
/// struct the UI reads. Pure, so every shape is pinned by a unit test rather than only
/// by a device.
pub(crate) fn system_ime_status_from(reply: Result<String, String>) -> SystemImeStatus {
    match reply.and_then(|wire| parse_platform_ime_facts(&wire)) {
        Ok(facts) => SystemImeStatus {
            available: true,
            reason: String::new(),
            enabled: Some(facts.ours_enabled),
            selected: Some(facts.ours_selected),
            current_id: Some(facts.current_id),
        },
        Err(reason) => SystemImeStatus {
            available: false,
            reason,
            enabled: None,
            selected: None,
            current_id: None,
        },
    }
}

/// The platform's answer to "launch this surface".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImeOpenOutcome {
    /// The platform took the request.
    Opened,
    /// No `InputMethodManager` on the `Context` (never seen on a device).
    Unavailable,
    /// The platform refused, or the call threw.
    Denied,
    /// Nothing in this window is accepting text, so the platform's picker had no IME window to
    /// hang its switcher on and drew nothing (measured; see the glue's `STATUS_NO_EDITOR`).
    /// This is a **refusal to report success**, not a failure of the platform.
    NoEditor,
    /// A word the glue does not emit — a contract drift between the two halves.
    Unknown,
}

/// Map one `ImeSettingsGlue.STATUS_*` word to an outcome.
///
/// The one place the glue's spellings live on this side, so a rename on either side is a
/// failing unit test rather than a user who presses the button and sees nothing — the
/// `RotationGlue` precedent (`rotation_outcome_from_status`, F-TAU-021).
pub(crate) fn ime_open_outcome_from_status(status: &str) -> ImeOpenOutcome {
    match status {
        "ok" => ImeOpenOutcome::Opened,
        "unavailable" => ImeOpenOutcome::Unavailable,
        "denied" => ImeOpenOutcome::Denied,
        "no_editor" => ImeOpenOutcome::NoEditor,
        _ => ImeOpenOutcome::Unknown,
    }
}

/// The platform's answer about the input method, or this build's honest inability.
#[cfg(feature = "android")]
pub(crate) fn ask_the_platform_for_system_ime() -> Result<String, String> {
    call_system_ime_glue("status")
}

/// Ask the platform to **show its keyboard switcher**.
#[cfg(feature = "android")]
pub(crate) fn ask_the_platform_to_show_ime_picker() -> Result<String, String> {
    call_system_ime_glue("openPicker")
}

/// Ask the platform to open its **input-method settings** screen.
#[cfg(feature = "android")]
pub(crate) fn ask_the_platform_for_ime_settings() -> Result<String, String> {
    call_system_ime_glue("openSettings")
}

/// Call one `(Context) -> String` static on [`SYSTEM_IME_GLUE_CLASS`].
///
/// The class is resolved through the bound `Context`'s loader rather than *named* at the
/// call site: `call_static_method(&str, …)` is a `find_class` one step removed, and a
/// tokio worker's loader cannot see `com.amos.ai.glue.*` (REQ-A1866 / F-AND-017;
/// `jni-exception-scan.mjs` rule 3 fails the build for it). Resolving is correct from
/// any thread, so this stays right if these commands ever become `async`.
#[cfg(feature = "android")]
fn call_system_ime_glue(member: &str) -> Result<String, String> {
    crate::ble::android_jni::with_context_result(|ctx, env| {
        let class = crate::ble::android_jni::glue_class(env, ctx, SYSTEM_IME_GLUE_CLASS)?;
        let class: &::jni::objects::JClass<'_> = class.as_obj().into();
        let sig = "(Landroid/content/Context;)Ljava/lang/String;";
        let args = [::jni::objects::JValue::Object(ctx.as_ref())];
        let value = amos_jni::jni_call!(env, env.call_static_method(class, member, sig, &args))
            .map_err(|e| e.to_string())?;
        // The owned object is bound to a local rather than chained: `get_string` borrows
        // through the `JString` view it is converted into, so a temporary would be freed
        // at the end of that statement (E0716).
        let object = match value {
            ::jni::objects::JValueOwned::Object(object) => object,
            _ => return Err(format!("{member} answered with a non-object")),
        };
        if object.is_null() {
            return Err(format!("{member} answered null"));
        }
        let text = env
            .get_string((&object).into())
            .map_err(|e| e.to_string())?;
        Ok(String::from(text))
    })
}

#[cfg(not(feature = "android"))]
pub(crate) fn ask_the_platform_for_system_ime() -> Result<String, String> {
    Err(host_without_ime_glue())
}
#[cfg(not(feature = "android"))]
pub(crate) fn ask_the_platform_to_show_ime_picker() -> Result<String, String> {
    Err(host_without_ime_glue())
}

#[cfg(not(feature = "android"))]
pub(crate) fn ask_the_platform_for_ime_settings() -> Result<String, String> {
    Err(host_without_ime_glue())
}

// REQ-A2090 / F-IME-031: host builds (macOS / Linux desktop) have no Android
// glue to ask; we **always** answer with the explicit reason string instead of
// panic'ing or folding to an empty `reason`.

#[cfg(not(feature = "android"))]
fn host_without_ime_glue() -> String {
    "this build has no Android input-method glue (host/desktop target)".to_string()
}

/// Tauri command: what does the **platform** say about AmOS's own keyboard?
///
/// Returns the value directly rather than a `Result`, mirroring
/// `screen_record_capability`: "this build cannot ask" is a **fact** the UI renders,
/// not a failed read, and an `Err` would be indistinguishable from the command being
/// missing. The failure's own sentence rides in [`SystemImeStatus::reason`].
#[tauri::command]
pub fn ime_system_status() -> SystemImeStatus {
    system_ime_status_from(ask_the_platform_for_system_ime())
}

/// Tauri command: show the platform's keyboard switcher.
#[tauri::command]
pub fn ime_system_open_picker() -> Result<(), AmosError> {
    let status = ask_the_platform_to_show_ime_picker().map_err(glue_unavailable)?;
    check_ime_open(ime_open_outcome_from_status(&status))
}

/// Tauri command: open the platform's input-method settings — the screen where AmOS
/// 拼音 is **enabled**, which is the door a user who has never enabled it cannot reach
/// from the picker (that one lists enabled keyboards only).
#[tauri::command]
pub fn ime_system_open_settings() -> Result<(), AmosError> {
    let status = ask_the_platform_for_ime_settings().map_err(glue_unavailable)?;
    check_ime_open(ime_open_outcome_from_status(&status))
}

/// The one failure the two launchers can hit *before* the platform is reached: no bound
/// `Context`, or the glue class is not on the app's loader. Both mean "this build cannot
/// ask", which is [`ErrorCode::ImeSystemGlueUnavailable`] — the same word
/// `ime_system_status` carries as a *fact* rather than an `Err`.
fn glue_unavailable(reason: String) -> AmosError {
    AmosError::new(ErrorCode::ImeSystemGlueUnavailable, reason)
}

/// Turn a glue outcome into the command's answer. `Opened` is the only success: a word
/// the glue never emits is a contract drift, and reporting it as "opened" would tell the
/// user a screen came up that did not.
pub(crate) fn check_ime_open(outcome: ImeOpenOutcome) -> Result<(), AmosError> {
    match outcome {
        ImeOpenOutcome::Opened => Ok(()),
        // The glue's own word for "this Context has no `InputMethodManager`". Asking the
        // platform a *different* question here (e.g. `status`) would be a second JNI call
        // about something else and would report its reason for the wrong failure.
        ImeOpenOutcome::Unavailable => Err(AmosError::new(
            ErrorCode::ImeSystemGlueUnavailable,
            "this build has no Android input-method glue (host/desktop target)",
        )),
        ImeOpenOutcome::Denied => Err(AmosError::new(
            ErrorCode::ImeSystemOpenFailed,
            "the platform refused to open the input-method surface",
        )),
        // Its own code, not `ImeSystemOpenFailed`: the user's next step is different — put the
        // caret in a text field (or use the settings door, which needs no input connection) —
        // and "could not open the screen" would send them to retry something that cannot work.
        ImeOpenOutcome::NoEditor => Err(AmosError::new(
            ErrorCode::ImeSystemNoTextEditor,
            "nothing in this window is accepting text, so the platform had no keyboard window to \
             draw its switcher over",
        )),
        ImeOpenOutcome::Unknown => Err(AmosError::new(
            ErrorCode::ImeSystemOpenFailed,
            "the input-method glue answered a status word this build does not know",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window every single-window test types in — the label Android's System UI
    /// window carries (one WebView, one buffer).
    const MAIN: &str = "main";

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("amos-ime-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// An undo belongs to the window that committed: forgetting in A must not clear
    /// B's hint, and each window's undo remembers **its own** code.
    #[test]
    fn the_undo_hint_is_per_window() {
        let b = ImeBridge::boot();
        b.key("notes", "zhongguo");
        assert_eq!(
            b.commit("notes", 0).state.last_pick_code.as_deref(),
            Some("zhongguo")
        );
        b.key("files", "wo");
        assert_eq!(
            b.commit("files", 0).state.last_pick_code.as_deref(),
            Some("wo")
        );

        let s = b.forget_last("files");
        assert_eq!(s.last_pick_code, None);
        assert_eq!(
            b.snapshot("notes").last_pick_code.as_deref(),
            Some("zhongguo"),
            "A's undo must survive B forgetting"
        );
    }

    /// A fuzzy preference is a **device** setting: it applies to every window at
    /// once, and every in-flight buffer is abandoned because the ranking rules
    /// changed under it.
    #[test]
    fn a_fuzzy_change_applies_to_every_window_and_abandons_their_buffers() {
        let b = ImeBridge::boot();
        b.key("notes", "zong");
        b.key("files", "ni");
        assert!(b.snapshot("notes").strict);

        let s = b.fuzzy_toggle("notes", "z_zh").expect("known pair");
        assert!(!s.strict, "the calling window sees the new preference");
        assert!(
            !b.snapshot("files").strict,
            "the preference is device-wide, not per window"
        );
        assert_eq!(b.snapshot("notes").input, "", "A's buffer is abandoned");
        assert_eq!(b.snapshot("files").input, "", "B's buffer is abandoned");
        assert_eq!(b.snapshot("notes").candidates.len(), 0);
        assert_eq!(b.snapshot("files").candidates.len(), 0);

        // The new ranking is in force for both windows.
        b.key("files", "zong");
        assert!(b
            .snapshot("files")
            .candidates
            .iter()
            .any(|c| c.text == "中"));
    }

    /// The session map is **bounded**: an app window's label is never reused after
    /// its window closes, so a long-running desktop must not keep one buffer per
    /// window forever.
    #[test]
    fn the_window_map_is_bounded_and_prunes_what_holds_nothing() {
        let b = ImeBridge::boot();
        // A map at the cap may still grow — but never past it: the windows that
        // hold nothing a user could miss are dropped first.
        for i in 0..MAX_IME_SESSIONS {
            b.snapshot(&format!("idle-{i}"));
        }
        assert_eq!(b.open_window_count(), MAX_IME_SESSIONS);
        b.snapshot("idle-extra");
        assert!(
            b.open_window_count() <= MAX_IME_SESSIONS,
            "the map grew past the cap: {}",
            b.open_window_count()
        );

        // …and a window that is mid-composition is never the one dropped while
        // idle ones are sitting there.
        let survivor = "notes";
        b.key(survivor, "zhongguo");
        for i in 0..MAX_IME_SESSIONS {
            b.snapshot(&format!("later-{i}"));
        }
        assert_eq!(
            b.snapshot(survivor).input,
            "zhongguo",
            "a composing window was evicted while idle ones were droppable"
        );
        assert!(b.open_window_count() <= MAX_IME_SESSIONS);
    }

    /// One window's pinyin buffer is **bounded** — a paste / a runaway keyboard
    /// loop cannot push it past the cap, and letters beyond it are silently
    /// dropped (so the buffer's state is preserved, the new chars are not).
    #[test]
    fn the_input_buffer_is_bounded_and_extra_letters_are_dropped() {
        let b = ImeBridge::boot();
        // Fill the buffer to the cap with one big call.
        let big = "z".repeat(MAX_INPUT_CHARS + 50);
        let s = b.key(MAIN, &big);
        assert_eq!(
            s.input.len(),
            MAX_INPUT_CHARS,
            "the buffer was not capped at MAX_INPUT_CHARS"
        );

        // Further letters stay dropped.
        let s = b.key(MAIN, "abc");
        assert_eq!(s.input.len(), MAX_INPUT_CHARS);
        // …and an ASCII tap **beyond** the cap on a new call also stays a no-op:
        // a stuck keyboard that hammers ime_key would otherwise grow this map
        // to an unbounded size.
        let s = b.key(MAIN, "xyz");
        assert_eq!(s.input.len(), MAX_INPUT_CHARS);

        // `backspace` releases room and accepts letters again.
        let s = b.backspace(MAIN);
        assert_eq!(s.input.len(), MAX_INPUT_CHARS - 1);
        let s = b.key(MAIN, "q");
        assert_eq!(s.input.len(), MAX_INPUT_CHARS);
    }

    /// The constants defend the documented shapes — E.164 + pinyin lengths +
    /// the cap is comfortably above any single human keystroke, and the
    /// per-tap limit fits in the buffer's per-window limit (so a single key
    /// cannot exceed it in one go).
    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn the_key_and_input_constants_make_sense() {
        assert!(
            MAX_KEY_CHARS >= 1,
            "MAX_KEY_CHARS must allow at least one char"
        );
        assert!(
            MAX_INPUT_CHARS >= MAX_KEY_CHARS,
            "MAX_INPUT_CHARS must accept a full MAX_KEY_CHARS tap"
        );
        assert!(
            MAX_INPUT_CHARS >= 32,
            "MAX_INPUT_CHARS must cover a real pinyin sentence"
        );
    }

    /// Two windows answer from **one** profile: what one window learns is on disk
    /// once, and a restart sees it from either window.
    #[test]
    fn two_windows_share_one_profile() {
        let dir = temp_dir("profiles");
        let path = file_in(&dir);

        let b = ImeBridge::boot();
        b.configure(path.clone());
        learn_window(&b, "notes", "shi", "时");
        b.key("files", "wo"); // a second window with a buffer of its own

        let restarted = ImeBridge::boot();
        restarted.configure(path.clone());
        assert_eq!(restarted.snapshot("files").learned_pins, 1);
        restarted.key("files", "shi");
        assert_eq!(restarted.snapshot("files").candidates[0].text, "时");
        assert_eq!(
            restarted.snapshot("files").input,
            "shi",
            "a fresh boot has no in-flight buffer from the last run"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Pick `word` for `code` three times — the engine's promotion threshold — so
    /// the L0 learner pins it through the bridge.
    fn learn(bridge: &ImeBridge, code: &str, word: &str) {
        learn_window(bridge, MAIN, code, word);
    }

    /// The same three picks, in a named window (the multi-window tests).
    fn learn_window(bridge: &ImeBridge, window: &str, code: &str, word: &str) {
        for _ in 0..3 {
            bridge.clear(window);
            let state = bridge.key(window, code);
            let idx = state
                .candidates
                .iter()
                .position(|c| c.text == word)
                .unwrap_or_else(|| panic!("{word} is not a candidate for {code}"));
            assert_eq!(bridge.commit(window, idx).committed.as_deref(), Some(word));
        }
    }

    #[test]
    fn boot_state_is_honest_about_an_empty_session() {
        let b = ImeBridge::boot();
        let s = b.snapshot(MAIN);
        assert_eq!(s.input, "");
        assert!(s.candidates.is_empty());
        assert!(!s.composing);
        assert!(s.strict, "defaults are strict pinyin");
        assert_eq!(s.fuzzy, FuzzyPrefs::strict());
        assert!(s.dict_entries > 100_000, "{}", s.dict_entries);
        assert_eq!((s.learned_pins, s.learned_pending), (0, 0));
        assert_eq!(s.last_committed, None);
        assert_eq!(s.last_pick_code, None, "nothing committed yet");
    }

    #[test]
    fn typing_composes_and_backspace_edits() {
        let b = ImeBridge::boot();
        let s = b.key(MAIN, "zhongguo");
        assert!(s.composing);
        assert_eq!(s.input, "zhongguo");
        assert_eq!(s.candidates.first().map(|c| c.text.as_str()), Some("中国"));
        assert_eq!(s.candidates[0].kind, "dict");

        let s = b.backspace(MAIN);
        assert_eq!(s.input, "zhonggu");
        let s = b.clear(MAIN);
        assert_eq!(s.input, "");
        assert!(s.candidates.is_empty());
    }

    #[test]
    fn non_letters_do_not_compose() {
        let b = ImeBridge::boot();
        let s = b.key(MAIN, "12,中");
        assert_eq!(s.input, "");
        assert!(!s.composing);
        assert_eq!(b.key(MAIN, "Z").input, "z");
    }

    #[test]
    fn commit_returns_the_word_and_resets_the_session() {
        let b = ImeBridge::boot();
        b.key(MAIN, "zhongguo");
        let out = b.commit(MAIN, 0);
        assert_eq!(out.committed.as_deref(), Some("中国"));
        assert_eq!(out.state.input, "");
        assert!(out.state.candidates.is_empty());
        assert_eq!(out.state.last_committed.as_deref(), Some("中国"));
    }

    #[test]
    fn an_out_of_range_commit_changes_nothing() {
        let b = ImeBridge::boot();
        b.key(MAIN, "wo");
        let out = b.commit(MAIN, 9_999);
        assert_eq!(out.committed, None);
        assert_eq!(out.state.input, "wo");
    }

    #[test]
    fn a_long_buffer_commits_a_sentence_composition() {
        let b = ImeBridge::boot();
        let s = b.key(MAIN, "zhongguorenmin");
        assert_eq!(s.candidates[0].text, "中国人民");
        assert_eq!(s.candidates[0].kind, "sentence");
        let out = b.commit(MAIN, 0);
        assert_eq!(out.committed.as_deref(), Some("中国人民"));
        // A composed sentence is not a dictionary word: the learner stays empty.
        assert_eq!(out.state.learned_pins, 0);
    }

    #[test]
    fn fuzzy_toggle_is_addressed_by_stable_key_and_rejects_junk() {
        let b = ImeBridge::boot();
        let s = b.fuzzy_toggle(MAIN, "z_zh").expect("known pair");
        assert!(s.fuzzy.z_zh);
        assert!(!s.strict);
        // `zong` now reaches 中 through z↔zh.
        let s = b.key(MAIN, "zong");
        assert!(s.candidates.iter().any(|c| c.text == "中"));

        let err = b.fuzzy_toggle(MAIN, "q_q").expect_err("unknown pair");
        assert!(err.contains("unknown fuzzy pair"), "{err}");
    }

    #[test]
    fn fuzzy_preset_applies_by_name_and_rejects_junk() {
        let b = ImeBridge::boot();
        assert!(!b.fuzzy_preset(MAIN, "permissive").expect("preset").strict);
        assert!(b.fuzzy_preset(MAIN, "strict").expect("preset").strict);
        let err = b.fuzzy_preset(MAIN, "loose").expect_err("unknown preset");
        assert!(err.contains("unknown fuzzy preset"), "{err}");
    }

    /// **The G1 defect** (REQ-A258): the desktop shell opens one window per app, so
    /// two windows used to compose into one buffer — A's candidate bar showed B's
    /// typing and B's commit ate A's code.
    #[test]
    fn two_windows_do_not_share_a_composition_buffer() {
        let b = ImeBridge::boot();
        let (a, c) = ("notes", "files");

        b.key(a, "zhongguo");
        b.key(c, "wo");

        let sa = b.snapshot(a);
        let sc = b.snapshot(c);
        assert_eq!(sa.input, "zhongguo", "B's typing must not appear in A");
        assert_eq!(sc.input, "wo");
        assert_eq!(sa.candidates.first().map(|x| x.text.as_str()), Some("中国"));
        assert_eq!(sc.candidates.first().map(|x| x.text.as_str()), Some("我"));

        // A commit in B leaves A's composition (and its undo hint) untouched.
        assert_eq!(b.commit(c, 0).committed.as_deref(), Some("我"));
        let sa = b.snapshot(a);
        assert_eq!(sa.input, "zhongguo", "B's commit ate A's code");
        assert_eq!(sa.candidates.first().map(|x| x.text.as_str()), Some("中国"));
        assert_eq!(sa.last_committed, None, "A never committed anything");
        assert_eq!(sa.last_pick_code, None);

        // …and backspacing in A does not touch B.
        b.backspace(a);
        assert_eq!(b.snapshot(a).input, "zhonggu");
        assert_eq!(b.snapshot(c).input, "", "B already committed");
        assert_eq!(b.snapshot(c).last_committed.as_deref(), Some("我"));
    }

    /// The other half of the split: the **learner is process-wide**, so a word
    /// window A taught the IME ranks first in window B.
    #[test]
    fn a_word_learned_in_one_window_is_known_to_the_other() {
        let b = ImeBridge::boot();
        learn_window(&b, "notes", "shi", "时");
        assert_eq!(b.snapshot("notes").learned_pins, 1);
        assert_eq!(
            b.snapshot("files").learned_pins,
            1,
            "one learner, one process"
        );

        b.key("files", "shi");
        assert_eq!(
            b.snapshot("files").candidates[0].text,
            "时",
            "the word was learned in the other window"
        );
    }

    // ---- 联想 / next-word suggestions (REQ-A260) -----------------------------

    /// The suggestion list is the candidate list once the buffer is empty — and it
    /// needs two committed words of context (我们 + 的 → 国家/生活/工作/社会).
    #[test]
    fn an_empty_buffer_offers_suggestions_for_what_this_window_committed() {
        let b = ImeBridge::boot();
        // Cold start and one word are not context.
        assert!(b.snapshot(MAIN).candidates.is_empty());
        b.key(MAIN, "women");
        b.commit(MAIN, 0);
        assert!(
            b.snapshot(MAIN).candidates.is_empty(),
            "one word is not context"
        );

        b.key(MAIN, "de");
        b.commit(MAIN, 0);
        let s = b.snapshot(MAIN);
        assert_eq!(s.input, "");
        assert!(!s.composing);
        assert_eq!(
            s.candidates
                .iter()
                .map(|c| (c.text.as_str(), c.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("国家", PREDICT_KIND),
                ("生活", PREDICT_KIND),
                ("工作", PREDICT_KIND),
                ("社会", PREDICT_KIND),
            ]
        );

        // A new composition takes the list back over (one index space, one meaning).
        b.key(MAIN, "zhong");
        let s = b.snapshot(MAIN);
        assert!(s.composing);
        assert!(s.candidates.iter().all(|c| c.kind != PREDICT_KIND));
    }

    /// Picking a suggestion inserts it, continues the chain, and teaches the learner
    /// nothing (so there is no "forget this word" to offer either).
    #[test]
    fn picking_a_suggestion_inserts_it_and_teaches_nothing() {
        let b = ImeBridge::boot();
        b.key(MAIN, "women");
        b.commit(MAIN, 0);
        b.key(MAIN, "de");
        b.commit(MAIN, 0);
        let before = b.snapshot(MAIN);
        assert_eq!(before.candidates[0].text, "国家");

        let out = b.commit(MAIN, 0);
        assert_eq!(out.committed.as_deref(), Some("国家"));
        assert_eq!(out.state.last_committed.as_deref(), Some("国家"));
        assert_eq!(out.state.last_pick_code, None, "nothing was learned");
        assert_eq!(out.state.learned_pins, 0);
        assert_eq!(
            out.state.candidates.first().map(|c| c.kind.as_str()),
            Some(PREDICT_KIND),
            "the new context produces the next list"
        );
        assert_ne!(
            out.state
                .candidates
                .iter()
                .map(|c| c.text.as_str())
                .collect::<Vec<_>>(),
            before
                .candidates
                .iter()
                .map(|c| c.text.as_str())
                .collect::<Vec<_>>()
        );

        // An out-of-range pick is a no-op, not a panic and not a claim.
        let out = b.commit(MAIN, 9_999);
        assert_eq!(out.committed, None);
        assert_eq!(out.state.last_committed.as_deref(), Some("国家"));
    }

    /// Suggestions are per window (same rule as the buffer): A's two commits are not
    /// B's context.
    #[test]
    fn suggestions_are_per_window() {
        let b = ImeBridge::boot();
        b.key("notes", "women");
        b.commit("notes", 0);
        b.key("notes", "de");
        b.commit("notes", 0);
        assert!(!b.snapshot("notes").candidates.is_empty());

        b.key("files", "women");
        b.commit("files", 0);
        assert!(
            b.snapshot("files").candidates.is_empty(),
            "one word of context in B, two in A"
        );
    }

    #[test]
    fn learning_pins_a_word_and_clearing_forgets_it() {
        let b = ImeBridge::boot();
        learn(&b, "shi", "时");
        let s = b.snapshot(MAIN);
        assert_eq!(s.learned_pins, 1);
        assert_eq!(s.learned_pending, 0);

        let s = b.clear_learning(MAIN);
        assert_eq!(s.learned_pins, 0);
        assert_eq!(s.learned_pending, 0);
    }

    #[test]
    fn a_dictionary_commit_is_undoable() {
        let b = ImeBridge::boot();
        b.key(MAIN, "zhongguo");
        let out = b.commit(MAIN, 0);
        assert_eq!(out.committed.as_deref(), Some("中国"));
        assert_eq!(out.state.last_committed.as_deref(), Some("中国"));
        assert_eq!(
            out.state.last_pick_code.as_deref(),
            Some("zhongguo"),
            "a dictionary pick remembers the code it taught"
        );
    }

    #[test]
    fn forgetting_the_last_pick_undoes_the_pin_and_clears_the_hint() {
        let b = ImeBridge::boot();
        learn(&b, "shi", "时");
        assert_eq!(b.snapshot(MAIN).learned_pins, 1);
        assert_eq!(b.snapshot(MAIN).last_pick_code.as_deref(), Some("shi"));

        let s = b.forget_last(MAIN);
        assert_eq!(s.learned_pins, 0, "the pin is really gone");
        assert_eq!(s.last_pick_code, None);
        assert_eq!(s.last_committed, None, "the hint goes with the action");

        // …and the ranking reflects it: 时 is no longer the head of `shi`.
        b.key(MAIN, "shi");
        assert_ne!(b.snapshot(MAIN).candidates[0].text, "时");
    }

    #[test]
    fn a_sentence_commit_offers_nothing_to_forget() {
        let b = ImeBridge::boot();
        b.key(MAIN, "zhongguorenmin");
        let out = b.commit(MAIN, 0);
        assert_eq!(out.committed.as_deref(), Some("中国人民"));
        assert_eq!(out.state.last_committed.as_deref(), Some("中国人民"));
        assert_eq!(
            out.state.last_pick_code, None,
            "a composition never teaches the dictionary, so it must not offer an undo"
        );

        // Acting on it anyway is honest: the hint clears, the learner is untouched.
        let s = b.forget_last(MAIN);
        assert_eq!(s.learned_pins, 0);
        assert_eq!(s.last_committed, None);
    }

    #[test]
    fn starting_the_next_word_closes_the_previous_undo() {
        let b = ImeBridge::boot();
        b.key(MAIN, "zhongguo");
        assert_eq!(
            b.commit(MAIN, 0).state.last_pick_code.as_deref(),
            Some("zhongguo")
        );
        assert_eq!(b.snapshot(MAIN).last_committed.as_deref(), Some("中国"));

        // A rejected tap (a digit) is not a new word…
        let s = b.key(MAIN, "1");
        assert_eq!(s.last_pick_code.as_deref(), Some("zhongguo"));
        assert_eq!(s.last_committed.as_deref(), Some("中国"));

        // …a letter is: the hint and the undo both go away.
        let s = b.key(MAIN, "n");
        assert_eq!(s.last_pick_code, None);
        assert_eq!(s.last_committed, None);
        assert_eq!(s.input, "n");
    }

    #[test]
    fn forgetting_with_nothing_committed_is_a_quiet_noop() {
        let b = ImeBridge::boot();
        let s = b.forget_last(MAIN);
        assert_eq!(s.last_committed, None);
        assert_eq!(s.last_pick_code, None);
        assert_eq!(s.learned_pins, 0);
    }

    #[test]
    fn profile_path_is_the_app_data_dir_file() {
        assert_eq!(
            file_in(Path::new("/data/user/0/com.amos.ai/files")),
            Path::new("/data/user/0/com.amos.ai/files/amos-ime.json")
        );
    }

    #[test]
    fn preferences_and_learning_survive_a_restart() {
        let dir = temp_dir("restart");
        let path = file_in(&dir);

        let first = ImeBridge::boot();
        first.configure(path.clone());
        first.fuzzy_toggle(MAIN, "n_l").expect("pair");
        learn(&first, "shi", "时");

        // The file on disk really holds both pieces of state.
        let text = std::fs::read_to_string(&path).expect("profile written");
        let stored = ImeProfile::from_json(&text).expect("profile parses");
        assert!(stored.fuzzy().n_l);
        assert_eq!(
            stored.l0().pins,
            vec![("shi".to_string(), "时".to_string())]
        );

        // A fresh process (new bridge, same path) restores them.
        let second = ImeBridge::boot();
        second.configure(path.clone());
        let s = second.snapshot(MAIN);
        assert!(s.fuzzy.n_l);
        assert!(!s.strict);
        assert_eq!(s.learned_pins, 1);
        second.key(MAIN, "shi");
        assert_eq!(second.snapshot(MAIN).candidates[0].text, "时");

        let _ = std::fs::remove_dir_all(&dir);
    }
    /// The rebuild inside `PinyinInput::set_prefs` used to drop the L0 learner, and
    /// this bridge persists right after a toggle — so flipping one fuzzy pair wrote
    /// a profile with **no** pinned words over the good one. The loss was durable:
    /// the next boot restored an emptied learner.
    #[test]
    fn toggling_a_fuzzy_pair_does_not_erase_the_profile_learner() {
        let dir = temp_dir("fuzzy-keeps-learner");
        let path = file_in(&dir);

        let b = ImeBridge::boot();
        b.configure(path.clone());
        learn(&b, "shi", "时");
        assert_eq!(b.snapshot(MAIN).learned_pins, 1);
        let before = std::fs::read_to_string(&path).expect("profile written");
        assert_eq!(
            ImeProfile::from_json(&before).expect("parses").l0().pins,
            vec![("shi".to_string(), "时".to_string())]
        );

        b.fuzzy_toggle(MAIN, "n_l").expect("known pair");

        // The file the toggle just published still holds the pin…
        let after = std::fs::read_to_string(&path).expect("profile rewritten");
        let stored = ImeProfile::from_json(&after).expect("parses");
        assert!(stored.fuzzy().n_l, "the toggle itself is persisted");
        assert_eq!(
            stored.l0().pins,
            vec![("shi".to_string(), "时".to_string())],
            "the toggle must not erase the learner from disk"
        );

        // …and a fresh boot (same path) still ranks the learned word first.
        let restarted = ImeBridge::boot();
        restarted.configure(path.clone());
        assert_eq!(restarted.snapshot(MAIN).learned_pins, 1);
        restarted.key(MAIN, "shi");
        assert_eq!(restarted.snapshot(MAIN).candidates[0].text, "时");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_profile_is_reported_and_defaults_are_kept() {
        let dir = temp_dir("corrupt");
        let path = file_in(&dir);
        std::fs::write(&path, "{ this is not json").expect("write junk");

        let b = ImeBridge::boot();
        b.configure(path.clone()); // must not panic and must not fake state
        let s = b.snapshot(MAIN);
        assert!(s.strict, "a corrupt file cannot conjure preferences");
        assert_eq!(s.learned_pins, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The `corrupt-*` sibling of a profile, if the fix moved one aside.
    fn corrupt_aside(dir: &Path) -> Option<PathBuf> {
        std::fs::read_dir(dir)
            .ok()?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().contains("corrupt-"))
            })
    }

    /// F-SH-933 (REQ-A1933): a profile that exists but cannot be parsed is **moved
    /// aside**, not silently kept-as-defaults while the path stays live — every later
    /// keystroke that persists (a toggle, a learned pin) would otherwise rewrite the one
    /// copy of the user's learned words with the defaults. Before the fix `configure`
    /// only warned and kept the path, so the next toggle clobbered the file.
    #[test]
    fn a_corrupt_profile_is_kept_aside_before_the_next_write_overwrites_it() {
        let dir = temp_dir("kept-aside");
        let path = file_in(&dir);
        std::fs::write(&path, "{ this is not json").expect("write junk");

        let b = ImeBridge::boot();
        b.configure(path.clone());
        assert!(b.snapshot(MAIN).strict, "defaults are kept, not faked");
        assert!(
            !path.exists(),
            "the unreadable profile must be moved aside, not left to be overwritten"
        );
        let kept = corrupt_aside(&dir).expect("the unreadable profile was kept under corrupt-*");
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            b"{ this is not json",
            "the user's original bytes survive intact"
        );

        // A later write publishes a fresh profile at the original path — beside, not over.
        learn(&b, "shi", "时");
        assert!(
            path.exists(),
            "a fresh profile is written at the original path"
        );
        assert!(kept.exists(), "and the preserved bytes are still there");
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            b"{ this is not json",
            "the fresh write did not touch the preserved bytes"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Positive control: a **readable** profile is loaded in place and is **not** moved
    /// aside (the fix must not rename healthy files). Applying the aside unconditionally
    /// makes this fail.
    #[test]
    fn a_readable_profile_is_loaded_without_being_moved_aside() {
        let dir = temp_dir("readable");
        let path = file_in(&dir);

        let writer = ImeBridge::boot();
        writer.configure(path.clone()); // absent → silent first run
        learn(&writer, "shi", "时");
        assert!(path.exists(), "the write created the file");

        let reader = ImeBridge::boot();
        reader.configure(path.clone());
        assert_eq!(
            reader.snapshot(MAIN).learned_pins,
            1,
            "the readable file loads"
        );
        assert!(path.exists(), "a readable profile is left where it is");
        assert!(
            corrupt_aside(&dir).is_none(),
            "a readable profile must not be moved aside"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The disjoint control: an **absent** file is the ordinary first run — nothing is
    /// moved aside, nothing is invented, and the path stays usable for the first write.
    #[test]
    fn a_missing_profile_keeps_nothing_aside() {
        let dir = temp_dir("missing");
        let path = file_in(&dir);

        let b = ImeBridge::boot();
        b.configure(path.clone());
        assert!(b.snapshot(MAIN).strict);
        assert!(!path.exists(), "no file is invented");
        assert!(
            corrupt_aside(&dir).is_none(),
            "a first run has nothing to move aside"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn configuring_the_same_path_twice_does_not_reload_or_reset() {
        let dir = temp_dir("idempotent");
        let path = file_in(&dir);
        let b = ImeBridge::boot();
        b.configure(path.clone());
        learn(&b, "shi", "时");
        assert_eq!(b.snapshot(MAIN).learned_pins, 1);

        b.configure(path.clone()); // same path: no reload, no reset
        assert_eq!(b.snapshot(MAIN).learned_pins, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn without_a_configured_path_nothing_is_written() {
        // Host/tests before setup: mutating commands must still work in memory.
        let b = ImeBridge::boot();
        learn(&b, "shi", "时");
        assert_eq!(b.snapshot(MAIN).learned_pins, 1);
    }

    #[test]
    fn every_staging_path_is_its_own_file() {
        let base = Path::new("/data/user/0/com.amos.ai/files/amos-ime.json");
        let seen: std::collections::HashSet<PathBuf> =
            (0..64).map(|_| staging_path(base)).collect();
        // Two writers must never share a staging file — that is what makes a torn
        // profile *impossible* rather than merely unlikely.
        assert_eq!(seen.len(), 64, "staging paths collided");
        for p in &seen {
            assert_eq!(p.parent(), base.parent(), "staged beside the profile");
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            assert!(
                name.starts_with(".amos-ime.json.tmp."),
                "unexpected staging name: {name}"
            );
        }
    }

    #[test]
    fn concurrent_persists_never_publish_a_torn_profile() {
        let dir = temp_dir("concurrent");
        let path = file_in(&dir);
        let bridge = ImeBridge::boot();
        bridge.configure(path.clone());

        std::thread::scope(|scope| {
            for worker in 0..4 {
                let bridge = &bridge;
                scope.spawn(move || {
                    for i in 0..15 {
                        // The two branches write *different* bytes, so a shared
                        // staging file would let one writer publish a mix of both.
                        if (worker + i) % 2 == 0 {
                            bridge.key(MAIN, "shi");
                            bridge.commit(MAIN, 0);
                        } else {
                            bridge.fuzzy_toggle(MAIN, "n_l").expect("known pair");
                            bridge.key(MAIN, "wo");
                            bridge.commit(MAIN, 0);
                        }
                    }
                });
            }
        });

        // Whatever order the writers finished in, the published profile is whole…
        let text = std::fs::read_to_string(&path).expect("profile written");
        let parsed = ImeProfile::from_json(&text);
        assert!(parsed.is_ok(), "torn profile: {text}");
        // …and no staging junk survives.
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp."))
            .collect();
        assert!(
            leftovers.is_empty(),
            "leftover staging files: {leftovers:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// REQ-A1880: the Android IME service drives the WebView keyboard's **own**
    /// bridge (see `crate::android_ime`), so a clone must share one engine, one
    /// learner and one buffer map — not fork a private copy of either. If `Clone`
    /// ever stopped being an `Arc` bump, a word taught through the system IME would
    /// silently not reach the WebView's ranking, which this pins.
    #[test]
    fn clones_share_one_engine_one_learner_and_one_buffer_map() {
        let bridge = ImeBridge::boot();
        let service = bridge.clone();

        // A composition started on one clone is the *same* buffer on the other —
        // they are one `ImeInner`, not two.
        service.key(ANDROID_WINDOW, "ni");
        assert_eq!(bridge.snapshot(ANDROID_WINDOW).input, "ni");

        // Learn a word through the service's pseudo-window…
        learn_window(&service, ANDROID_WINDOW, "zhongguo", "中国");

        // …and the WebView's own window reads the *same* learner: one dictionary,
        // one set of pinned words, whichever surface taught it.
        assert_eq!(
            bridge.snapshot(MAIN).learned_pins,
            1,
            "the learner must be shared between the system IME and the WebView"
        );
    }

    /// The service's pseudo-window is an ordinary key in the per-window map: a
    /// half-typed code there is invisible to the WebView's windows (and vice
    /// versa). This is the reason [`ANDROID_WINDOW`] exists rather than the
    /// service sharing `MAIN`.
    #[test]
    fn the_android_window_keeps_its_own_buffer() {
        let bridge = ImeBridge::boot();
        bridge.key(ANDROID_WINDOW, "wo");
        assert_eq!(bridge.snapshot(ANDROID_WINDOW).input, "wo");
        assert_eq!(bridge.snapshot(MAIN).input, "", "MAIN must not see it");
    }

    /// Negative control for [`a_late_installer_adopts_the_already_shared_bridge`]:
    /// two independent `boot()`s are two engines, so "the managed handle *is* the
    /// shared engine" is an assertion a non-adopting fix can actually fail — it is
    /// not a tautology of "there is one process". Never touches the process-wide
    /// singleton, so it is order-independent and compiles with or without the fix.
    #[test]
    fn two_boots_are_disjoint_learners() {
        let a = ImeBridge::boot();
        let b = ImeBridge::boot();
        a.fuzzy_toggle(MAIN, "z_zh").expect("known pair");
        assert!(!a.snapshot(MAIN).strict, "A must see its own change");
        assert!(
            b.snapshot(MAIN).strict,
            "a second boot must not see A's setting — two boots really are two learners"
        );
    }

    /// The process has exactly one `AmosImeService` and one Tauri host, and both
    /// must drive the same learner over the same `amos-ime.json`. The platform can
    /// cold-start this process for the *service* first (`AmosImeService.onCreate` →
    /// `nativeAttach` → [`shared_or_boot`]), so the host's own boot then arrives
    /// second: `install_shared` must let it **adopt** the published engine instead of
    /// managing a private second one. Two learners behind one file would clobber
    /// each other's picks on every `persist` — exactly the split the singleton's
    /// doc-comment promises cannot happen.
    ///
    /// Red-first note: the pre-fix `install_shared` answered `()` (no way to learn
    /// which instance won), so this test **did not compile** against it — the
    /// compiler refused `let service = install_shared(..)` (E0308). The disjoint
    /// negative control above is the compilable half that proves the property has
    /// teeth.
    #[test]
    fn a_late_installer_adopts_the_already_shared_bridge() {
        // The service publishes its engine first (the IME-first cold start).
        let service = install_shared(ImeBridge::boot());
        // The host boots its own — and must be handed the service's, not its own.
        let host_boot = ImeBridge::boot();
        let host = install_shared(host_boot.clone());

        host.fuzzy_toggle(ANDROID_WINDOW, "z_zh")
            .expect("known pair");
        assert!(
            !service.snapshot(ANDROID_WINDOW).strict,
            "the managed handle must be the shared engine, not a second boot"
        );
        assert!(
            host_boot.snapshot(ANDROID_WINDOW).strict,
            "the boot that lost the race keeps its own defaults — 'adopt' means the other one"
        );
    }

    /* ---- the Android system IME's entry point (REQ-A1904) -------------------- */

    /// The exact bytes `ImeSettingsTest.kt::aSuccessfulReadWritesEveryFactLine` pins.
    ///
    /// Copied here rather than generated, so a change on either side is a red test on
    /// that side and the two must be re-agreed. `ImeSettings.ok` is the authority for
    /// the shape; this is the reader's half of the same contract.
    const ANDROID_SELECTED_WIRE: &str = "state\tok\n\
         current\tcom.amos.ai/.glue.AmosImeService\n\
         ours_enabled\t1\n\
         ours_selected\t1\n";

    #[test]
    fn the_pinned_kotlin_wire_reads_as_facts() {
        let facts =
            parse_platform_ime_facts(ANDROID_SELECTED_WIRE).expect("the pinned bytes parse");
        assert_eq!(
            facts,
            PlatformImeFacts {
                current_id: "com.amos.ai/.glue.AmosImeService".to_string(),
                ours_enabled: true,
                ours_selected: true,
            }
        );
    }

    /// Enabled but **not** in force — the ordinary state for a user who enabled the
    /// keyboard and stayed on Gboard. The two flags must not be conflated.
    #[test]
    fn an_enabled_but_unselected_keyboard_is_two_separate_facts() {
        let wire = "state\tok\n\
             current\tcom.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME\n\
             ours_enabled\t1\n\
             ours_selected\t0\n";
        let facts = parse_platform_ime_facts(wire).expect("parses");
        assert!(facts.ours_enabled, "AmOS's keyboard is in the enabled list");
        assert!(!facts.ours_selected, "but LatinIME is the current one");
        assert_eq!(facts.current_id, parts::latin_ime());
    }

    /// "No keyboard is selected" is a *measurement*: `current` is an empty value, not an
    /// absent record. Reading it as absence would turn a platform statement into silence.
    #[test]
    fn an_empty_current_id_is_a_measurement_not_an_absence() {
        let facts =
            parse_platform_ime_facts("state\tok\ncurrent\t\nours_enabled\t0\nours_selected\t0\n")
                .expect("the empty current record is present, so this parses");
        assert_eq!(facts.current_id, "");
        assert!(!facts.ours_enabled);
        assert!(!facts.ours_selected);
    }

    /// A read that did not reach the platform writes **no fact lines** — so it must be an
    /// `Err` here, never an `Ok` with defaulted `false`s (the `nfc_status` family,
    /// REQ-A775 / F-AND-007).
    #[test]
    fn an_unavailable_answer_is_an_error_carrying_the_platforms_words() {
        let err =
            parse_platform_ime_facts("state\tunavailable\nwhy\tSecurityException: no access\n")
                .expect_err("a failed read is not a set of facts");
        assert!(err.contains("SecurityException: no access"), "got {err:?}");
    }

    /// The three facts are required on `ok`: a truncated wire is an error, not a default.
    #[test]
    fn a_missing_fact_record_is_an_error_not_a_default() {
        for wire in [
            "state\tok\ncurrent\tx\nours_enabled\t1\n",
            "state\tok\ncurrent\tx\nours_selected\t1\n",
            "state\tok\nours_enabled\t1\nours_selected\t1\n",
        ] {
            assert!(
                parse_platform_ime_facts(wire).is_err(),
                "{wire:?} is missing a required record"
            );
        }
    }

    #[test]
    fn a_state_word_this_build_does_not_know_is_an_error() {
        assert!(parse_platform_ime_facts("state\tmaybe\n").is_err());
        assert!(
            parse_platform_ime_facts("current\tx\n").is_err(),
            "no state record"
        );
    }

    /// A flag is `0`/`1`; anything else is unreadable, and an unreadable flag must not
    /// become `false` (which is itself a platform sentence).
    #[test]
    fn a_flag_that_is_not_zero_or_one_is_an_error() {
        let err = parse_platform_ime_facts(
            "state\tok\ncurrent\tx\nours_enabled\ttrue\nours_selected\t0\n",
        )
        .expect_err("`true` is not the wire's spelling");
        assert!(err.contains("ours_enabled"), "got {err:?}");
    }

    /// An unknown record is ignored, so a future Kotlin field is additive rather than a
    /// breaking change to this parser.
    #[test]
    fn an_unknown_record_does_not_break_the_parse() {
        let wire = "state\tok\ncurrent\tx\nfuture\twhatever\nours_enabled\t0\nours_selected\t0\n";
        assert_eq!(
            parse_platform_ime_facts(wire)
                .expect("the extra record is additive")
                .current_id,
            "x"
        );
    }

    /// The invariant the UI leans on: `available` **iff** there is no `reason`. It holds
    /// by shape — the two arms cannot both be written — so this pins the shape, not two
    /// hand-written sentences agreeing with each other.
    #[test]
    fn availability_and_a_reason_are_mutually_exclusive() {
        let yes = system_ime_status_from(Ok(ANDROID_SELECTED_WIRE.to_string()));
        assert!(yes.available && yes.reason.is_empty());
        assert_eq!(yes.enabled, Some(true));
        assert_eq!(yes.selected, Some(true));
        assert_eq!(
            yes.current_id.as_deref(),
            Some("com.amos.ai/.glue.AmosImeService")
        );

        let no = system_ime_status_from(Err("no glue".to_string()));
        assert!(!no.available && no.reason == "no glue");
        // The three facts are `None`, **not** `Some(false)`: nothing was asked.
        assert_eq!((no.enabled, no.selected, no.current_id), (None, None, None));
    }

    /// A wire that cannot be read leaves the facts absent — the same shape as "never
    /// asked", because in both cases the platform did not state them.
    #[test]
    fn an_unreadable_wire_leaves_every_fact_absent() {
        let status = system_ime_status_from(Ok("state\tunavailable\nwhy\tboom\n".to_string()));
        assert!(!status.available);
        assert!(status.reason.contains("boom"), "got {status:?}");
        assert_eq!(
            (status.enabled, status.selected, status.current_id),
            (None, None, None)
        );
    }

    /// The one place the glue's words live. `Unknown` is the caller's fallback for a word
    /// it does not know — reporting `Opened` for one would tell the user a screen came up
    /// that did not.
    #[test]
    fn the_glues_status_words_map_to_outcomes() {
        assert_eq!(ime_open_outcome_from_status("ok"), ImeOpenOutcome::Opened);
        assert_eq!(
            ime_open_outcome_from_status("unavailable"),
            ImeOpenOutcome::Unavailable
        );
        assert_eq!(
            ime_open_outcome_from_status("denied"),
            ImeOpenOutcome::Denied
        );
        assert_eq!(
            ime_open_outcome_from_status("no_editor"),
            ImeOpenOutcome::NoEditor,
            "the platform's own precondition, answered as its own word"
        );
        assert_eq!(
            ime_open_outcome_from_status("Opened"),
            ImeOpenOutcome::Unknown,
            "the spelling is the wire's, not this enum's"
        );
    }

    #[test]
    fn only_the_opened_outcome_is_a_success() {
        assert!(check_ime_open(ImeOpenOutcome::Opened).is_ok());
        for refused in [
            ImeOpenOutcome::Unavailable,
            ImeOpenOutcome::Denied,
            ImeOpenOutcome::NoEditor,
            ImeOpenOutcome::Unknown,
        ] {
            let err = check_ime_open(refused).expect_err("only `Opened` succeeds");
            let expected = match refused {
                ImeOpenOutcome::Unavailable => ErrorCode::ImeSystemGlueUnavailable,
                // Its own code, so the UI can say "put the caret in a text field" instead of
                // "could not open the screen, please retry" — the two need different actions.
                ImeOpenOutcome::NoEditor => ErrorCode::ImeSystemNoTextEditor,
                _ => ErrorCode::ImeSystemOpenFailed,
            };
            assert_eq!(err.code, expected, "for {refused:?}");
        }
    }

    /// The host/desktop build (a `cargo test` on macOS, an `amos-tauri` binary without
    /// the `android` feature) cannot ask the platform — there is no `Context`, no
    /// `InputMethodManager`, no glue class on any loader. The command must answer the
    /// honest `available: false` shape with a **non-empty, human-readable `reason`**
    /// the UI renders verbatim (`ImePage.svelte`'s `ime.systemUnavailableHint` is
    /// `t(..., { reason: sys.reason })` — a folded `""` would render the "why" sentence
    /// blank, telling the operator "this build cannot ask" without the **what**).
    ///
    /// Folding "the host has no glue" into a silent `available: false, reason: ""`
    /// would be the same shape as the "platform was never asked" reply — the
    /// `nfc_status` family paid for that one (REQ-A775 / F-AND-007). Pinned here so a
    /// `host_without_ime_glue` rewrite cannot collapse into a constant empty string.
    #[cfg(not(feature = "android"))]
    #[test]
    fn host_build_answers_unavailable_not_a_panic() {
        // The `status` command path: `ime_system_status` is a thin wrapper over
        // `system_ime_status_from(ask_the_platform_for_system_ime())`. The ask side
        // answers the `host_without_ime_glue` string on a host build.
        let raw = ask_the_platform_for_system_ime().expect_err("host build has no glue");
        assert!(
            !raw.is_empty(),
            "the host reason must not be folded to \"\" (would render the UI sentence blank)"
        );
        assert!(
            raw.contains("host") || raw.contains("desktop") || raw.contains("Android"),
            "the host reason must name the platform it could not reach, got: {raw:?}"
        );

        let status = system_ime_status_from(Err(raw.clone()));
        assert!(!status.available);
        assert_eq!(
            status.reason, raw,
            "the command's reason must round-trip through system_ime_status_from verbatim"
        );
        assert_eq!(
            (status.enabled, status.selected, status.current_id),
            (None, None, None),
            "the three facts must be None, not false — nothing was asked"
        );

        // The two launchers (`ime_system_open_picker` / `ime_system_open_settings`) also
        // hit the same no-glue path. The chain is `ask_…().map_err(glue_unavailable)?`,
        // which is a `Result<_, AmosError>` flow — the host reason rides in the
        // `AmosError`'s message, the **code** must be `ImeSystemGlueUnavailable` so the
        // UI picks the right sentence (`spacesFailure` / F-SH-577 family). Replicated
        // here directly rather than going through the `tauri::command` wrapper so the
        // test does not need a `tauri::test` harness.
        let glue_err = glue_unavailable(
            ask_the_platform_to_show_ime_picker().expect_err("host build has no glue"),
        );
        assert_eq!(glue_err.code, ErrorCode::ImeSystemGlueUnavailable);
        assert!(
            !glue_err.message.is_empty(),
            "the refusal's own sentence must be rendered to the operator, not folded to \"\""
        );
        let glue_err = glue_unavailable(
            ask_the_platform_for_ime_settings().expect_err("host build has no glue"),
        );
        assert_eq!(glue_err.code, ErrorCode::ImeSystemGlueUnavailable);
        assert!(!glue_err.message.is_empty());
    }

    /// The persist-failure counter is the only path between "I lost the
    /// user's pinned words" and "the operator sees the loss". The wire shape is
    /// `ImeStateOut.persist_failures: u64`, and the contract is: starts at `0`,
    /// increments by exactly one per failed `persist()`, and **never**
    /// increments on a successful persist (so a healthy daemon answers `0`
    /// forever, not a flapping number).
    ///
    /// `bump_persist_failures` is the only mutator; `persist_failures` is the
    /// only reader. The negative controls below prove the wire value tracks the
    /// counter rather than being hard-coded — folding either into a constant
    /// would make this test catch it (the `nfc_status` family paid for the
    /// `Option` shape; this one pays for the `u64` shape, REQ-A2091 / F-IME-032).
    #[test]
    fn persist_failures_starts_at_zero_and_increments_exactly_per_call() {
        let bridge = ImeBridge::boot();
        assert_eq!(
            bridge.persist_failures(),
            0,
            "a fresh bridge must start at zero — any other value would lie about lost pins"
        );
        assert_eq!(
            bridge.snapshot(MAIN).persist_failures,
            0,
            "the wire field is the same counter, not a folded constant"
        );

        bridge.bump_persist_failures();
        assert_eq!(bridge.persist_failures(), 1);
        assert_eq!(bridge.snapshot(MAIN).persist_failures, 1);

        bridge.bump_persist_failures();
        bridge.bump_persist_failures();
        assert_eq!(bridge.persist_failures(), 3);
        assert_eq!(
            bridge.snapshot(MAIN).persist_failures,
            3,
            "every command must see the cumulative count, not a per-call value"
        );
    }

    /// A `commit` that lands (a real dictionary pick) persists the profile; on a
    /// healthy disk the counter does **not** move. The bridge here is a
    /// `boot()` with no `configure(path)` — `persist()` is then a no-op that
    /// returns early, so neither the success path nor the failure path
    /// fires. The counter is the value that matters: it must stay at `0`
    /// through a normal commit cycle, so a noisy test cannot turn green by
    /// accidentally counting a healthy write.
    #[test]
    fn persist_failures_does_not_increment_on_a_successful_commit() {
        let bridge = ImeBridge::boot();
        // A real commit on a healthy engine…
        bridge.key(MAIN, "zhongguo");
        let out = bridge.commit(MAIN, 0);
        assert_eq!(out.committed.as_deref(), Some("中国"));
        // …must not move the counter (persist() is a no-op when no path was
        // configured, but neither path is a failure — the counter is the
        // observability story, not the persist-attempt story).
        assert_eq!(bridge.persist_failures(), 0);
        assert_eq!(bridge.snapshot(MAIN).persist_failures, 0);
    }

    /// Real on-disk failure path: configure the bridge at a path whose
    /// **parent directory** does not exist and is on a read-only mount we
    /// cannot create. The same shape as `logfile.rs`'s "Is a directory"
    /// failure — every stage of `persist()` will return an `io::Error`, so
    /// the counter increments. The negative control is the healthy
    /// `persist_failures_does_not_increment_on_a_successful_commit` above.
    #[cfg(unix)]
    #[test]
    fn persist_failures_increments_on_a_real_write_failure() {
        let dir = temp_dir("persistfail");
        // `/dev/null/<x>` is a path whose parent exists but is a char device, so
        // `create_dir_all` fails with `NotADirectory` — exactly the kind of
        // failure the bridge should surface, not silently swallow.
        let path = std::path::PathBuf::from("/dev/null").join(format!("amos-ime-{dir:?}.json"));
        let bridge = ImeBridge::boot();
        bridge.configure(path.clone());

        let before = bridge.persist_failures();
        bridge.key(MAIN, "wo");
        let _ = bridge.commit(MAIN, 0);
        let after = bridge.persist_failures();

        assert!(
            after > before,
            "a commit on an unwritable profile must surface as a persist failure \
             (before={before}, after={after}, path={path:?})"
        );
        assert_eq!(
            bridge.snapshot(MAIN).persist_failures,
            after,
            "the wire field is the cumulative count, not the per-commit count"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Tiny helpers for the fixtures above, so a repeated literal cannot drift from the
    /// one place it is spelled.
    mod parts {
        pub(super) fn latin_ime() -> String {
            "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME"
                .to_string()
        }
    }
}

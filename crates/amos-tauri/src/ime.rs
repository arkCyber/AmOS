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
pub struct ImeBridge {
    inner: Mutex<ImeInner>,
}

struct ImeInner {
    /// The process-wide engine + learner every window composes against.
    core: Arc<PinyinCore>,
    path: Option<PathBuf>,
    /// The per-window buffers, keyed by `WebviewWindow::label()`.
    windows: HashMap<String, WindowSession>,
    /// Monotonic counter behind [`WindowSession::touched`] (deterministic LRU).
    seq: u64,
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

/// Build the serializable state from one window's session + the shared core.
///
/// **One candidate list, two sources** (REQ-A260): while a code is being composed
/// the list is the engine's candidates for that buffer; with an empty buffer it is
/// the 联想 suggestions for what *this* window has committed. One index space
/// either way, so the keyboard's pager and its commit index mean exactly one thing
/// (the suggestion carries `"predict"` so the UI can label it).
fn state_of(session: &WindowSession, core: &PinyinCore) -> ImeStateOut {
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
            inner: Mutex::new(ImeInner {
                core: Arc::new(core),
                path: None,
                windows: HashMap::new(),
                seq: 0,
            }),
        }
    }

    /// Point the bridge at its profile file and load it (once per path). A missing
    /// file is a first run; a corrupt/unreadable one is logged and the defaults are
    /// kept — never a silent reset of preferences the user can see, never a crash.
    pub fn configure(&self, path: PathBuf) {
        let mut inner = self.lock();
        if inner.path.as_deref() == Some(path.as_path()) {
            return;
        }
        inner.path = Some(path.clone());
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(_) => return, // no profile yet — first run
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
            Err(e) => tracing::warn!(
                target: "amos::ime",
                path = %path.display(),
                error = %e,
                "IME profile unreadable — keeping defaults"
            ),
        }
    }

    /// The current state of `window`'s composition (the keyboard pulls this when it
    /// mounts).
    pub fn snapshot(&self, window: &str) -> ImeStateOut {
        let mut inner = self.lock();
        let core = Arc::clone(&inner.core);
        let session = inner.session(window);
        state_of(session, &core)
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
            return state_of(session, &core);
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
        state_of(session, &core)
    }

    /// Drop one buffered character from `window`. Not persisted (same reason as
    /// [`Self::key`]).
    pub fn backspace(&self, window: &str) -> ImeStateOut {
        let mut inner = self.lock();
        let core = Arc::clone(&inner.core);
        let session = inner.session(window);
        session.input.backspace();
        state_of(session, &core)
    }

    /// Abandon `window`'s in-flight buffer. Not persisted.
    pub fn clear(&self, window: &str) -> ImeStateOut {
        let mut inner = self.lock();
        let core = Arc::clone(&inner.core);
        let session = inner.session(window);
        session.input.clear();
        state_of(session, &core)
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
                (committed, state_of(session, &core))
            } else {
                let committed = session.input.commit_prediction(index, CANDIDATE_LIMIT);
                // A suggestion carries no pinyin code, so there is nothing the
                // learner could have learned and nothing "forget" could undo.
                session.last_pick_code = None;
                (committed, state_of(session, &core))
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
            let session = inner.session(window);
            if let Some(code) = session.last_pick_code.take() {
                session.input.forget(&code);
            }
            session.input.clear_hint();
            state_of(session, &core)
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
        let session = inner.session(window);
        state_of(session, &core)
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
            let session = inner.session(window);
            state_of(session, &core)
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
    /// logged, never reported as a failed keystroke/commit.
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
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, &path) {
            tracing::warn!(target: "amos::ime", error = %e, "IME profile rename failed");
            remove_staging(&tmp);
        }
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
}

//! Tauri <-> input-method (IME) bridge — the System UI's on-screen pinyin
//! keyboard. The engine itself is `amos-ime`; this module owns the *session
//! state*, the `ime_*` commands and the profile file.
//!
//! Why the state is here and not in the engine: the WebView sends one tap at a
//! time (`ime_key` / `ime_backspace`) and the engine's buffer + its per-user
//! learner must be shared by every keystroke, so a single `Mutex<ImeInner>` is
//! the session. The engine's dictionary is process-wide and immutable, so this
//! costs one lock per tap and no re-load per tap — the engine itself is only
//! rebuilt when the fuzzy preferences change (`ime_fuzzy_*`).
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

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use amos_ime::{
    CandidateKind, FuzzyPair, FuzzyPrefs, ImeProfile, L0Data, PinyinInput, MAX_CANDIDATES,
};
use serde::Serialize;

/// File name inside the app data dir.
pub const IME_FILE: &str = "amos-ime.json";

/// Candidates a single query returns (the keyboard pages through this list).
pub const CANDIDATE_LIMIT: usize = MAX_CANDIDATES;

/// The IME session: the engine buffer + the learner, behind one lock.
pub struct ImeBridge {
    inner: Mutex<ImeInner>,
}

struct ImeInner {
    input: PinyinInput,
    path: Option<PathBuf>,
    /// The pinyin code of the most recent **dictionary** commit — the only kind of
    /// pick the L0 learner records, so it is also the only one "forget" can undo.
    /// `None` after a sentence commit (nothing was learned) or a forget.
    last_pick_code: Option<String>,
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

/// Build the serializable state from a session.
fn state_of(inner: &ImeInner) -> ImeStateOut {
    let input = &inner.input;
    let candidates = input
        .candidates(CANDIDATE_LIMIT)
        .into_iter()
        .map(|c| ImeCandidateOut {
            text: c.text,
            kind: c.kind.key().to_string(),
        })
        .collect();
    ImeStateOut {
        input: input.input().to_string(),
        candidates,
        composing: input.is_composing(),
        strict: input.is_strict(),
        fuzzy: input.prefs(),
        dict_entries: input.dict_entries(),
        learned_pins: input.learned_pins(),
        learned_pending: input.learned_pending(),
        last_committed: input.last_committed().map(str::to_string),
        last_pick_code: inner.last_pick_code.clone(),
    }
}

impl ImeBridge {
    /// Boot with the strict defaults and no learner state.
    pub fn boot() -> Self {
        Self::from_profile(FuzzyPrefs::strict(), L0Data::default())
    }

    /// Boot from a known profile (tests / restoring a snapshot).
    pub fn from_profile(fuzzy: FuzzyPrefs, l0: L0Data) -> Self {
        let mut input = PinyinInput::new(fuzzy);
        input.import_l0(&l0);
        Self {
            inner: Mutex::new(ImeInner {
                input,
                path: None,
                last_pick_code: None,
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
                inner.input.set_prefs(profile.fuzzy());
                let accepted = inner.input.import_l0(&profile.l0());
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

    /// The current session state.
    pub fn snapshot(&self) -> ImeStateOut {
        state_of(&self.lock())
    }

    /// Feed one tap's worth of characters (only ASCII letters land in the buffer).
    /// Deliberately **not** persisted: a half-typed code is not user state.
    ///
    /// A tap that starts a new word also closes the previous commit's undo window
    /// (the engine drops its hint, and the code it would have forgotten is no
    /// longer the "last pick").
    pub fn key(&self, ch: &str) -> ImeStateOut {
        let mut inner = self.lock();
        if inner.input.type_str(ch) > 0 {
            inner.last_pick_code = None;
        }
        state_of(&inner)
    }

    /// Drop one buffered character. Not persisted (same reason as [`Self::key`]).
    pub fn backspace(&self) -> ImeStateOut {
        let mut inner = self.lock();
        inner.input.backspace();
        state_of(&inner)
    }

    /// Abandon the in-flight buffer. Not persisted.
    pub fn clear(&self) -> ImeStateOut {
        let mut inner = self.lock();
        inner.input.clear();
        state_of(&inner)
    }

    /// Commit candidate `index`: the inserted text (or `None` for an out-of-range
    /// index) plus the new state. A real commit changes the learner, so it is
    /// flushed to the profile.
    pub fn commit(&self, index: usize) -> ImeCommitOut {
        let (committed, state) = {
            let mut inner = self.lock();
            // The code and the candidate *kind* must be read **before** the commit
            // consumes the buffer, and only a dictionary pick is learnable — a
            // sentence composition teaches the dictionary nothing, so it must not
            // offer an "undo" that would be a no-op. (This re-runs the candidate
            // query once; it is a dictionary lookup plus, for long buffers, the
            // segmenter — microseconds, and it keeps the engine's API unchanged.)
            let code = inner.input.input().to_string();
            let learnable = inner
                .input
                .candidates(CANDIDATE_LIMIT)
                .get(index)
                .is_some_and(|c| c.kind == CandidateKind::Dict);
            let committed = inner.input.commit(index);
            inner.last_pick_code = if committed.is_some() && learnable {
                Some(code)
            } else {
                None
            };
            (committed, state_of(&inner))
        };
        if committed.is_some() {
            self.persist();
        }
        ImeCommitOut { committed, state }
    }

    /// Forget the word the user just committed — undo its learned pin — and clear
    /// the commit hint. A no-op on the learner when the last commit was a sentence
    /// composition (it never taught anything); the hint is cleared either way,
    /// because the user acted on it.
    pub fn forget_last(&self) -> ImeStateOut {
        let state = {
            let mut inner = self.lock();
            if let Some(code) = inner.last_pick_code.take() {
                inner.input.forget(&code);
            }
            inner.input.clear_hint();
            state_of(&inner)
        };
        self.persist();
        state
    }

    /// Flip one fuzzy pair by its stable key. Unknown pairs are an error.
    pub fn fuzzy_toggle(&self, pair: &str) -> Result<ImeStateOut, String> {
        let pair =
            FuzzyPair::from_key(pair).ok_or_else(|| format!("unknown fuzzy pair: {pair}"))?;
        let state = {
            let mut inner = self.lock();
            inner.input.toggle_fuzzy(pair);
            state_of(&inner)
        };
        self.persist();
        Ok(state)
    }

    /// Apply a named fuzzy preset (`"strict"` / `"permissive"`).
    pub fn fuzzy_preset(&self, preset: &str) -> Result<ImeStateOut, String> {
        let prefs =
            FuzzyPrefs::preset(preset).ok_or_else(|| format!("unknown fuzzy preset: {preset}"))?;
        let state = {
            let mut inner = self.lock();
            inner.input.set_prefs(prefs);
            state_of(&inner)
        };
        self.persist();
        Ok(state)
    }

    /// Forget **everything** the learner knows (all pins and counters) and flush.
    pub fn clear_learning(&self) -> ImeStateOut {
        let state = {
            let mut inner = self.lock();
            // `import_l0` replaces the whole L0 layer, so an empty snapshot is the
            // engine's own "forget all" — no per-code loop that could miss one.
            inner.input.import_l0(&L0Data::default());
            state_of(&inner)
        };
        self.persist();
        state
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
            let profile = ImeProfile::new(inner.input.prefs(), inner.input.export_l0());
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

/// The current session state (the keyboard pulls this when it mounts).
#[tauri::command]
pub fn ime_status(bridge: tauri::State<'_, ImeBridge>) -> Result<ImeStateOut, String> {
    Ok(bridge.snapshot())
}

/// Feed a tap's characters from the keyboard (only ASCII letters compose).
#[tauri::command]
pub fn ime_key(ch: String, bridge: tauri::State<'_, ImeBridge>) -> Result<ImeStateOut, String> {
    Ok(bridge.key(&ch))
}

/// Delete the last buffered pinyin letter.
#[tauri::command]
pub fn ime_backspace(bridge: tauri::State<'_, ImeBridge>) -> Result<ImeStateOut, String> {
    Ok(bridge.backspace())
}

/// Abandon the composition (Esc / hide keyboard).
#[tauri::command]
pub fn ime_clear(bridge: tauri::State<'_, ImeBridge>) -> Result<ImeStateOut, String> {
    Ok(bridge.clear())
}

/// Commit candidate `index` and return the inserted text + the new state.
#[tauri::command]
pub fn ime_commit(
    index: usize,
    bridge: tauri::State<'_, ImeBridge>,
) -> Result<ImeCommitOut, String> {
    Ok(bridge.commit(index))
}

/// Toggle one fuzzy pair (`"z_zh"`, `"n_l"`, …).
#[tauri::command]
pub fn ime_fuzzy_toggle(
    pair: String,
    bridge: tauri::State<'_, ImeBridge>,
) -> Result<ImeStateOut, String> {
    bridge.fuzzy_toggle(&pair)
}

/// Apply a fuzzy preset (`"strict"` / `"permissive"`).
#[tauri::command]
pub fn ime_fuzzy_preset(
    preset: String,
    bridge: tauri::State<'_, ImeBridge>,
) -> Result<ImeStateOut, String> {
    bridge.fuzzy_preset(&preset)
}

/// Forget everything the learner has learned (all pins + counters).
#[tauri::command]
pub fn ime_learning_clear(bridge: tauri::State<'_, ImeBridge>) -> Result<ImeStateOut, String> {
    Ok(bridge.clear_learning())
}

/// Undo the just-committed dictionary word (drop its learned pin) and clear the
/// commit hint. The keyboard only offers this while a dictionary pick is the last
/// commit, so a sentence composition never lands here.
#[tauri::command]
pub fn ime_forget_last(bridge: tauri::State<'_, ImeBridge>) -> Result<ImeStateOut, String> {
    Ok(bridge.forget_last())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Pick `word` for `code` three times — the engine's promotion threshold — so
    /// the L0 learner pins it through the bridge.
    fn learn(bridge: &ImeBridge, code: &str, word: &str) {
        for _ in 0..3 {
            bridge.clear();
            let state = bridge.key(code);
            let idx = state
                .candidates
                .iter()
                .position(|c| c.text == word)
                .unwrap_or_else(|| panic!("{word} is not a candidate for {code}"));
            assert_eq!(bridge.commit(idx).committed.as_deref(), Some(word));
        }
    }

    #[test]
    fn boot_state_is_honest_about_an_empty_session() {
        let b = ImeBridge::boot();
        let s = b.snapshot();
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
        let s = b.key("zhongguo");
        assert!(s.composing);
        assert_eq!(s.input, "zhongguo");
        assert_eq!(s.candidates.first().map(|c| c.text.as_str()), Some("中国"));
        assert_eq!(s.candidates[0].kind, "dict");

        let s = b.backspace();
        assert_eq!(s.input, "zhonggu");
        let s = b.clear();
        assert_eq!(s.input, "");
        assert!(s.candidates.is_empty());
    }

    #[test]
    fn non_letters_do_not_compose() {
        let b = ImeBridge::boot();
        let s = b.key("12,中");
        assert_eq!(s.input, "");
        assert!(!s.composing);
        assert_eq!(b.key("Z").input, "z");
    }

    #[test]
    fn commit_returns_the_word_and_resets_the_session() {
        let b = ImeBridge::boot();
        b.key("zhongguo");
        let out = b.commit(0);
        assert_eq!(out.committed.as_deref(), Some("中国"));
        assert_eq!(out.state.input, "");
        assert!(out.state.candidates.is_empty());
        assert_eq!(out.state.last_committed.as_deref(), Some("中国"));
    }

    #[test]
    fn an_out_of_range_commit_changes_nothing() {
        let b = ImeBridge::boot();
        b.key("wo");
        let out = b.commit(9_999);
        assert_eq!(out.committed, None);
        assert_eq!(out.state.input, "wo");
    }

    #[test]
    fn a_long_buffer_commits_a_sentence_composition() {
        let b = ImeBridge::boot();
        let s = b.key("zhongguorenmin");
        assert_eq!(s.candidates[0].text, "中国人民");
        assert_eq!(s.candidates[0].kind, "sentence");
        let out = b.commit(0);
        assert_eq!(out.committed.as_deref(), Some("中国人民"));
        // A composed sentence is not a dictionary word: the learner stays empty.
        assert_eq!(out.state.learned_pins, 0);
    }

    #[test]
    fn fuzzy_toggle_is_addressed_by_stable_key_and_rejects_junk() {
        let b = ImeBridge::boot();
        let s = b.fuzzy_toggle("z_zh").expect("known pair");
        assert!(s.fuzzy.z_zh);
        assert!(!s.strict);
        // `zong` now reaches 中 through z↔zh.
        let s = b.key("zong");
        assert!(s.candidates.iter().any(|c| c.text == "中"));

        let err = b.fuzzy_toggle("q_q").expect_err("unknown pair");
        assert!(err.contains("unknown fuzzy pair"), "{err}");
    }

    #[test]
    fn fuzzy_preset_applies_by_name_and_rejects_junk() {
        let b = ImeBridge::boot();
        assert!(!b.fuzzy_preset("permissive").expect("preset").strict);
        assert!(b.fuzzy_preset("strict").expect("preset").strict);
        let err = b.fuzzy_preset("loose").expect_err("unknown preset");
        assert!(err.contains("unknown fuzzy preset"), "{err}");
    }

    #[test]
    fn learning_pins_a_word_and_clearing_forgets_it() {
        let b = ImeBridge::boot();
        learn(&b, "shi", "时");
        let s = b.snapshot();
        assert_eq!(s.learned_pins, 1);
        assert_eq!(s.learned_pending, 0);

        let s = b.clear_learning();
        assert_eq!(s.learned_pins, 0);
        assert_eq!(s.learned_pending, 0);
    }

    #[test]
    fn a_dictionary_commit_is_undoable() {
        let b = ImeBridge::boot();
        b.key("zhongguo");
        let out = b.commit(0);
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
        assert_eq!(b.snapshot().learned_pins, 1);
        assert_eq!(b.snapshot().last_pick_code.as_deref(), Some("shi"));

        let s = b.forget_last();
        assert_eq!(s.learned_pins, 0, "the pin is really gone");
        assert_eq!(s.last_pick_code, None);
        assert_eq!(s.last_committed, None, "the hint goes with the action");

        // …and the ranking reflects it: 时 is no longer the head of `shi`.
        b.key("shi");
        assert_ne!(b.snapshot().candidates[0].text, "时");
    }

    #[test]
    fn a_sentence_commit_offers_nothing_to_forget() {
        let b = ImeBridge::boot();
        b.key("zhongguorenmin");
        let out = b.commit(0);
        assert_eq!(out.committed.as_deref(), Some("中国人民"));
        assert_eq!(out.state.last_committed.as_deref(), Some("中国人民"));
        assert_eq!(
            out.state.last_pick_code, None,
            "a composition never teaches the dictionary, so it must not offer an undo"
        );

        // Acting on it anyway is honest: the hint clears, the learner is untouched.
        let s = b.forget_last();
        assert_eq!(s.learned_pins, 0);
        assert_eq!(s.last_committed, None);
    }

    #[test]
    fn starting_the_next_word_closes_the_previous_undo() {
        let b = ImeBridge::boot();
        b.key("zhongguo");
        assert_eq!(
            b.commit(0).state.last_pick_code.as_deref(),
            Some("zhongguo")
        );
        assert_eq!(b.snapshot().last_committed.as_deref(), Some("中国"));

        // A rejected tap (a digit) is not a new word…
        let s = b.key("1");
        assert_eq!(s.last_pick_code.as_deref(), Some("zhongguo"));
        assert_eq!(s.last_committed.as_deref(), Some("中国"));

        // …a letter is: the hint and the undo both go away.
        let s = b.key("n");
        assert_eq!(s.last_pick_code, None);
        assert_eq!(s.last_committed, None);
        assert_eq!(s.input, "n");
    }

    #[test]
    fn forgetting_with_nothing_committed_is_a_quiet_noop() {
        let b = ImeBridge::boot();
        let s = b.forget_last();
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
        first.fuzzy_toggle("n_l").expect("pair");
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
        let s = second.snapshot();
        assert!(s.fuzzy.n_l);
        assert!(!s.strict);
        assert_eq!(s.learned_pins, 1);
        second.key("shi");
        assert_eq!(second.snapshot().candidates[0].text, "时");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_profile_is_reported_and_defaults_are_kept() {
        let dir = temp_dir("corrupt");
        let path = file_in(&dir);
        std::fs::write(&path, "{ this is not json").expect("write junk");

        let b = ImeBridge::boot();
        b.configure(path.clone()); // must not panic and must not fake state
        let s = b.snapshot();
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
        assert_eq!(b.snapshot().learned_pins, 1);

        b.configure(path.clone()); // same path: no reload, no reset
        assert_eq!(b.snapshot().learned_pins, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn without_a_configured_path_nothing_is_written() {
        // Host/tests before setup: mutating commands must still work in memory.
        let b = ImeBridge::boot();
        learn(&b, "shi", "时");
        assert_eq!(b.snapshot().learned_pins, 1);
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
                            bridge.key("shi");
                            bridge.commit(0);
                        } else {
                            bridge.fuzzy_toggle("n_l").expect("known pair");
                            bridge.key("wo");
                            bridge.commit(0);
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

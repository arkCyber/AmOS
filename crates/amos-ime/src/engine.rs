//! The typing session: buffer + candidate composition + commit/learning.
//!
//! `inputx-pinyin`'s `Session<'e>` **borrows** its engine, so the buffer and the
//! engine cannot live in one self-referential struct. Instead this type owns the
//! engine, keeps the raw buffer itself, and rebuilds a short-lived `Session` per
//! operation (constructing one is allocation-free; rejecting a handful of
//! characters through it costs microseconds — measured ~130 µs for 14 keystrokes
//! including every candidate lookup).

use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

use inputx_pinyin::{PinyinEngine, Session};

use crate::fuzzy::{FuzzyPair, FuzzyPrefs};
use crate::profile::L0Data;

/// Upper bound on how many candidates a single query may return. A one-syllable
/// buffer can have 100+ dictionary words; the keyboard pages through a bounded
/// list instead of rendering a thousand buttons.
pub const MAX_CANDIDATES: usize = 60;

/// Where a candidate came from — the keyboard shows these differently (a
/// sentence composition is a whole-buffer guess, not a dictionary word).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandidateKind {
    /// An exact dictionary match for the typed code.
    Dict,
    /// The best whole-buffer segmentation composition.
    Sentence,
}

impl CandidateKind {
    /// Stable wire key (`"dict"` / `"sentence"`).
    pub const fn key(self) -> &'static str {
        match self {
            CandidateKind::Dict => "dict",
            CandidateKind::Sentence => "sentence",
        }
    }
}

/// One candidate: the text to insert and where it came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub text: String,
    pub kind: CandidateKind,
}

/// Rebuild a short-lived session over `engine` with `input` replayed into it.
fn session_for<'e>(engine: &'e PinyinEngine, input: &str) -> Session<'e> {
    let mut session = Session::new(engine);
    for c in input.chars() {
        session.input_char(c);
    }
    session
}

/// The **process-wide** half of the IME: one dictionary (the embedded corpus),
/// one L0 learner and one fuzzy-preference set.
///
/// Why this is a type of its own (REQ-A258): the desktop shell opens one real
/// `WebviewWindow` per app (`docs/multi-window.md` §6) and the keyboard overlay
/// is mounted by `Shell.svelte`, so **every window** talks to the same bridge. The
/// dictionary and the learner really are process-wide (one user, one corpus, one
/// set of pinned words), but a half-typed pinyin code is not — it belongs to the
/// window it was typed in. Splitting the two is what makes "window A's candidate
/// bar shows what window B typed" impossible rather than unlikely.
///
/// The engine is immutable apart from the learner (which lives behind the
/// dictionary's own lock), so a session only holds an `Arc` to it: a
/// fuzzy-preference change **swaps the engine** (`FuzzyConfig` is baked in at
/// construction) and every session picks up the new one on its next keystroke.
pub struct PinyinCore {
    state: RwLock<CoreState>,
}

struct CoreState {
    prefs: FuzzyPrefs,
    engine: Arc<PinyinEngine>,
}

impl PinyinCore {
    /// A core with `prefs` and an empty learner.
    pub fn new(prefs: FuzzyPrefs) -> Self {
        Self {
            state: RwLock::new(CoreState {
                prefs,
                engine: Arc::new(PinyinEngine::with_fuzzy(prefs.to_config())),
            }),
        }
    }

    /// Current fuzzy preferences.
    pub fn prefs(&self) -> FuzzyPrefs {
        self.read().prefs
    }

    /// The engine every session is composing against *right now*.
    ///
    /// Handed back as an owned `Arc` so no caller holds the lock while it queries
    /// candidates: a long buffer runs the segmenter, and keeping a process-wide
    /// read lock across that would serialize typing in every window for nothing.
    fn engine(&self) -> Arc<PinyinEngine> {
        Arc::clone(&self.read().engine)
    }

    /// Replace the preferences, rebuilding the engine **and carrying the L0
    /// learner across**; returns whether anything changed.
    ///
    /// The learner lives *inside* the engine's dictionary, so a plain rebuild
    /// drops every word the user taught the IME — and the host persists right
    /// after a toggle, which turned that in-memory loss into a durable one (the
    /// user's pins were gone from `amos-ime.json` too). That was REQ-A254's
    /// defect; a shared core must keep the same rule.
    pub fn set_prefs(&self, prefs: FuzzyPrefs) -> bool {
        let mut state = self.write();
        if prefs == state.prefs {
            return false;
        }
        let learned = state.engine.dict().export_l0();
        let engine = PinyinEngine::with_fuzzy(prefs.to_config());
        engine.dict().import_l0(learned);
        state.prefs = prefs;
        state.engine = Arc::new(engine);
        true
    }

    /// Flip one fuzzy pair; returns the resulting preferences.
    pub fn toggle_fuzzy(&self, pair: FuzzyPair) -> FuzzyPrefs {
        let mut prefs = self.prefs();
        prefs.toggle(pair);
        self.set_prefs(prefs);
        prefs
    }

    /// Number of distinct pinyin codes in the embedded dictionary.
    pub fn dict_entries(&self) -> usize {
        self.engine().dict().len()
    }

    /// Number of user-pinned codes in the L0 learner.
    pub fn learned_pins(&self) -> usize {
        self.engine().dict().l0_pin_count()
    }

    /// Number of `(code, word)` pairs still earning their promotion in L0.
    pub fn learned_pending(&self) -> usize {
        self.engine().dict().l0_pending_count()
    }

    /// Snapshot the learner for persistence.
    pub fn export_l0(&self) -> L0Data {
        L0Data::from_snapshot(self.engine().dict().export_l0())
    }

    /// Restore a persisted learner snapshot; returns the number of accepted pins.
    pub fn import_l0(&self, data: &L0Data) -> usize {
        self.engine().dict().import_l0(data.to_snapshot())
    }

    /// Drop the learner's pin (and pick counters) for one code.
    pub fn forget(&self, pinyin: &str) -> bool {
        self.engine().dict().forget(pinyin)
    }

    /// 联想 / next-word suggestions after `prev_prev`, `prev` (most recent last).
    ///
    /// The **context** (trigram) path on purpose — see [`PinyinInput::predictions`]
    /// for why the bigram-only one is not shipped. Empty when the trigram data was
    /// not linked in, which is the crate's own contract.
    pub fn predictions(&self, prev_prev: Option<&str>, prev: &str, limit: usize) -> Vec<String> {
        self.engine()
            .dict()
            .predict_next_words_context(prev_prev, prev, limit)
            .into_iter()
            .map(|(word, _count)| word)
            .collect()
    }

    /// A read guard. A poisoned lock can only mean a panic inside some other
    /// window's keystroke, and refusing to type afterwards would be worse: what
    /// lives behind it is a dictionary plus some counters, not an invariant that a
    /// half-finished write can break.
    fn read(&self) -> RwLockReadGuard<'_, CoreState> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write(&self) -> RwLockWriteGuard<'_, CoreState> {
        self.state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Default for PinyinCore {
    fn default() -> Self {
        Self::new(FuzzyPrefs::strict())
    }
}

/// **One window's** composition over a shared [`PinyinCore`]: the in-flight
/// buffer plus the "just committed" hint.
///
/// [`PinyinInput::new`] gives a self-contained session (with its own core) — what
/// single-window callers and the tests below use. The multi-window host builds
/// sessions with [`PinyinInput::with_core`], so each window composes into its own
/// buffer while every window shares one dictionary and one learner.
pub struct PinyinInput {
    core: Arc<PinyinCore>,
    input: String,
    last_committed: Option<String>,
    /// The last two **committed** words of this window (oldest first) — the context
    /// the next-word suggestions are derived from. Per window, like the buffer:
    /// what one window just wrote says nothing about what the user is writing in
    /// another one.
    recent: [Option<String>; 2],
}

impl PinyinInput {
    /// The exact-code words for `input` under `engine`.
    fn exact_matches(engine: &PinyinEngine, input: &str) -> Vec<String> {
        session_for(engine, input).candidates().to_vec()
    }

    /// Commit the candidate at `index` (into [`Self::candidates`]'s list): the
    /// buffer is cleared and the committed text returned.
    ///
    /// A **dictionary** pick is routed through `Session::commit`, so the engine's
    /// per-user L0 layer records it (three picks of the same code+word pin it to
    /// the head of that code's list). A **sentence** pick is a whole-buffer guess
    /// that is not a dictionary entry: it is returned and remembered as the last
    /// committed text but deliberately **not** fed to the learner.
    ///
    /// `None` for an out-of-range index (the buffer is left untouched).
    pub fn commit(&mut self, index: usize) -> Option<String> {
        let engine = self.core.engine();
        let picked = self.candidates(MAX_CANDIDATES).into_iter().nth(index)?;
        match picked.kind {
            CandidateKind::Dict => {
                let mut session = session_for(&engine, &self.input);
                let exact = session.candidates().to_vec();
                let at = exact.iter().position(|w| *w == picked.text)?;
                let word = session.commit(at)?;
                self.input.clear();
                self.record_commit(&word);
                Some(word)
            }
            CandidateKind::Sentence => {
                self.input.clear();
                self.record_commit(&picked.text);
                Some(picked.text)
            }
        }
    }

    /// Record `word` as this window's most recent commit (the hint + the context
    /// the next-word suggestions are computed from).
    fn record_commit(&mut self, word: &str) {
        self.last_committed = Some(word.to_string());
        let [_, prev] = &self.recent;
        self.recent = [prev.clone(), Some(word.to_string())];
    }

    /// 联想 / next-word suggestions for this window, most likely first.
    ///
    /// Deliberately the crate's **context** path (`predict_next_words_context`,
    /// which needs a word-trigram hit) rather than the bigram-only
    /// `predict_next_words`: upstream documents the bigram path as too noisy to
    /// ship (it produced "在年月日年月日…" chains on a real device), and a
    /// suggestion list that is wrong most of the time is worse than none. That
    /// path needs **two** committed words, so:
    ///
    /// * nothing / one word committed ⇒ empty (the user types the next word —
    ///   honest, not noisy);
    /// * a non-empty buffer ⇒ empty: suggestions are what the keyboard offers when
    ///   there is nothing being composed, and mixing them into a live candidate
    ///   list would make one index space mean two things.
    ///
    /// Without the trigram data ever being linked in (a `--no-default-features`
    /// build) the crate answers empty here, so this call site needs no `cfg`.
    pub fn predictions(&self, limit: usize) -> Vec<String> {
        if self.is_composing() || limit == 0 {
            return Vec::new();
        }
        match (&self.recent[0], &self.recent[1]) {
            (Some(prev_prev), Some(prev)) => self.core.predictions(Some(prev_prev), prev, limit),
            _ => Vec::new(),
        }
    }

    /// Take suggestion `index` (into [`Self::predictions`]) — the text is inserted
    /// and becomes this window's most recent commit, so a suggestion chain can
    /// continue.
    ///
    /// Nothing is taught to the learner: a suggestion carries no pinyin code, and a
    /// list the user picked *from* must not be reported as a word the user typed
    /// (the same rule the sentence composition follows).
    pub fn commit_prediction(&mut self, index: usize, limit: usize) -> Option<String> {
        let word = self.predictions(limit).into_iter().nth(index)?;
        self.record_commit(&word);
        Some(word)
    }

    /// The last committed text, if any (the keyboard shows it as a transient
    /// "just committed" hint).
    pub fn last_committed(&self) -> Option<&str> {
        self.last_committed.as_deref()
    }

    /// Number of distinct pinyin codes in the embedded dictionary.
    pub fn dict_entries(&self) -> usize {
        self.core.dict_entries()
    }

    /// Number of user-pinned codes in the L0 learner.
    pub fn learned_pins(&self) -> usize {
        self.core.learned_pins()
    }

    /// Number of `(code, word)` pairs still earning their promotion in L0.
    pub fn learned_pending(&self) -> usize {
        self.core.learned_pending()
    }

    /// Snapshot the learner for persistence.
    pub fn export_l0(&self) -> L0Data {
        self.core.export_l0()
    }

    /// Restore a persisted learner snapshot; returns the number of accepted pins.
    pub fn import_l0(&mut self, data: &L0Data) -> usize {
        self.core.import_l0(data)
    }

    /// Drop the learner's pin (and pick counters) for one code.
    pub fn forget(&mut self, pinyin: &str) -> bool {
        self.core.forget(pinyin)
    }

    /// Clear the transient "just committed" hint ([`Self::last_committed`]).
    ///
    /// The hint is a *display* fact, not session state: the bridge clears it when
    /// the user acts on it (forgets the word) so the keyboard stops offering an
    /// action that no longer applies.
    pub fn clear_hint(&mut self) {
        self.last_committed = None;
    }
}

impl PinyinInput {
    /// A self-contained session with `prefs` (strict by default via
    /// [`FuzzyPrefs::default`]): its own dictionary, learner and buffer. The
    /// single-window case — and what every test in this file uses.
    pub fn new(prefs: FuzzyPrefs) -> Self {
        Self::with_core(Arc::new(PinyinCore::new(prefs)))
    }

    /// A session composing into **its own** buffer over a shared [`PinyinCore`] —
    /// one per window in the desktop shell (REQ-A258).
    pub fn with_core(core: Arc<PinyinCore>) -> Self {
        Self {
            core,
            input: String::new(),
            last_committed: None,
            recent: [None, None],
        }
    }

    /// The shared engine + learner this session composes against.
    ///
    /// A caller that must act on the *engine* rather than the buffer (persisting
    /// the profile, clearing the learner, changing the preferences of every
    /// window) goes through the core, not through one window's session — that is
    /// the whole point of the split.
    pub fn core(&self) -> &Arc<PinyinCore> {
        &self.core
    }

    /// Current fuzzy preferences.
    pub fn prefs(&self) -> FuzzyPrefs {
        self.core.prefs()
    }

    /// Replace the preferences: the engine is rebuilt (a `FuzzyConfig` is baked in
    /// at construction) and this session's in-flight buffer is cleared, because the
    /// candidate list for the old buffer would be ranked under the old rules.
    ///
    /// With a **shared** core the rebuild is process-wide (every window sees the
    /// new engine on its next keystroke); clearing the *other* windows' buffers is
    /// the host's job, because only the host owns the sessions.
    /// The rebuild carries the L0 learner across — see [`PinyinCore::set_prefs`].
    pub fn set_prefs(&mut self, prefs: FuzzyPrefs) {
        if self.core.set_prefs(prefs) {
            self.input.clear();
        }
    }

    /// Flip one fuzzy pair; returns the resulting preferences.
    pub fn toggle_fuzzy(&mut self, pair: FuzzyPair) -> FuzzyPrefs {
        let prefs = self.core.toggle_fuzzy(pair);
        self.input.clear();
        prefs
    }

    /// `true` iff every fuzzy pair is off.
    pub fn is_strict(&self) -> bool {
        self.prefs().is_strict()
    }

    /// Append one character. Only ASCII letters are accepted (lowercased);
    /// anything else is ignored and reported with `false`, so the caller decides
    /// what to do with `1`, `,` or `中` (the keyboard's business).
    ///
    /// Starting the next word also **ends the "just committed" hint**: it
    /// describes the most recent commit, and keeping it would make a stale chip
    /// pop back the moment the new composition is cleared.
    pub fn type_char(&mut self, c: char) -> bool {
        if c.is_ascii_alphabetic() {
            self.input.push(c.to_ascii_lowercase());
            self.last_committed = None;
            true
        } else {
            false
        }
    }

    /// Append every accepted character in `s`; returns how many were accepted.
    pub fn type_str(&mut self, s: &str) -> usize {
        let mut n = 0;
        for c in s.chars() {
            if self.type_char(c) {
                n += 1;
            }
        }
        n
    }

    /// Drop the last buffered character; `false` when the buffer was empty.
    pub fn backspace(&mut self) -> bool {
        self.input.pop().is_some()
    }

    /// Clear the in-flight buffer (Esc / abandon composition).
    pub fn clear(&mut self) {
        self.input.clear();
    }

    /// The raw pinyin typed so far.
    pub fn input(&self) -> &str {
        &self.input
    }

    /// `true` while a non-empty buffer is being composed.
    pub fn is_composing(&self) -> bool {
        !self.input.is_empty()
    }

    /// The candidate list for the current buffer, capped at `MAX_CANDIDATES`.
    ///
    /// Order: exact-code words first (engine frequency + the user's L0 layer).
    /// When the buffer has *no* exact match — a continuous multi-syllable string
    /// like `zhongguorenmin` — the sentence composition leads instead; otherwise
    /// it is appended (deduplicated) as the last resort.
    pub fn candidates(&self, limit: usize) -> Vec<Candidate> {
        let limit = limit.clamp(1, MAX_CANDIDATES);
        let mut out: Vec<Candidate> = Vec::new();
        if self.input.is_empty() {
            return out;
        }
        let engine = self.core.engine();
        let exact = Self::exact_matches(&engine, &self.input);
        let composed = engine.dict().best_composition(&self.input);
        if exact.is_empty() {
            if let Some((_, sentence)) = composed {
                out.push(Candidate {
                    text: sentence,
                    kind: CandidateKind::Sentence,
                });
            }
        } else {
            for word in exact {
                out.push(Candidate {
                    text: word,
                    kind: CandidateKind::Dict,
                });
            }
            if let Some((_, sentence)) = composed {
                if !out.iter().any(|c| c.text == sentence) {
                    out.push(Candidate {
                        text: sentence,
                        kind: CandidateKind::Sentence,
                    });
                }
            }
        }
        out.truncate(limit);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> PinyinInput {
        PinyinInput::new(FuzzyPrefs::strict())
    }

    fn first_text(cands: &[Candidate]) -> Option<&str> {
        cands.first().map(|c| c.text.as_str())
    }

    /// Pick `word` for `code` three times — the engine's promotion threshold — so
    /// the L0 learner pins it.
    fn learn(ime: &mut PinyinInput, code: &str, word: &str) {
        for _ in 0..3 {
            ime.type_str(code);
            let idx = ime
                .candidates(MAX_CANDIDATES)
                .iter()
                .position(|c| c.text == word)
                .unwrap_or_else(|| panic!("{word} is not a candidate for {code}"));
            assert_eq!(ime.commit(idx).as_deref(), Some(word));
        }
    }

    #[test]
    fn typing_zhongguo_offers_china_first() {
        let mut ime = fresh();
        assert_eq!(ime.type_str("zhongguo"), 8);
        let cands = ime.candidates(MAX_CANDIDATES);
        assert_eq!(first_text(&cands), Some("中国"));
        assert_eq!(cands[0].kind, CandidateKind::Dict);
        assert!(ime.is_composing());
        assert_eq!(ime.input(), "zhongguo");
    }

    #[test]
    fn only_ascii_letters_are_accepted() {
        let mut ime = fresh();
        assert!(!ime.type_char('1'));
        assert!(!ime.type_char(' '));
        assert!(!ime.type_char('中'));
        assert!(!ime.type_char(','));
        assert_eq!(ime.input(), "");
        assert!(!ime.is_composing());
        assert!(ime.type_char('Z'));
        assert_eq!(ime.input(), "z"); // lowercased
        assert_eq!(ime.type_str("zhong"), 5);
        assert_eq!(ime.input(), "zzhong");
    }

    #[test]
    fn empty_buffer_has_no_candidates() {
        assert!(fresh().candidates(10).is_empty());
    }

    #[test]
    fn backspace_and_clear_edit_the_buffer() {
        let mut ime = fresh();
        ime.type_str("zhong");
        assert!(ime.backspace());
        assert_eq!(ime.input(), "zhon");
        ime.clear();
        assert_eq!(ime.input(), "");
        assert!(!ime.backspace());
    }

    #[test]
    fn a_long_multi_syllable_buffer_composes_a_sentence() {
        let mut ime = fresh();
        ime.type_str("zhongguorenmin");
        let cands = ime.candidates(MAX_CANDIDATES);
        assert_eq!(first_text(&cands), Some("中国人民"));
        assert_eq!(cands[0].kind, CandidateKind::Sentence);
    }

    #[test]
    fn candidate_limit_is_bounded() {
        let mut ime = fresh();
        ime.type_str("shi"); // 86 dictionary candidates
        assert_eq!(ime.candidates(0).len(), 1, "0 is clamped up to 1");
        assert_eq!(ime.candidates(3).len(), 3);
        assert!(ime.candidates(10_000).len() <= MAX_CANDIDATES);
    }

    #[test]
    fn commit_returns_the_word_clears_the_buffer_and_remembers_it() {
        let mut ime = fresh();
        ime.type_str("zhongguo");
        assert_eq!(ime.commit(0).as_deref(), Some("中国"));
        assert_eq!(ime.input(), "");
        assert!(!ime.is_composing());
        assert_eq!(ime.last_committed(), Some("中国"));
        assert!(ime.candidates(MAX_CANDIDATES).is_empty());
    }

    #[test]
    fn an_out_of_range_commit_leaves_the_buffer_untouched() {
        let mut ime = fresh();
        ime.type_str("wo");
        assert_eq!(ime.commit(9_999), None);
        assert_eq!(ime.input(), "wo");
        assert_eq!(ime.commit(0).as_deref(), Some("我"));
    }

    #[test]
    fn committing_on_an_empty_buffer_is_a_noop() {
        let mut ime = fresh();
        assert_eq!(ime.commit(0), None);
        assert_eq!(ime.last_committed(), None);
    }

    #[test]
    fn committing_a_sentence_never_teaches_the_dictionary() {
        let mut ime = fresh();
        ime.type_str("zhongguorenmin");
        assert_eq!(ime.commit(0).as_deref(), Some("中国人民"));
        // The composed sentence is not a dictionary word, so L0 stays empty rather
        // than pretending the dictionary now contains it.
        assert_eq!(ime.learned_pins(), 0);
        assert_eq!(ime.learned_pending(), 0);
        assert_eq!(ime.last_committed(), Some("中国人民"));
    }

    #[test]
    fn fuzzy_off_is_strict_and_fuzzy_on_finds_the_dialect_reading() {
        let mut strict = fresh();
        strict.type_str("zong");
        assert!(!strict
            .candidates(MAX_CANDIDATES)
            .iter()
            .any(|c| c.text == "中"));

        let mut fuzzy = fresh();
        assert!(fuzzy.is_strict());
        let prefs = fuzzy.toggle_fuzzy(FuzzyPair::ZZh);
        assert!(prefs.z_zh);
        assert_eq!(fuzzy.prefs(), prefs);
        assert!(!fuzzy.is_strict());
        fuzzy.type_str("zong");
        assert!(fuzzy
            .candidates(MAX_CANDIDATES)
            .iter()
            .any(|c| c.text == "中"));
    }

    #[test]
    fn toggling_fuzzy_clears_the_in_flight_buffer() {
        let mut ime = fresh();
        ime.type_str("zhong");
        assert!(ime.is_composing());
        ime.toggle_fuzzy(FuzzyPair::NL);
        assert!(!ime.is_composing(), "the old ranking must not survive");
    }

    #[test]
    fn setting_the_same_preferences_keeps_the_buffer() {
        let mut ime = fresh();
        ime.type_str("zhong");
        ime.set_prefs(FuzzyPrefs::strict());
        assert_eq!(ime.input(), "zhong");
    }

    #[test]
    fn repeated_picks_pin_a_word_and_survive_export_import() {
        let mut ime = fresh();
        assert_eq!(ime.learned_pins(), 0);
        learn(&mut ime, "shi", "时");
        assert_eq!(ime.learned_pins(), 1);
        ime.type_str("shi");
        assert_eq!(ime.candidates(MAX_CANDIDATES)[0].text, "时");

        let exported = ime.export_l0();
        assert_eq!(exported.pins, vec![("shi".to_string(), "时".to_string())]);

        let mut restored = fresh();
        assert_eq!(restored.import_l0(&exported), 1);
        assert_eq!(restored.learned_pins(), 1);
        restored.type_str("shi");
        assert_eq!(restored.candidates(MAX_CANDIDATES)[0].text, "时");
    }

    /// A fuzzy-pair change rebuilds the engine (`FuzzyConfig` is baked in at
    /// construction), so the per-user L0 layer has to be carried across. It was
    /// not: three picks of a word were dropped the moment the user flipped one
    /// fuzzy pair, and the host bridge persists right after the toggle — so the
    /// wipe was **durable**, not just in-memory.
    #[test]
    fn changing_fuzzy_preferences_keeps_the_learned_words() {
        let mut ime = fresh();
        learn(&mut ime, "shi", "时");
        assert_eq!(ime.learned_pins(), 1);

        ime.toggle_fuzzy(FuzzyPair::NL);
        assert_eq!(
            ime.learned_pins(),
            1,
            "a preference change must not wipe the learner"
        );
        ime.type_str("shi");
        assert_eq!(
            ime.candidates(MAX_CANDIDATES)[0].text,
            "时",
            "the learned word must still rank first after the change"
        );

        // The named preset is the same code path (`set_prefs`).
        ime.set_prefs(FuzzyPrefs::default());
        assert_eq!(ime.learned_pins(), 1, "presets must not wipe the learner");
    }

    #[test]
    fn forget_drops_a_learned_pin() {
        let mut ime = fresh();
        learn(&mut ime, "shi", "时");
        assert_eq!(ime.learned_pins(), 1);
        assert!(ime.forget("shi"));
        assert_eq!(ime.learned_pins(), 0);
        // Forgetting something never learned reports honestly.
        assert!(!ime.forget("zzzz"));
    }

    #[test]
    fn the_commit_hint_is_over_once_the_next_word_starts() {
        let mut ime = fresh();
        ime.type_str("wo");
        assert_eq!(ime.commit(0).as_deref(), Some("我"));
        assert_eq!(ime.last_committed(), Some("我"));

        // A key the engine rejects is not "starting a word"…
        assert!(!ime.type_char('1'));
        assert_eq!(ime.last_committed(), Some("我"));
        // …but a letter is.
        assert!(ime.type_char('n'));
        assert_eq!(ime.last_committed(), None);
        // The new buffer is the only thing composing now.
        assert_eq!(ime.input(), "n");
    }

    #[test]
    fn the_commit_hint_can_be_cleared_without_touching_the_session() {
        let mut ime = fresh();
        assert_eq!(ime.last_committed(), None);
        ime.type_str("zhongguo");
        assert_eq!(ime.commit(0).as_deref(), Some("中国"));
        assert_eq!(ime.last_committed(), Some("中国"));

        ime.clear_hint();
        assert_eq!(ime.last_committed(), None);
        // Only the *hint* went away — the buffer is empty either way and the
        // learner is untouched (nothing was pinned by a single pick).
        assert!(!ime.is_composing());
        assert_eq!(ime.learned_pins(), 0);
    }

    // ---- 联想 / next-word suggestions (REQ-A260) -----------------------------

    /// One committed word is **not** enough context: the crate's context path needs
    /// two, and offering guesses from one word is what upstream measured as noise.
    #[test]
    fn predictions_need_two_committed_words_of_context() {
        let mut ime = fresh();
        assert!(ime.predictions(MAX_CANDIDATES).is_empty(), "cold start");

        ime.type_str("wo");
        assert_eq!(ime.commit(0).as_deref(), Some("我"));
        assert!(
            ime.predictions(MAX_CANDIDATES).is_empty(),
            "one word is not context"
        );
    }

    /// While something is being composed the suggestion list stays empty: the
    /// candidate bar belongs to the buffer (one index space, one meaning).
    #[test]
    fn predictions_are_silent_while_composing() {
        let mut ime = fresh();
        // Two commits give real context (我们 + 的 → 国家/生活/工作/社会)…
        ime.type_str("women");
        ime.commit(0);
        ime.type_str("de");
        ime.commit(0);
        assert!(
            !ime.predictions(MAX_CANDIDATES).is_empty(),
            "context exists"
        );

        // …and the moment a new code is being typed, they are off the table.
        ime.type_str("zhong");
        assert!(ime.predictions(MAX_CANDIDATES).is_empty());
    }

    /// The suggestion chain: a picked suggestion becomes the new context, and the
    /// learner is **not** taught (a list the user picked from is not something the
    /// user typed).
    #[test]
    fn a_picked_prediction_continues_the_chain_without_teaching_the_learner() {
        let mut ime = fresh();
        ime.type_str("women");
        assert_eq!(ime.commit(0).as_deref(), Some("我们"));
        ime.type_str("de");
        assert_eq!(ime.commit(0).as_deref(), Some("的"));

        let suggestions = ime.predictions(MAX_CANDIDATES);
        assert_eq!(
            suggestions,
            vec!["国家", "生活", "工作", "社会"],
            "我们 + 的 has established continuations"
        );
        assert_eq!(ime.learned_pins(), 0);

        let picked = ime.commit_prediction(0, MAX_CANDIDATES);
        assert_eq!(picked.as_deref(), Some("国家"));
        assert_eq!(ime.last_committed(), picked.as_deref());
        assert_eq!(
            ime.learned_pins(),
            0,
            "a suggestion must never be learned as a typed word"
        );
        assert!(!ime.is_composing());
        // The picked word is now the context, so the next list is a different one.
        assert_ne!(ime.predictions(MAX_CANDIDATES), suggestions);
    }

    #[test]
    fn an_out_of_range_suggestion_pick_changes_nothing() {
        let mut ime = fresh();
        ime.type_str("women");
        ime.commit(0);
        ime.type_str("de");
        ime.commit(0);
        assert_eq!(ime.commit_prediction(9_999, MAX_CANDIDATES), None);
        assert_eq!(ime.last_committed(), Some("的"));
    }

    /// Two windows do not share their suggestion context (it is the same rule as the
    /// buffer): what A committed says nothing about B.
    #[test]
    fn the_suggestion_context_is_per_session() {
        let core = Arc::new(PinyinCore::new(FuzzyPrefs::strict()));
        let mut a = PinyinInput::with_core(Arc::clone(&core));
        let mut b = PinyinInput::with_core(Arc::clone(&core));

        a.type_str("women");
        a.commit(0);
        a.type_str("de");
        a.commit(0);
        assert!(!a.predictions(MAX_CANDIDATES).is_empty());

        b.type_str("women");
        b.commit(0);
        assert!(
            b.predictions(MAX_CANDIDATES).is_empty(),
            "B has one word of context, not A's two"
        );
    }

    #[test]
    fn the_dictionary_is_the_full_corpus() {
        assert!(
            fresh().dict_entries() > 100_000,
            "{}",
            fresh().dict_entries()
        );
    }

    /// Two windows over one core (REQ-A258): each window's composition is its own,
    /// and a commit in one must not consume the other's code.
    #[test]
    fn two_sessions_over_one_core_keep_their_own_buffers() {
        let core = Arc::new(PinyinCore::new(FuzzyPrefs::strict()));
        let mut a = PinyinInput::with_core(Arc::clone(&core));
        let mut b = PinyinInput::with_core(Arc::clone(&core));

        a.type_str("zhongguo");
        b.type_str("wo");
        assert_eq!(a.input(), "zhongguo");
        assert_eq!(b.input(), "wo");
        assert_eq!(first_text(&a.candidates(MAX_CANDIDATES)), Some("中国"));
        assert_eq!(first_text(&b.candidates(MAX_CANDIDATES)), Some("我"));

        assert_eq!(b.commit(0).as_deref(), Some("我"));
        assert_eq!(a.input(), "zhongguo", "B's commit must not eat A's code");
        assert_eq!(first_text(&a.candidates(MAX_CANDIDATES)), Some("中国"));
        assert_eq!(a.last_committed(), None, "A never committed anything");
    }

    /// …while the learner is genuinely shared: a word pinned in one window ranks
    /// first in the other, and the core counts it once.
    #[test]
    fn a_word_learned_in_one_session_is_known_to_the_other() {
        let core = Arc::new(PinyinCore::new(FuzzyPrefs::strict()));
        let mut a = PinyinInput::with_core(Arc::clone(&core));
        let mut b = PinyinInput::with_core(Arc::clone(&core));

        learn(&mut a, "shi", "时");
        assert_eq!(core.learned_pins(), 1, "one learner, not one per window");

        b.type_str("shi");
        assert_eq!(first_text(&b.candidates(MAX_CANDIDATES)), Some("时"));
    }

    /// A preference change swaps the engine for **every** session at once (one
    /// device, one setting) and still carries the learner across.
    #[test]
    fn a_preference_change_reaches_every_session_and_keeps_the_learner() {
        let core = Arc::new(PinyinCore::new(FuzzyPrefs::strict()));
        let mut a = PinyinInput::with_core(Arc::clone(&core));
        let mut b = PinyinInput::with_core(Arc::clone(&core));
        learn(&mut a, "shi", "时");

        a.toggle_fuzzy(FuzzyPair::ZZh);
        assert_eq!(b.prefs(), a.prefs(), "one preference set per process");
        assert_eq!(core.learned_pins(), 1, "the engine swap keeps the learner");

        b.type_str("zong");
        assert!(
            b.candidates(MAX_CANDIDATES).iter().any(|c| c.text == "中"),
            "the other session ranks under the new prefs too"
        );
    }

    /// `PinyinCore` is what a multi-threaded host needs: `Arc` + one session per
    /// thread, no shared buffer and one learner. (Tauri keeps this in its managed
    /// state, which is `Send + Sync`.)
    #[test]
    fn many_threads_can_compose_over_one_core() {
        let core = Arc::new(PinyinCore::new(FuzzyPrefs::strict()));
        let heads: Vec<Option<String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = ["wo", "ni", "ta", "shi"]
                .into_iter()
                .map(|code| {
                    let core = Arc::clone(&core);
                    scope.spawn(move || {
                        let mut session = PinyinInput::with_core(core);
                        session.type_str(code);
                        session
                            .candidates(MAX_CANDIDATES)
                            .first()
                            .map(|c| c.text.clone())
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or(None))
                .collect()
        });
        assert_eq!(heads.len(), 4);
        assert!(heads.iter().all(|h| h.is_some()), "{heads:?}");
    }
}

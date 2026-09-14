//! The typing session: buffer + candidate composition + commit/learning.
//!
//! `inputx-pinyin`'s `Session<'e>` **borrows** its engine, so the buffer and the
//! engine cannot live in one self-referential struct. Instead this type owns the
//! engine, keeps the raw buffer itself, and rebuilds a short-lived `Session` per
//! operation (constructing one is allocation-free; rejecting a handful of
//! characters through it costs microseconds — measured ~130 µs for 14 keystrokes
//! including every candidate lookup).

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

/// A pinyin typing session with its preference + learning state.
pub struct PinyinInput {
    engine: PinyinEngine,
    prefs: FuzzyPrefs,
    input: String,
    last_committed: Option<String>,
}

impl PinyinInput {
    /// The exact-code words for the current buffer.
    fn exact_matches(&self) -> Vec<String> {
        session_for(&self.engine, &self.input).candidates().to_vec()
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
        let picked = self.candidates(MAX_CANDIDATES).into_iter().nth(index)?;
        match picked.kind {
            CandidateKind::Dict => {
                let Self {
                    engine,
                    input,
                    last_committed,
                    ..
                } = self;
                let mut session = session_for(engine, input);
                let exact = session.candidates().to_vec();
                let at = exact.iter().position(|w| *w == picked.text)?;
                let word = session.commit(at)?;
                input.clear();
                *last_committed = Some(word.clone());
                Some(word)
            }
            CandidateKind::Sentence => {
                self.input.clear();
                self.last_committed = Some(picked.text.clone());
                Some(picked.text)
            }
        }
    }

    /// The last committed text, if any (the keyboard shows it as a transient
    /// "just committed" hint).
    pub fn last_committed(&self) -> Option<&str> {
        self.last_committed.as_deref()
    }

    /// Number of distinct pinyin codes in the embedded dictionary.
    pub fn dict_entries(&self) -> usize {
        self.engine.dict().len()
    }

    /// Number of user-pinned codes in the L0 learner.
    pub fn learned_pins(&self) -> usize {
        self.engine.dict().l0_pin_count()
    }

    /// Number of `(code, word)` pairs still earning their promotion in L0.
    pub fn learned_pending(&self) -> usize {
        self.engine.dict().l0_pending_count()
    }

    /// Snapshot the learner for persistence.
    pub fn export_l0(&self) -> L0Data {
        L0Data::from_snapshot(self.engine.dict().export_l0())
    }

    /// Restore a persisted learner snapshot; returns the number of accepted pins.
    pub fn import_l0(&mut self, data: &L0Data) -> usize {
        self.engine.dict().import_l0(data.to_snapshot())
    }

    /// Drop the learner's pin (and pick counters) for one code.
    pub fn forget(&mut self, pinyin: &str) -> bool {
        self.engine.dict().forget(pinyin)
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
    /// A fresh session with `prefs` (strict by default via `FuzzyPrefs::default`).
    pub fn new(prefs: FuzzyPrefs) -> Self {
        Self {
            engine: PinyinEngine::with_fuzzy(prefs.to_config()),
            prefs,
            input: String::new(),
            last_committed: None,
        }
    }

    /// Current fuzzy preferences.
    pub fn prefs(&self) -> FuzzyPrefs {
        self.prefs
    }

    /// Replace the preferences. Rebuilds the engine (a `FuzzyConfig` is baked into
    /// the engine at construction) and clears the in-flight buffer, because the
    /// candidate list for the old buffer would be ranked under the old rules.
    pub fn set_prefs(&mut self, prefs: FuzzyPrefs) {
        if prefs == self.prefs {
            return;
        }
        self.prefs = prefs;
        self.engine = PinyinEngine::with_fuzzy(prefs.to_config());
        self.input.clear();
    }

    /// Flip one fuzzy pair; returns the resulting preferences.
    pub fn toggle_fuzzy(&mut self, pair: FuzzyPair) -> FuzzyPrefs {
        let mut prefs = self.prefs;
        prefs.toggle(pair);
        self.set_prefs(prefs);
        self.prefs
    }

    /// `true` iff every fuzzy pair is off.
    pub fn is_strict(&self) -> bool {
        self.prefs.is_strict()
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
        let exact = self.exact_matches();
        let composed = self.engine.dict().best_composition(&self.input);
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

    #[test]
    fn the_dictionary_is_the_full_corpus() {
        assert!(
            fresh().dict_entries() > 100_000,
            "{}",
            fresh().dict_entries()
        );
    }
}

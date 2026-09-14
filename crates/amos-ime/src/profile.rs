//! The persistable IME profile: schema version + fuzzy prefs + the exported L0
//! learner (pins and pending pick counts).
//!
//! Pure serde + string (de)serialization — **no file I/O here** (the host bridge
//! owns the path and the atomic write, exactly like `amos-blocklist`'s rules).
//! Import is deliberately defensive: a profile file is user-writable state on a
//! device, so codes and caps are validated instead of trusted.

use inputx_pinyin::L0Snapshot;
use serde::{Deserialize, Serialize};

use crate::fuzzy::FuzzyPrefs;

/// Cap on remembered pins (a real user pins tens, not thousands).
pub const MAX_PINS: usize = 2000;
/// Cap on pending `(code, word)` pick counters.
pub const MAX_PICK_COUNTS: usize = 5000;
/// Longest accepted pinyin code. The engine's own longest syllable is 6 letters;
/// 64 leaves room for multi-syllable phrase codes while still rejecting junk.
pub const MAX_CODE_LEN: usize = 64;
/// Longest accepted committed word, in characters.
pub const MAX_WORD_CHARS: usize = 16;

/// The L0 learner state, in a serde-friendly shape (`L0Snapshot` deliberately has
/// no serde surface upstream).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct L0Data {
    /// `(pinyin, word)` pairs the user has pinned (manually or by repeated picks).
    #[serde(default)]
    pub pins: Vec<(String, String)>,
    /// `(pinyin, word, count)` — picks that have not yet reached promotion.
    #[serde(default)]
    pub pick_counts: Vec<(String, String, u32)>,
}

/// `true` for a code this crate is willing to persist: lowercase ASCII letters,
/// 1..=`MAX_CODE_LEN` long.
fn is_valid_code(code: &str) -> bool {
    !code.is_empty() && code.len() <= MAX_CODE_LEN && code.chars().all(|c| c.is_ascii_lowercase())
}

/// `true` for a word this crate is willing to persist: non-empty, at most
/// `MAX_WORD_CHARS` characters, and containing no control characters.
fn is_valid_word(word: &str) -> bool {
    !word.is_empty()
        && word.chars().count() <= MAX_WORD_CHARS
        && !word.chars().any(char::is_control)
}

impl L0Data {
    /// `true` when nothing has been learned yet.
    pub fn is_empty(&self) -> bool {
        self.pins.is_empty() && self.pick_counts.is_empty()
    }

    /// Drop entries a real dictionary could not have produced, and clamp the
    /// list lengths. The engine additionally drops pairs absent from its lexicon
    /// on import — this is the part that keeps a hostile file from being loaded
    /// into memory at all.
    pub(crate) fn sanitized(mut self) -> Self {
        self.pins
            .retain(|(code, word)| is_valid_code(code) && is_valid_word(word));
        self.pick_counts
            .retain(|(code, word, count)| is_valid_code(code) && is_valid_word(word) && *count > 0);
        self.pins.truncate(MAX_PINS);
        self.pick_counts.truncate(MAX_PICK_COUNTS);
        self
    }

    /// The engine's snapshot type for this data (validated + clamped).
    pub(crate) fn to_snapshot(&self) -> L0Snapshot {
        let clean = self.clone().sanitized();
        L0Snapshot {
            pins: clean.pins,
            pick_counts: clean.pick_counts,
        }
    }

    /// Mirror an engine snapshot (already engine-validated) into serde shape.
    pub(crate) fn from_snapshot(snapshot: L0Snapshot) -> Self {
        Self {
            pins: snapshot.pins,
            pick_counts: snapshot.pick_counts,
        }
    }
}

/// The persisted profile (`amos-ime.json` on device).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImeProfile {
    /// Schema version, so a future change can migrate honestly.
    #[serde(default = "ImeProfile::current_version")]
    version: u32,
    #[serde(default)]
    fuzzy: FuzzyPrefs,
    #[serde(default)]
    l0: L0Data,
}

impl ImeProfile {
    /// The schema version this build writes.
    pub const VERSION: u32 = 1;

    fn current_version() -> u32 {
        Self::VERSION
    }

    /// A profile from its two pieces of state.
    pub fn new(fuzzy: FuzzyPrefs, l0: L0Data) -> Self {
        Self {
            version: Self::VERSION,
            fuzzy,
            l0,
        }
    }

    /// The persisted fuzzy preferences.
    pub fn fuzzy(&self) -> FuzzyPrefs {
        self.fuzzy
    }

    /// The persisted learner state (sanitized).
    pub fn l0(&self) -> L0Data {
        self.l0.clone().sanitized()
    }

    /// Serialize to JSON. `Err` is a real error the caller must not hide.
    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|e| format!("serialize IME profile: {e}"))
    }

    /// Parse a profile. Rejects a *newer* schema version (this build cannot know
    /// what fields it means) and refuses junk codes; a corrupt file is an error
    /// the caller reports, never a silently reset profile.
    pub fn from_json(text: &str) -> Result<Self, String> {
        let profile: Self =
            serde_json::from_str(text).map_err(|e| format!("parse IME profile: {e}"))?;
        if profile.version > Self::VERSION {
            return Err(format!(
                "IME profile version {} is newer than this build's {}",
                profile.version,
                Self::VERSION
            ));
        }
        Ok(Self {
            version: profile.version,
            fuzzy: profile.fuzzy,
            l0: profile.l0.sanitized(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fuzzy::FuzzyPair;

    fn sample() -> ImeProfile {
        let mut fuzzy = FuzzyPrefs::strict();
        fuzzy.toggle(FuzzyPair::NL);
        ImeProfile::new(
            fuzzy,
            L0Data {
                pins: vec![("shi".to_string(), "时".to_string())],
                pick_counts: vec![("wo".to_string(), "我".to_string(), 2)],
            },
        )
    }

    #[test]
    fn round_trips_through_json() {
        let p = sample();
        let json = p.to_json().expect("serialize");
        let back = ImeProfile::from_json(&json).expect("parse");
        assert_eq!(back, p);
        assert!(!back.fuzzy().is_strict());
        assert_eq!(back.l0().pins.len(), 1);
        assert_eq!(back.l0().pick_counts[0].2, 2);
    }

    #[test]
    fn empty_object_parses_to_defaults() {
        let p = ImeProfile::from_json("{}").expect("empty object");
        assert_eq!(p.fuzzy(), FuzzyPrefs::strict());
        assert!(p.l0().is_empty());
        assert_eq!(p.version, ImeProfile::VERSION);
    }

    #[test]
    fn a_newer_schema_version_is_refused_not_ignored() {
        let err = ImeProfile::from_json(r#"{"version": 99}"#).expect_err("newer version");
        assert!(err.contains("newer than"), "unexpected error: {err}");
    }

    #[test]
    fn malformed_json_is_an_error_not_a_silent_reset() {
        assert!(ImeProfile::from_json("not json").is_err());
        assert!(ImeProfile::from_json("[1,2,3]").is_err());
    }

    #[test]
    fn import_drops_junk_codes_and_counts() {
        let pins = vec![
            ("shi".to_string(), "时".to_string()),
            ("SHI".to_string(), "时".to_string()), // uppercase → dropped
            (String::new(), "空".to_string()),     // empty code → dropped
            ("shi".to_string(), "时\u{0007}".to_string()), // control char → dropped
            ("shi".to_string(), String::new()),    // empty word → dropped
            ("x".repeat(MAX_CODE_LEN + 1), "长".to_string()), // too long → dropped
        ];
        let json = serde_json::json!({
            "version": 1,
            "l0": { "pins": pins, "pick_counts": [["wo", "我", 0]] }
        })
        .to_string();
        let p = ImeProfile::from_json(&json).expect("parse");
        assert_eq!(p.l0().pins, vec![("shi".to_string(), "时".to_string())]);
        assert!(p.l0().pick_counts.is_empty(), "a zero count is dropped");
    }

    #[test]
    fn sanitized_truncates_to_the_caps() {
        // Codes must be lowercase ASCII letters, so encode the index in base-26.
        fn code_of(mut i: usize) -> String {
            let mut s = String::new();
            loop {
                s.push((b'a' + (i % 26) as u8) as char);
                i /= 26;
                if i == 0 {
                    break;
                }
            }
            s
        }
        let pins: Vec<(String, String)> = (0..MAX_PINS + 10)
            .map(|i| (code_of(i), "字".to_string()))
            .collect();
        let data = L0Data {
            pins,
            pick_counts: Vec::new(),
        };
        assert_eq!(data.sanitized().pins.len(), MAX_PINS);
    }

    #[test]
    fn snapshot_conversion_round_trips_clean_data() {
        let data = sample().l0();
        let snap = data.clone().to_snapshot();
        assert_eq!(L0Data::from_snapshot(snap), data);
    }
}

//! Fuzzy-pair preferences: which near-homophone spellings the engine should
//! accept, as a serde-stable struct the UI can persist and toggle pair by pair.
//!
//! The engine's own [`inputx_pinyin::FuzzyConfig`] is a plain `Copy` struct with
//! no serde surface (the crate intentionally has no serde dependency), so this is
//! the persistence/transport mirror of it — one `to_config` call at the boundary.

use inputx_pinyin::FuzzyConfig;
use serde::{Deserialize, Serialize};

/// One addressable fuzzy pair. The stable string keys are the wire/JSON names
/// (`"z_zh"`, …) the frontend toggles, so a UI label change can never move a
/// stored preference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FuzzyPair {
    /// `z ↔ zh` (initial)
    ZZh,
    /// `c ↔ ch` (initial)
    CCh,
    /// `s ↔ sh` (initial)
    SSh,
    /// `n ↔ l` (initial)
    NL,
    /// `f ↔ h` (initial)
    FH,
    /// `r ↔ l` (initial)
    RL,
    /// `in ↔ ing` (final)
    InIng,
    /// `en ↔ eng` (final)
    EnEng,
    /// `an ↔ ang` (final)
    AnAng,
}

/// Every pair, in display order (initials first, then finals) — the order the
/// keyboard's settings panel renders them in.
pub const FUZZY_PAIRS: [FuzzyPair; 9] = [
    FuzzyPair::ZZh,
    FuzzyPair::CCh,
    FuzzyPair::SSh,
    FuzzyPair::NL,
    FuzzyPair::FH,
    FuzzyPair::RL,
    FuzzyPair::InIng,
    FuzzyPair::EnEng,
    FuzzyPair::AnAng,
];

impl FuzzyPair {
    /// Stable key used on the wire, in JSON and by the UI toggle.
    pub const fn key(self) -> &'static str {
        match self {
            FuzzyPair::ZZh => "z_zh",
            FuzzyPair::CCh => "c_ch",
            FuzzyPair::SSh => "s_sh",
            FuzzyPair::NL => "n_l",
            FuzzyPair::FH => "f_h",
            FuzzyPair::RL => "r_l",
            FuzzyPair::InIng => "in_ing",
            FuzzyPair::EnEng => "en_eng",
            FuzzyPair::AnAng => "an_ang",
        }
    }

    /// Parse one of [`Self::key`]'s strings. `None` for anything else — an
    /// unknown pair is a caller error, never a silent no-op.
    pub fn from_key(key: &str) -> Option<Self> {
        FUZZY_PAIRS.into_iter().find(|p| p.key() == key)
    }

    /// Whether this pair is enabled in `prefs`.
    pub const fn get(self, prefs: &FuzzyPrefs) -> bool {
        match self {
            FuzzyPair::ZZh => prefs.z_zh,
            FuzzyPair::CCh => prefs.c_ch,
            FuzzyPair::SSh => prefs.s_sh,
            FuzzyPair::NL => prefs.n_l,
            FuzzyPair::FH => prefs.f_h,
            FuzzyPair::RL => prefs.r_l,
            FuzzyPair::InIng => prefs.in_ing,
            FuzzyPair::EnEng => prefs.en_eng,
            FuzzyPair::AnAng => prefs.an_ang,
        }
    }

    /// Write this pair's enabled state into `prefs`.
    pub const fn set(self, prefs: &mut FuzzyPrefs, on: bool) {
        match self {
            FuzzyPair::ZZh => prefs.z_zh = on,
            FuzzyPair::CCh => prefs.c_ch = on,
            FuzzyPair::SSh => prefs.s_sh = on,
            FuzzyPair::NL => prefs.n_l = on,
            FuzzyPair::FH => prefs.f_h = on,
            FuzzyPair::RL => prefs.r_l = on,
            FuzzyPair::InIng => prefs.in_ing = on,
            FuzzyPair::EnEng => prefs.en_eng = on,
            FuzzyPair::AnAng => prefs.an_ang = on,
        }
    }
}

/// The nine toggleable fuzzy pairs. All off = strict pinyin.
///
/// `#[serde(default)]` at the container level means a stored profile missing a
/// field (an older/partial write) fills it from `Default` — strict — instead of
/// failing to parse and silently dropping the user's whole profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FuzzyPrefs {
    pub z_zh: bool,
    pub c_ch: bool,
    pub s_sh: bool,
    pub n_l: bool,
    pub f_h: bool,
    pub r_l: bool,
    pub in_ing: bool,
    pub en_eng: bool,
    pub an_ang: bool,
}

impl Default for FuzzyPrefs {
    fn default() -> Self {
        Self::strict()
    }
}

impl FuzzyPrefs {
    /// All pairs off — strict pinyin matching (the default).
    pub const fn strict() -> Self {
        Self {
            z_zh: false,
            c_ch: false,
            s_sh: false,
            n_l: false,
            f_h: false,
            r_l: false,
            in_ing: false,
            en_eng: false,
            an_ang: false,
        }
    }

    /// All pairs on — the dialect-tolerant preset (southern-speaker default).
    pub const fn permissive() -> Self {
        Self {
            z_zh: true,
            c_ch: true,
            s_sh: true,
            n_l: true,
            f_h: true,
            r_l: true,
            in_ing: true,
            en_eng: true,
            an_ang: true,
        }
    }

    /// `true` iff every pair is off.
    pub fn is_strict(&self) -> bool {
        *self == Self::strict()
    }

    /// Named preset for the settings panel: `"strict"` / `"permissive"`.
    /// `None` for an unknown name.
    pub fn preset(name: &str) -> Option<Self> {
        match name {
            "strict" => Some(Self::strict()),
            "permissive" => Some(Self::permissive()),
            _ => None,
        }
    }

    /// Flip one pair in place.
    pub fn toggle(&mut self, pair: FuzzyPair) {
        pair.set(self, !pair.get(self));
    }

    /// The engine's own config for these preferences.
    pub const fn to_config(self) -> FuzzyConfig {
        FuzzyConfig {
            z_zh: self.z_zh,
            c_ch: self.c_ch,
            s_sh: self.s_sh,
            n_l: self.n_l,
            f_h: self.f_h,
            r_l: self.r_l,
            in_ing: self.in_ing,
            en_eng: self.en_eng,
            an_ang: self.an_ang,
        }
    }

    /// Mirror an engine config (round-trip helper for tests and adapters).
    pub const fn from_config(config: FuzzyConfig) -> Self {
        Self {
            z_zh: config.z_zh,
            c_ch: config.c_ch,
            s_sh: config.s_sh,
            n_l: config.n_l,
            f_h: config.f_h,
            r_l: config.r_l,
            in_ing: config.in_ing,
            en_eng: config.en_eng,
            an_ang: config.an_ang,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_and_permissive_are_opposites() {
        assert!(FuzzyPrefs::strict().is_strict());
        assert!(!FuzzyPrefs::permissive().is_strict());
        assert_eq!(FuzzyPrefs::default(), FuzzyPrefs::strict());
    }

    #[test]
    fn pair_keys_round_trip_and_cover_every_pair_once() {
        assert_eq!(FUZZY_PAIRS.len(), 9);
        let mut seen: Vec<&str> = Vec::new();
        for p in FUZZY_PAIRS {
            let key = p.key();
            assert_eq!(FuzzyPair::from_key(key), Some(p));
            assert!(!seen.contains(&key), "duplicate key {key}");
            seen.push(key);
        }
        assert_eq!(FuzzyPair::from_key("q_q"), None);
        assert_eq!(FuzzyPair::from_key(""), None);
    }

    #[test]
    fn toggle_flips_exactly_one_pair() {
        let mut prefs = FuzzyPrefs::strict();
        prefs.toggle(FuzzyPair::ZZh);
        assert!(prefs.z_zh);
        assert_eq!(
            prefs,
            FuzzyPrefs {
                z_zh: true,
                ..FuzzyPrefs::strict()
            }
        );
        prefs.toggle(FuzzyPair::ZZh);
        assert!(prefs.is_strict());
    }

    #[test]
    fn set_get_agree_for_every_pair() {
        for pair in FUZZY_PAIRS {
            let mut prefs = FuzzyPrefs::strict();
            pair.set(&mut prefs, true);
            assert!(pair.get(&prefs));
            assert!(!prefs.is_strict());
            pair.set(&mut prefs, false);
            assert!(!pair.get(&prefs));
            assert!(prefs.is_strict());
        }
    }

    #[test]
    fn presets_parse_by_name() {
        assert_eq!(FuzzyPrefs::preset("strict"), Some(FuzzyPrefs::strict()));
        assert_eq!(
            FuzzyPrefs::preset("permissive"),
            Some(FuzzyPrefs::permissive())
        );
        assert_eq!(FuzzyPrefs::preset("loose"), None);
    }

    #[test]
    fn config_conversion_round_trips() {
        for prefs in [FuzzyPrefs::strict(), FuzzyPrefs::permissive()] {
            assert_eq!(FuzzyPrefs::from_config(prefs.to_config()), prefs);
        }
    }

    #[test]
    fn partial_json_fills_missing_pairs_as_strict() {
        // A profile written by an older schema (only one pair stored) must parse.
        let prefs: FuzzyPrefs = serde_json::from_str(r#"{"z_zh": true}"#).expect("partial json");
        assert!(prefs.z_zh);
        assert!(!prefs.n_l);
        assert_eq!(
            prefs,
            FuzzyPrefs {
                z_zh: true,
                ..FuzzyPrefs::strict()
            }
        );
    }
}

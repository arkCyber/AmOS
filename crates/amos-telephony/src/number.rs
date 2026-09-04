//! Phone-number rules: a validated [`Number`] and the emergency classification
//! [`EmergencyMap`] that backs the legal 110/112 hard path.

use crate::error::{Result, TelephonyError};

/// Whether a [`Number`] is a recognized emergency code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NumberKind {
    /// A recognized emergency number (e.g. 110/112/911/999) per an [`EmergencyMap`].
    Emergency,
    /// An ordinary number that must go through the regular (SIM/telecom) path.
    Regular,
}

/// A validated, canonically-formatted phone number.
///
/// Canonical form keeps only digits and an optional leading `+` (separators such
/// as spaces / hyphens / parentheses are stripped during construction).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Number(String);

impl Number {
    /// Parse and validate a raw dial string.
    ///
    /// Empty / whitespace-only input, letters and other symbols (other than a
    /// leading `+` and the allowed separators) are rejected.
    pub fn new(raw: &str) -> Result<Self> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(TelephonyError::InvalidNumber(raw.to_string()));
        }
        let cleaned: String = trimmed
            .chars()
            .filter(|c| !matches!(c, ' ' | '-' | '(' | ')'))
            .collect();
        let mut chars = cleaned.chars();
        // Optional leading '+', then at least one ASCII digit and nothing else.
        let mut seen_digit = false;
        if let Some(first) = chars.next() {
            match first {
                '+' => {}
                c if c.is_ascii_digit() => seen_digit = true,
                _ => return Err(TelephonyError::InvalidNumber(raw.to_string())),
            }
        } else {
            return Err(TelephonyError::InvalidNumber(raw.to_string()));
        }
        for c in chars {
            if c.is_ascii_digit() {
                seen_digit = true;
            } else {
                return Err(TelephonyError::InvalidNumber(raw.to_string()));
            }
        }
        if !seen_digit {
            return Err(TelephonyError::InvalidNumber(raw.to_string()));
        }
        Ok(Self(cleaned))
    }

    /// The canonical string (digits, optional leading `+`).
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Digits only (leading `+` removed) — the form used for emergency lookup.
    pub fn digits(&self) -> String {
        self.0.trim_start_matches('+').to_string()
    }

    /// Classify against an [`EmergencyMap`].
    pub fn kind(&self, map: &EmergencyMap) -> NumberKind {
        if map.is_emergency(&self.digits()) {
            NumberKind::Emergency
        } else {
            NumberKind::Regular
        }
    }
}

/// The set of emergency codes the platform recognizes, per jurisdiction.
///
/// Code is matched on the *digits-only* form (spaces/dashes/`+` ignored), so a
/// user typing `1 1 2` still hits `112`. Matches the design's "number
/// normalization fallback" requirement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmergencyMap {
    codes: Vec<String>,
}

impl EmergencyMap {
    /// Build from raw codes (each normalized to digits).
    pub fn from_slice(codes: &[&str]) -> Self {
        Self {
            codes: codes.iter().map(|c| normalize(c)).collect(),
        }
    }

    /// A broad, commonly-shared emergency set (CN + EU + US + JP style codes).
    pub fn common_global() -> Self {
        Self::from_slice(&["110", "112", "119", "120", "122", "911", "999"])
    }

    /// Whether `digits` (already digits-only) is a recognized emergency code.
    pub fn is_emergency(&self, digits: &str) -> bool {
        self.codes.iter().any(|c| c == digits)
    }
}

/// Digits-only normalization used when building [`EmergencyMap`] codes.
fn normalize(s: &str) -> String {
    s.trim().trim_start_matches('+').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_accepts_digits_and_leading_plus() {
        assert!(Number::new("13800138000").is_ok());
        assert!(Number::new("+8613800138000").is_ok());
    }

    #[test]
    fn number_strips_common_separators() {
        let n = Number::new("1 3-8 (0013) 8000").unwrap();
        assert_eq!(n.digits(), "13800138000");
    }

    #[test]
    fn number_rejects_garbage() {
        assert_eq!(
            Number::new("").unwrap_err(),
            TelephonyError::InvalidNumber("".into())
        );
        assert!(Number::new("abc123").is_err());
        assert!(Number::new("   ").is_err());
        assert!(Number::new("+").is_err(), "lone '+' has no digits");
        assert!(Number::new("12a34").is_err());
    }

    #[test]
    fn common_map_classifies_emergency_codes() {
        let map = EmergencyMap::common_global();
        assert!(map.is_emergency("110"));
        assert!(map.is_emergency("112"));
        assert!(map.is_emergency("911"));
        assert!(!map.is_emergency("12345"));
    }

    #[test]
    fn separators_still_hit_emergency_map() {
        let map = EmergencyMap::common_global();
        // digits() strips separators and the leading '+'.
        assert_eq!(Number::new("1 1 2").unwrap().digits(), "112");
        assert_eq!(Number::new("+112").unwrap().digits(), "112");
        let n = Number::new("1 1 2").unwrap();
        assert_eq!(n.kind(&map), NumberKind::Emergency);
        let ordinary = Number::new("13800138000").unwrap();
        assert_eq!(ordinary.kind(&map), NumberKind::Regular);
    }
}

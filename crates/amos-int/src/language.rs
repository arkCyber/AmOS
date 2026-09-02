//! Language identifiers and directed pairs.

use std::fmt;

use serde::{Deserialize, Serialize};

/// A BCP-47-ish language tag, e.g. `"zh"`, `"en"`, `"ja"`, `"pt-BR"`.
///
/// Tags are normalised to lower-case on construction. The sentinel tag
/// `"auto"` means "detect from speech".
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Language(String);

impl Language {
    /// Build a language tag, normalising to lower-case. `"auto"` is reserved
    /// for language detection.
    pub fn new(tag: impl Into<String>) -> Self {
        Self(tag.into().to_ascii_lowercase())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_auto(&self) -> bool {
        self.0 == "auto"
    }

    /// The reserved "auto-detect" tag.
    pub fn auto() -> Self {
        Self("auto".to_string())
    }
}

impl Default for Language {
    fn default() -> Self {
        Self::auto()
    }
}

impl fmt::Display for Language {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for Language {
    fn from(s: &str) -> Self {
        Self::new(s)
    }
}

impl From<String> for Language {
    fn from(s: String) -> Self {
        Self::new(s)
    }
}

/// A directed language pair. The source may be `"auto"` (detected at runtime);
/// [`LanguagePair::resolve`] turns an auto source into a concrete tag once a
/// language has been detected from the first utterance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LanguagePair {
    pub source: Language,
    pub target: Language,
}

impl LanguagePair {
    pub fn new(source: impl Into<Language>, target: impl Into<Language>) -> Self {
        Self {
            source: source.into(),
            target: target.into(),
        }
    }

    /// Resolve an auto source against a detected language. When no detection is
    /// available yet, the target is used as a conservative fallback.
    pub fn resolve(&self, detected: Option<&Language>) -> LanguagePair {
        let source = if self.source.is_auto() {
            detected.cloned().unwrap_or_else(|| self.target.clone())
        } else {
            self.source.clone()
        };
        LanguagePair {
            source,
            target: self.target.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_lowercased() {
        assert_eq!(Language::new("zh-CN").as_str(), "zh-cn");
    }

    #[test]
    fn auto_is_a_sentinel() {
        assert!(Language::auto().is_auto());
        assert!(!Language::new("en").is_auto());
    }

    #[test]
    fn resolve_without_detection_falls_back_to_target() {
        let pair = LanguagePair::new("auto", "zh");
        let resolved = pair.resolve(None);
        assert_eq!(resolved.source, Language::new("zh"));
        assert_eq!(resolved.target, Language::new("zh"));
    }

    #[test]
    fn resolve_with_detection_pins_the_source() {
        let pair = LanguagePair::new("auto", "zh");
        let resolved = pair.resolve(Some(&Language::new("ja")));
        assert_eq!(resolved.source, Language::new("ja"));
        assert_eq!(resolved.target, Language::new("zh"));
    }

    #[test]
    fn explicit_source_is_untouched() {
        let pair = LanguagePair::new("en", "zh");
        let resolved = pair.resolve(Some(&Language::new("ja")));
        assert_eq!(resolved.source, Language::new("en"));
    }
}

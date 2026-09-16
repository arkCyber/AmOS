//! Language identifiers and directed pairs.

use std::fmt;

use serde::{Deserialize, Serialize};

/// A BCP-47-ish language tag, e.g. `"zh"`, `"en"`, `"ja"`, `"pt-BR"`.
///
/// Tags are normalised to lower-case on construction. The sentinel tag
/// `"auto"` means "detect from speech".
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Language(String);

/// Maximum length of a BCP-47 language tag in bytes.
///
/// Real tags are 2–5 ASCII letters (sometimes with a `-` region subtag),
/// totalling well under 16 bytes. We cap at 32 to absorb anything reasonable;
/// anything longer is either a paste attack or a bug and would propagate as a
/// giant string into the translation daemon's gRPC header.
pub const MAX_LANG_TAG_BYTES: usize = 32;

impl Language {
    /// Build a language tag, normalising to lower-case. `"auto"` is reserved
    /// for language detection.
    ///
    /// The tag is bounded to [`MAX_LANG_TAG_BYTES`] bytes; longer input is
    /// truncated to the prefix so a paste-attack caller cannot inflate every
    /// downstream gRPC header — same rationale as `MAX_AI_PROMPT_BYTES` at the
    /// `ask_ai_agent` seam.
    pub fn new(tag: impl Into<String>) -> Self {
        let raw = tag.into();
        let truncated: String = if raw.len() > MAX_LANG_TAG_BYTES {
            raw.chars().take(MAX_LANG_TAG_BYTES).collect()
        } else {
            raw
        };
        Self(truncated.to_ascii_lowercase())
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

    /// Past the [`MAX_LANG_TAG_BYTES`] cap the tag is truncated, so a paste
    /// attack cannot inflate every downstream gRPC header — the tag stays
    /// well-formed ASCII, just bounded.
    #[test]
    fn oversized_tags_are_truncated_to_the_cap() {
        // A normal real tag is well under the cap.
        assert_eq!(Language::new("zh-Hant-HK").as_str(), "zh-hant-hk");
        // A paste / buggy caller with a huge tag is clipped, not propagated.
        let huge = "x".repeat(MAX_LANG_TAG_BYTES * 4);
        let bounded = Language::new(huge);
        assert_eq!(bounded.as_str().len(), MAX_LANG_TAG_BYTES);
        assert!(
            bounded.as_str().chars().all(|c| c == 'x'),
            "truncation keeps the prefix intact"
        );
    }

    /// Real BCP-47 tags and the cap: room for a longest plausible tag (e.g. a
    /// private-use `x-…` subtag), but no headroom for a multi-kilobyte junk
    /// string to slip through.
    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn the_lang_tag_constant_has_real_headroom() {
        // Real longest tag is `zh-Hant-HK` (11 ASCII chars) — comfortably inside
        // the cap; the cap itself is short enough to fit in any reasonable log line.
        assert!(MAX_LANG_TAG_BYTES >= 12);
        assert!(MAX_LANG_TAG_BYTES < 256);
    }
}

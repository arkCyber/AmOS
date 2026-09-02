//! Transcript segments: streaming partials, finalized segments, and the
//! [`UtteranceBuilder`] that merges a stream of partials into stable text.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::language::Language;

/// Which speaker produced a segment. `"default"` covers the common single-speaker
/// case; a meeting client assigns per-participant ids.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Speaker(pub String);

impl Default for Speaker {
    fn default() -> Self {
        Self("default".to_string())
    }
}

/// One finalized utterance: recognized source text plus its translation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    /// Monotonic id within the session (1-based).
    pub id: u64,
    pub speaker: Speaker,
    pub source_text: String,
    pub source_lang: Language,
    pub target_text: String,
    pub target_lang: Language,
    /// Approximate utterance start (wall-clock offset within the session).
    pub start: Duration,
    /// Approximate utterance end.
    pub end: Duration,
}

/// In-flight, unstable recognition for the current utterance. `text` is the
/// whole thing so far; `stable` is the committed prefix that will not change.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PartialSegment {
    pub speaker: Speaker,
    pub text: String,
    pub stable: String,
    pub lang: Option<Language>,
}

fn common_prefix_len(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count()
}

/// Accumulates streaming ASR partials for one utterance.
///
/// Each [`UtteranceBuilder::update`] marks the common prefix of the previous
/// and new text as *stable* and the tail as unstable, so the UI can render a
/// committed part and a provisional part separately. [`UtteranceBuilder::finalize`]
/// returns the final source text.
#[derive(Clone, Debug)]
pub struct UtteranceBuilder {
    pub speaker: Speaker,
    pub start: Duration,
    last: String,
    stable_len: usize,
}

impl UtteranceBuilder {
    pub fn new(speaker: Speaker, start: Duration) -> Self {
        Self {
            speaker,
            start,
            last: String::new(),
            stable_len: 0,
        }
    }

    /// Merge a new partial. Returns the current [`PartialSegment`].
    pub fn update(&mut self, text: &str) -> PartialSegment {
        let common = common_prefix_len(&self.last, text);
        // `common` is a *char* count; convert to a byte offset so the slice is
        // always on a char boundary (multi-byte tags like CJK).
        let byte_len = text
            .char_indices()
            .nth(common)
            .map(|(i, _)| i)
            .unwrap_or(text.len());
        self.stable_len = byte_len;
        self.last = text.to_string();
        PartialSegment {
            speaker: self.speaker.clone(),
            text: text.to_string(),
            stable: text[..byte_len].to_string(),
            lang: None,
        }
    }

    /// The latest committed (stable) prefix, for UI progress rendering.
    pub fn stable(&self) -> &str {
        &self.last[..self.stable_len.min(self.last.len())]
    }

    /// Finish the utterance and return its full source text.
    pub fn finalize(&mut self, _now: Duration) -> String {
        std::mem::take(&mut self.last)
    }

    /// Whether no meaningful text has been accumulated yet.
    pub fn is_empty(&self) -> bool {
        self.last.trim().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zh() -> Language {
        Language::new("zh")
    }

    #[test]
    fn speaker_defaults() {
        assert_eq!(Speaker::default(), Speaker("default".to_string()));
    }

    #[test]
    fn partial_marks_common_prefix_stable() {
        let mut b = UtteranceBuilder::new(Speaker::default(), Duration::ZERO);
        let p1 = b.update("你");
        assert_eq!(p1.stable, "");
        assert_eq!(p1.text, "你");

        let p2 = b.update("你好");
        assert_eq!(p2.text, "你好");
        assert_eq!(p2.stable, "你", "common prefix 你 is now stable");

        let p3 = b.update("你好世");
        assert_eq!(p3.stable, "你好");
        assert_eq!(p3.text, "你好世");
    }

    #[test]
    fn finalize_returns_full_text_and_clears() {
        let mut b = UtteranceBuilder::new(Speaker::default(), Duration::from_millis(10));
        b.update("你好");
        b.update("你好世界");
        assert_eq!(b.finalize(Duration::from_millis(500)), "你好世界");
        assert!(b.is_empty());
    }

    #[test]
    fn partial_regression_keeps_common_prefix_stable() {
        // ASR corrects "你好世界" → "你好" (drops the tail): the stable prefix
        // must track the new text, not the old one.
        let mut b = UtteranceBuilder::new(Speaker::default(), Duration::ZERO);
        b.update("你好世界");
        let p = b.update("你好");
        assert_eq!(p.text, "你好");
        assert_eq!(p.stable, "你好", "common prefix 你好 stays stable");
        assert_eq!(b.finalize(Duration::ZERO), "你好");
    }

    #[test]
    fn partial_that_grows_elsewhere_replaces_tail() {
        let mut b = UtteranceBuilder::new(Speaker::default(), Duration::ZERO);
        b.update("你好");
        let p = b.update("你好吗");
        assert_eq!(p.text, "你好吗");
        assert_eq!(p.stable, "你好");
        assert_eq!(p.text, "你好吗");
    }

    #[test]
    fn empty_partial_never_panics() {
        let mut b = UtteranceBuilder::new(Speaker::default(), Duration::ZERO);
        assert!(b.is_empty());
        b.update("");
        assert!(b.is_empty());
        assert_eq!(b.finalize(Duration::ZERO), "");
    }

    #[test]
    fn segment_carries_source_and_target() {
        let seg = Segment {
            id: 1,
            speaker: Speaker::default(),
            source_text: "hello".to_string(),
            source_lang: Language::new("en"),
            target_text: "你好".to_string(),
            target_lang: zh(),
            start: Duration::ZERO,
            end: Duration::from_millis(300),
        };
        assert_eq!(seg.target_lang, zh());
        assert_eq!(seg.target_text, "你好");
    }
}

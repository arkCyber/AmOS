//! Session configuration and two-way ("both-mode") planning.

use serde::{Deserialize, Serialize};

use crate::language::{Language, LanguagePair};
use crate::segment::Speaker;

/// How a two-way (both-language) session should be realized.
///
/// Mirrors sokuji's `BothModePlan`: some providers can translate both
/// directions inside one session ([`BothMode::Shared`]), others need a split
/// into two sessions ([`BothMode::Split`]), and single-direction sessions use
/// [`BothMode::Disabled`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BothMode {
    /// One provider session translates both directions (auto-detect speaker
    /// language, e.g. OpenAI Realtime / Soniox two-stream).
    Shared,
    /// Two independent sessions, one per direction.
    Split,
    /// Single direction only.
    Disabled,
}

/// Immutable configuration for one interpretation session.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionConfig {
    pub languages: LanguagePair,
    pub speaker: Speaker,
    /// Whether to synthesize the translation (TTS) and emit [`TtsRequest`]s.
    pub tts_enabled: bool,
    /// Whether the source language should be pinned from the first utterance
    /// when [`LanguagePair::source`] is `"auto"`.
    pub auto_detect: bool,
    /// How many extra attempts are made after a translation failure before the
    /// session errors out (transient daemon hiccups / stale-channel reconnects
    /// are absorbed by the retry).
    pub translate_retries: usize,
}

impl SessionConfig {
    /// A single-direction session from `source` to `target`.
    pub fn one_way(source: impl Into<Language>, target: impl Into<Language>) -> Self {
        let languages = LanguagePair::new(source, target);
        Self {
            auto_detect: languages.source.is_auto(),
            languages,
            speaker: Speaker::default(),
            tts_enabled: false,
            translate_retries: 1,
        }
    }

    /// Builder-style: enable or disable TTS.
    pub fn with_tts(mut self, enabled: bool) -> Self {
        self.tts_enabled = enabled;
        self
    }

    /// Builder-style: set the session speaker label.
    pub fn with_speaker(mut self, speaker: impl Into<String>) -> Self {
        self.speaker = Speaker(speaker.into());
        self
    }

    /// Builder-style: set the number of extra translation attempts on failure.
    pub fn with_translate_retries(mut self, retries: usize) -> Self {
        self.translate_retries = retries;
        self
    }
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self::one_way("auto", "zh")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_way_defaults_to_auto_source() {
        let cfg = SessionConfig::one_way("auto", "zh");
        assert!(cfg.languages.source.is_auto());
        assert!(cfg.auto_detect);
        assert!(!cfg.tts_enabled);
    }

    #[test]
    fn explicit_source_disables_auto_detect() {
        let cfg = SessionConfig::one_way("en", "zh");
        assert!(!cfg.auto_detect);
    }

    #[test]
    fn builders_compose() {
        let cfg = SessionConfig::one_way("en", "zh")
            .with_tts(true)
            .with_speaker("participant-7");
        assert!(cfg.tts_enabled);
        assert_eq!(cfg.speaker, Speaker("participant-7".to_string()));
    }
}

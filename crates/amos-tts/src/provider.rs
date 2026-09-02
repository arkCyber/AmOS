//! The [`TtsProvider`] trait and a deterministic mock.

use std::f32::consts::TAU;

use amos_int::error::Result;
use amos_int::language::Language;
use amos_int::pipeline::TtsAudio;
use async_trait::async_trait;

/// A pluggable text-to-speech backend.
#[async_trait]
pub trait TtsProvider: Send + Sync {
    /// Backend display name.
    fn name(&self) -> &'static str;

    /// Synthesize `text` into PCM audio.
    async fn synthesize(&self, text: &str, lang: &Language) -> Result<TtsAudio>;
}

/// Deterministic [`TtsProvider`] for tests / offline demos.
///
/// Emits a short buffer: silence (or a soft 440 Hz tone when
/// [`MockTtsProvider::beep`] is set), `samples_per_char` samples per character.
#[derive(Clone, Debug)]
pub struct MockTtsProvider {
    pub sample_rate: u32,
    pub channels: u16,
    /// Samples of audio per character of input.
    pub samples_per_char: usize,
    /// Emit a soft tone instead of silence so the output is audible in demos.
    pub beep: bool,
}

impl Default for MockTtsProvider {
    fn default() -> Self {
        Self {
            sample_rate: 16_000,
            channels: 1,
            samples_per_char: 160, // 10 ms per char at 16 kHz
            beep: false,
        }
    }
}

#[async_trait]
impl TtsProvider for MockTtsProvider {
    fn name(&self) -> &'static str {
        "mock-tts"
    }

    async fn synthesize(&self, text: &str, _lang: &Language) -> Result<TtsAudio> {
        let n = text.chars().count().max(1) * self.samples_per_char;
        let samples: Vec<f32> = if self.beep {
            let sr = self.sample_rate.max(1) as f32;
            (0..n)
                .map(|i| (TAU * 440.0 * (i as f32) / sr).sin() * 0.3)
                .collect()
        } else {
            vec![0.0; n]
        };
        Ok(TtsAudio {
            sample_rate: self.sample_rate,
            channels: self.channels,
            samples,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_synthesizes_deterministic_audio() {
        let p = MockTtsProvider::default();
        let a = p.synthesize("你好", &Language::new("zh")).await.unwrap();
        assert_eq!(a.sample_rate, 16_000);
        assert_eq!(a.channels, 1);
        assert_eq!(a.samples.len(), 2 * 160, "two chars * 160 samples");
        assert!(a.samples.iter().all(|&s| s == 0.0), "silence by default");
    }

    #[tokio::test]
    async fn beep_is_audible_and_bounded() {
        let p = MockTtsProvider {
            beep: true,
            samples_per_char: 40,
            ..Default::default()
        };
        let a = p.synthesize("hi", &Language::new("en")).await.unwrap();
        assert_eq!(a.samples.len(), 80);
        assert!(
            a.samples.iter().any(|&s| s.abs() > 0.1),
            "tone is non-silent"
        );
    }

    #[tokio::test]
    async fn empty_text_still_yields_audio() {
        let p = MockTtsProvider::default();
        let a = p.synthesize("", &Language::new("zh")).await.unwrap();
        assert!(
            !a.samples.is_empty(),
            "empty text still yields a short buffer"
        );
    }

    #[tokio::test]
    async fn lang_is_accepted_but_not_required() {
        let p = MockTtsProvider::default();
        assert!(p.synthesize("hi", &Language::new("fr")).await.is_ok());
    }
}

//! Local Piper TTS backend (feature `piper`).
//!
//! Wraps `piper-rs` so a Piper `.onnx` model + voice `.json` can synthesize
//! on-device. Requires model files and the `piper` feature:
//!
//! ```bash
//! cargo build -p amos-tts --features piper
//! ```
//!
//! Note: `piper-rs` may pull native dependencies (espeak-ng / onnxruntime) and
//! needs network to fetch them. This module is written against piper-rs 0.2's
//! documented API; verify the exact `Piper`/`PiperConfig` surface with a local
//! `--features piper` build.

use amos_int::error::{InterpretationError, Result};
use amos_int::language::Language;
use amos_int::pipeline::TtsAudio;
use async_trait::async_trait;
use piper_rs::{Piper, PiperConfig};

use crate::provider::TtsProvider;

/// A [`TtsProvider`] backed by a local Piper model.
pub struct PiperProvider {
    piper: Piper,
    sample_rate: u32,
}

impl PiperProvider {
    /// Load a Piper model from `model` (`.onnx`) and its `voice` config (`.json`).
    pub fn new(model: std::path::PathBuf, voice: std::path::PathBuf) -> anyhow::Result<Self> {
        let config = PiperConfig {
            model,
            voice: Some(voice),
            ..Default::default()
        };
        let piper = Piper::new(config)?;
        let sample_rate = piper.sample_rate();
        Ok(Self {
            piper,
            sample_rate: sample_rate as u32,
        })
    }
}

#[async_trait]
impl TtsProvider for PiperProvider {
    fn name(&self) -> &'static str {
        "piper"
    }

    async fn synthesize(&self, text: &str, _lang: &Language) -> Result<TtsAudio> {
        let text = text.to_string();
        let sr = self.sample_rate;
        let piper = &self.piper;
        let samples: Vec<i16> = tokio::task::spawn_blocking(move || {
            piper
                .synthesize(&text)
                .map_err(|e| InterpretationError::Other(e.to_string()))
        })
        .await
        .map_err(|e| InterpretationError::Other(format!("piper task join: {e}")))??;

        Ok(TtsAudio {
            sample_rate: sr,
            channels: 1,
            samples: samples.into_iter().map(|s| s as f32 / 32767.0).collect(),
        })
    }
}

//! Local Piper TTS backend (feature `piper`).
//!
//! Wraps `piper-rs` so a Piper `.onnx` model + voice `.json` can synthesize
//! on-device. Requires model files and the `piper` feature:
//!
//! ```bash
//! cargo build -p amos-tts --features piper
//! ```
//!
//! Note: `piper-rs` pulls native deps (onnxruntime + espeak-ng) and needs network
//! to fetch them. Verified against piper-rs 0.2.0's real API:
//! `Piper::new(model_path, config_path)` and `Piper::create(&mut self, text, …)`
//! returning `(Vec<f32> samples, u32 sample_rate)`. Because `create` needs
//! `&mut self` while [`TtsProvider::synthesize`] takes `&self`, the `Piper` is
//! held in an `Arc<Mutex<Piper>>` and driven on a blocking task.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use amos_int::error::{InterpretationError, Result};
use amos_int::language::Language;
use amos_int::pipeline::TtsAudio;
use async_trait::async_trait;
use piper_rs::Piper;

use crate::provider::TtsProvider;

/// A [`TtsProvider`] backed by a local Piper model.
pub struct PiperProvider {
    piper: Arc<Mutex<Piper>>,
}

impl PiperProvider {
    /// Load a Piper model from `model` (`.onnx`) and its `voice` config (`.json`).
    pub fn new(model: PathBuf, voice: PathBuf) -> anyhow::Result<Self> {
        let piper = Piper::new(&model, &voice)?;
        Ok(Self {
            piper: Arc::new(Mutex::new(piper)),
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
        let piper = Arc::clone(&self.piper);
        let (samples, sample_rate) = tokio::task::spawn_blocking(move || {
            let mut guard = piper.lock().unwrap_or_else(|e| e.into_inner());
            guard
                .create(&text, false, None, None, None, None)
                .map_err(|e| InterpretationError::Other(e.to_string()))
        })
        .await
        .map_err(|e| InterpretationError::Other(format!("piper task join: {e}")))??;

        Ok(TtsAudio {
            sample_rate,
            channels: 1,
            samples,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_int::language::Language;

    /// Real Piper synthesis: model dir must exist on disk and the `piper` native
    /// deps must be linked. Run with:
    ///   AMOS_PIPER_MODEL_DIR=$PWD/models/piper-low \
    ///     cargo test -p amos-tts --features piper -- --ignored synthesizes_real_pcm
    #[tokio::test]
    #[ignore = "requires AMOS_PIPER_MODEL_DIR with a Piper onnx+json + native libs"]
    async fn synthesizes_real_pcm() {
        let dir = std::env::var("AMOS_PIPER_MODEL_DIR").expect("set AMOS_PIPER_MODEL_DIR");
        let base = PathBuf::from(&dir);
        let mut onnx: Option<PathBuf> = None;
        let mut json: Option<PathBuf> = None;
        for stem in ["en_US-lessac-medium", "en_US-lessac-low"] {
            let o = base.join(format!("{stem}.onnx"));
            let j = base.join(format!("{stem}.onnx.json"));
            if o.exists() && j.exists() {
                onnx = Some(o);
                json = Some(j);
                break;
            }
        }
        let onnx = onnx.expect("found a .onnx + .onnx.json pair in AMOS_PIPER_MODEL_DIR");
        let json = json.unwrap();
        let provider = PiperProvider::new(onnx, json).expect("load piper model");
        let audio = provider
            .synthesize("hello amos world", &Language::new("en"))
            .await
            .expect("piper synthesized audio");
        assert!(audio.sample_rate > 0, "sample rate > 0");
        assert!(audio.channels >= 1);
        assert!(!audio.samples.is_empty(), "produced PCM samples");
    }
}

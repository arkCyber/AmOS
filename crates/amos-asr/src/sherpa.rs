//! sherpa-onnx streaming ASR backend (feature `sherpa`).
//!
//! Wraps `sherpa-onnx`'s [`OnlineRecognizer`] as a [`StreamingRecognizer`] so it
//! can feed `AsrEvent::Partial`/`Final` into `amos-int` sessions. Requires model
//! files on disk (see [`SherpaOnlineRecognizerConfig`]) and the `sherpa` feature:
//!
//! ```bash
//! cargo build -p amos-asr --features sherpa
//! ```
//!
//! Note: `sherpa-onnx` downloads a prebuilt native library from GitHub releases
//! during its build (or uses `SHERPA_ONNX_LIB_DIR`). Verified against the
//! sherpa-onnx 1.13.7 Rust API (root-level `OnlineRecognizer`/`OnlineModelConfig`
//! types, `OnlineRecognizer::create`, `OnlineStream::accept_waveform(i32, &[f32])`,
//! `OnlineRecognizer::decode`).

use amos_int::language::Language;

use crate::recognizer::{Hypothesis, StreamingRecognizer};

/// File paths for a sherpa-onnx streaming (transducer/zipformer) model.
#[derive(Clone, Debug)]
pub struct SherpaOnlineRecognizerConfig {
    /// Path to `tokens.txt`.
    pub tokens: std::path::PathBuf,
    /// `encoder.onnx`
    pub encoder: std::path::PathBuf,
    /// `decoder.onnx`
    pub decoder: std::path::PathBuf,
    /// `joiner.onnx`
    pub joiner: std::path::PathBuf,
    pub sample_rate: u32,
    pub feature_dim: usize,
    pub num_threads: usize,
    /// Enable sherpa's built-in endpoint detection.
    pub enable_endpoint: bool,
    pub lang: Language,
}

impl Default for SherpaOnlineRecognizerConfig {
    fn default() -> Self {
        Self {
            tokens: "/models/sherpa-onnx/tokens.txt".into(),
            encoder: "/models/sherpa-onnx/encoder.onnx".into(),
            decoder: "/models/sherpa-onnx/decoder.onnx".into(),
            joiner: "/models/sherpa-onnx/joiner.onnx".into(),
            sample_rate: 16_000,
            feature_dim: 80,
            num_threads: 2,
            enable_endpoint: true,
            lang: Language::new("auto"),
        }
    }
}

/// A [`StreamingRecognizer`] backed by sherpa-onnx's online recognizer.
pub struct SherpaOnlineRecognizer {
    inner: sherpa_onnx::OnlineRecognizer,
    stream: sherpa_onnx::OnlineStream,
    cfg: SherpaOnlineRecognizerConfig,
    last: Option<String>,
}

impl SherpaOnlineRecognizer {
    /// Build the recognizer, loading the model files from `cfg`.
    pub fn new(cfg: SherpaOnlineRecognizerConfig) -> anyhow::Result<Self> {
        use sherpa_onnx::{
            OnlineModelConfig, OnlineRecognizer, OnlineRecognizerConfig,
            OnlineTransducerModelConfig,
        };

        let model_config = OnlineModelConfig {
            transducer: OnlineTransducerModelConfig {
                encoder: Some(cfg.encoder.display().to_string()),
                decoder: Some(cfg.decoder.display().to_string()),
                joiner: Some(cfg.joiner.display().to_string()),
            },
            tokens: Some(cfg.tokens.display().to_string()),
            num_threads: cfg.num_threads as i32,
            ..Default::default()
        };
        // `OnlineRecognizerConfig::default()` already sets feat_config to the
        // 16 kHz / 80-dim we need, so only the model + endpoint options differ.
        let config = OnlineRecognizerConfig {
            model_config,
            enable_endpoint: cfg.enable_endpoint,
            rule1_min_trailing_silence: 2.4,
            rule2_min_trailing_silence: 1.2,
            rule3_min_utterance_length: 300.0,
            ..Default::default()
        };

        let inner = OnlineRecognizer::create(&config).ok_or_else(|| {
            anyhow::anyhow!("sherpa-onnx: failed to create online recognizer (check model paths)")
        })?;
        let stream = inner.create_stream();
        Ok(Self {
            inner,
            stream,
            cfg,
            last: None,
        })
    }
}

impl StreamingRecognizer for SherpaOnlineRecognizer {
    fn reset(&mut self) {
        self.inner.reset(&self.stream);
        self.last = None;
    }

    fn push_samples(&mut self, samples: &[f32]) -> Option<Hypothesis> {
        if samples.is_empty() {
            return None;
        }
        self.stream
            .accept_waveform(self.cfg.sample_rate as i32, samples);
        self.inner.decode(&self.stream);
        let text = self
            .inner
            .get_result(&self.stream)
            .map(|r| r.text.trim().to_string())
            .unwrap_or_default();
        if text.is_empty() || Some(&text) == self.last.as_ref() {
            return None;
        }
        self.last = Some(text.clone());
        Some(Hypothesis {
            stable: text.clone(),
            text,
            lang: Some(self.cfg.lang.clone()),
        })
    }

    fn is_endpoint(&self) -> bool {
        self.cfg.enable_endpoint && self.inner.is_endpoint(&self.stream)
    }

    fn finalize(&mut self) -> String {
        let text = self
            .inner
            .get_result(&self.stream)
            .map(|r| r.text.trim().to_string())
            .unwrap_or_default();
        self.inner.reset(&self.stream);
        self.last = None;
        text
    }
}

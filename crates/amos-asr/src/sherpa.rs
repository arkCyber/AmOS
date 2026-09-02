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
//! Note: the `sherpa-onnx` crate's build script downloads a prebuilt native
//! library from GitHub releases (or uses `SHERPA_ONNX_LIB_DIR`). Offline/build
//! sandboxes must set `SHERPA_ONNX_LIB_DIR` to a populated directory. This
//! module is written against sherpa-onnx 1.13.7's documented API; verify the
//! exact `*Config` field names with a local `--features sherpa` build.

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
    pub enable_endpoint_detection: bool,
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
            enable_endpoint_detection: true,
            lang: Language::new("auto"),
        }
    }
}

/// A [`StreamingRecognizer`] backed by sherpa-onnx's online recognizer.
pub struct SherpaOnlineRecognizer {
    inner: sherpa_onnx::online_recognizer::OnlineRecognizer,
    stream: sherpa_onnx::online_recognizer::OnlineStream,
    cfg: SherpaOnlineRecognizerConfig,
    last: Option<String>,
}

impl SherpaOnlineRecognizer {
    /// Build the recognizer, loading the model files from `cfg`.
    pub fn new(cfg: SherpaOnlineRecognizerConfig) -> anyhow::Result<Self> {
        use sherpa_onnx::{
            feature_config::FeatureConfig,
            model_config::OnlineModelConfig,
            online_recognizer::{OnlineRecognizer, OnlineRecognizerConfig},
        };

        let mut model_config = OnlineModelConfig {
            transducer: sherpa_onnx::model_config::OnlineTransducerModelConfig {
                encoder: cfg.encoder.display().to_string(),
                decoder: cfg.decoder.display().to_string(),
                joiner: cfg.joiner.display().to_string(),
            },
            tokens: cfg.tokens.display().to_string(),
            ..Default::default()
        };
        model_config.num_threads = cfg.num_threads;

        let config = OnlineRecognizerConfig {
            feat_config: FeatureConfig {
                sample_rate: cfg.sample_rate as f32,
                feature_dim: cfg.feature_dim,
                ..Default::default()
            },
            model_config,
            enable_endpoint_detection: cfg.enable_endpoint_detection,
            // Trailing-silence endpoints (seconds); these fields exist when
            // endpoint detection is on.
            rule1_min_trailing_silence: 2.4,
            rule2_min_trailing_silence: 1.2,
            rule3_min_utterance_length: 300.0,
            ..Default::default()
        };

        let inner = OnlineRecognizer::new(config)
            .map_err(|e| anyhow::anyhow!("sherpa-onnx init failed: {e}"))?;
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
        self.inner.reset(&mut self.stream);
        self.last = None;
    }

    fn push_samples(&mut self, samples: &[f32]) -> Option<Hypothesis> {
        if samples.is_empty() {
            return None;
        }
        self.stream
            .accept_waveform(self.cfg.sample_rate as f32, samples);
        self.inner.decode_stream(&mut self.stream);
        let result = self.inner.get_result(&self.stream);
        let text = result.text.trim().to_string();
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
        self.cfg.enable_endpoint_detection && self.inner.is_endpoint(&self.stream)
    }

    fn finalize(&mut self) -> String {
        let result = self.inner.get_result(&self.stream);
        let text = result.text.trim().to_string();
        self.inner.reset(&mut self.stream);
        self.last = None;
        text
    }
}

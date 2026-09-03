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

/// Build a composite pipeline from a **local sherpa streaming ASR** plus an
/// optional translation delegate (e.g. a `GrpcPipeline` to the amos-translate
/// daemon). This is the seam a System UI / CLI would use to run real local ASR
/// inside an `amos_int::Session` without linking the native sherpa lib into the
/// GUI itself.
///
/// ```rust,no_run
/// # use amos_asr::{sherpa_pipeline, SherpaOnlineRecognizerConfig};
/// let cfg = SherpaOnlineRecognizerConfig {
///     tokens: "models/sherpa-en-20m/tokens.txt".into(),
///     encoder: "models/sherpa-en-20m/encoder-epoch-99-avg-1.int8.onnx".into(),
///     decoder: "models/sherpa-en-20m/decoder-epoch-99-avg-1.int8.onnx".into(),
///     joiner: "models/sherpa-en-20m/joiner-epoch-99-avg-1.int8.onnx".into(),
///     ..Default::default()
/// };
/// let pipeline = sherpa_pipeline(cfg, None).unwrap();
/// # let _ = pipeline;
/// ```
pub fn sherpa_pipeline(
    cfg: SherpaOnlineRecognizerConfig,
    translate: Option<std::sync::Arc<dyn amos_int::pipeline::Pipeline>>,
) -> anyhow::Result<crate::pipeline::AsrPipeline<SherpaOnlineRecognizer>> {
    let recognizer = SherpaOnlineRecognizer::new(cfg.clone())?;
    let mut builder = crate::pipeline::AsrPipelineBuilder::new(recognizer, cfg.lang);
    if let Some(t) = translate {
        builder = builder.with_translate(t);
    }
    Ok(builder.build())
}

/// Recognize a **whole recording** (e.g. the audio buffer of an RPC `Transcribe`
/// request) and return the final hypothesis text. Feeds the buffer through the
/// streaming recognizer in chunks, then finalizes. Deterministic and reusable by
/// both the native System UI path and a daemon `SpeechRecognizer`.
pub fn transcribe_buffer(
    cfg: SherpaOnlineRecognizerConfig,
    samples: &[f32],
) -> anyhow::Result<String> {
    let mut recognizer = SherpaOnlineRecognizer::new(cfg)?;
    // Feed in ~400 ms chunks (6400 @16 kHz): streaming decoders need enough
    // buffered audio per decode to produce features — too-fine chunks (e.g.
    // 4096) can trip sherpa's internal frame assertion on short clips.
    const CHUNK: usize = 6400;
    for chunk in samples.chunks(CHUNK) {
        let _ = recognizer.push_samples(chunk);
    }
    Ok(recognizer.finalize().trim().to_string())
}

/// Decode a 16-bit mono PCM WAV into `(sample_rate, f32 samples)`. Minimal but
/// sufficient for the bundled demo clips (used by tests / examples).
pub fn decode_pcm16_wav(bytes: &[u8]) -> Option<(u32, Vec<f32>)> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut i = 12;
    let mut sample_rate = 0u32;
    let mut channels = 1u16;
    let mut data: Option<&[u8]> = None;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size =
            u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
        i += 8;
        match id {
            b"fmt " if size >= 16 => {
                channels = u16::from_le_bytes([bytes[i + 2], bytes[i + 3]]);
                sample_rate =
                    u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]);
                i += size;
            }
            b"data" => {
                data = Some(&bytes[i..(i + size).min(bytes.len())]);
                i += size;
            }
            _ => i += size,
        }
    }
    let pcm = data?;
    let mut out = Vec::with_capacity(pcm.len() / 2);
    for pair in pcm.chunks_exact(2) {
        let v = i16::from_le_bytes([pair[0], pair[1]]);
        out.push(v as f32 / 32768.0);
    }
    if channels != 1 {
        // Down-mix to mono by dropping extra channels (demo clips are mono).
        out = out.iter().step_by(channels as usize).copied().collect();
    }
    Some((sample_rate, out))
}

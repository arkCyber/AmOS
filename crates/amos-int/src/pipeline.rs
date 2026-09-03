//! The pluggable provider pipeline.
//!
//! This is the single seam every provider (cloud realtime, local sherpa-onnx,
//! mock) implements — the `amos-int` analogue of sokuji's
//! `ProviderDescriptor`/`IClient`. The engine depends only on this trait, so a
//! provider can be swapped without touching the session machine, the CLI, or
//! the Tauri UI.

use std::time::Duration;

use async_trait::async_trait;

use crate::config::BothMode;
use crate::error::Result;
use crate::event::TtsRequest;
use crate::language::Language;
use crate::segment::{PartialSegment, Speaker};

/// Static facts about a provider, surfaced to setup/status UIs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PipelineInfo {
    pub provider: String,
    pub model: Option<String>,
    pub streaming_asr: bool,
    pub tts: bool,
    pub both_mode: BothMode,
}

/// A source utterance handed to [`Pipeline::translate`].
#[derive(Clone, Copy, Debug)]
pub struct SourceText<'a> {
    pub text: &'a str,
    pub lang: &'a Language,
    pub speaker: &'a Speaker,
}

/// A translated source utterance.
#[derive(Clone, Debug, PartialEq)]
pub struct Translation {
    pub target_text: String,
    pub target_lang: Language,
}

/// Synthesized speech, as raw interleaved f32 samples.
#[derive(Clone, Debug, PartialEq)]
pub struct TtsAudio {
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
}

/// Recognition events emitted by streaming ASR.
#[derive(Clone, Debug)]
pub enum AsrEvent {
    /// An in-flight, unstable partial for the current utterance.
    Partial(PartialSegment),
    /// The utterance was finalized.
    Final {
        text: String,
        lang: Language,
        start: Duration,
        end: Duration,
    },
}

/// A live provider pipeline: streaming ASR + translation + TTS.
#[async_trait]
pub trait Pipeline: Send + Sync {
    /// Static provider facts.
    fn info(&self) -> PipelineInfo;

    /// Feed one chunk of mono PCM (16 kHz f32). Returns any recognition events
    /// that completed (partials and, when the utterance ends, a final), or an
    /// error if the provider is unreachable.
    async fn feed_audio(&self, chunk: &[f32]) -> Result<Vec<AsrEvent>>;

    /// Optional: ask the pipeline to *flush* the current utterance — finalize any
    /// in-flight recognition that hasn't signalled an endpoint yet (e.g. a
    /// streaming ASR fed a finite clip or told to stop). Returns any finalization
    /// events. Recognizer-backed pipelines override this; the default is a no-op.
    async fn end_of_utterance(&self) -> Result<Vec<AsrEvent>> {
        Ok(Vec::new())
    }

    /// Translate a finalized source utterance.
    async fn translate(&self, src: SourceText<'_>) -> Result<Translation>;

    /// Synthesize the translation to audio.
    async fn synthesize(&self, req: &TtsRequest) -> Result<TtsAudio>;
}

/// A deterministic pipeline for tests and for the daemon's offline mode.
///
/// After [`MockPipeline::stream_chunks`] audio chunks it emits one partial then
/// a final containing [`MockPipeline::recognized`]; translation echoes the text
/// with its language marker (`"[zh] 你好"`); TTS returns silence.
pub struct MockPipeline {
    pub recognized: String,
    pub source_lang: Language,
    /// Number of audio chunks before the utterance finalizes.
    pub stream_chunks: usize,
    pub tts_enabled: bool,
    chunks: std::sync::Mutex<usize>,
}

impl MockPipeline {
    pub fn new(recognized: impl Into<String>, source_lang: impl Into<Language>) -> Self {
        Self {
            recognized: recognized.into(),
            source_lang: source_lang.into(),
            stream_chunks: 1,
            tts_enabled: true,
            chunks: std::sync::Mutex::new(0),
        }
    }
}

#[async_trait]
impl Pipeline for MockPipeline {
    fn info(&self) -> PipelineInfo {
        PipelineInfo {
            provider: "mock".to_string(),
            model: None,
            streaming_asr: true,
            tts: self.tts_enabled,
            both_mode: BothMode::Disabled,
        }
    }

    async fn feed_audio(&self, chunk: &[f32]) -> Result<Vec<AsrEvent>> {
        let mut out = Vec::new();
        if chunk.is_empty() {
            return Ok(out);
        }
        // Poison-safe lock: a panicked thread must not take the session down.
        let mut n = self.chunks.lock().unwrap_or_else(|p| p.into_inner());
        *n += 1;
        if *n == 1 {
            out.push(AsrEvent::Partial(PartialSegment {
                speaker: Speaker::default(),
                text: self.recognized.clone(),
                stable: String::new(),
                lang: Some(self.source_lang.clone()),
            }));
        }
        if *n >= self.stream_chunks {
            out.push(AsrEvent::Final {
                text: self.recognized.clone(),
                lang: self.source_lang.clone(),
                start: Duration::ZERO,
                end: Duration::from_millis(100),
            });
        }
        Ok(out)
    }

    async fn translate(&self, src: SourceText<'_>) -> Result<Translation> {
        Ok(Translation {
            target_text: format!("[{}] {}", src.lang, src.text),
            target_lang: src.lang.clone(),
        })
    }

    async fn synthesize(&self, req: &TtsRequest) -> Result<TtsAudio> {
        Ok(TtsAudio {
            sample_rate: 16_000,
            channels: 1,
            samples: vec![0.0; req.text.len().max(1) * 160],
        })
    }
}

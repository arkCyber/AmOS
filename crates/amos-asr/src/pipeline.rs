//! [`AsrPipeline`] — adapts a [`StreamingRecognizer`] to `amos_int::Pipeline`.

use std::sync::Arc;
use std::time::Duration;

use amos_int::config::BothMode;
use amos_int::error::{InterpretationError, Result};
use amos_int::event::TtsRequest;
use amos_int::language::Language;
use amos_int::pipeline::{AsrEvent, Pipeline, PipelineInfo, SourceText, Translation, TtsAudio};
use amos_int::segment::{PartialSegment, Speaker};
use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::recognizer::StreamingRecognizer;

/// An `amos_int::Pipeline` backed by a streaming recognizer.
///
/// `feed_audio` buffers PCM into the [`StreamingRecognizer`], emitting
/// `AsrEvent::Partial` as the hypothesis grows and `AsrEvent::Final` when the
/// recognizer signals an endpoint. Translation/TTS delegate to an optional
/// inner pipeline (e.g. `GrpcPipeline` → amos-translate), so a composite
/// pipeline yields *local streaming ASR + remote translation*.
///
/// Use [`AsrPipelineBuilder`] to construct with a translation delegate.
pub struct AsrPipeline<R: StreamingRecognizer + Send> {
    recognizer: Mutex<R>,
    translate: Option<Arc<dyn Pipeline>>,
    source_lang: Language,
}

impl<R: StreamingRecognizer + Send> AsrPipeline<R> {
    /// ASR-only pipeline (translation returns an error).
    pub fn new(recognizer: R, source_lang: impl Into<Language>) -> Self {
        Self {
            recognizer: Mutex::new(recognizer),
            translate: None,
            source_lang: source_lang.into(),
        }
    }
}

/// Builder for an [`AsrPipeline`] with an optional translation delegate.
pub struct AsrPipelineBuilder<R: StreamingRecognizer + Send> {
    recognizer: R,
    translate: Option<Arc<dyn Pipeline>>,
    source_lang: Language,
}

impl<R: StreamingRecognizer + Send> AsrPipelineBuilder<R> {
    pub fn new(recognizer: R, source_lang: impl Into<Language>) -> Self {
        Self {
            recognizer,
            translate: None,
            source_lang: source_lang.into(),
        }
    }

    /// Delegate translation (and TTS) to `pipeline` — e.g. a `GrpcPipeline`.
    pub fn with_translate(mut self, pipeline: Arc<dyn Pipeline>) -> Self {
        self.translate = Some(pipeline);
        self
    }

    pub fn build(self) -> AsrPipeline<R> {
        AsrPipeline {
            recognizer: Mutex::new(self.recognizer),
            translate: self.translate,
            source_lang: self.source_lang,
        }
    }
}

#[async_trait]
impl<R: StreamingRecognizer + Send + Sync + 'static> Pipeline for AsrPipeline<R> {
    fn info(&self) -> PipelineInfo {
        PipelineInfo {
            provider: "amos-asr".to_string(),
            model: None,
            streaming_asr: true,
            tts: self
                .translate
                .as_ref()
                .map(|t| t.info().tts)
                .unwrap_or(false),
            both_mode: BothMode::Disabled,
        }
    }

    async fn feed_audio(&self, chunk: &[f32]) -> Result<Vec<AsrEvent>> {
        let mut events = Vec::new();
        let mut rec = self.recognizer.lock().await;
        if let Some(h) = rec.push_samples(chunk) {
            events.push(AsrEvent::Partial(PartialSegment {
                speaker: Speaker::default(),
                text: h.text,
                stable: h.stable,
                lang: h.lang,
            }));
        }
        if rec.is_endpoint() {
            let text = rec.finalize();
            if !text.trim().is_empty() {
                events.push(AsrEvent::Final {
                    text,
                    lang: self.source_lang.clone(),
                    start: Duration::ZERO,
                    end: Duration::ZERO,
                });
            }
            rec.reset();
        }
        Ok(events)
    }

    async fn translate(&self, src: SourceText<'_>) -> Result<Translation> {
        match &self.translate {
            Some(t) => t.translate(src).await,
            None => Err(InterpretationError::Other(
                "AsrPipeline does not translate; attach a translation pipeline".into(),
            )),
        }
    }

    async fn synthesize(&self, req: &TtsRequest) -> Result<TtsAudio> {
        match &self.translate {
            Some(t) => t.synthesize(req).await,
            None => Err(InterpretationError::Other(
                "AsrPipeline has no TTS backend".into(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recognizer::MockStreamingRecognizer;

    #[test]
    fn feed_audio_yields_partials_then_final() {
        // 3 words, endpoint after 3 -> partials on each 160-sample frame, final on the 3rd.
        let pipe = AsrPipeline::new(
            MockStreamingRecognizer::new(["你", "好", "，Amos"], 3),
            "zh",
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let p1 = pipe.feed_audio(&vec![0.0; 160]).await.unwrap();
            assert_eq!(p1.len(), 1);
            assert!(matches!(&p1[0], AsrEvent::Partial(p) if p.text == "你"));

            let p2 = pipe.feed_audio(&vec![0.0; 160]).await.unwrap();
            assert!(matches!(&p2[0], AsrEvent::Partial(p) if p.text == "你好"));

            // Third frame triggers the endpoint -> partial + final.
            let p3 = pipe.feed_audio(&vec![0.0; 160]).await.unwrap();
            assert!(p3
                .iter()
                .any(|e| matches!(e, AsrEvent::Final { text, .. } if text == "你好，Amos")));
            // After reset, next frame starts a fresh partial.
            let p4 = pipe.feed_audio(&vec![0.0; 160]).await.unwrap();
            assert!(matches!(&p4[0], AsrEvent::Partial(p) if p.text == "你"));
        });
    }

    #[test]
    fn translate_without_delegate_errors() {
        use amos_int::error::InterpretationError;
        use amos_int::language::Language;
        use amos_int::pipeline::SourceText;
        use amos_int::segment::Speaker;
        // No translate delegate attached.
        let pipe = AsrPipeline::new(MockStreamingRecognizer::new(["x"], 1), "zh");
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let err = pipe
                .translate(SourceText {
                    text: "hi",
                    lang: &Language::new("en"),
                    speaker: &Speaker::default(),
                })
                .await
                .unwrap_err();
            assert!(matches!(err, InterpretationError::Other(_)), "{err}");
        });
    }
}

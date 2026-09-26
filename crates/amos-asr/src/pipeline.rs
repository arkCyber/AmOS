//! [`AsrPipeline`] — adapts a [`StreamingRecognizer`] to `amos_int::Pipeline`.

use std::sync::Arc;
use std::time::Duration;

use amos_int::config::BothMode;
use amos_int::error::{InterpretationError, Result};
use amos_int::event::TtsRequest;
use amos_int::language::Language;
use amos_int::pipeline::{
    samples_to_duration, AsrEvent, Pipeline, PipelineInfo, SourceText, Translation, TtsAudio,
};
use amos_int::segment::{PartialSegment, Speaker};
use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::recognizer::StreamingRecognizer;

/// The recognizer plus the **audio clock** that gives each utterance its real
/// time bounds. The streaming path is the only place that sees the audio, so it
/// is the only place that can say where in the stream an utterance began and
/// ended — the [`AsrEvent::Final`] `start`/`end` fields downstream consumers
/// (e.g. `amos_int`'s `Segment`) read as utterance time.
struct AsrState<R> {
    recognizer: R,
    /// Stream-relative audio consumed since the pipeline started.
    fed: Duration,
    /// Stream-relative offset at which the current utterance began.
    utterance_start: Duration,
}

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
    state: Mutex<AsrState<R>>,
    translate: Option<Arc<dyn Pipeline>>,
    source_lang: Language,
}

impl<R: StreamingRecognizer + Send> AsrPipeline<R> {
    fn state(recognizer: R) -> Mutex<AsrState<R>> {
        Mutex::new(AsrState {
            recognizer,
            fed: Duration::ZERO,
            utterance_start: Duration::ZERO,
        })
    }

    /// ASR-only pipeline (translation returns an error).
    pub fn new(recognizer: R, source_lang: impl Into<Language>) -> Self {
        Self {
            state: Self::state(recognizer),
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
            state: AsrPipeline::state(self.recognizer),
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
        let mut st = self.state.lock().await;
        // Advance the audio clock by the chunk's duration *before* the endpoint
        // decision, so a finalizing utterance's `end` includes the audio that
        // just completed it.
        st.fed += samples_to_duration(chunk.len());
        if let Some(h) = st.recognizer.push_samples(chunk) {
            events.push(AsrEvent::Partial(PartialSegment {
                speaker: Speaker::default(),
                text: h.text,
                stable: h.stable,
                lang: h.lang,
            }));
        }
        if st.recognizer.is_endpoint() {
            let text = st.recognizer.finalize();
            if !text.trim().is_empty() {
                events.push(AsrEvent::Final {
                    text,
                    lang: self.source_lang.clone(),
                    start: st.utterance_start,
                    end: st.fed,
                });
            }
            st.recognizer.reset();
            // The next utterance begins where this one ended.
            st.utterance_start = st.fed;
        }
        Ok(events)
    }

    async fn end_of_utterance(&self) -> Result<Vec<AsrEvent>> {
        // Flush the recognizer's in-flight utterance even if it never signalled
        // an endpoint (finite clip, forced stop). Reset for the next utterance.
        let mut events = Vec::new();
        let mut st = self.state.lock().await;
        let text = st.recognizer.finalize();
        st.recognizer.reset();
        let start = st.utterance_start;
        let end = st.fed;
        st.utterance_start = st.fed;
        if !text.trim().is_empty() {
            events.push(AsrEvent::Final {
                text,
                lang: self.source_lang.clone(),
                start,
                end,
            });
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

    /// The finalized utterance must carry its real time bounds within the stream:
    /// `start` where the utterance began, `end` where it ended. Both were
    /// hard-coded to `Duration::ZERO`, so every finalized segment claimed a
    /// zero-width utterance at t=0 — the declared "utterance start/end"
    /// measurement that no code path established, even though this pipeline is
    /// the one component that sees the audio and can supply it (REQ-A611).
    ///
    /// One 160-sample frame at 16 kHz is exactly 10 ms.
    #[test]
    fn finalized_utterance_carries_its_real_time_bounds() {
        let pipe = AsrPipeline::new(
            MockStreamingRecognizer::new(["你", "好", "，Amos"], 3),
            "zh",
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let frame = vec![0.0f32; 160]; // 10 ms

            let first = collect_final(&pipe, &frame, 3).await;
            let (start, end) = first.expect("the first utterance finalizes at the endpoint");
            assert_eq!(
                start,
                Duration::ZERO,
                "the first utterance begins at the stream origin"
            );
            assert_eq!(
                end,
                Duration::from_millis(30),
                "three 10 ms frames of audio = 30 ms"
            );
            assert!(end > start, "an utterance is not zero-width");

            // A second utterance's bounds start where the first ended.
            let second = collect_final(&pipe, &frame, 3).await;
            let (start2, end2) = second.expect("the second utterance finalizes too");
            assert_eq!(
                start2,
                Duration::from_millis(30),
                "the second utterance begins where the first ended"
            );
            assert_eq!(
                end2,
                Duration::from_millis(60),
                "and ends 30 ms of audio later"
            );
        });
    }

    /// Feed `frames` frames and return the first `AsrEvent::Final` seen.
    async fn collect_final(
        pipe: &AsrPipeline<MockStreamingRecognizer>,
        frame: &[f32],
        frames: usize,
    ) -> Option<(Duration, Duration)> {
        for _ in 0..frames {
            for ev in pipe.feed_audio(frame).await.unwrap() {
                if let AsrEvent::Final { start, end, .. } = ev {
                    return Some((start, end));
                }
            }
        }
        None
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

    #[test]
    fn end_of_utterance_flushes_without_endpoint() {
        // endpoint_after (10) > word count so feed_audio never auto-finalizes;
        // only end_of_utterance finalizes the utterance.
        let pipe = AsrPipeline::new(
            MockStreamingRecognizer::new(["你", "好", "世界"], 10).with_samples_per_partial(160),
            "zh",
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            // Feed enough partials but never reach the endpoint threshold.
            for _ in 0..5 {
                let ev = pipe.feed_audio(&vec![0.0; 160]).await.unwrap();
                assert!(
                    ev.iter().all(|e| matches!(e, AsrEvent::Partial(_))),
                    "no final yet"
                );
            }
            // Flush -> the accumulated utterance is finalized.
            let flushed = pipe.end_of_utterance().await.unwrap();
            assert!(
                flushed
                    .iter()
                    .any(|e| matches!(e, AsrEvent::Final { text, .. } if text == "你好世界")),
                "flush produced the final: {flushed:?}"
            );
        });
    }
}

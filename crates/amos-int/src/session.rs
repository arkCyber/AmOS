//! The interpretation [`Session`] state machine.
//!
//! Owns a [`Pipeline`], a validated [`SessionState`], and a per-utterance
//! [`UtteranceBuilder`]. Callers push [`SessionEvent`]s via [`Session::handle`]
//! and consume [`InterpretationOutput`]s from the channel returned by
//! [`Session::new`]. The engine performs no I/O of its own — everything it
//! knows comes from the pipeline and everything it says goes out the channel.

use std::time::Duration;

use tokio::sync::mpsc;

use crate::config::SessionConfig;
use crate::error::{InterpretationError, Result};
use crate::event::{EndReason, InterpretationOutput, SessionEvent, TtsRequest};
use crate::language::Language;
use crate::pipeline::{AsrEvent, Pipeline, SourceText, Translation};
use crate::segment::{Segment, UtteranceBuilder};
use crate::state::SessionState;

/// A live interpretation session.
pub struct Session {
    id: u64,
    state: SessionState,
    config: SessionConfig,
    pipeline: Box<dyn Pipeline>,
    out: mpsc::Sender<InterpretationOutput>,
    builder: Option<UtteranceBuilder>,
    detected_lang: Option<Language>,
    next_segment: u64,
}

impl Session {
    /// Create a session bound to `pipeline`. Returns the session and the channel
    /// its outputs are delivered on.
    pub fn new(
        config: SessionConfig,
        pipeline: Box<dyn Pipeline>,
    ) -> (Session, mpsc::Receiver<InterpretationOutput>) {
        let (tx, rx) = mpsc::channel(128);
        let session = Session {
            id: next_session_id(),
            state: SessionState::Idle,
            config,
            pipeline,
            out: tx,
            builder: None,
            detected_lang: None,
            next_segment: 1,
        };
        (session, rx)
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn state(&self) -> SessionState {
        self.state
    }

    /// Move the session into `Collecting` so it can accept input.
    pub fn start(&mut self) -> Result<()> {
        if self.state == SessionState::Collecting {
            return Ok(());
        }
        if self.state == SessionState::Idle {
            self.set_state(SessionState::Starting)?;
        }
        self.set_state(SessionState::Collecting)?;
        self.reset_builder();
        Ok(())
    }

    /// Reset a finished session so it can run again (bypasses the terminal
    /// `Ended`/`Error` states). No-op when already collecting; errors if the
    /// session is mid-flight.
    pub fn restart(&mut self) -> Result<()> {
        use SessionState::*;
        match self.state {
            Collecting => Ok(()),
            Starting | Interpreting | Speaking | Paused => Err(InterpretationError::Other(
                "session is active; stop it before restarting".into(),
            )),
            _ => {
                self.detected_lang = None;
                self.next_segment = 1;
                self.builder = None;
                // Force through the terminal state back to Starting (Ended is
                // intentionally unreachable via the normal state machine).
                self.state = Starting;
                self.emit(InterpretationOutput::StateChanged(Starting));
                self.set_state(Collecting)?;
                self.reset_builder();
                Ok(())
            }
        }
    }

    /// Push one input event.
    pub async fn handle(&mut self, event: SessionEvent) -> Result<()> {
        match event {
            SessionEvent::AudioChunk(chunk) => self.feed_audio(&chunk).await,
            SessionEvent::TextSegment(text) => {
                self.require_collecting()?;
                let lang = self
                    .detected_lang
                    .clone()
                    .unwrap_or_else(|| self.config.languages.source.clone());
                self.translate_source(text, lang, Duration::ZERO, Duration::ZERO)
                    .await
            }
            SessionEvent::EndOfSpeech => self.end_of_speech().await,
            SessionEvent::Pause => self.pause(),
            SessionEvent::Resume => self.resume(),
            SessionEvent::Stop => self.stop(),
            SessionEvent::Abort => self.abort(),
            SessionEvent::SetSourceLang(lang) => {
                self.detected_lang = Some(lang.clone());
                self.emit(InterpretationOutput::LanguageDetected(lang));
                Ok(())
            }
        }
    }

    /// Feed a chunk of mono PCM audio to streaming ASR.
    pub async fn feed_audio(&mut self, chunk: &[f32]) -> Result<()> {
        self.require_collecting()?;
        let events = {
            let p = self.pipeline.as_ref();
            p.feed_audio(chunk).await
        }?;
        for ev in events {
            match ev {
                AsrEvent::Partial(partial) => {
                    if let Some(b) = self.builder.as_mut() {
                        b.update(&partial.text);
                    }
                    self.emit(InterpretationOutput::Partial(partial));
                }
                AsrEvent::Final {
                    text,
                    lang,
                    start,
                    end,
                } => {
                    self.translate_source(text, lang, start, end).await?;
                }
            }
        }
        Ok(())
    }

    pub fn pause(&mut self) -> Result<()> {
        if self.state == SessionState::Paused {
            return Ok(());
        }
        self.set_state(SessionState::Paused)
    }

    pub fn resume(&mut self) -> Result<()> {
        if self.state == SessionState::Collecting {
            return Ok(());
        }
        self.set_state(SessionState::Collecting)
    }

    /// Graceful end.
    pub fn stop(&mut self) -> Result<()> {
        self.end(EndReason::Stopped)
    }

    /// Hard end, discarding in-flight state.
    pub fn abort(&mut self) -> Result<()> {
        self.end(EndReason::Aborted)
    }

    /// Triggered by VAD when the current utterance ended: finalize whatever the
    /// builder has and translate it (used by manual / non-streaming pipelines).
    async fn end_of_speech(&mut self) -> Result<()> {
        self.require_collecting()?;
        let Some(mut b) = self.builder.take() else {
            return Ok(());
        };
        let text = b.finalize(Duration::ZERO);
        let start = b.start;
        let lang = self
            .detected_lang
            .clone()
            .unwrap_or_else(|| self.config.languages.source.clone());
        self.translate_source(text, lang, start, Duration::ZERO)
            .await
    }

    /// The shared translate path for a finalized source utterance: pin language
    /// (auto), translate via the pipeline, emit the segment, optionally request
    /// TTS, and return to collecting.
    async fn translate_source(
        &mut self,
        text: String,
        lang: Language,
        start: Duration,
        end: Duration,
    ) -> Result<()> {
        if text.trim().is_empty() {
            return Ok(());
        }
        if self.config.auto_detect && self.detected_lang.is_none() {
            self.detected_lang = Some(lang.clone());
            self.emit(InterpretationOutput::LanguageDetected(lang.clone()));
        }

        let id = self.next_segment;
        self.emit(InterpretationOutput::UtteranceRecognized {
            id,
            text: text.clone(),
            lang: lang.clone(),
        });

        self.set_state(SessionState::Interpreting)?;

        // Translate with a small number of retries: a transient daemon hiccup /
        // stale-channel failure (the gRPC pipeline reconnects on its next call)
        // is absorbed, so only a persistent failure surfaces as an error.
        let speaker = self.config.speaker.clone();
        let attempts = self.config.translate_retries + 1; // 1 initial + retries
        let mut translation: Option<Translation> = None;
        for attempt in 0..attempts {
            let res = {
                let p = self.pipeline.as_ref();
                p.translate(SourceText {
                    text: &text,
                    lang: &lang,
                    speaker: &speaker,
                })
                .await
            };
            match res {
                Ok(t) => {
                    translation = Some(t);
                    break;
                }
                Err(_e) if attempt + 1 < attempts => {
                    // Transient failure: retry on the next iteration.
                }
                Err(e) => {
                    self.fail(e);
                    return Ok(());
                }
            }
        }
        let Translation {
            target_text,
            target_lang,
        } = translation.expect("translation either succeeded or failed above");

        let segment = Segment {
            id,
            speaker,
            source_text: text,
            source_lang: lang,
            target_text,
            target_lang,
            start,
            end,
        };
        self.next_segment += 1;
        self.emit(InterpretationOutput::SegmentFinal(segment.clone()));

        if self.config.tts_enabled {
            self.set_state(SessionState::Speaking)?;
            self.emit(InterpretationOutput::TtsRequest(TtsRequest {
                text: segment.target_text.clone(),
                lang: segment.target_lang.clone(),
                segment_id: segment.id,
            }));
        }

        self.set_state(SessionState::Collecting)?;
        self.reset_builder();
        Ok(())
    }

    fn end(&mut self, reason: EndReason) -> Result<()> {
        if self.state == SessionState::Ended {
            return Ok(());
        }
        self.set_state(SessionState::Ended)?;
        self.builder = None;
        self.emit(InterpretationOutput::SessionEnded { reason });
        Ok(())
    }

    fn fail(&mut self, e: InterpretationError) {
        if SessionState::allowed(self.state, SessionState::Error) {
            let _ = self.set_state(SessionState::Error);
        }
        self.emit(InterpretationOutput::Error {
            message: e.to_string(),
        });
    }

    fn require_collecting(&self) -> Result<()> {
        match self.state {
            SessionState::Collecting => Ok(()),
            SessionState::Ended => Err(InterpretationError::Closed),
            other => Err(InterpretationError::NotActive { state: other }),
        }
    }

    fn reset_builder(&mut self) {
        self.builder = Some(UtteranceBuilder::new(
            self.config.speaker.clone(),
            Duration::ZERO,
        ));
    }

    fn set_state(&mut self, to: SessionState) -> Result<()> {
        let next = self.state.transition(to)?;
        self.state = next;
        self.emit(InterpretationOutput::StateChanged(next));
        Ok(())
    }

    fn emit(&self, out: InterpretationOutput) {
        let _ = self.out.try_send(out);
    }
}

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
fn next_session_id() -> u64 {
    NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::MockPipeline;

    /// Drain all outputs currently buffered in the channel.
    async fn drain(rx: &mut mpsc::Receiver<InterpretationOutput>) -> Vec<InterpretationOutput> {
        let mut v = Vec::new();
        while let Ok(Some(o)) = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            v.push(o);
        }
        v
    }

    fn has_segment(v: &[InterpretationOutput]) -> bool {
        v.iter()
            .any(|o| matches!(o, InterpretationOutput::SegmentFinal(_)))
    }
    fn has_tts(v: &[InterpretationOutput]) -> bool {
        v.iter()
            .any(|o| matches!(o, InterpretationOutput::TtsRequest(_)))
    }

    #[tokio::test]
    async fn end_to_end_streaming_with_tts() {
        let cfg = SessionConfig::one_way("auto", "zh").with_tts(true);
        let (mut s, mut rx) = Session::new(cfg, Box::new(MockPipeline::new("你好", "zh")));
        s.start().unwrap();

        // One non-empty chunk triggers partial + final -> translate -> segment + tts.
        s.feed_audio(&vec![0.0; 160]).await.unwrap();
        let out = drain(&mut rx).await;

        assert!(has_segment(&out), "expected a finalized segment");
        assert!(has_tts(&out), "expected a TTS request when tts_enabled");
        let seg = out
            .iter()
            .find_map(|o| match o {
                InterpretationOutput::SegmentFinal(s) => Some(s.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(seg.source_text, "你好");
        assert_eq!(seg.target_text, "[zh] 你好");
        assert_eq!(s.state(), SessionState::Collecting);
    }

    #[tokio::test]
    async fn tts_omitted_when_disabled() {
        let cfg = SessionConfig::one_way("auto", "zh"); // tts off
        let (mut s, mut rx) = Session::new(cfg, Box::new(MockPipeline::new("你好", "zh")));
        s.start().unwrap();
        s.feed_audio(&vec![0.0; 160]).await.unwrap();
        let out = drain(&mut rx).await;
        assert!(has_segment(&out));
        assert!(!has_tts(&out), "no TTS request when tts disabled");
    }

    #[tokio::test]
    async fn feeding_before_start_is_rejected() {
        let (mut s, _rx) = Session::new(
            SessionConfig::one_way("auto", "zh"),
            Box::new(MockPipeline::new("hi", "en")),
        );
        let err = s.feed_audio(&vec![0.0; 160]).await.unwrap_err();
        assert!(matches!(err, InterpretationError::NotActive { .. }));
    }

    #[tokio::test]
    async fn typed_text_bypasses_asr() {
        let cfg = SessionConfig::one_way("en", "zh");
        let (mut s, mut rx) = Session::new(cfg, Box::new(MockPipeline::new("x", "en")));
        s.start().unwrap();
        s.handle(SessionEvent::TextSegment("hello".into()))
            .await
            .unwrap();
        let out = drain(&mut rx).await;
        let seg = out
            .iter()
            .find_map(|o| match o {
                InterpretationOutput::SegmentFinal(s) => Some(s.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(seg.source_text, "hello");
        assert_eq!(seg.target_text, "[en] hello");
    }

    #[tokio::test]
    async fn language_is_detected_for_auto_source() {
        let cfg = SessionConfig::one_way("auto", "zh");
        let (mut s, mut rx) = Session::new(cfg, Box::new(MockPipeline::new("你好", "zh")));
        s.start().unwrap();
        s.feed_audio(&vec![0.0; 160]).await.unwrap();
        let out = drain(&mut rx).await;
        assert!(
            out.iter().any(|o| matches!(
                o,
                InterpretationOutput::LanguageDetected(l) if l.as_str() == "zh"
            )),
            "auto source should be pinned from the first utterance"
        );
    }

    #[tokio::test]
    async fn pause_resume_stop_lifecycle() {
        let cfg = SessionConfig::one_way("en", "zh");
        let (mut s, mut rx) = Session::new(cfg, Box::new(MockPipeline::new("x", "en")));
        s.start().unwrap();

        s.pause().unwrap();
        assert_eq!(s.state(), SessionState::Paused);
        // Input while paused is rejected.
        assert!(matches!(
            s.feed_audio(&vec![0.0; 160]).await.unwrap_err(),
            InterpretationError::NotActive { .. }
        ));

        s.resume().unwrap();
        assert_eq!(s.state(), SessionState::Collecting);

        s.stop().unwrap();
        assert_eq!(s.state(), SessionState::Ended);
        let out = drain(&mut rx).await;
        assert!(out.iter().any(|o| matches!(
            o,
            InterpretationOutput::SessionEnded {
                reason: EndReason::Stopped
            }
        )));
    }

    #[tokio::test]
    async fn restart_resets_counter_and_reruns() {
        let cfg = SessionConfig::one_way("auto", "zh");
        let (mut s, mut rx) = Session::new(cfg, Box::new(MockPipeline::new("你好", "zh")));
        s.start().unwrap();
        s.feed_audio(&vec![0.0; 160]).await.unwrap();
        let seg1 = drain(&mut rx)
            .await
            .iter()
            .find_map(|o| match o {
                InterpretationOutput::SegmentFinal(s) => Some(s.id),
                _ => None,
            })
            .unwrap();
        assert_eq!(seg1, 1);

        s.stop().unwrap();
        assert_eq!(s.state(), SessionState::Ended);

        // Restart must reset the segment counter and run again.
        s.restart().unwrap();
        assert_eq!(s.state(), SessionState::Collecting);
        s.feed_audio(&vec![0.0; 160]).await.unwrap();
        let seg2 = drain(&mut rx)
            .await
            .iter()
            .find_map(|o| match o {
                InterpretationOutput::SegmentFinal(s) => Some(s.id),
                _ => None,
            })
            .unwrap();
        assert_eq!(seg2, 1, "segment counter reset on restart");

        // Restarting while mid-flight is rejected (paused = not ended).
        s.pause().unwrap();
        assert!(s.restart().is_err());
        s.resume().unwrap();
    }

    /// Pipeline whose translate always fails, to exercise the error path.
    struct FailTranslatePipeline;
    #[async_trait::async_trait]
    impl crate::pipeline::Pipeline for FailTranslatePipeline {
        fn info(&self) -> crate::pipeline::PipelineInfo {
            crate::pipeline::PipelineInfo {
                provider: "fail".into(),
                model: None,
                streaming_asr: false,
                tts: false,
                both_mode: crate::config::BothMode::Disabled,
            }
        }
        async fn feed_audio(&self, chunk: &[f32]) -> Result<Vec<crate::pipeline::AsrEvent>> {
            // Emit a final after one chunk, then translate fails downstream.
            if chunk.is_empty() {
                return Ok(Vec::new());
            }
            Ok(vec![crate::pipeline::AsrEvent::Final {
                text: "hi".into(),
                lang: crate::language::Language::new("en"),
                start: Duration::ZERO,
                end: Duration::ZERO,
            }])
        }
        async fn translate(&self, _src: crate::pipeline::SourceText<'_>) -> Result<Translation> {
            Err(InterpretationError::Pipeline("boom".into()))
        }
        async fn synthesize(&self, _req: &TtsRequest) -> Result<crate::pipeline::TtsAudio> {
            Err(InterpretationError::Other("no tts".into()))
        }
    }

    /// Pipeline that fails translation the first time, then succeeds — used to
    /// prove transient failures are absorbed by the retry.
    struct FlakyPipeline {
        remaining_failures: std::sync::atomic::AtomicUsize,
    }
    impl FlakyPipeline {
        fn new() -> Self {
            Self {
                remaining_failures: std::sync::atomic::AtomicUsize::new(1),
            }
        }
    }
    #[async_trait::async_trait]
    impl crate::pipeline::Pipeline for FlakyPipeline {
        fn info(&self) -> crate::pipeline::PipelineInfo {
            crate::pipeline::PipelineInfo {
                provider: "flaky".into(),
                model: None,
                streaming_asr: false,
                tts: false,
                both_mode: crate::config::BothMode::Disabled,
            }
        }
        async fn feed_audio(&self, _chunk: &[f32]) -> Result<Vec<crate::pipeline::AsrEvent>> {
            Ok(Vec::new())
        }
        async fn translate(&self, src: crate::pipeline::SourceText<'_>) -> Result<Translation> {
            use std::sync::atomic::Ordering;
            if self
                .remaining_failures
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok()
            {
                return Err(InterpretationError::Pipeline("transient".into()));
            }
            Ok(Translation {
                target_text: format!("[{}] {}", src.lang, src.text),
                target_lang: src.lang.clone(),
            })
        }
        async fn synthesize(&self, _req: &TtsRequest) -> Result<crate::pipeline::TtsAudio> {
            Err(InterpretationError::Other("no tts".into()))
        }
    }

    #[tokio::test]
    async fn transient_translate_failure_is_retried_once() {
        let cfg = SessionConfig::one_way("en", "zh"); // default translate_retries = 1
        let (mut s, mut rx) = Session::new(cfg, Box::new(FlakyPipeline::new()));
        s.start().unwrap();
        s.handle(SessionEvent::TextSegment("hello".into()))
            .await
            .unwrap();
        let out = drain(&mut rx).await;
        assert!(
            !matches!(s.state(), SessionState::Error),
            "transient failure should be retried, not error: {:?}",
            s.state()
        );
        let seg = out
            .iter()
            .find_map(|o| match o {
                InterpretationOutput::SegmentFinal(x) => Some(x.clone()),
                _ => None,
            })
            .expect("segment produced after retry");
        assert_eq!(seg.target_text, "[en] hello");
    }

    #[tokio::test]
    async fn translate_retries_zero_disables_retry() {
        // With retries disabled, a single (even transient) failure errors out.
        let cfg = SessionConfig::one_way("en", "zh").with_translate_retries(0);
        let (mut s, mut rx) = Session::new(cfg, Box::new(FlakyPipeline::new()));
        s.start().unwrap();
        s.handle(SessionEvent::TextSegment("hello".into()))
            .await
            .unwrap();
        let out = drain(&mut rx).await;
        assert_eq!(s.state(), SessionState::Error, "retries=0 => no retry");
        assert!(out
            .iter()
            .any(|o| matches!(o, InterpretationOutput::Error { .. })));
    }

    #[tokio::test]
    async fn restart_recovers_an_error_session() {
        // Fail once (retries disabled) -> Error; restart makes it usable again
        // (the flaky pipeline's single failure is now consumed).
        let cfg = SessionConfig::one_way("en", "zh").with_translate_retries(0);
        let (mut s, mut rx) = Session::new(cfg, Box::new(FlakyPipeline::new()));
        s.start().unwrap();
        s.handle(SessionEvent::TextSegment("boom".into()))
            .await
            .unwrap();
        assert_eq!(s.state(), SessionState::Error);
        drain(&mut rx).await; // consume the error output

        s.restart().unwrap();
        assert_eq!(s.state(), SessionState::Collecting);
        s.handle(SessionEvent::TextSegment("ok".into()))
            .await
            .unwrap();
        let out = drain(&mut rx).await;
        let seg = out
            .iter()
            .find_map(|o| match o {
                InterpretationOutput::SegmentFinal(x) => Some(x.clone()),
                _ => None,
            })
            .expect("segment produced after restart from error");
        assert_eq!(seg.target_text, "[en] ok");
    }

    #[tokio::test]
    async fn translate_failure_puts_session_in_error() {
        let cfg = SessionConfig::one_way("en", "zh");
        let (mut s, mut rx) = Session::new(cfg, Box::new(FailTranslatePipeline));
        s.start().unwrap();
        s.feed_audio(&vec![0.0; 160]).await.unwrap();

        let out = drain(&mut rx).await;
        assert!(
            out.iter().any(
                |o| matches!(o, InterpretationOutput::Error { message } if message.contains("boom"))
            ),
            "expected an error output: {out:?}"
        );
        assert_eq!(s.state(), SessionState::Error, "session should be in Error");
    }

    #[tokio::test]
    async fn set_source_lang_pins_subsequent_utterances() {
        let cfg = SessionConfig::one_way("auto", "zh");
        let (mut s, mut rx) = Session::new(cfg, Box::new(MockPipeline::new("x", "en")));
        s.start().unwrap();
        // User hints the source is Japanese.
        s.handle(SessionEvent::SetSourceLang(Language::new("ja")))
            .await
            .unwrap();
        // A text segment now uses the pinned language for translation.
        s.handle(SessionEvent::TextSegment("こんにちは".into()))
            .await
            .unwrap();
        let out = drain(&mut rx).await;
        let seg = out
            .iter()
            .find_map(|o| match o {
                InterpretationOutput::SegmentFinal(s) => Some(s.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(seg.source_lang.as_str(), "ja");
        assert!(
            seg.target_text.contains("[ja]"),
            "translated with pinned ja: {}",
            seg.target_text
        );
    }

    #[tokio::test]
    async fn end_of_speech_without_utterance_is_noop() {
        let cfg = SessionConfig::one_way("en", "zh");
        let (mut s, _rx) = Session::new(cfg, Box::new(MockPipeline::new("x", "en")));
        s.start().unwrap();
        // No audio/text was fed; EndOfSpeech must not translate anything.
        s.handle(SessionEvent::EndOfSpeech).await.unwrap();
        assert_eq!(s.state(), SessionState::Collecting);
    }

    #[tokio::test]
    async fn abort_clears_in_flight_utterance() {
        let cfg = SessionConfig::one_way("auto", "zh");
        let (mut s, mut rx) = Session::new(cfg, Box::new(MockPipeline::new("你好", "zh")));
        s.start().unwrap();
        s.feed_audio(&vec![0.0; 160]).await.unwrap(); // may partially collect
        s.abort().unwrap();
        assert_eq!(s.state(), SessionState::Ended);
        let out = drain(&mut rx).await;
        assert!(out.iter().any(|o| matches!(
            o,
            InterpretationOutput::SessionEnded {
                reason: EndReason::Aborted
            }
        )));
    }

    #[tokio::test]
    async fn end_of_speech_finalizes_manual_utterance() {
        // stream_chunks large so feed_audio only yields partials (no auto-final).
        let mut pipe = MockPipeline::new("你好", "zh");
        pipe.stream_chunks = 100;
        let cfg = SessionConfig::one_way("auto", "zh");
        let (mut s, mut rx) = Session::new(cfg, Box::new(pipe));
        s.start().unwrap();
        s.feed_audio(&vec![0.0; 160]).await.unwrap(); // partial only, builder updated
        s.handle(SessionEvent::EndOfSpeech).await.unwrap(); // VAD says done
        let out = drain(&mut rx).await;
        assert!(
            has_segment(&out),
            "EndOfSpeech should translate the utterance"
        );
        let seg = out
            .iter()
            .find_map(|o| match o {
                InterpretationOutput::SegmentFinal(s) => Some(s.source_text.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(seg, "你好");
    }
}

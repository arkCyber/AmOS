//! Tauri <-> interpretation session bridge.
//!
//! Lets the WebView run a live simultaneous-interpretation session by pushing
//! [`SessionEvent`]s through `interpret_*` commands and receiving
//! [`InterpretationOutput`]s as `interpret-output` Tauri events.
//!
//! A single [`InterpretationBridge`] owns at most one active session at a time.
//! The session is driven by an `amos_int::Session` over an
//! `amos_translate::grpc_pipeline::GrpcPipeline` (the amos-translate daemon).

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use amos_int::event::{InterpretationOutput, SessionEvent};
use amos_int::pipeline::Pipeline;
use amos_int::{Session, SessionConfig};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

/// Tauri event emitted for every session output.
pub const INTERPRET_EVENT: &str = "interpret-output";

/// Serializable mirror of [`InterpretationOutput`] (prost/domain enums are not
/// directly `Serialize`-able as one tagged enum).
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InterpretEventPayload {
    StateChanged {
        session_id: u64,
        state: String,
    },
    Partial {
        session_id: u64,
        text: String,
        stable: String,
    },
    UtteranceRecognized {
        session_id: u64,
        id: u64,
        text: String,
        lang: String,
    },
    SegmentFinal {
        session_id: u64,
        id: u64,
        source_text: String,
        source_lang: String,
        target_text: String,
        target_lang: String,
    },
    LanguageDetected {
        session_id: u64,
        lang: String,
    },
    TtsRequest {
        session_id: u64,
        text: String,
        lang: String,
        segment_id: u64,
    },
    SessionEnded {
        session_id: u64,
        reason: String,
    },
    Error {
        session_id: u64,
        message: String,
    },
}

/// Map a domain output to its serializable wire payload.
pub fn payload_for(session_id: u64, out: &InterpretationOutput) -> InterpretEventPayload {
    use InterpretationOutput::*;
    match out {
        StateChanged(s) => InterpretEventPayload::StateChanged {
            session_id,
            state: format!("{s:?}").to_lowercase(),
        },
        Partial(p) => InterpretEventPayload::Partial {
            session_id,
            text: p.text.clone(),
            stable: p.stable.clone(),
        },
        UtteranceRecognized { id, text, lang } => InterpretEventPayload::UtteranceRecognized {
            session_id,
            id: *id,
            text: text.clone(),
            lang: lang.as_str().to_string(),
        },
        SegmentFinal(s) => InterpretEventPayload::SegmentFinal {
            session_id,
            id: s.id,
            source_text: s.source_text.clone(),
            source_lang: s.source_lang.as_str().to_string(),
            target_text: s.target_text.clone(),
            target_lang: s.target_lang.as_str().to_string(),
        },
        LanguageDetected(l) => InterpretEventPayload::LanguageDetected {
            session_id,
            lang: l.as_str().to_string(),
        },
        TtsRequest(r) => InterpretEventPayload::TtsRequest {
            session_id,
            text: r.text.clone(),
            lang: r.lang.as_str().to_string(),
            segment_id: r.segment_id,
        },
        SessionEnded { reason } => InterpretEventPayload::SessionEnded {
            session_id,
            reason: format!("{reason:?}").to_lowercase(),
        },
        Error { message } => InterpretEventPayload::Error {
            session_id,
            message: message.clone(),
        },
    }
}

/// Drain all buffered outputs and map them to wire payloads.
pub fn drain_payloads(
    session_id: u64,
    rx: &mut mpsc::Receiver<InterpretationOutput>,
) -> Vec<InterpretEventPayload> {
    let mut out = Vec::new();
    while let Ok(o) = rx.try_recv() {
        out.push(payload_for(session_id, &o));
    }
    out
}

/// An active interpretation session held by the bridge.
pub struct ActiveSession {
    pub id: u64,
    pub source: String,
    pub target: String,
    session: Session,
    rx: mpsc::Receiver<InterpretationOutput>,
}

impl ActiveSession {
    /// Apply one session event and return the outputs it produced (for emission).
    async fn apply(&mut self, event: SessionEvent) -> Result<Vec<InterpretEventPayload>, String> {
        self.session
            .handle(event)
            .await
            .map_err(|e| e.to_string())?;
        Ok(drain_payloads(self.id, &mut self.rx))
    }

    fn status(&self) -> InterpretStatus {
        InterpretStatus {
            session_id: self.id,
            state: format!("{:?}", self.session.state()).to_lowercase(),
            connected: true,
            source: self.source.clone(),
            target: self.target.clone(),
        }
    }
}

/// Status reported to the UI for the active session.
#[derive(Clone, Debug, Serialize)]
pub struct InterpretStatus {
    pub session_id: u64,
    pub state: String,
    pub connected: bool,
    pub source: String,
    pub target: String,
}

fn resolve_socket() -> PathBuf {
    if let Ok(p) = std::env::var("AMOS_TRANSLATE_SOCKET") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    PathBuf::from("/tmp/amos-translate.sock")
}

/// App-managed bridge owning (at most) one active interpretation session.
pub struct InterpretationBridge {
    active: tokio::sync::Mutex<Option<ActiveSession>>,
    socket: PathBuf,
    next_id: AtomicU64,
}

impl Default for InterpretationBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl InterpretationBridge {
    pub fn new() -> Self {
        Self {
            active: tokio::sync::Mutex::new(None),
            socket: resolve_socket(),
            next_id: AtomicU64::new(1),
        }
    }
}

impl InterpretationBridge {
    /// Whether a caller-provided `session_id` matches the active session.
    fn check_id(active: Option<&ActiveSession>, session_id: Option<u64>) -> Result<(), String> {
        let Some(a) = active else {
            return Err("no active interpretation session; call interpret_start first".into());
        };
        if let Some(id) = session_id {
            if id != a.id {
                return Err(format!("session id mismatch: expected {} got {id}", a.id));
            }
        }
        Ok(())
    }
}

fn emit(app: &AppHandle, payloads: Vec<InterpretEventPayload>) {
    for p in payloads {
        let _ = app.emit(INTERPRET_EVENT, p);
    }
}

/// Build a composite **local sherpa ASR** + daemon-translation pipeline when the
/// `sherpa-asr` feature is enabled and `AMOS_SHERPA_MODEL_DIR` points at a model
/// directory with the standard sherpa files. Returns `None` (so callers fall
/// back to the daemon) when not configured / models missing.
#[cfg(feature = "sherpa-asr")]
fn local_sherpa_pipeline(
    socket: &std::path::Path,
    source: &str,
    target: &str,
) -> Option<Box<dyn Pipeline>> {
    use amos_asr::{sherpa_pipeline, SherpaOnlineRecognizerConfig};

    let dir = PathBuf::from(std::env::var("AMOS_SHERPA_MODEL_DIR").ok()?);
    let names = [
        "tokens.txt",
        "encoder-epoch-99-avg-1.int8.onnx",
        "decoder-epoch-99-avg-1.int8.onnx",
        "joiner-epoch-99-avg-1.int8.onnx",
    ];
    if names.iter().any(|f| !dir.join(f).exists()) {
        return None; // models not downloaded; use the daemon
    }
    let lang = if source.is_empty() || source == "auto" {
        "en"
    } else {
        source
    };
    let cfg = SherpaOnlineRecognizerConfig {
        tokens: dir.join("tokens.txt"),
        encoder: dir.join(names[1]),
        decoder: dir.join(names[2]),
        joiner: dir.join(names[3]),
        lang: lang.into(),
        ..Default::default()
    };
    let translate: std::sync::Arc<dyn Pipeline> =
        std::sync::Arc::new(amos_translate::grpc_pipeline::GrpcPipeline::new(
            socket.to_owned(),
            source.to_string(),
            target.to_string(),
        ));
    let pipeline = sherpa_pipeline(cfg, Some(translate)).ok()?;
    tracing::info!("interpret: using local sherpa ASR from {}", dir.display());
    Some(Box::new(pipeline))
}

/// Start an interpretation session against the amos-translate daemon.
#[tauri::command]
pub async fn interpret_start(
    app: AppHandle,
    state: State<'_, InterpretationBridge>,
    source_lang: Option<String>,
    target_lang: Option<String>,
) -> Result<u64, String> {
    let source = source_lang.unwrap_or_else(|| "auto".into());
    let target = target_lang.unwrap_or_else(|| "zh".into());
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);

    // Default: daemon ASR + translation via amos-translate.
    let grpc = || {
        Box::new(amos_translate::grpc_pipeline::GrpcPipeline::new(
            state.socket.clone(),
            source.clone(),
            target.clone(),
        )) as Box<dyn Pipeline>
    };
    #[cfg(feature = "sherpa-asr")]
    let pipeline: Box<dyn Pipeline> =
        local_sherpa_pipeline(&state.socket, &source, &target).unwrap_or_else(grpc);
    #[cfg(not(feature = "sherpa-asr"))]
    let pipeline: Box<dyn Pipeline> = grpc();

    let config = SessionConfig::one_way(source.clone(), target.clone());
    let (session, rx) = Session::new(config, pipeline);
    let mut active = ActiveSession {
        id,
        source,
        target,
        session,
        rx,
    };
    // `start()` is pure (no daemon I/O yet); the first feed/translate connects.
    active.session.start().map_err(|e| e.to_string())?;
    let payloads = drain_payloads(id, &mut active.rx);

    let mut guard = state.active.lock().await;
    *guard = Some(active);
    drop(guard);
    emit(&app, payloads);
    Ok(id)
}

/// Translate a typed text line in the active session.
#[tauri::command]
pub async fn interpret_text(
    app: AppHandle,
    state: State<'_, InterpretationBridge>,
    text: String,
    session_id: Option<u64>,
) -> Result<(), String> {
    let mut guard = state.active.lock().await;
    InterpretationBridge::check_id(guard.as_ref(), session_id)?;
    let a = guard.as_mut().unwrap();
    let payloads = a.apply(SessionEvent::TextSegment(text)).await?;
    drop(guard);
    emit(&app, payloads);
    Ok(())
}

/// Feed a mono PCM chunk (f32) to the active session's streaming ASR.
#[tauri::command]
pub async fn interpret_audio(
    app: AppHandle,
    state: State<'_, InterpretationBridge>,
    chunk: Vec<f32>,
    session_id: Option<u64>,
) -> Result<(), String> {
    let mut guard = state.active.lock().await;
    InterpretationBridge::check_id(guard.as_ref(), session_id)?;
    let a = guard.as_mut().unwrap();
    let payloads = a.apply(SessionEvent::AudioChunk(chunk)).await?;
    drop(guard);
    emit(&app, payloads);
    Ok(())
}

/// Tell the active session that the current utterance ended (VAD/manual).
#[tauri::command]
pub async fn interpret_end_of_speech(
    app: AppHandle,
    state: State<'_, InterpretationBridge>,
    session_id: Option<u64>,
) -> Result<(), String> {
    let mut guard = state.active.lock().await;
    InterpretationBridge::check_id(guard.as_ref(), session_id)?;
    let a = guard.as_mut().unwrap();
    let payloads = a.apply(SessionEvent::EndOfSpeech).await?;
    drop(guard);
    emit(&app, payloads);
    Ok(())
}

#[tauri::command]
pub async fn interpret_pause(
    app: AppHandle,
    state: State<'_, InterpretationBridge>,
    session_id: Option<u64>,
) -> Result<(), String> {
    let mut guard = state.active.lock().await;
    InterpretationBridge::check_id(guard.as_ref(), session_id)?;
    let a = guard.as_mut().unwrap();
    a.session.pause().map_err(|e| e.to_string())?;
    let payloads = drain_payloads(a.id, &mut a.rx);
    drop(guard);
    emit(&app, payloads);
    Ok(())
}

#[tauri::command]
pub async fn interpret_resume(
    app: AppHandle,
    state: State<'_, InterpretationBridge>,
    session_id: Option<u64>,
) -> Result<(), String> {
    let mut guard = state.active.lock().await;
    InterpretationBridge::check_id(guard.as_ref(), session_id)?;
    let a = guard.as_mut().unwrap();
    a.session.resume().map_err(|e| e.to_string())?;
    let payloads = drain_payloads(a.id, &mut a.rx);
    drop(guard);
    emit(&app, payloads);
    Ok(())
}

/// Gracefully end the active session.
#[tauri::command]
pub async fn interpret_stop(
    app: AppHandle,
    state: State<'_, InterpretationBridge>,
    session_id: Option<u64>,
) -> Result<(), String> {
    let mut guard = state.active.lock().await;
    InterpretationBridge::check_id(guard.as_ref(), session_id)?;
    let a = guard.as_mut().unwrap();
    a.session.stop().map_err(|e| e.to_string())?;
    let payloads = drain_payloads(a.id, &mut a.rx);
    drop(guard);
    emit(&app, payloads);
    Ok(())
}

/// Reset the active (ended) session so it can run again, reusing its session id.
#[tauri::command]
pub async fn interpret_restart(
    app: AppHandle,
    state: State<'_, InterpretationBridge>,
    session_id: Option<u64>,
) -> Result<(), String> {
    let mut guard = state.active.lock().await;
    InterpretationBridge::check_id(guard.as_ref(), session_id)?;
    let a = guard.as_mut().unwrap();
    a.session.restart().map_err(|e| e.to_string())?;
    let payloads = drain_payloads(a.id, &mut a.rx);
    drop(guard);
    emit(&app, payloads);
    Ok(())
}

/// Hard-end the active session and clear it.
#[tauri::command]
pub async fn interpret_abort(
    app: AppHandle,
    state: State<'_, InterpretationBridge>,
    session_id: Option<u64>,
) -> Result<(), String> {
    let mut guard = state.active.lock().await;
    InterpretationBridge::check_id(guard.as_ref(), session_id)?;
    let mut a = guard.take().unwrap();
    a.session.abort().map_err(|e| e.to_string())?;
    let payloads = drain_payloads(a.id, &mut a.rx);
    drop(guard);
    emit(&app, payloads);
    Ok(())
}

/// Query the active session's status (or none if no session).
#[tauri::command]
pub async fn interpret_status(
    state: State<'_, InterpretationBridge>,
) -> Result<Option<InterpretStatus>, String> {
    let guard = state.active.lock().await;
    Ok(guard.as_ref().map(|a| a.status()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_int::segment::{PartialSegment, Segment, Speaker};
    use amos_int::{MockPipeline, SessionConfig};
    use std::time::Duration;

    fn fresh_session() -> (Session, mpsc::Receiver<InterpretationOutput>) {
        let cfg = SessionConfig::one_way("en", "zh");
        Session::new(cfg, Box::new(MockPipeline::new("ignored", "en")))
    }

    #[test]
    fn payload_maps_all_variants() {
        let seg = Segment {
            id: 1,
            speaker: Speaker::default(),
            source_text: "hello".into(),
            source_lang: amos_int::Language::new("en"),
            target_text: "你好".into(),
            target_lang: amos_int::Language::new("zh"),
            start: Duration::ZERO,
            end: Duration::from_millis(10),
        };
        let cases: Vec<(InterpretationOutput, &str)> = vec![
            (
                InterpretationOutput::StateChanged(amos_int::SessionState::Collecting),
                "state_changed",
            ),
            (
                InterpretationOutput::Partial(PartialSegment {
                    speaker: Speaker::default(),
                    text: "hello".into(),
                    stable: "he".into(),
                    lang: None,
                }),
                "partial",
            ),
            (
                InterpretationOutput::UtteranceRecognized {
                    id: 1,
                    text: "hello".into(),
                    lang: amos_int::Language::new("en"),
                },
                "utterance_recognized",
            ),
            (InterpretationOutput::SegmentFinal(seg), "segment_final"),
            (
                InterpretationOutput::LanguageDetected(amos_int::Language::new("en")),
                "language_detected",
            ),
            (
                InterpretationOutput::TtsRequest(amos_int::TtsRequest {
                    text: "你好".into(),
                    lang: amos_int::Language::new("zh"),
                    segment_id: 1,
                }),
                "tts_request",
            ),
            (
                InterpretationOutput::SessionEnded {
                    reason: amos_int::EndReason::Stopped,
                },
                "session_ended",
            ),
            (
                InterpretationOutput::Error {
                    message: "boom".into(),
                },
                "error",
            ),
        ];
        for (out, kind) in cases {
            let p = payload_for(7, &out);
            let json = serde_json::to_value(&p).unwrap();
            assert_eq!(json["kind"], kind, "for {out:?}");
            assert_eq!(json["session_id"], 7);
        }
    }

    #[tokio::test]
    async fn active_session_applies_text_and_drains() {
        let (session, rx) = fresh_session();
        let mut active = ActiveSession {
            id: 3,
            source: "en".into(),
            target: "zh".into(),
            session,
            rx,
        };
        active.session.start().unwrap();

        let payloads = active
            .apply(SessionEvent::TextSegment("hello".into()))
            .await
            .unwrap();
        assert!(
            payloads.iter().any(|p| matches!(p, InterpretEventPayload::SegmentFinal { target_text, .. } if target_text == "[en] hello")),
            "{payloads:?}"
        );
    }

    #[tokio::test]
    async fn check_id_rejects_mismatch_and_missing() {
        let (session, rx) = fresh_session();
        let active = ActiveSession {
            id: 3,
            source: "en".into(),
            target: "zh".into(),
            session,
            rx,
        };
        assert!(InterpretationBridge::check_id(Some(&active), Some(3)).is_ok());
        assert!(InterpretationBridge::check_id(Some(&active), Some(9)).is_err());
        assert!(InterpretationBridge::check_id(None, None).is_err());
    }

    #[tokio::test]
    async fn active_session_restarts_after_stop() {
        let (session, rx) = fresh_session();
        let mut active = ActiveSession {
            id: 3,
            source: "en".into(),
            target: "zh".into(),
            session,
            rx,
        };
        active.session.start().unwrap();
        active.session.stop().unwrap();
        assert_eq!(active.session.state(), amos_int::SessionState::Ended);

        active.session.restart().unwrap();
        assert_eq!(active.session.state(), amos_int::SessionState::Collecting);

        let payloads = active
            .apply(SessionEvent::TextSegment("again".into()))
            .await
            .unwrap();
        assert!(
            payloads.iter().any(|p| matches!(
                p,
                InterpretEventPayload::SegmentFinal { source_text, .. } if source_text == "again"
            )),
            "{payloads:?}"
        );
    }

    /// With the `sherpa-asr` feature, a missing/misconfigured model directory
    /// must yield `None` so `interpret_start` falls back to the daemon.
    #[cfg(feature = "sherpa-asr")]
    #[test]
    fn local_sherpa_pipeline_falls_back_when_models_missing() {
        std::env::set_var("AMOS_SHERPA_MODEL_DIR", "/nonexistent-amos-sherpa-models");
        let p = local_sherpa_pipeline(&PathBuf::from("/tmp/amos-test.sock"), "auto", "zh");
        assert!(
            p.is_none(),
            "missing models must fall back to the daemon (None)"
        );
    }
}

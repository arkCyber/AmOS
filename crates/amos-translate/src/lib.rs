//! `amos-translate` — simultaneous-interpretation daemon.
//!
//! A gRPC service over a Unix Domain Socket. The System UI / `amos-ai` send
//! text (and, once ASR is wired, audio) segments here; the daemon routes each
//! segment through a pluggable [`TranslationProvider`] and streams translations
//! back, enabling real-time (simultaneous) interpretation.

// P0-1 gate: production code must not panic on programmer error. Test code is
// exempt (assertions/unwrap are idiomatic there).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod asr;
pub mod grpc_pipeline;
pub mod provider;

use std::sync::Arc;

use amos_proto::translate::{
    translate_in,
    translator_server::{Translator, TranslatorServer},
    StatusReply, StatusRequest, TranscribeRequest, TranscribeResponse, TranslateIn, TranslateOut,
    TranslateRequest, TranslateResponse,
};
use anyhow::Context;
use tokio::sync::mpsc;
use tokio_stream::wrappers::{ReceiverStream, UnixListenerStream};
use tonic::{Request, Response, Status, Streaming};

use crate::asr::SpeechRecognizer;
use crate::provider::TranslationProvider;

/// Daemon-level translation defaults.
#[derive(Debug, Clone)]
pub struct TranslateConfig {
    pub source_lang: String,
    pub target_lang: String,
}

impl Default for TranslateConfig {
    fn default() -> Self {
        Self {
            source_lang: "auto".to_string(),
            target_lang: "zh".to_string(),
        }
    }
}

/// The gRPC `Translator` service backed by a pluggable translation provider.
pub struct TranslatorService {
    provider: Arc<dyn TranslationProvider>,
    config: TranslateConfig,
    recognizer: Option<Arc<dyn SpeechRecognizer>>,
}

impl TranslatorService {
    pub fn new(provider: Arc<dyn TranslationProvider>, config: TranslateConfig) -> Self {
        Self {
            provider,
            config,
            recognizer: None,
        }
    }

    /// Attach a speech recognizer so `Transcribe` and audio stream frames work.
    pub fn with_recognizer(mut self, recognizer: Arc<dyn SpeechRecognizer>) -> Self {
        self.recognizer = Some(recognizer);
        self
    }
}

/// Deliver one translation segment to the client.
///
/// Returns `false` when the consumer is gone, and **every** caller must treat that as "stop":
/// `mpsc::Sender::send` fails only when the receiver was dropped — a *full* buffer waits, it does
/// not fail — so a failure always means nobody is left to receive. Keeping the rule in one place
/// is the point: it used to be applied in the text branch and silently skipped in the two audio
/// branches, so a client that went away mid-stream left the daemon running ASR on frames it could
/// never receive (Power of 10 rule #7 — a dropped result that changes what the daemon does).
async fn deliver(tx: &mpsc::Sender<Result<TranslateOut, Status>>, out: TranslateOut) -> bool {
    tx.send(Ok(out)).await.is_ok()
}

#[tonic::async_trait]
impl Translator for TranslatorService {
    async fn translate(
        &self,
        request: Request<TranslateRequest>,
    ) -> Result<Response<TranslateResponse>, Status> {
        let req = request.into_inner();
        let source = if req.source_lang.is_empty() {
            &self.config.source_lang
        } else {
            &req.source_lang
        };
        let target = if req.target_lang.is_empty() {
            &self.config.target_lang
        } else {
            &req.target_lang
        };

        let translated = self
            .provider
            .translate(&req.text, source, target)
            .await
            .map_err(|e| Status::internal(format!("translation failed: {e}")))?;

        Ok(Response::new(TranslateResponse {
            translated,
            detected_lang: if req.source_lang.is_empty() {
                String::new()
            } else {
                req.source_lang.clone()
            },
        }))
    }

    async fn transcribe(
        &self,
        request: Request<TranscribeRequest>,
    ) -> Result<Response<TranscribeResponse>, Status> {
        let req = request.into_inner();
        let Some(recognizer) = &self.recognizer else {
            return Ok(Response::new(TranscribeResponse {
                text: String::new(),
                recognized: false,
            }));
        };
        let text = recognizer
            .transcribe(&req.audio, &req.language, &req.format)
            .await
            .map_err(|e| Status::internal(format!("transcribe failed: {e}")))?;
        Ok(Response::new(TranscribeResponse {
            text,
            recognized: true,
        }))
    }

    type StreamTranslateStream = ReceiverStream<Result<TranslateOut, Status>>;

    async fn stream_translate(
        &self,
        request: Request<Streaming<TranslateIn>>,
    ) -> Result<Response<Self::StreamTranslateStream>, Status> {
        let mut inbound = request.into_inner();
        let provider = self.provider.clone();
        let config = self.config.clone();
        let recognizer = self.recognizer.clone();
        let (tx, rx) = mpsc::channel(64);

        tokio::spawn(async move {
            while let Ok(Some(msg)) = inbound.message().await {
                match msg.payload {
                    Some(translate_in::Payload::Text(text)) => {
                        match provider
                            .translate(&text, &config.source_lang, &config.target_lang)
                            .await
                        {
                            Ok(segment) => {
                                if !deliver(
                                    &tx,
                                    TranslateOut {
                                        segment,
                                        done: false,
                                    },
                                )
                                .await
                                {
                                    break;
                                }
                            }
                            Err(e) => {
                                // The only way this send fails is the client having dropped the
                                // response stream — there is nobody left to tell about `e`. If it
                                // *does* land, the error reaches the client and we stop.
                                let _ = tx.send(Err(Status::internal(e.to_string()))).await;
                                break;
                            }
                        }
                    }
                    Some(translate_in::Payload::Audio(audio)) => {
                        match &recognizer {
                            Some(r) => {
                                // ASR wired: transcribe the audio frame to text and
                                // stream it back (the client can then translate it).
                                match r.transcribe(&audio, "", "").await {
                                    Ok(text) if !text.is_empty() => {
                                        // The consumer-gone rule lives in `deliver` — this branch
                                        // used to discard the answer and keep running ASR for a
                                        // client that had already left.
                                        if !deliver(
                                            &tx,
                                            TranslateOut {
                                                segment: text,
                                                done: false,
                                            },
                                        )
                                        .await
                                        {
                                            break;
                                        }
                                    }
                                    Ok(_) => {}
                                    Err(e) => {
                                        // Nobody left to tell if this fails — the same documented
                                        // case as the text branch above; the `break` is the point.
                                        let _ = tx.send(Err(Status::internal(e.to_string()))).await;
                                        break;
                                    }
                                }
                            }
                            None => {
                                // ASR not wired yet: acknowledge the frame honestly.
                                let note = format!("[语音] {} 字节音频，ASR 未接入", audio.len());
                                if !deliver(
                                    &tx,
                                    TranslateOut {
                                        segment: note,
                                        done: false,
                                    },
                                )
                                .await
                                {
                                    break;
                                }
                            }
                        }
                    }
                    None => {}
                }
            }
            let _ = tx
                .send(Ok(TranslateOut {
                    segment: String::new(),
                    done: true,
                }))
                .await;
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn get_status(
        &self,
        _request: Request<StatusRequest>,
    ) -> Result<Response<StatusReply>, Status> {
        let meta = self.provider.metadata();
        Ok(Response::new(StatusReply {
            running: true,
            model: meta.model,
            source_lang: self.config.source_lang.clone(),
            target_lang: self.config.target_lang.clone(),
        }))
    }
}

/// Select and build the translation provider from the environment.
///
///   AMOS_TRANSLATE_BACKEND = "ollama" | "mock"   (default "ollama")
///   AMOS_TRANSLATE_HOST / AMOS_TRANSLATE_MODEL   (ollama)
pub fn provider_from_env() -> Arc<dyn TranslationProvider> {
    let kind = std::env::var("AMOS_TRANSLATE_BACKEND").unwrap_or_else(|_| "ollama".to_string());
    match kind.as_str() {
        "mock" => Arc::new(provider::MockProvider::default()),
        _ => Arc::new(
            provider::OllamaProvider::new(
                std::env::var("AMOS_TRANSLATE_HOST")
                    .unwrap_or_else(|_| "http://localhost:11434".into()),
                std::env::var("AMOS_TRANSLATE_MODEL").unwrap_or_else(|_| "llama3.2".into()),
            )
            .with_api_key(std::env::var("AMOS_TRANSLATE_API_KEY").unwrap_or_default()),
        ),
    }
}

/// Select and build the speech recognizer from the environment (optional).
///
///   AMOS_ASR_BACKEND = "mock" | "whisper" | "none"   (default "none")
///   AMOS_ASR_ENDPOINT / AMOS_ASR_MODEL / AMOS_ASR_API_KEY   (whisper)
pub fn recognizer_from_env() -> Option<Arc<dyn SpeechRecognizer>> {
    let kind = std::env::var("AMOS_ASR_BACKEND").unwrap_or_else(|_| "none".to_string());
    match kind.as_str() {
        "mock" => Some(Arc::new(asr::MockRecognizer::default())),
        "whisper" => Some(Arc::new(asr::WhisperProvider::new(
            std::env::var("AMOS_ASR_ENDPOINT")
                .unwrap_or_else(|_| "http://localhost:11434/v1/audio/transcriptions".into()),
            std::env::var("AMOS_ASR_API_KEY").ok(),
            std::env::var("AMOS_ASR_MODEL").unwrap_or_else(|_| "whisper".into()),
        ))),
        _ => None,
    }
}

/// Bind the UDS, harden it, and serve the `Translator` service until a shutdown
/// signal arrives, then clean up the socket file.
pub async fn serve(path: std::path::PathBuf) -> anyhow::Result<()> {
    let listener = tokio::net::UnixListener::bind(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .context("failed to harden socket permissions")?;
    }

    let incoming = UnixListenerStream::new(listener);
    let config = TranslateConfig {
        source_lang: std::env::var("AMOS_TRANSLATE_SOURCE").unwrap_or_else(|_| "auto".into()),
        target_lang: std::env::var("AMOS_TRANSLATE_TARGET").unwrap_or_else(|_| "zh".into()),
    };
    let mut service = TranslatorService::new(provider_from_env(), config);
    if let Some(r) = recognizer_from_env() {
        service = service.with_recognizer(r);
    }

    let server = tonic::transport::Server::builder()
        .add_service(TranslatorServer::new(service))
        .serve_with_incoming(incoming);

    tokio::select! {
        result = server => { result?; }
        _ = shutdown_signal() => {
            tracing::info!("shutdown signal received");
        }
    }

    // Best-effort, but not invisible: `serve()` binds this exact path, and `bind` fails with
    // `EADDRINUSE` on a socket file left behind — so a failed cleanup breaks the *next* start,
    // which is precisely what a silent `let _` would hide.
    if let Err(e) = std::fs::remove_file(&path) {
        tracing::warn!("failed to remove the socket file {}: {e}", path.display());
    }
    Ok(())
}

/// Resolves on SIGINT, SIGTERM, or Ctrl-C so the daemon can exit cleanly.
/// Registering the Unix handlers is best-effort: failing to install one must
/// never panic the daemon (P0-1) — we degrade to whatever is available, and
/// Ctrl-C always is.
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    let term = match signal(SignalKind::terminate()) {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!(
                "SIGTERM handler unavailable ({e}); supervisor stop falls back to SIGINT"
            );
            None
        }
    };
    let int = match signal(SignalKind::interrupt()) {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!("SIGINT handler unavailable ({e}); relying on Ctrl-C");
            None
        }
    };
    // A handler that could not be installed is awaited as pending (never fires),
    // so the other branches still decide the outcome.
    let wait = |mut s: Option<tokio::signal::unix::Signal>| async move {
        match s.as_mut() {
            Some(sig) => {
                sig.recv().await;
            }
            None => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        _ = wait(term) => {}
        _ = wait(int) => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::MockProvider;

    /// The contract every streaming branch depends on (REQ-A443): `send` fails **only** when the
    /// consumer is gone, and `deliver` must report that as `false` so the caller stops. Pinning it
    /// here is what keeps the rule from being half-applied again — the audio branches used to
    /// discard the answer and keep running ASR for a client that had already left.
    #[tokio::test]
    async fn deliver_is_true_for_a_live_consumer_and_false_once_it_is_gone() {
        let (tx, mut rx) = mpsc::channel::<Result<TranslateOut, Status>>(4);
        assert!(
            deliver(
                &tx,
                TranslateOut {
                    segment: "a".into(),
                    done: false,
                },
            )
            .await
        );
        let got = rx.recv().await.expect("the segment is delivered").unwrap();
        assert_eq!(got.segment, "a");
        assert!(!got.done);

        // A *full* buffer must not be mistaken for a gone consumer: with the receiver alive and
        // the channel at capacity, `send` waits rather than failing. (If it failed here, every
        // slow client would be treated as a departed one.)
        let (tx1, mut rx1) = mpsc::channel::<Result<TranslateOut, Status>>(1);
        assert!(
            deliver(
                &tx1,
                TranslateOut {
                    segment: "fill".into(),
                    done: false,
                },
            )
            .await
        );
        let pending = deliver(
            &tx1,
            TranslateOut {
                segment: "more".into(),
                done: false,
            },
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), pending)
                .await
                .is_err(),
            "a full channel waits; it must not report the consumer as gone"
        );
        let drained = rx1.recv().await.expect("drain one slot");
        assert_eq!(drained.expect("the queued segment").segment, "fill");

        drop(rx);
        assert!(
            !deliver(
                &tx,
                TranslateOut {
                    segment: "b".into(),
                    done: false,
                },
            )
            .await,
            "a dropped receiver is the signal every branch must act on"
        );
    }

    #[tokio::test]
    async fn translate_returns_provider_result() {
        let svc = TranslatorService::new(
            Arc::new(MockProvider::default()),
            TranslateConfig::default(),
        );
        let reply = svc
            .translate(Request::new(TranslateRequest {
                text: "hello".into(),
                source_lang: "en".into(),
                target_lang: "zh".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(reply.translated, "[译](en->zh)hello");
        assert_eq!(reply.detected_lang, "en");
    }

    #[tokio::test]
    async fn translate_falls_back_to_config_langs() {
        let svc = TranslatorService::new(
            Arc::new(MockProvider::default()),
            TranslateConfig {
                target_lang: "fr".into(),
                ..Default::default()
            },
        );
        let reply = svc
            .translate(Request::new(TranslateRequest {
                text: "hi".into(),
                source_lang: String::new(),
                target_lang: String::new(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(reply.translated, "[译](auto->fr)hi");
    }

    #[tokio::test]
    async fn get_status_reports_provider_and_config() {
        let svc = TranslatorService::new(
            Arc::new(MockProvider::default()),
            TranslateConfig::default(),
        );
        let reply = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert!(reply.running);
        assert_eq!(reply.model, "mock-translator");
        assert_eq!(reply.target_lang, "zh");
    }

    #[tokio::test]
    async fn transcribe_without_recognizer_returns_unrecognized() {
        let svc = TranslatorService::new(
            Arc::new(MockProvider::default()),
            TranslateConfig::default(),
        );
        let reply = svc
            .transcribe(Request::new(TranscribeRequest {
                audio: vec![0u8; 16],
                language: "zh".into(),
                format: "wav".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(!reply.recognized);
        assert!(reply.text.is_empty());
    }

    #[tokio::test]
    async fn transcribe_with_recognizer_returns_text() {
        let svc = TranslatorService::new(
            Arc::new(MockProvider::default()),
            TranslateConfig::default(),
        )
        .with_recognizer(Arc::new(crate::asr::MockRecognizer::default()));
        let reply = svc
            .transcribe(Request::new(TranscribeRequest {
                audio: vec![1u8; 8],
                language: "zh".into(),
                format: "wav".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(reply.recognized);
        assert_eq!(reply.text, "语音转写(模拟)(lang=zh,fmt=wav)");
    }
}

//! `amos-translate` — simultaneous-interpretation daemon.
//!
//! A gRPC service over a Unix Domain Socket. The System UI / `amos-ai` send
//! text (and, once ASR is wired, audio) segments here; the daemon routes each
//! segment through a pluggable [`TranslationProvider`] and streams translations
//! back, enabling real-time (simultaneous) interpretation.

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
                                if tx
                                    .send(Ok(TranslateOut {
                                        segment,
                                        done: false,
                                    }))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            Err(e) => {
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
                                        let _ = tx
                                            .send(Ok(TranslateOut {
                                                segment: text,
                                                done: false,
                                            }))
                                            .await;
                                    }
                                    Ok(_) => {}
                                    Err(e) => {
                                        let _ = tx.send(Err(Status::internal(e.to_string()))).await;
                                        break;
                                    }
                                }
                            }
                            None => {
                                // ASR not wired yet: acknowledge the frame honestly.
                                let note = format!("[语音] {} 字节音频，ASR 未接入", audio.len());
                                let _ = tx
                                    .send(Ok(TranslateOut {
                                        segment: note,
                                        done: false,
                                    }))
                                    .await;
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
        _ => Arc::new(provider::OllamaProvider::new(
            std::env::var("AMOS_TRANSLATE_HOST")
                .unwrap_or_else(|_| "http://localhost:11434".into()),
            std::env::var("AMOS_TRANSLATE_MODEL").unwrap_or_else(|_| "llama3.2".into()),
        )),
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

    let _ = std::fs::remove_file(&path);
    Ok(())
}

/// Resolves on SIGINT, SIGTERM, or Ctrl-C so the daemon can exit cleanly.
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("install SIGINT handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::MockProvider;

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

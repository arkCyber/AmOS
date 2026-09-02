//! A [`Pipeline`] (from `amos-int`) backed by the `amos-translate` daemon.
//!
//! This is the seam that connects the transport-agnostic interpretation engine
//! to the real daemon over gRPC / Unix Domain Socket:
//!
//! * `feed_audio` streams mono PCM through the daemon's `StreamTranslate` audio
//!   path (ASR → recognized text, surfaced as an [`AsrEvent::Final`]).
//! * `translate` calls the daemon's unary `Translate` RPC (honours source/target
//!   languages, unlike the stream's text path which uses daemon defaults).
//! * `synthesize` reports TTS as unsupported (the daemon has no TTS yet).
//!
//! A single `GrpcPipeline` can drive an `amos_int::Session` end to end.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use amos_int::config::BothMode;
use amos_int::error::{InterpretationError, Result};
use amos_int::event::TtsRequest;
use amos_int::language::Language;
use amos_int::pipeline::{AsrEvent, Pipeline, PipelineInfo, SourceText, Translation, TtsAudio};
use amos_proto::translate::{
    translate_in, translator_client::TranslatorClient, TranslateIn, TranslateOut, TranslateRequest,
};
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Channel, Endpoint, Uri};
use tonic::{Request, Streaming};
use tower::service_fn;

/// A persistent `StreamTranslate` bidi channel: one sender to push audio, one
/// response stream to read recognized text back.
struct Bidi {
    tx: mpsc::Sender<TranslateIn>,
    rx: Streaming<TranslateOut>,
}

/// Upper bound on how long a `StreamTranslate` open handshake may take.
const STREAM_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
/// Upper bound on how long the daemon may take to answer one audio frame, so a
/// wedged daemon surfaces an error instead of hanging the session forever.
const AUDIO_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

/// `amos-int` `Pipeline` implementation that proxies to the `amos-translate`
/// daemon over a Unix Domain Socket.
pub struct GrpcPipeline {
    socket: PathBuf,
    source_lang: Language,
    target_lang: Language,
    /// Cached tonic channel (rebuilt on failure, like the System UI bridge).
    channel: Arc<Mutex<Option<Channel>>>,
    /// Lazily-opened persistent audio stream.
    bidi: Arc<tokio::sync::Mutex<Option<Bidi>>>,
    /// Serializes send+read so responses correlate with requests by order.
    op: Arc<tokio::sync::Mutex<()>>,
}

impl GrpcPipeline {
    pub fn new(
        socket: impl Into<PathBuf>,
        source_lang: impl Into<Language>,
        target_lang: impl Into<Language>,
    ) -> Self {
        Self {
            socket: socket.into(),
            source_lang: source_lang.into(),
            target_lang: target_lang.into(),
            channel: Arc::new(Mutex::new(None)),
            bidi: Arc::new(tokio::sync::Mutex::new(None)),
            op: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// Return the cached gRPC channel, rebuilding it on demand.
    async fn connect_channel(&self) -> Result<Channel> {
        if let Some(c) = self
            .channel
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            return Ok(c.clone());
        }
        let channel = build_channel(&self.socket).await?;
        if let Ok(mut g) = self.channel.lock() {
            *g = Some(channel.clone());
        }
        Ok(channel)
    }

    /// Drop the cached channel and audio stream so the next call reconnects
    /// (recovers from a daemon restart).
    fn invalidate(&self) {
        if let Ok(mut g) = self.channel.lock() {
            *g = None;
        }
        if let Ok(mut b) = self.bidi.try_lock() {
            *b = None;
        }
    }

    /// Open the persistent `StreamTranslate` stream if not already open.
    async fn ensure_bidi(&self) -> Result<()> {
        let mut guard = self.bidi.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        let channel = self.connect_channel().await?;
        let mut client = TranslatorClient::new(channel);
        let (tx, rx) = mpsc::channel(64);
        let out = tokio::time::timeout(
            STREAM_OPEN_TIMEOUT,
            client.stream_translate(Request::new(ReceiverStream::new(rx))),
        )
        .await
        .map_err(|_| {
            InterpretationError::Pipeline("open stream timed out (daemon unresponsive)".into())
        })?
        .map_err(|e| InterpretationError::Pipeline(format!("open stream: {e}")))?
        .into_inner();
        *guard = Some(Bidi { tx, rx: out });
        Ok(())
    }
}

/// Convert mono f32 samples in [-1, 1] to little-endian s16 PCM (what the
/// daemon's ASR expects).
fn pcm_to_i16le(chunk: &[f32]) -> Vec<u8> {
    chunk
        .iter()
        .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
        .flat_map(|s| s.to_le_bytes())
        .collect()
}

#[tonic::async_trait]
impl Pipeline for GrpcPipeline {
    fn info(&self) -> PipelineInfo {
        PipelineInfo {
            provider: "amos-translate".to_string(),
            model: None,
            streaming_asr: false,
            tts: false,
            both_mode: BothMode::Disabled,
        }
    }

    async fn feed_audio(&self, chunk: &[f32]) -> Result<Vec<AsrEvent>> {
        if chunk.is_empty() {
            return Ok(Vec::new());
        }
        let pcm = pcm_to_i16le(chunk);
        let _op = self.op.lock().await;
        self.ensure_bidi().await?;

        let mut guard = self.bidi.lock().await;
        let bidi = guard
            .as_mut()
            .ok_or_else(|| InterpretationError::Other("audio stream closed".into()))?;

        bidi.tx
            .send(TranslateIn {
                payload: Some(translate_in::Payload::Audio(pcm)),
            })
            .await
            .map_err(|_| InterpretationError::Pipeline("audio send failed".into()))?;

        let msg = match tokio::time::timeout(AUDIO_RESPONSE_TIMEOUT, bidi.rx.message()).await {
            Ok(Ok(m)) => m, // Option<TranslateOut>
            Ok(Err(e)) => {
                self.invalidate();
                return Err(InterpretationError::Pipeline(format!("audio stream: {e}")));
            }
            Err(_) => {
                self.invalidate();
                return Err(InterpretationError::Pipeline(
                    "audio response timed out (daemon unresponsive)".into(),
                ));
            }
        };

        match msg {
            Some(out) => Ok(vec![AsrEvent::Final {
                text: out.segment,
                lang: self.source_lang.clone(),
                start: Duration::ZERO,
                end: Duration::ZERO,
            }]),
            None => {
                self.invalidate();
                Err(InterpretationError::Pipeline(
                    "audio stream ended unexpectedly".into(),
                ))
            }
        }
    }

    async fn translate(&self, src: SourceText<'_>) -> Result<Translation> {
        let channel = self.connect_channel().await?;
        let mut client = TranslatorClient::new(channel);
        let resp = match client
            .translate(TranslateRequest {
                text: src.text.to_string(),
                source_lang: src.lang.as_str().to_string(),
                target_lang: self.target_lang.as_str().to_string(),
            })
            .await
        {
            Ok(r) => r,
            Err(e) => {
                // Drop the stale cached channel so the next call reconnects
                // (a daemon restart leaves the cached channel dead otherwise).
                self.invalidate();
                return Err(InterpretationError::Pipeline(format!("translate: {e}")));
            }
        }
        .into_inner();
        Ok(Translation {
            target_text: resp.translated,
            target_lang: self.target_lang.clone(),
        })
    }

    async fn synthesize(&self, _req: &TtsRequest) -> Result<TtsAudio> {
        Err(InterpretationError::Other(
            "TTS is not supported by the amos-translate daemon".into(),
        ))
    }
}

/// Build a tonic channel over the daemon's Unix Domain Socket.
async fn build_channel(socket: &PathBuf) -> Result<Channel> {
    let owned = socket.clone();
    let endpoint = Endpoint::try_from("http://[::1]:50051")
        .map_err(|e| InterpretationError::Pipeline(e.to_string()))?;
    let channel = endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| {
            InterpretationError::Pipeline(format!(
                "translate daemon unavailable at {socket:?}: {e}"
            ))
        })?;
    Ok(channel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_convert_is_le_s16() {
        let chunk = vec![0.0, 1.0, -1.0, 0.5];
        let bytes = pcm_to_i16le(&chunk);
        assert_eq!(bytes.len(), chunk.len() * 2);
        // 0.0 -> 0 (little-endian)
        assert_eq!(&bytes[0..2], &[0x00, 0x00]);
        // 1.0 -> 32767
        assert_eq!(&bytes[2..4], &[0xff, 0x7f]);
        // -1.0 -> -32767 (32767 * -1, not i16::MIN)
        assert_eq!(&bytes[4..6], &[0x01, 0x80]);
        // 0.5 -> ~16383
        let v = i16::from_le_bytes([bytes[6], bytes[7]]);
        assert_eq!(v, 16383);
    }

    #[test]
    fn info_reports_provider_facts() {
        let pipe = GrpcPipeline::new("/nonexistent.sock", "auto", "zh");
        let out = pipe.info();
        assert_eq!(out.provider, "amos-translate");
        assert!(!out.tts);
        assert!(!out.streaming_asr);
    }
}

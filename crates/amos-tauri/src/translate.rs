//! Tauri <-> translate daemon bridge.
//!
//! Drives the **Voice** pipeline: the WebView captures audio (or sends test
//! bytes) and calls `transcribe_audio`; this opens a tonic client over the
//! translate daemon's Unix Domain Socket, runs the `Transcribe` RPC (ASR), and
//! returns the text to the frontend. Also exposes `translate_text` for the
//! same socket.

use amos_proto::translate::{
    translator_client::TranslatorClient, TranscribeRequest, TranslateRequest,
};
use serde::Serialize;
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

/// Serializable transcription result (prost structs are not `Serialize`).
#[derive(Clone, Serialize)]
pub struct TranscriptionPayload {
    pub text: String,
    pub recognized: bool,
}

/// Where the translate daemon's UDS lives (matches `deploy/daemons.json`).
fn translate_socket_path() -> std::path::PathBuf {
    std::env::var("AMOS_TRANSLATE_SOCKET")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp/amos-translate.sock"))
}

async fn build_channel() -> Result<tonic::transport::Channel, String> {
    let socket = translate_socket_path();
    let owned = socket.clone();
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| e.to_string())?;
    let channel = endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| format!("translate daemon unavailable at {socket:?}: {e}"))?;
    Ok(channel)
}

/// Transcribe an audio buffer via the translate daemon's ASR recognizer.
#[tauri::command]
pub async fn transcribe_audio(
    audio: Vec<u8>,
    language: Option<String>,
    format: Option<String>,
) -> Result<TranscriptionPayload, String> {
    let mut client = TranslatorClient::new(build_channel().await?);
    let resp = client
        .transcribe(TranscribeRequest {
            audio,
            language: language.unwrap_or_default(),
            format: format.unwrap_or_default(),
        })
        .await
        .map_err(|e| format!("transcribe RPC failed: {e}"))?
        .into_inner();
    Ok(TranscriptionPayload {
        text: resp.text,
        recognized: resp.recognized,
    })
}

/// Unary text translation via the translate daemon.
#[tauri::command]
pub async fn translate_text(
    text: String,
    source_lang: Option<String>,
    target_lang: Option<String>,
) -> Result<String, String> {
    let mut client = TranslatorClient::new(build_channel().await?);
    let resp = client
        .translate(TranslateRequest {
            text,
            source_lang: source_lang.unwrap_or_default(),
            target_lang: target_lang.unwrap_or_default(),
        })
        .await
        .map_err(|e| format!("translate RPC failed: {e}"))?
        .into_inner();
    Ok(resp.translated)
}

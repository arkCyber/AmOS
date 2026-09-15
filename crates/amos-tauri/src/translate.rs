//! Tauri <-> translate daemon bridge.
//!
//! Drives the **Voice** pipeline: the WebView captures audio (or sends test
//! bytes) and calls `transcribe_audio`; this opens a tonic client over the
//! translate daemon's Unix Domain Socket, runs the `Transcribe` RPC (ASR), and
//! returns the text to the frontend. Also exposes `translate_text` for the
//! same socket.

use amos_int::language::MAX_LANG_TAG_BYTES;
use amos_proto::translate::{
    translator_client::TranslatorClient, TranscribeRequest, TranslateRequest,
};
use serde::Serialize;
use tokio::net::UnixStream;
use tonic::transport::{Channel, Endpoint, Uri};
use tower::service_fn;

/// Serializable transcription result (prost structs are not `Serialize`).
#[derive(Clone, Serialize)]
pub struct TranscriptionPayload {
    pub text: String,
    pub recognized: bool,
}

/// Maximum bytes in a `translate_text` source text handed in by the WebView.
///
/// Real inputs are one utterance / one paragraph — bounded at 32 KiB (matches
/// `MAX_INTERPRET_TEXT_BYTES`). Past that, the daemon's translation pipeline
/// would either stall or consume its own token budget.
pub const MAX_TRANSLATE_TEXT_BYTES: usize = 32 << 10;

/// Maximum bytes in an audio payload handed in via `transcribe_audio`.
///
/// 16 MiB covers a generous 30-second 22.05 kHz / 2-channel buffer and is
/// large enough for any legitimate recording dump from the WebView's encoder.
pub const MAX_TRANSCRIBE_AUDIO_BYTES: usize = 16 << 20;

/// Where the translate daemon's UDS lives (matches `deploy/daemons.json`).
fn translate_socket_path() -> std::path::PathBuf {
    std::env::var("AMOS_TRANSLATE_SOCKET")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp/amos-translate.sock"))
}

/// The translate daemon is **not** amos-ai: it lives on its own socket and has no shared
/// secret (the `x-amos-token` transport belongs to amos-ai alone), so this stays a plain
/// `Channel` — no token is attached to requests for it.
async fn build_channel() -> Result<Channel, String> {
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
    if audio.len() > MAX_TRANSCRIBE_AUDIO_BYTES {
        return Err(format!(
            "transcribe audio too large: {} bytes (max {MAX_TRANSCRIBE_AUDIO_BYTES})",
            audio.len()
        ));
    }
    let language = check_lang(language)?;
    let format = check_format(format)?;
    let mut client = TranslatorClient::new(build_channel().await?);
    let resp = client
        .transcribe(TranscribeRequest {
            audio,
            language,
            format,
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
    if text.len() > MAX_TRANSLATE_TEXT_BYTES {
        return Err(format!(
            "translate text too long: {} bytes (max {MAX_TRANSLATE_TEXT_BYTES})",
            text.len()
        ));
    }
    let source_lang = check_lang(source_lang)?;
    let target_lang = check_lang(target_lang)?;
    let mut client = TranslatorClient::new(build_channel().await?);
    let resp = client
        .translate(TranslateRequest {
            text,
            source_lang,
            target_lang,
        })
        .await
        .map_err(|e| format!("translate RPC failed: {e}"))?
        .into_inner();
    Ok(resp.translated)
}

/// Bound a language tag passed in via `Option<String>` — the daemon accepts the
/// default empty string (auto-detect) but a paste-sized caller must not slip
/// through.
fn check_lang(s: Option<String>) -> Result<String, String> {
    let v = s.unwrap_or_default();
    if v.len() > MAX_LANG_TAG_BYTES {
        return Err(format!(
            "language tag too long: {} bytes (max {MAX_LANG_TAG_BYTES})",
            v.len()
        ));
    }
    if v.chars().any(|c| c.is_control() || c == '\0') {
        return Err("language tag contains control characters".to_string());
    }
    Ok(v)
}

/// Bound a format string (the ASR encoding hint, e.g. `"wav"`/`"pcm_s16le"`).
/// Real values are short labels; a paste-sized caller must not slip through.
fn check_format(s: Option<String>) -> Result<String, String> {
    let v = s.unwrap_or_default();
    if v.len() > 64 {
        return Err(format!("format too long: {} bytes (max 64)", v.len()));
    }
    if v.chars().any(|c| c.is_control() || c == '\0') {
        return Err("format contains control characters".to_string());
    }
    Ok(v)
}

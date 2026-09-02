//! Pluggable speech recognition (ASR) — powers the hardware **Voice** button.
//!
//! `MockRecognizer` is deterministic (offline / tests); `WhisperProvider` calls
//! an OpenAI-compatible `/v1/audio/transcriptions` endpoint (e.g. a local
//! whisper server). Swapping recognizers only requires implementing the trait.

use std::time::Duration;

use anyhow::{anyhow, Result};
use async_trait::async_trait;

/// A recognizer that transcribes audio bytes to text.
#[async_trait]
pub trait SpeechRecognizer: Send + Sync {
    async fn transcribe(&self, audio: &[u8], language: &str, format: &str) -> Result<String>;
}

/// Deterministic recognizer for tests / offline development.
pub struct MockRecognizer {
    /// Text always returned (annotated with the request params).
    pub text: String,
}

impl Default for MockRecognizer {
    fn default() -> Self {
        Self {
            text: "语音转写(模拟)".to_string(),
        }
    }
}

#[async_trait]
impl SpeechRecognizer for MockRecognizer {
    async fn transcribe(&self, _audio: &[u8], language: &str, format: &str) -> Result<String> {
        let lang = if language.is_empty() {
            "auto"
        } else {
            language
        };
        let fmt = if format.is_empty() { "auto" } else { format };
        Ok(format!("{}(lang={},fmt={})", self.text, lang, fmt))
    }
}

/// Extract the transcribed text from a Whisper-style JSON response.
fn parse_whisper_text(json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()?
        .get("text")?
        .as_str()
        .map(str::to_string)
}

/// Build a `multipart/form-data` body (the OpenAI-style `/v1/audio/transcriptions`
/// endpoint requires an `audio` file field plus `model`/`language` parts).
/// Returns `(boundary, body_bytes)`.
fn build_multipart(audio: &[u8], filename: &str, fields: &[(&str, &str)]) -> (String, Vec<u8>) {
    let boundary = format!("----amos-mp-{}", fast_boundary());
    let mut body = Vec::new();
    for (k, v) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
                .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; \
             filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (boundary, body)
}

fn fast_boundary() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static N: AtomicU64 = AtomicU64::new(0);
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    format!("{t:x}{n:x}")
}

/// Whisper-compatible recognizer via an OpenAI-style `/v1/audio/transcriptions`.
pub struct WhisperProvider {
    endpoint: String,
    api_key: Option<String>,
    model: String,
}

impl WhisperProvider {
    pub fn new(
        endpoint: impl Into<String>,
        api_key: Option<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            endpoint: endpoint.into(),
            api_key,
            model: model.into(),
        }
    }
}

#[async_trait]
impl SpeechRecognizer for WhisperProvider {
    async fn transcribe(&self, audio: &[u8], language: &str, format: &str) -> Result<String> {
        let endpoint = self.endpoint.clone();
        let api_key = self.api_key.clone();
        let model = self.model.clone();
        let audio = audio.to_vec();
        let language = language.to_string();
        let ext = if format.is_empty() { "wav" } else { format };
        let ext = ext.trim_start_matches('.').to_string();

        let resp = tokio::task::spawn_blocking(move || {
            let mut fields: Vec<(&str, &str)> = vec![("model", model.as_str())];
            if !language.is_empty() {
                fields.push(("language", language.as_str()));
            }
            let (boundary, body) = build_multipart(&audio, &format!("audio.{ext}"), &fields);
            let mut req = ureq::post(&endpoint).timeout(Duration::from_secs(60)).set(
                "Content-Type",
                &format!("multipart/form-data; boundary={boundary}"),
            );
            if let Some(k) = &api_key {
                req = req.set("Authorization", &format!("Bearer {k}"));
            }
            let resp = req.send_bytes(&body).map_err(|e| e.to_string())?;
            resp.into_string().map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| anyhow!("ASR task join error: {e}"))?
        .map_err(anyhow::Error::msg)?;

        parse_whisper_text(&resp).ok_or_else(|| anyhow!("no text in ASR response"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_whisper_text_extracts_text() {
        assert_eq!(
            parse_whisper_text(r#"{"text":"你好世界"}"#).as_deref(),
            Some("你好世界")
        );
        assert_eq!(parse_whisper_text("{}"), None);
        assert_eq!(parse_whisper_text("not json"), None);
    }

    #[test]
    fn build_multipart_forms_valid_body() {
        let audio = b"RIFF....";
        let (boundary, body) = build_multipart(
            audio,
            "audio.wav",
            &[("model", "whisper"), ("language", "zh")],
        );
        let s = String::from_utf8(body).unwrap();
        assert!(
            s.contains(&format!("--{boundary}\r\n")),
            "opens with boundary"
        );
        assert!(
            s.contains("name=\"model\"\r\n\r\nwhisper\r\n"),
            "model field present"
        );
        assert!(
            s.contains("name=\"language\"\r\n\r\nzh\r\n"),
            "language field present"
        );
        assert!(
            s.contains("name=\"file\"; filename=\"audio.wav\""),
            "file field present"
        );
        assert!(
            s.ends_with(&format!("\r\n--{boundary}--\r\n")),
            "closes boundary"
        );
        assert!(s.contains("RIFF...."), "audio bytes embedded");
    }

    #[tokio::test]
    async fn mock_recognizer_annotates_params() {
        let r = MockRecognizer::default();
        let out = r.transcribe(&[0u8; 8], "zh", "wav").await.unwrap();
        assert_eq!(out, "语音转写(模拟)(lang=zh,fmt=wav)");
        let auto = r.transcribe(&[], "", "").await.unwrap();
        assert!(auto.contains("lang=auto"));
    }
}

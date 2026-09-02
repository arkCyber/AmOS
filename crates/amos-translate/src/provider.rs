//! Pluggable translation providers for the simultaneous-interpretation daemon.
//!
//! The daemon routes every translation through a [`TranslationProvider`]. Only
//! `OllamaProvider` is wired by default; swapping in Hermes / an API is a matter
//! of implementing the trait (the transport and gRPC surface stay unchanged).

use std::time::Duration;

use anyhow::{anyhow, Result};
use async_trait::async_trait;

/// Metadata describing a translation provider.
#[derive(Debug, Clone)]
pub struct ProviderMeta {
    pub name: &'static str,
    pub model: String,
}

/// A provider capable of translating a segment of text between two languages.
#[async_trait]
pub trait TranslationProvider: Send + Sync {
    /// Translate `text` from `source` to `target` (`source` may be empty for
    /// auto-detect). Returns the translated text.
    async fn translate(&self, text: &str, source: &str, target: &str) -> Result<String>;

    fn metadata(&self) -> ProviderMeta;
}

/// Build the instruction the provider should follow to translate a segment.
pub fn build_prompt(text: &str, source: &str, target: &str) -> String {
    let src = if source.is_empty() { "auto" } else { source };
    format!(
        "You are a professional simultaneous interpreter.\n\
         Translate the text from '{src}' to '{target}'.\n\
         Output only the translation, nothing else.\n\n{text}"
    )
}

/// Parse the assistant text from a non-streaming OpenAI-compatible response.
/// Unit-testable; returns an error when `choices[0].message.content` is absent.
pub fn parse_openai_content(body: &str) -> Result<String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| anyhow!("invalid translation response JSON: {e}"))?;
    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| anyhow!("no content in translation response"))?;
    Ok(content.to_string())
}

/// Local Ollama provider (OpenAI-compatible `/v1/chat/completions`, non-stream).
pub struct OllamaProvider {
    host: String,
    model: String,
}

impl OllamaProvider {
    /// Create a provider for an Ollama base URL (e.g. `http://localhost:11434`).
    pub fn new(host: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            host: host.into().trim_end_matches('/').to_string(),
            model: model.into(),
        }
    }
}

#[async_trait]
impl TranslationProvider for OllamaProvider {
    async fn translate(&self, text: &str, source: &str, target: &str) -> Result<String> {
        let host = self.host.clone();
        let model = self.model.clone();
        let prompt = build_prompt(text, source, target);

        let body = serde_json::json!({
            "model": model,
            "messages": [
                { "role": "system", "content": "You are a simultaneous interpreter." },
                { "role": "user", "content": prompt },
            ],
            "stream": false,
        });

        let resp = tokio::task::spawn_blocking(move || {
            ureq::post(&format!("{host}/v1/chat/completions"))
                .timeout(Duration::from_secs(60))
                .set("Content-Type", "application/json")
                .send_string(&body.to_string())
                .map_err(|e| e.to_string())?
                .into_string()
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| anyhow!("translation task join error: {e}"))?
        .map_err(anyhow::Error::msg)?;

        parse_openai_content(&resp)
    }

    fn metadata(&self) -> ProviderMeta {
        ProviderMeta {
            name: "ollama",
            model: self.model.clone(),
        }
    }
}

/// Deterministic in-process provider for tests / offline development.
pub struct MockProvider {
    /// Prefix added to every translation so tests can assert routing.
    pub prefix: String,
}

impl Default for MockProvider {
    fn default() -> Self {
        Self {
            prefix: "[译]".to_string(),
        }
    }
}

#[async_trait]
impl TranslationProvider for MockProvider {
    async fn translate(&self, text: &str, source: &str, target: &str) -> Result<String> {
        Ok(format!("{}({}->{}){}", self.prefix, source, target, text))
    }

    fn metadata(&self) -> ProviderMeta {
        ProviderMeta {
            name: "mock",
            model: "mock-translator".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_openai_content_extracts_assistant_text() {
        let body = r#"{"choices":[{"message":{"content":"你好"}}]}"#;
        assert_eq!(parse_openai_content(body).unwrap(), "你好");
        assert!(parse_openai_content("{}").is_err());
        assert!(parse_openai_content(r#"{"choices":[{"message":{}}]}"#).is_err());
    }

    #[test]
    fn build_prompt_includes_languages() {
        let p = build_prompt("hello", "en", "zh");
        assert!(p.contains("'en'"));
        assert!(p.contains("'zh'"));
        assert!(p.contains("hello"));
    }

    #[tokio::test]
    async fn mock_provider_routes_and_annotates() {
        let p = MockProvider::default();
        let out = p.translate("hi", "en", "zh").await.unwrap();
        assert_eq!(out, "[译](en->zh)hi");
    }
}

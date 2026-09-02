//! Tauri <-> TTS bridge.
//!
//! Exposes `tts_synthesize`, so the WebView can synthesize translated text to
//! playable audio (Web Audio API) — completing the speech loop for the
//! interpretation app. The backend is a managed [`TtsProvider`] (mock by
//! default; swap in Piper behind the `piper` feature).

use std::sync::Arc;

use amos_int::language::Language;
use amos_tts::{MockTtsProvider, TtsProvider};
use serde::Serialize;

/// Serializable synthesis result for the WebView.
#[derive(Clone, Debug, Serialize)]
pub struct TtsAudioPayload {
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
}

/// App-managed TTS backend.
pub struct TtsBridge {
    provider: Arc<dyn TtsProvider>,
}

impl Default for TtsBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl TtsBridge {
    pub fn new() -> Self {
        Self {
            provider: Arc::new(MockTtsProvider::default()),
        }
    }

    /// Swap the backend (e.g. a Piper provider), for tests/advanced use.
    pub fn with_provider(mut self, provider: Arc<dyn TtsProvider>) -> Self {
        self.provider = provider;
        self
    }
}

/// Synthesize `text` to PCM audio via the managed TTS provider.
#[tauri::command]
pub async fn tts_synthesize(
    state: tauri::State<'_, TtsBridge>,
    text: String,
    lang: Option<String>,
) -> Result<TtsAudioPayload, String> {
    let lang = Language::new(lang.unwrap_or_else(|| "zh".to_string()));
    let audio = state
        .provider
        .synthesize(&text, &lang)
        .await
        .map_err(|e| e.to_string())?;
    Ok(TtsAudioPayload {
        sample_rate: audio.sample_rate,
        channels: audio.channels,
        samples: audio.samples,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_synthesize_returns_playable_payload() {
        let bridge = TtsBridge::new();
        // Call the provider directly (command requires a Tauri AppHandle).
        let audio = bridge
            .provider
            .synthesize("你好", &Language::new("zh"))
            .await
            .unwrap();
        let payload = TtsAudioPayload {
            sample_rate: audio.sample_rate,
            channels: audio.channels,
            samples: audio.samples,
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["sample_rate"], 16000);
        assert_eq!(json["channels"], 1);
        assert!(json["samples"].is_array());
    }
}

//! Tauri <-> TTS bridge.
//!
//! Exposes `tts_synthesize`, so the WebView can synthesize translated text to
//! playable audio (Web Audio API) — completing the speech loop for the
//! interpretation app. The backend is a managed [`TtsProvider`]: the
//! deterministic mock by default, or a **local Piper voice** behind the
//! `piper-tts` feature when `AMOS_PIPER_MODEL_DIR` points at a voice dir.

use std::sync::Arc;

use amos_int::language::Language;
#[cfg(feature = "piper-tts")]
use amos_tts::PiperProvider;
use amos_tts::{MockTtsProvider, TtsProvider};
use serde::Serialize;
#[cfg(feature = "piper-tts")]
use std::path::PathBuf;

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
            provider: Self::select_provider(),
        }
    }

    /// Choose the default provider: a local Piper voice when the `piper-tts`
    /// feature is enabled and `AMOS_PIPER_MODEL_DIR` is configured; otherwise
    /// the deterministic mock (App behavior unchanged when Piper isn't set up).
    fn select_provider() -> Arc<dyn TtsProvider> {
        #[cfg(feature = "piper-tts")]
        if let Some(p) = Self::local_piper_provider() {
            return p;
        }
        Arc::new(MockTtsProvider::default())
    }

    /// Load a local Piper voice from `AMOS_PIPER_MODEL_DIR` (expected to contain
    /// `en_US-lessac-low.onnx` + its `.onnx.json`). Returns `None` when the
    /// models are missing or fail to load, so the caller keeps the mock.
    #[cfg(feature = "piper-tts")]
    fn local_piper_provider() -> Option<Arc<dyn TtsProvider>> {
        let dir = PathBuf::from(std::env::var("AMOS_PIPER_MODEL_DIR").ok()?);
        let onnx = dir.join("en_US-lessac-low.onnx");
        let voice = dir.join("en_US-lessac-low.onnx.json");
        if !onnx.exists() || !voice.exists() {
            return None; // Piper models not downloaded; keep the mock
        }
        match PiperProvider::new(onnx, voice) {
            Ok(p) => {
                tracing::info!("tts: using local Piper voice from {}", dir.display());
                Some(Arc::new(p) as Arc<dyn TtsProvider>)
            }
            Err(e) => {
                tracing::warn!("tts: Piper model load failed ({e}); falling back to mock");
                None
            }
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

    /// With the `piper-tts` feature, an unset/misconfigured model directory must
    /// keep the deterministic mock backend (App behavior unchanged).
    #[cfg(feature = "piper-tts")]
    #[test]
    fn falls_back_to_mock_without_piper_dir() {
        std::env::set_var("AMOS_PIPER_MODEL_DIR", "/nonexistent-amos-piper");
        let bridge = TtsBridge::new();
        assert_eq!(
            bridge.provider.name(),
            "mock-tts",
            "no models => mock backend"
        );
    }

    /// Runtime proof that `tts_synthesize` uses a real local Piper voice when
    /// `AMOS_PIPER_MODEL_DIR` points at a downloaded voice dir (loads the model,
    /// so it needs `models/` on disk). Ignored by default — run it alone with
    /// `cargo test -p amos-tauri --features piper-tts piper_voice -- --ignored`
    /// and the env var exported, so it doesn't race the mock tests.
    #[cfg(feature = "piper-tts")]
    #[tokio::test]
    #[ignore = "requires AMOS_PIPER_MODEL_DIR with a downloaded Piper voice"]
    async fn piper_voice_loads_when_configured() {
        let _ = std::env::var("AMOS_PIPER_MODEL_DIR")
            .expect("export AMOS_PIPER_MODEL_DIR=.../models/piper-low for this test");
        let bridge = TtsBridge::new();
        assert_eq!(
            bridge.provider.name(),
            "piper",
            "configured Piper dir => Piper backend"
        );
        // And it actually synthesizes real PCM.
        let audio = bridge
            .provider
            .synthesize("hello", &Language::new("en"))
            .await
            .expect("piper synthesize");
        assert!(!audio.samples.is_empty(), "Piper produced non-empty audio");
    }
}

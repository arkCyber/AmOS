//! Voice input for the bidi `Chat` stream: a per-connection recognizer that
//! turns incoming `Payload::Audio` frames into a finalized utterance.
//!
//! `amos-ai` speaks the *wire* format for audio as **mono 16 kHz f32 PCM,
//! little-endian** (4 bytes per sample) — the same sample format
//! [`amos_asr::StreamingRecognizer`] expects. When the recognizer signals an
//! utterance end (its endpoint / VAD), [`ChatAsr::feed_audio`] returns the
//! recognized text so the server can enqueue it as a normal prompt. Design:
//! `docs/bidi-voice-asr.md`.
//!
//! Backend is selected by `AMOS_ASR_BACKEND`:
//! * `mock` (default, deterministic, offline — emits a fixed phrase once enough
//!   samples arrive);
//! * `sherpa` — real local on-device ASR (sherpa-onnx behind `amos-asr`'s
//!   `sherpa` feature). Requires building `amos-ai` with the `asr-sherpa`
//!   feature **and** pointing `AMOS_SHERPA_MODEL_DIR` at a sherpa model dir;
//!   otherwise voice falls back to `None` (honest "not configured") rather than
//!   silently degrading to the mock.
//! * `off` / `none` / `disabled` — disable voice entirely.

use amos_asr::{MockStreamingRecognizer, StreamingRecognizer};

/// Upper bound on one inbound audio frame (in 16 kHz samples ≈ 4 bytes each).
/// ~10 seconds @16 kHz is far above any real mic chunk (milliseconds–hundreds of
/// ms), so anything larger is a malformed/malicious client trying to make us
/// allocate an unbounded buffer — dropped before decode, never processed.
const MAX_FRAME_SAMPLES: usize = 160_000;

/// Wraps a [`StreamingRecognizer`] for one bidi connection.
pub struct ChatAsr {
    rec: Box<dyn StreamingRecognizer>,
}

impl ChatAsr {
    /// Wrap a recognizer.
    pub fn new(rec: Box<dyn StreamingRecognizer>) -> Self {
        Self { rec }
    }

    /// Build from the environment. Selects the recognizer backend:
    ///
    /// * `AMOS_ASR_BACKEND=off|none|disabled` → `None` (voice disabled).
    /// * `AMOS_ASR_BACKEND=sherpa` (requires the `asr-sherpa` feature) → real
    ///   local sherpa-onnx streaming recognizer, configured via
    ///   `AMOS_SHERPA_MODEL_DIR`. If the feature or the model files are missing
    ///   we warn and return `None` so `Payload::Audio` falls back to the honest
    ///   "voice not configured" path instead of silently degrading to the mock.
    /// * anything else (default) → the deterministic mock.
    pub fn from_env() -> Option<Self> {
        match std::env::var("AMOS_ASR_BACKEND").as_deref() {
            Ok("off") | Ok("none") | Ok("disabled") => {
                tracing::debug!("voice input disabled (AMOS_ASR_BACKEND)");
                None
            }
            Ok("sherpa") => sherpa_recognizer_from_env(),
            // mock (default) or any unrecognised value -> deterministic mock.
            _ => {
                tracing::info!("voice input: deterministic mock ASR (AMOS_ASR_BACKEND=mock)");
                Some(Self::new(Box::new(mock_recognizer())))
            }
        }
    }

    /// Feed one PCM frame (mono 16 kHz f32, little-endian) and return the
    /// finalized utterance text if the recognizer reached its endpoint (the
    /// recognizer is then reset, ready for the next utterance).
    pub fn feed_audio(&mut self, bytes: &[u8]) -> Option<String> {
        // Bound the untrusted wire frame *before* allocating/decode: an oversized
        // or corrupt frame must not make us allocate a huge buffer (memory DoS).
        if bytes.len() / 4 > MAX_FRAME_SAMPLES {
            tracing::warn!(
                "dropping oversized audio frame ({} samples > cap {MAX_FRAME_SAMPLES})",
                bytes.len() / 4
            );
            return None;
        }
        let samples = decode_f32_le(bytes);
        if samples.is_empty() {
            return None;
        }
        self.feed_samples(&samples)
    }

    /// Feed decoded samples; exposed for tests and non-wire callers.
    pub fn feed_samples(&mut self, samples: &[f32]) -> Option<String> {
        if samples.is_empty() {
            return None;
        }
        let _ = self.rec.push_samples(samples);
        if self.rec.is_endpoint() {
            let text = self.rec.finalize();
            self.rec.reset();
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        None
    }

    /// **Force-finalize** the current utterance and reset, returning its text
    /// without waiting for the recognizer's own endpoint/VAD. This is what a
    /// push-to-talk release (`Payload::AudioEnd`) triggers: the user said "I'm
    /// done speaking", so whatever was recognized so far becomes the turn.
    pub fn finish(&mut self) -> Option<String> {
        let text = self.rec.finalize();
        self.rec.reset();
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            Some(trimmed.to_string())
        } else {
            None
        }
    }
}

/// Deterministic mock recognizer for offline demo / CI.
fn mock_recognizer() -> MockStreamingRecognizer {
    // Emits one word per ~10 ms frame; endpoint after 4 words (~640 samples).
    MockStreamingRecognizer::new(["你", "好", "，", "Amos"], 4)
}

/// Resolve a model file by trying each candidate name in order and returning the
/// first that exists in `dir` (used for the int8 → plain → generic fallback).
#[cfg(feature = "asr-sherpa")]
fn first_existing(dir: &std::path::Path, candidates: &[&str]) -> Option<std::path::PathBuf> {
    candidates.iter().map(|f| dir.join(f)).find(|p| p.exists())
}

/// Real local sherpa-onnx streaming recognizer selected by
/// `AMOS_ASR_BACKEND=sherpa` + `AMOS_SHERPA_MODEL_DIR` (feature `asr-sherpa`).
#[cfg(feature = "asr-sherpa")]
fn sherpa_recognizer_from_env() -> Option<ChatAsr> {
    use amos_asr::{SherpaOnlineRecognizer, SherpaOnlineRecognizerConfig};
    use std::path::PathBuf;

    let dir = std::env::var("AMOS_SHERPA_MODEL_DIR")
        .ok()
        .map(PathBuf::from)
        .filter(|d| !d.as_os_str().is_empty());
    let Some(dir) = dir else {
        tracing::warn!("AMOS_ASR_BACKEND=sherpa but AMOS_SHERPA_MODEL_DIR is unset");
        return None;
    };
    if !dir.join("tokens.txt").exists() {
        tracing::warn!(
            "AMOS_ASR_BACKEND=sherpa but tokens.txt missing under {}",
            dir.display()
        );
        return None;
    }
    // Resolve each ONNX with an int8 → plain → generic-name fallback, so a model
    // dir carrying only the non-quantised files still loads (mirrors the Tauri
    // side's model resolution).
    let encoder = first_existing(
        &dir,
        &[
            "encoder-epoch-99-avg-1.int8.onnx",
            "encoder-epoch-99-avg-1.onnx",
            "encoder.onnx",
        ],
    );
    let decoder = first_existing(
        &dir,
        &[
            "decoder-epoch-99-avg-1.int8.onnx",
            "decoder-epoch-99-avg-1.onnx",
            "decoder.onnx",
        ],
    );
    let joiner = first_existing(
        &dir,
        &[
            "joiner-epoch-99-avg-1.int8.onnx",
            "joiner-epoch-99-avg-1.onnx",
            "joiner.onnx",
        ],
    );
    let (Some(encoder), Some(decoder), Some(joiner)) = (encoder, decoder, joiner) else {
        tracing::warn!(
            "AMOS_ASR_BACKEND=sherpa but encoder/decoder/joiner model files missing under {}",
            dir.display()
        );
        return None;
    };
    let cfg = SherpaOnlineRecognizerConfig {
        tokens: dir.join("tokens.txt"),
        encoder,
        decoder,
        joiner,
        lang: "auto".into(),
        ..Default::default()
    };
    match SherpaOnlineRecognizer::new(cfg) {
        Ok(rec) => {
            tracing::info!("voice input: local sherpa-onnx ASR from {}", dir.display());
            Some(ChatAsr::new(Box::new(rec)))
        }
        Err(e) => {
            tracing::warn!("AMOS_ASR_BACKEND=sherpa but recognizer init failed: {e}");
            None
        }
    }
}

/// Fallback when the daemon was built without `asr-sherpa`.
#[cfg(not(feature = "asr-sherpa"))]
fn sherpa_recognizer_from_env() -> Option<ChatAsr> {
    tracing::warn!(
        "AMOS_ASR_BACKEND=sherpa but amos-ai was built without the `asr-sherpa` feature"
    );
    None
}

/// Decode mono 16 kHz f32 little-endian PCM bytes into `f32` samples. Trailing
/// partial samples (< 4 bytes) are ignored.
fn decode_f32_le(bytes: &[u8]) -> Vec<f32> {
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zeros(n: usize) -> Vec<u8> {
        vec![0u8; n * 4]
    }

    #[test]
    fn decodes_f32_le_bytes() {
        let bytes = 1.0f32.to_le_bytes();
        assert_eq!(decode_f32_le(&bytes), vec![1.0]);
        // Trailing <4 bytes ignored.
        let mut b = bytes.to_vec();
        b.push(0);
        assert_eq!(decode_f32_le(&b), vec![1.0]);
    }

    #[test]
    fn mock_recognizes_after_enough_samples() {
        let mut asr = ChatAsr::new(Box::new(mock_recognizer()));
        // 160 samples per partial, 4 partials -> endpoint.
        let frame = zeros(640);
        let text = asr.feed_audio(&frame);
        assert_eq!(text.as_deref(), Some("你好，Amos"));
    }

    #[test]
    fn accumulates_across_frames_then_resets() {
        let mut asr = ChatAsr::new(Box::new(mock_recognizer()));
        // Two frames of 320 samples each (cumulative 640 -> endpoint).
        assert_eq!(asr.feed_audio(&zeros(320)), None, "not enough yet");
        let text = asr.feed_audio(&zeros(320));
        assert_eq!(text.as_deref(), Some("你好，Amos"));
        // Recognizer reset: a fresh utterance needs more samples before endpoint.
        assert_eq!(
            asr.feed_audio(&zeros(160)),
            None,
            "reset, still accumulating"
        );
    }

    #[test]
    fn from_env_can_be_disabled() {
        std::env::set_var("AMOS_ASR_BACKEND", "off");
        assert!(ChatAsr::from_env().is_none());
        std::env::remove_var("AMOS_ASR_BACKEND");
        assert!(ChatAsr::from_env().is_some(), "default is mock");
    }

    #[test]
    fn finish_force_finalizes_a_short_utterance_and_resets() {
        let mut asr = ChatAsr::new(Box::new(mock_recognizer()));
        // One partial (160 samples) is not enough to auto-endpoint (needs 640).
        assert_eq!(asr.feed_audio(&zeros(160)), None, "still accumulating");
        // Push-to-talk release force-finalizes whatever was heard.
        assert_eq!(asr.finish().as_deref(), Some("你好，Amos"));
        // Recognizer is reset for the next utterance.
        assert_eq!(
            asr.feed_audio(&zeros(160)),
            None,
            "reset, accumulating anew"
        );
        assert_eq!(asr.finish().as_deref(), Some("你好，Amos"));
    }

    #[test]
    fn oversized_audio_frame_is_dropped_before_decode() {
        let mut asr = ChatAsr::new(Box::new(mock_recognizer()));
        // One full valid frame (enough for an utterance) works as usual.
        assert_eq!(asr.feed_audio(&zeros(640)), Some("你好，Amos".to_string()));

        // A frame far beyond the cap must be dropped (None) without panic or a
        // huge decode allocation.
        let huge = vec![0u8; (MAX_FRAME_SAMPLES + 10) * 4];
        assert_eq!(asr.feed_audio(&huge), None, "oversized frame ignored");

        // The recognizer/session remains fully usable afterwards.
        assert_eq!(asr.finish().as_deref(), Some("你好，Amos"));
    }
}

#[cfg(feature = "asr-sherpa")]
mod sherpa_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn first_existing_prefers_int8_then_falls_back_to_plain() {
        let dir = std::env::temp_dir().join(format!("amos-sherpa-find-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Only the plain (non-int8) model present -> it is chosen.
        std::fs::write(dir.join("encoder-epoch-99-avg-1.onnx"), b"x").unwrap();
        let p = first_existing(
            Path::new(&dir),
            &[
                "encoder-epoch-99-avg-1.int8.onnx",
                "encoder-epoch-99-avg-1.onnx",
            ],
        )
        .expect("plain fallback resolves");
        assert_eq!(p, dir.join("encoder-epoch-99-avg-1.onnx"));

        // Once the int8 variant appears, it is preferred.
        std::fs::write(dir.join("encoder-epoch-99-avg-1.int8.onnx"), b"y").unwrap();
        let p = first_existing(
            Path::new(&dir),
            &[
                "encoder-epoch-99-avg-1.int8.onnx",
                "encoder-epoch-99-avg-1.onnx",
            ],
        )
        .expect("int8 preferred");
        assert_eq!(p, dir.join("encoder-epoch-99-avg-1.int8.onnx"));

        // None of the candidates present -> None.
        assert!(first_existing(Path::new(&dir), &["joiner.onnx"]).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}

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
//! Backend is selected by `AMOS_ASR_BACKEND`: `mock` (default, deterministic,
//! offline — emits a fixed phrase once enough samples arrive) or `off`/`none` to
//! disable voice entirely. A real local ASR (sherpa-onnx behind `amos-asr`'s
//! `sherpa` feature) can be wired here later without changing the seam.

use amos_asr::{MockStreamingRecognizer, StreamingRecognizer};

/// Wraps a [`StreamingRecognizer`] for one bidi connection.
pub struct ChatAsr {
    rec: Box<dyn StreamingRecognizer>,
}

impl ChatAsr {
    /// Wrap a recognizer.
    pub fn new(rec: Box<dyn StreamingRecognizer>) -> Self {
        Self { rec }
    }

    /// Build from the environment. Defaults to the deterministic mock; returns
    /// `None` when voice is disabled (`AMOS_ASR_BACKEND=off|none|disabled`).
    pub fn from_env() -> Option<Self> {
        match std::env::var("AMOS_ASR_BACKEND").as_deref() {
            Ok("off") | Ok("none") | Ok("disabled") => {
                tracing::debug!("voice input disabled (AMOS_ASR_BACKEND)");
                None
            }
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
}

/// Deterministic mock recognizer for offline demo / CI.
fn mock_recognizer() -> MockStreamingRecognizer {
    // Emits one word per ~10 ms frame; endpoint after 4 words (~640 samples).
    MockStreamingRecognizer::new(["你", "好", "，", "Amos"], 4)
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
}

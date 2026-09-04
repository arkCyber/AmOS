//! Sample-format helpers and the shared stream descriptor used by every source /
//! sink in `amos-audio`.

use crate::error::AudioError;

/// The sample rate of AmOS's audio wire format and of the local streaming ASR
/// (`amos_asr::StreamingRecognizer` expects **mono 16 kHz f32**).
pub const ASR_SAMPLE_RATE: u32 = 16_000;

/// A description of one PCM stream. `amos-audio` always carries **mono f32**
/// across the trait boundary; multi-channel device frames are down-mixed by the
/// platform seams before they reach the traits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioSpec {
    /// Samples per second (per channel), e.g. `16_000` for the ASR wire format.
    pub sample_rate: u32,
    /// Number of interleaved channels (the traits normalise to 1 before use).
    pub channels: u16,
}

impl AudioSpec {
    /// Mono stream at `sample_rate`.
    pub const fn new(sample_rate: u32, channels: u16) -> Self {
        Self {
            sample_rate,
            channels,
        }
    }

    /// The exact spec the ASR / wire contract expect: mono 16 kHz.
    pub const fn asr() -> Self {
        Self::new(ASR_SAMPLE_RATE, 1)
    }

    /// True when the spec is plausible enough to open a stream against.
    pub fn is_valid(&self) -> bool {
        self.sample_rate >= 8_000 && self.channels >= 1
    }
}

impl Default for AudioSpec {
    fn default() -> Self {
        Self::asr()
    }
}

/// Convert one 16-bit signed PCM sample to the `[-1.0, 1.0]` f32 range.
pub fn i16_to_f32(v: i16) -> f32 {
    f32::from(v) / 32768.0
}

/// Convert one `[-1.0, 1.0]` f32 sample to 16-bit signed PCM (clamped).
pub fn f32_to_i16(v: f32) -> i16 {
    let scaled = (f64::from(v.clamp(-1.0, 1.0)) * 32768.0).round() as i64;
    scaled.clamp(i64::from(i16::MIN), i64::from(i16::MAX)) as i16
}

/// Down-mix an interleaved multi-channel f32 buffer to mono by averaging the
/// channels of each frame. Passes mono through unchanged.
///
/// Returns an error when `samples.len()` is not an exact multiple of `channels`.
pub fn to_mono(samples: &[f32], channels: u16) -> Result<Vec<f32>, AudioError> {
    if channels <= 1 {
        return Ok(samples.to_vec());
    }
    let c = channels as usize;
    if samples.len() % c != 0 {
        return Err(AudioError::InvalidArguments(format!(
            "interleaved buffer of {} samples is not a multiple of {} channels",
            samples.len(),
            channels
        )));
    }
    let frames = samples.len() / c;
    let mut mono = Vec::with_capacity(frames);
    for frame in samples.chunks_exact(c) {
        let sum: f32 = frame.iter().sum();
        mono.push(sum / c as f32);
    }
    Ok(mono)
}

/// Encode mono f32 samples as **little-endian f32 PCM bytes** — the on-the-wire
/// format of `ai_agent` `Payload::Audio` (4 bytes per sample). The daemon decodes
/// this back with the inverse operation before feeding its recognizer.
pub fn encode_f32_le(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn i16_f32_roundtrip() {
        let v = i16::MAX;
        assert_eq!(f32_to_i16(i16_to_f32(v)), v);
        assert_eq!(f32_to_i16(i16_to_f32(0)), 0);
        // Over/under-range clamp.
        assert_eq!(f32_to_i16(2.0), i16::MAX);
        assert_eq!(f32_to_i16(-2.0), i16::MIN);
    }

    #[test]
    fn to_mono_averages_channels() {
        // Two interleaved stereo frames: L=0.5,R=0.1 then L=0.2,R=-0.2.
        let m = to_mono(&[0.5, 0.1, 0.2, -0.2], 2).unwrap();
        assert_eq!(m.len(), 2);
        assert!((m[0] - 0.3).abs() < 1e-6);
        assert!(m[1].abs() < 1e-6);
        // Non-multiple of channels -> error.
        assert!(to_mono(&[0.0, 0.0, 0.0], 2).is_err());
        // Mono passes through.
        assert_eq!(to_mono(&[0.5, -0.5], 1).unwrap(), vec![0.5, -0.5]);
    }

    #[test]
    fn encode_f32_le_matches_wire() {
        let bytes = encode_f32_le(&[1.0f32, -0.5f32]);
        assert_eq!(bytes.len(), 8);
        assert_eq!(&bytes[0..4], &1.0f32.to_le_bytes());
        assert_eq!(&bytes[4..8], &(-0.5f32).to_le_bytes());
    }
}

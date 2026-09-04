//! Deterministic, offline captures and sinks for tests, demos and CI.
//!
//! These are the host-side stand-ins for the Android [`crate::android`] seams:
//! they speak the exact same [`AudioCapture`] / [`AudioSink`] contract, so code
//! written against the traits runs unchanged on both a laptop and a device.

use crate::capture::AudioCapture;
use crate::error::AudioError;
use crate::sink::AudioSink;
use crate::spec::AudioSpec;

/// A capture that replays a fixed mono f32 buffer and then reports
/// end-of-stream. Mirrors "a recorded PCM clip / call-audio tap" without a
/// device.
pub struct FrameMic {
    spec: AudioSpec,
    frames: Vec<f32>,
    pos: usize,
}

impl FrameMic {
    pub fn new(sample_rate: u32, frames: Vec<f32>) -> Self {
        Self {
            spec: AudioSpec::new(sample_rate, 1),
            frames,
            pos: 0,
        }
    }
}

impl AudioCapture for FrameMic {
    fn spec(&self) -> AudioSpec {
        self.spec
    }

    fn read(&mut self, out: &mut [f32]) -> Result<usize, AudioError> {
        let remaining = self.frames.len().saturating_sub(self.pos);
        let n = remaining.min(out.len());
        if n > 0 {
            out[..n].copy_from_slice(&self.frames[self.pos..self.pos + n]);
            self.pos += n;
        }
        Ok(n)
    }
}

/// A capture that yields a fixed number of pure-silence samples then ends.
/// Useful for exercising endpoint/decoder paths with a guaranteed length.
pub struct SilenceMic {
    spec: AudioSpec,
    remaining: usize,
}

impl SilenceMic {
    pub fn new(sample_rate: u32, total_samples: usize) -> Self {
        Self {
            spec: AudioSpec::new(sample_rate, 1),
            remaining: total_samples,
        }
    }
}

impl AudioCapture for SilenceMic {
    fn spec(&self) -> AudioSpec {
        self.spec
    }

    fn read(&mut self, out: &mut [f32]) -> Result<usize, AudioError> {
        let n = self.remaining.min(out.len());
        if n > 0 {
            for s in out[..n].iter_mut() {
                *s = 0.0;
            }
            self.remaining -= n;
        }
        Ok(n)
    }
}

/// A live-looking capture producing a deterministic sine wave at `frequency` Hz.
///
/// The phase is carried across reads so the waveform is continuous, making it a
/// stable stimulus for resamplers (a known number of output samples with a
/// predictable frequency) and a realistic placeholder for a microphone.
pub struct SineMic {
    spec: AudioSpec,
    /// Frequency of the generated tone, in Hz.
    pub frequency: f32,
    /// Peak amplitude in `[0, 1]`.
    pub amplitude: f32,
    /// Whether to end the stream (finite) or run forever (live mic semantics).
    pub finite: bool,
    phase: f64,
    remaining: usize,
}

impl SineMic {
    pub fn new(sample_rate: u32, frequency: f32) -> Self {
        Self {
            spec: AudioSpec::new(sample_rate, 1),
            frequency,
            amplitude: 0.5,
            finite: false,
            phase: 0.0,
            remaining: usize::MAX,
        }
    }

    /// A finite tone of `total_samples` (so the caller can read to EOF).
    pub fn with_total_samples(mut self, n: usize) -> Self {
        self.finite = true;
        self.remaining = n;
        self
    }
}

impl AudioCapture for SineMic {
    fn spec(&self) -> AudioSpec {
        self.spec
    }

    fn read(&mut self, out: &mut [f32]) -> Result<usize, AudioError> {
        let n = if self.finite {
            self.remaining.min(out.len())
        } else {
            out.len()
        };
        let rate = f64::from(self.spec.sample_rate);
        let omega = 2.0 * std::f64::consts::PI * f64::from(self.frequency) / rate;
        for s in out[..n].iter_mut() {
            *s = (f64::from(self.amplitude) * self.phase.sin()) as f32;
            self.phase += omega;
        }
        if self.finite {
            self.remaining -= n;
        }
        Ok(n)
    }
}

/// A sink that records every write, letting tests assert exactly what reached
/// the "device".
pub struct MockSink {
    spec: AudioSpec,
    /// All samples written so far, in order.
    pub recorded: Vec<f32>,
}

impl MockSink {
    pub fn new(spec: AudioSpec) -> Self {
        Self {
            spec,
            recorded: Vec::new(),
        }
    }
}

impl AudioSink for MockSink {
    fn spec(&self) -> AudioSpec {
        self.spec
    }

    fn write(&mut self, samples: &[f32]) -> Result<(), AudioError> {
        self.recorded.extend_from_slice(samples);
        Ok(())
    }
}

/// A sink that discards everything (backpressure / monitoring probes).
pub struct NullSink {
    spec: AudioSpec,
}

impl NullSink {
    pub fn new(spec: AudioSpec) -> Self {
        Self { spec }
    }
}

impl AudioSink for NullSink {
    fn spec(&self) -> AudioSpec {
        self.spec
    }

    fn write(&mut self, _samples: &[f32]) -> Result<(), AudioError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_mic_replays_then_eofs() {
        let mut mic = FrameMic::new(16_000, vec![0.1, 0.2, 0.3, 0.4]);
        let mut buf = [0.0f32; 3];
        assert_eq!(mic.read(&mut buf).unwrap(), 3);
        assert_eq!(&buf, &[0.1, 0.2, 0.3]);
        assert_eq!(mic.read(&mut buf).unwrap(), 1); // trailing sample
        assert_eq!(mic.read(&mut buf).unwrap(), 0); // EOF
    }

    #[test]
    fn silence_mic_produces_exactly_total() {
        let mut mic = SilenceMic::new(16_000, 5);
        let mut buf = [1.0f32; 4];
        assert_eq!(mic.read(&mut buf).unwrap(), 4);
        assert!(buf.iter().all(|s| *s == 0.0));
        assert_eq!(mic.read(&mut buf).unwrap(), 1);
        assert_eq!(mic.read(&mut buf).unwrap(), 0);
    }

    #[test]
    fn sine_is_continuous_and_bounded() {
        let mut mic = SineMic::new(16_000, 440.0).with_total_samples(1600);
        let mut buf = vec![0.0f32; 300];
        let mut samples = Vec::new();
        loop {
            let n = mic.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            samples.extend_from_slice(&buf[..n]);
        }
        assert_eq!(samples.len(), 1600);
        // Never clips beyond amplitude.
        assert!(samples.iter().all(|s| s.abs() <= 0.5 + 1e-6));
        // Two fresh sine mics at the same offset are identical (deterministic).
        let mut a = SineMic::new(16_000, 440.0);
        let mut b = SineMic::new(16_000, 440.0);
        let mut ba = [0.0f32; 100];
        let mut bb = [0.0f32; 100];
        a.read(&mut ba).unwrap();
        b.read(&mut bb).unwrap();
        assert_eq!(ba, bb);
    }

    #[test]
    fn mock_sink_records_writes() {
        let mut s = MockSink::new(AudioSpec::asr());
        s.write(&[0.5, -0.5]).unwrap();
        s.write(&[1.0]).unwrap();
        assert_eq!(s.recorded, vec![0.5, -0.5, 1.0]);
    }
}

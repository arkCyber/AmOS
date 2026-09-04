//! Resampling: convert a device-rate mono f32 stream down to the 16 kHz ASR /
//! wire spec (or any target rate).

use crate::error::AudioError;

/// A streaming linear-interpolation resampler for **down-sampling**
/// (`in_rate >= out_rate`, e.g. 48 kHz → 16 kHz).
///
/// It is phase-continuous across calls, so a microphone capture can be fed in
/// arbitrarily sized chunks and the output is identical to resampling the whole
/// stream at once. Only the fractional position and the unconsumed input tail
/// are kept between calls, so memory stays bounded.
pub struct LinearDownsampler {
    in_rate: u32,
    out_rate: u32,
    /// Input samples per output sample (`in_rate / out_rate`, >= 1).
    ratio: f64,
    /// Not-yet-consumed input samples; absolute index of `buf[0]` is `buf_base`.
    buf: Vec<f32>,
    buf_base: usize,
    /// Absolute input coordinate (may be fractional) of the next output sample.
    pos: f64,
}

impl LinearDownsampler {
    /// Build a resampler. Returns [`AudioError::UnsupportedFormat`] for an
    /// up-sampling or invalid ratio (open the device at the target rate instead,
    /// or use the one-shot [`resample_linear`]).
    pub fn new(in_rate: u32, out_rate: u32) -> Result<Self, AudioError> {
        if in_rate < 1 || out_rate < 1 {
            return Err(AudioError::UnsupportedFormat(format!(
                "invalid rates: in={in_rate} out={out_rate}"
            )));
        }
        let ratio = f64::from(in_rate) / f64::from(out_rate);
        if ratio < 1.0 {
            return Err(AudioError::UnsupportedFormat(format!(
                "up-sampling ({in_rate} -> {out_rate}) is not supported by LinearDownsampler; \
                 open the device at {out_rate} Hz instead"
            )));
        }
        Ok(Self {
            in_rate,
            out_rate,
            ratio,
            buf: Vec::new(),
            buf_base: 0,
            pos: 0.0,
        })
    }

    /// The input (device) sample rate this resampler consumes.
    pub fn in_rate(&self) -> u32 {
        self.in_rate
    }

    /// The output sample rate it produces.
    pub fn out_rate(&self) -> u32 {
        self.out_rate
    }

    /// Push a chunk of mono input samples and get back whatever complete output
    /// samples became available.
    pub fn process(&mut self, input: &[f32]) -> Result<Vec<f32>, AudioError> {
        self.buf.extend_from_slice(input);
        let mut out = Vec::new();
        // Absolute index of the sample one past the last one currently buffered.
        let end_abs = self.buf_base as i64 + self.buf.len() as i64;

        loop {
            let flo = self.pos.floor();
            let jf = flo as i64 - self.buf_base as i64;
            if jf < 0 {
                break; // safety: buffer was trimmed at or below the current position
            }
            let integer = (self.pos - flo).abs() < 1e-12;
            // Highest absolute input index this output may reference.
            let need_abs = if integer {
                flo as i64
            } else {
                (flo as i64) + 1
            };
            if need_abs >= end_abs {
                break; // not enough input yet; wait for the next chunk
            }
            let ji = jf as usize;
            let sample = if integer {
                self.buf[ji]
            } else {
                let frac = (self.pos - flo) as f32;
                let a = self.buf[ji];
                let b = self.buf[ji + 1];
                a + (b - a) * frac
            };
            out.push(sample);
            self.pos += self.ratio;
        }

        // Drop any fully-consumed prefix: samples strictly below the next output
        // position `floor(pos)` can never be referenced again. Removing exactly
        // `d` front samples advances `buf_base` by `d`, which keeps the append
        // pointer correct even when the whole buffer is consumed at once (so a
        // stream fed in chunks is identical to feeding it whole).
        let flo_now = self.pos.floor() as i64;
        let base = self.buf_base as i64;
        if flo_now > base {
            let d = ((flo_now - base) as usize).min(self.buf.len());
            if d > 0 {
                self.buf.drain(..d);
                self.buf_base += d;
            }
        }
        Ok(out)
    }
}

/// One-shot linear interpolation over a whole buffer (any ratio, up or down).
///
/// Stateless and simple — ideal for converting a finite recording before ASR.
/// For a continuous microphone stream prefer [`LinearDownsampler`].
pub fn resample_linear(in_rate: u32, out_rate: u32, input: &[f32]) -> Result<Vec<f32>, AudioError> {
    if in_rate < 1 || out_rate < 1 || input.is_empty() {
        return Err(AudioError::UnsupportedFormat(format!(
            "cannot resample {in_rate} -> {out_rate} over {} samples",
            input.len()
        )));
    }
    let ratio = f64::from(in_rate) / f64::from(out_rate);
    let out_len = ((input.len() as f64) / ratio).ceil() as usize;
    let mut out = Vec::with_capacity(out_len);
    for k in 0..out_len {
        let p = (k as f64) * ratio;
        let i0 = p.floor() as usize;
        let frac = (p - p.floor()) as f32;
        let a = input[i0.min(input.len() - 1)];
        let b = input[(i0 + 1).min(input.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input_ramp(n: usize) -> Vec<f32> {
        (0..n).map(|i| i as f32).collect()
    }

    #[test]
    fn integer_downsample_picks_expected_samples() {
        let mut rs = LinearDownsampler::new(48_000, 16_000).unwrap();
        let out = rs.process(&input_ramp(480)).unwrap();
        // Outputs at input positions 0,3,6,...477 -> 160 samples.
        assert_eq!(out.len(), 160);
        assert_eq!(out[0], 0.0);
        assert_eq!(out[1], 3.0);
        assert_eq!(out[159], 477.0);
    }

    #[test]
    fn integer_downsample_is_streaming_equivalent() {
        // One-shot 480 samples == feeding it in three chunks of 160.
        let whole = {
            let mut rs = LinearDownsampler::new(48_000, 16_000).unwrap();
            rs.process(&input_ramp(480)).unwrap()
        };
        let mut rs = LinearDownsampler::new(48_000, 16_000).unwrap();
        let mut parts = Vec::new();
        for chunk in input_ramp(480).chunks(160) {
            parts.extend_from_slice(&rs.process(chunk).unwrap());
        }
        assert_eq!(whole, parts);
    }

    #[test]
    fn fractional_downsample_produces_expected_length() {
        // 44.1k -> 16k ≈ 2.75625 ratio (non-integer).
        let mut rs = LinearDownsampler::new(44_100, 16_000).unwrap();
        let out = rs.process(&input_ramp(44_100)).unwrap();
        assert!(
            (out.len() as i64 - 16_000).abs() <= 2,
            "out len {} vs expected ~16000",
            out.len()
        );
        // Monotone increasing, stays within the input range.
        assert!(out.windows(2).all(|w| w[1] >= w[0]));
    }

    #[test]
    fn upsampling_is_rejected_for_downsampler() {
        assert!(LinearDownsampler::new(16_000, 48_000).is_err());
        assert!(LinearDownsampler::new(0, 16_000).is_err());
    }

    #[test]
    fn one_shot_upsample_works() {
        // 2x up: doubles length, endpoints preserved.
        let out = resample_linear(8_000, 16_000, &[0.0, 1.0]).unwrap();
        assert_eq!(out.len(), 4);
        assert_eq!(out[0], 0.0);
        assert_eq!(out[3], 1.0);
    }
}

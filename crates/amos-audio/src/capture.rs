//! The capture side of the audio abstraction: a pull model where AmOS reads
//! mono f32 PCM from a device (or mock) whenever it needs the next chunk.

use crate::error::AudioError;
use crate::spec::AudioSpec;

/// A source of PCM audio (microphone / call tap / file replay / test signal).
///
/// All samples cross this trait as **mono f32**. The concrete backend is
/// responsible for down-mixing a multi-channel device and, when it cannot open
/// the device at the requested rate, the caller wraps it in a
/// [`crate::LinearDownsampler`] to reach the 16 kHz ASR/wire spec.
///
/// The API is deliberately synchronous and allocation-light: on Android the
/// real backends map 1:1 onto a TinyALSA/AAudio read of a period into a ring
/// buffer, and the daemon / UI can drive it from a dedicated audio thread.
pub trait AudioCapture {
    /// The spec this source is delivering (its *native* rate — resample after
    /// the fact if it does not already match [`AudioSpec::asr`]).
    fn spec(&self) -> AudioSpec;

    /// Read up to `out.len()` mono f32 samples into `out`, returning the number
    /// of samples actually read.
    ///
    /// * `Ok(0)` signals end-of-stream (finite sources such as a file replay);
    ///   a live microphone never returns 0 until closed.
    /// * `Err` reports a device failure or a malformed request (e.g. a spec that
    ///   does not satisfy [`AudioSpec::is_valid`]).
    fn read(&mut self, out: &mut [f32]) -> Result<usize, AudioError>;

    /// Drain a live source continuously, calling `on_samples` for every read.
    ///
    /// `chunk` is the request size for each read. Returns `Ok(())` after the
    /// source reports end-of-stream, or the first error. Useful for pushing a
    /// microphone straight into an ASR recognizer without hand-rolling the loop.
    fn for_each<F>(&mut self, chunk: usize, mut on_samples: F) -> Result<(), AudioError>
    where
        F: FnMut(&[f32]) -> Result<(), AudioError>,
    {
        let chunk = chunk.max(1);
        let mut buf = vec![0.0f32; chunk];
        loop {
            let n = self.read(&mut buf)?;
            if n == 0 {
                return Ok(());
            }
            on_samples(&buf[..n])?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::FrameMic;

    #[test]
    fn for_each_yields_each_chunk_then_stops() {
        let frames: Vec<f32> = (0..100).map(|i| i as f32).collect();
        let mut mic = FrameMic::new(16000, frames.clone());
        let mut seen = Vec::new();
        mic.for_each(30, |c| {
            seen.extend_from_slice(c);
            Ok(())
        })
        .unwrap();
        assert_eq!(seen.len(), 100);
        assert_eq!(seen, frames);
    }
}

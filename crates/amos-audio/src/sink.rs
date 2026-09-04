//! The playback side of the audio abstraction: a push model where AmOS hands
//! mono f32 PCM to a device (or mock) for output.

use crate::error::AudioError;
use crate::spec::AudioSpec;

/// A sink that consumes mono f32 PCM (microphone speaker, translated-call
/// earpiece, mock recorder, or null). `write` returns once the samples have been
/// handed to the device (blocking backpressure is the backend's concern).
pub trait AudioSink {
    /// The spec this sink expects (its *native* rate — up-sample before calling
    /// when the ASR/wire 16 kHz differs and the device will not take 16 kHz).
    fn spec(&self) -> AudioSpec;

    /// Write `samples` (mono f32). `Ok(())` on success.
    fn write(&mut self, samples: &[f32]) -> Result<(), AudioError>;

    /// Flush any buffered samples to the device. `Ok(())` on success.
    fn flush(&mut self) -> Result<(), AudioError> {
        Ok(())
    }
}

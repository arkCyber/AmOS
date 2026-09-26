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

/// Whether a platform playback call consumed **every** frame it was handed.
///
/// [`AudioSink::write`]'s contract is that `Ok(())` means all of `samples` reached the
/// device. Both real seams hand the platform a frame count and get one back — AAudio's
/// `AAudioStream_write` and TinyALSA's `pcm_write` — but each used to check only
/// `n < 0`, so a **short** write (a timeout, a buffer underrun, a device that accepted
/// less than asked) returned `Ok(())` and reported a success the device never gave
/// (REQ-A1450/F-AUD-001). A count at or above what was offered is the only `Ok`.
///
/// Pure so it is host-testable: the seams themselves are Android-only, so this decision
/// is what can be pinned off-device.
pub const fn accepted_all_frames(returned: i64, frames: usize) -> bool {
    returned >= frames as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_write_is_accepted() {
        assert!(accepted_all_frames(512, 512));
    }

    #[test]
    fn a_short_write_is_not_accepted() {
        // The device took fewer frames than offered — the old `n < 0` check called this Ok.
        assert!(!accepted_all_frames(0, 512));
        assert!(!accepted_all_frames(511, 512));
    }

    #[test]
    fn a_negative_return_is_never_accepted() {
        assert!(!accepted_all_frames(-1, 512));
        assert!(!accepted_all_frames(i64::MIN, 1));
    }

    #[test]
    fn an_empty_write_is_vacuously_accepted() {
        // `write(&[])` is short-circuited by the seams; 0/0 still reads as Ok.
        assert!(accepted_all_frames(0, 0));
    }
}

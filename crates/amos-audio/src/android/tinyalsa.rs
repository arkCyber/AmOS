//! AOSP **TinyALSA** PCM capture/playback (feature `tinyalsa` + Android).
//!
//! Binds the classic AOSP C API in `external/tinyalsa/include/tinyalsa/pcm.h`
//! with hand-written `extern` blocks (no bindgen). TinyALSA talks to the ALSA
//! driver underneath AudioFlinger, so it is the seam a system component uses to
//! open the **primary microphone** and — with the matching HAL/DSP call-tap —
//! a **live telephony voice stream** for real-time translate.
//!
//! Open with a 16 kHz mono S16 request; when the driver cannot honour the rate,
//! AmOS resamples the returned native-rate frames with
//! [`crate::LinearDownsampler`] before feeding the ASR/wire spec.

use std::ffi::c_void;

use crate::capture::AudioCapture;
use crate::error::{device_err, AudioError};
use crate::sink::AudioSink;
use crate::spec::{f32_to_i16, i16_to_f32, AudioSpec, ASR_SAMPLE_RATE};
// The `pcm.h` facts (struct layout, enum values, period sizing) live in
// `crate::tinyalsa_layout`, which a host build compiles and tests — so the FFI
// contract is checked on every `cargo test`, not only on a device (F-SH-112).
use crate::tinyalsa_layout::{open_flags, PcmConfig};

extern "C" {
    fn pcm_open(card: u32, device: u32, flags: u32, config: *const PcmConfig) -> *mut c_void;
    fn pcm_is_ready(pcm: *const c_void) -> i32;
    fn pcm_read(pcm: *mut c_void, data: *mut c_void, frames: u32) -> i32;
    fn pcm_write(pcm: *mut c_void, data: *const c_void, frames: u32) -> i32;
    fn pcm_close(pcm: *mut c_void) -> *mut c_void;
}

/// Safety guard shared by both directions.
fn ready_or_err(pcm: *mut c_void, what: &str) -> Result<(), AudioError> {
    // SAFETY: the `||` short-circuits, so the FFI call only runs when `pcm` was already
    // found non-null; `pcm_is_ready` merely reads the handle's state.
    if pcm.is_null() || unsafe { pcm_is_ready(pcm) } != 1 {
        return Err(AudioError::Device(format!(
            "tinyalsa: {what}: stream is not ready (is /dev/snd accessible?)"
        )));
    }
    Ok(())
}

/// Open a TinyALSA PCM and check it is ready. `capture` selects input vs output;
/// `card`/`device` default to the primary (`0, 0`).
///
/// # Safety
///
/// `card`/`device` must name an existing ALSA device and `rate` a rate the kernel
/// accepts; the returned handle (non-null only when `pcm_is_ready` agrees) must be
/// closed exactly once with `pcm_close`.
unsafe fn open(
    card: u32,
    device: u32,
    capture: bool,
    rate: u32,
) -> Result<*mut c_void, AudioError> {
    let cfg = PcmConfig::new(rate, capture);
    let pcm = pcm_open(card, device, open_flags(capture), &cfg);
    ready_or_err(pcm, if capture { "capture" } else { "playback" })?;
    Ok(pcm)
}

/// Mono 16 kHz (requested) microphone capture over TinyALSA.
pub struct TinyAlsaCapture {
    pcm: *mut c_void,
    spec: AudioSpec,
}

impl TinyAlsaCapture {
    /// Open the primary microphone. Prefer `ASR_SAMPLE_RATE`; pass the device's
    /// true native rate to [`crate::LinearDownsampler`] when it is denied.
    pub fn open(rate: u32) -> Result<Self, AudioError> {
        let spec = AudioSpec::new(rate, 1);
        if !spec.is_valid() {
            return Err(AudioError::InvalidArguments(format!(
                "bad capture rate {rate}"
            )));
        }
        // SAFETY: card 0 / device 0 is the primary PCM and `rate` was validated by
        // `spec.is_valid()` above; `open` itself checks readiness before returning the
        // handle, which is then owned by this struct.
        let pcm = unsafe { open(0, 0, true, rate) }?;
        Ok(Self { pcm, spec })
    }
}

impl Drop for TinyAlsaCapture {
    fn drop(&mut self) {
        if !self.pcm.is_null() {
            // SAFETY: null-guarded (never a double close) and the handle came from
            // `open` in this type; it is nulled right after so no other path can use it.
            unsafe {
                pcm_close(self.pcm);
            }
            self.pcm = std::ptr::null_mut();
        }
    }
}

// SAFETY: the whole `TinyAlsaCapture` (opened PCM + spec) is moved as one unit to a
// single worker thread (the resident capture loop) that is the only reader and the
// one that closes it on drop. No `Sync`: TinyALSA PCM is not concurrently shareable,
// which the sole-owner consumer contract enforces.
unsafe impl Send for TinyAlsaCapture {}

impl AudioCapture for TinyAlsaCapture {
    fn spec(&self) -> AudioSpec {
        self.spec
    }

    fn read(&mut self, out: &mut [f32]) -> Result<usize, AudioError> {
        if out.is_empty() {
            return Ok(0);
        }
        if self.pcm.is_null() {
            return Err(AudioError::Device("tinyalsa capture: stream closed".into()));
        }
        // Read up to out.len() mono S16 frames, then widen to f32.
        let frames = out.len() as u32;
        let mut scratch = vec![0i16; frames as usize];
        // SAFETY: `self.pcm` is a non-null handle owned by this capture (checked just
        // above), and `scratch` holds exactly `frames` initialized i16 elements — the
        // buffer TinyALSA is allowed to fill.
        let n = unsafe { pcm_read(self.pcm, scratch.as_mut_ptr() as *mut c_void, frames) };
        if n < 0 {
            return Err(device_err("tinyalsa pcm_read", n));
        }
        let n = n as usize;
        for (dst, src) in out[..n].iter_mut().zip(scratch.iter()) {
            *dst = i16_to_f32(*src);
        }
        Ok(n)
    }
}

/// Mono playback over TinyALSA (assistant reply / translated call audio).
pub struct TinyAlsaSink {
    pcm: *mut c_void,
    spec: AudioSpec,
}

impl TinyAlsaSink {
    pub fn open(rate: u32) -> Result<Self, AudioError> {
        let spec = AudioSpec::new(rate, 1);
        if !spec.is_valid() {
            return Err(AudioError::InvalidArguments(format!(
                "bad playback rate {rate}"
            )));
        }
        // SAFETY: same contract as the capture's open — primary PCM, validated rate,
        // readiness checked inside `open`, handle owned by this struct.
        let pcm = unsafe { open(0, 0, false, rate) }?;
        Ok(Self { pcm, spec })
    }
}

impl Drop for TinyAlsaSink {
    fn drop(&mut self) {
        if !self.pcm.is_null() {
            // SAFETY: null-guarded, handle owned by this type, nulled immediately after.
            unsafe {
                pcm_close(self.pcm);
            }
            self.pcm = std::ptr::null_mut();
        }
    }
}

// SAFETY: sole-owner handoff of the sink between threads (opened once, written/closed
// by one thread). Not `Sync`; see the `TinyAlsaCapture` rationale.
unsafe impl Send for TinyAlsaSink {}

impl AudioSink for TinyAlsaSink {
    fn spec(&self) -> AudioSpec {
        self.spec
    }

    fn write(&mut self, samples: &[f32]) -> Result<(), AudioError> {
        if samples.is_empty() {
            return Ok(());
        }
        if self.pcm.is_null() {
            return Err(AudioError::Device(
                "tinyalsa playback: stream closed".into(),
            ));
        }
        let scratch: Vec<i16> = samples.iter().map(|s| f32_to_i16(*s)).collect();
        let frames = scratch.len() as u32;
        // SAFETY: `self.pcm` is a non-null handle owned by this sink (checked above) and
        // `scratch` has exactly `frames` initialized i16 elements, the most TinyALSA may
        // read for this call.
        let n = unsafe { pcm_write(self.pcm, scratch.as_ptr() as *const c_void, frames) };
        if n < 0 {
            return Err(device_err("tinyalsa pcm_write", n));
        }
        // `pcm_write` returns the frames it accepted; a short write is a failure, not a
        // success — see `sink::accepted_all_frames` (REQ-A1450/F-AUD-001).
        if !crate::sink::accepted_all_frames(i64::from(n), frames as usize) {
            return Err(AudioError::Device(format!(
                "tinyalsa pcm_write accepted {n}/{frames} frames"
            )));
        }
        Ok(())
    }
}

/// Open a capture at the ASR rate — the fast path that needs no resampling.
pub fn open_asr_mic() -> Result<TinyAlsaCapture, AudioError> {
    TinyAlsaCapture::open(ASR_SAMPLE_RATE)
}

/// The `pcm.h` facts AmOS depends on — re-exported from
/// [`crate::tinyalsa_layout`], where the host-runnable drift test that actually
/// asserts them lives (this module is compiled only on Android; see F-SH-112).
pub use crate::tinyalsa_layout::header_layout_notes;

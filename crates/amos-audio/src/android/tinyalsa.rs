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

/// `enum pcm_format` (subset AmOS uses).
#[allow(dead_code)]
mod fmt {
    pub const PCM_FORMAT_INVALID: i32 = -1;
    pub const PCM_FORMAT_S16_LE: i32 = 0;
    pub const PCM_FORMAT_S32_LE: i32 = 1;
}

/// `enum pcm_flags`.
#[allow(dead_code)]
mod flags {
    pub const PCM_OUT: u32 = 0x0000_0000;
    pub const PCM_IN: u32 = 0x1000_0000;
    pub const PCM_MONO: u32 = 0x0000_0001;
    pub const PCM_STEREO: u32 = 0x0000_0002;
}

/// Mirrors `struct pcm_config` (field order + layout must match `pcm.h`).
#[repr(C)]
struct PcmConfig {
    channels: u32,
    rate: u32,
    period_size: u32,
    period_count: u32,
    format: i32,
    start_threshold: u32,
    stop_threshold: u32,
    silence_threshold: u32,
    avail_min: i32,
}

impl PcmConfig {
    /// Sensible defaults for a blocking mono S16 stream. `period_size` is one
    /// ~20 ms period at the requested rate.
    fn new(rate: u32, capture: bool) -> Self {
        let period_size = (rate / 50).max(160);
        let period_count = 4u32;
        Self {
            channels: 1,
            rate,
            period_size,
            period_count,
            format: fmt::PCM_FORMAT_S16_LE,
            start_threshold: period_size,
            stop_threshold: period_size * period_count,
            silence_threshold: 0,
            avail_min: if capture { period_size as i32 } else { 1 },
        }
    }
}

extern "C" {
    fn pcm_open(card: u32, device: u32, flags: u32, config: *const PcmConfig) -> *mut c_void;
    fn pcm_is_ready(pcm: *const c_void) -> i32;
    fn pcm_read(pcm: *mut c_void, data: *mut c_void, frames: u32) -> i32;
    fn pcm_write(pcm: *mut c_void, data: *const c_void, frames: u32) -> i32;
    fn pcm_close(pcm: *mut c_void) -> *mut c_void;
}

/// Safety guard shared by both directions.
fn ready_or_err(pcm: *mut c_void, what: &str) -> Result<(), AudioError> {
    if pcm.is_null() || unsafe { pcm_is_ready(pcm) } != 1 {
        return Err(AudioError::Device(format!(
            "tinyalsa: {what}: stream is not ready (is /dev/snd accessible?)"
        )));
    }
    Ok(())
}

/// Open a TinyALSA PCM and check it is ready. `capture` selects input vs output;
/// `card`/`device` default to the primary (`0, 0`).
unsafe fn open(
    card: u32,
    device: u32,
    capture: bool,
    rate: u32,
) -> Result<*mut c_void, AudioError> {
    let flags = if capture {
        flags::PCM_IN | flags::PCM_MONO
    } else {
        flags::PCM_OUT | flags::PCM_MONO
    };
    let cfg = PcmConfig::new(rate, capture);
    let pcm = pcm_open(card, device, flags, &cfg);
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
        let pcm = unsafe { open(0, 0, true, rate) }?;
        Ok(Self { pcm, spec })
    }
}

impl Drop for TinyAlsaCapture {
    fn drop(&mut self) {
        if !self.pcm.is_null() {
            unsafe {
                pcm_close(self.pcm);
            }
            self.pcm = std::ptr::null_mut();
        }
    }
}

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
        let pcm = unsafe { open(0, 0, false, rate) }?;
        Ok(Self { pcm, spec })
    }
}

impl Drop for TinyAlsaSink {
    fn drop(&mut self) {
        if !self.pcm.is_null() {
            unsafe {
                pcm_close(self.pcm);
            }
            self.pcm = std::ptr::null_mut();
        }
    }
}

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
        let n = unsafe { pcm_write(self.pcm, scratch.as_ptr() as *const c_void, frames) };
        if n < 0 {
            return Err(device_err("tinyalsa pcm_write", n));
        }
        Ok(())
    }
}

/// Open a capture at the ASR rate — the fast path that needs no resampling.
pub fn open_asr_mic() -> Result<TinyAlsaCapture, AudioError> {
    TinyAlsaCapture::open(ASR_SAMPLE_RATE)
}

/// The `pcm.h` facts AmOS depends on, surfaced so Android bring-up tests can
/// assert the header has not drifted (field order/values).
pub fn header_layout_notes() -> &'static str {
    "pcm_config{channels,rate,period_size,period_count,format,start_threshold,\
     stop_threshold,silence_threshold,avail_min}; S16_LE=0; PCM_IN=0x10000000; PCM_MONO=1"
}

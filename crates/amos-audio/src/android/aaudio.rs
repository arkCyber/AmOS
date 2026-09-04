//! **AAudio** NDK capture/playback (feature `aaudio` + Android).
//!
//! Low-latency, app-accessible native audio (the path a shipped AI assistant
//! uses for always-on mic listen). The C API lives in the NDK's
//! `AAudio.h`; these are hand-written, self-contained `extern` bindings (no
//! bindgen, no third-party native crate). S16 frames are widened/narrowed to the
//! mono f32 that AmOS carries on its traits.
//!
//! Call interception / in-call voice streams are *not* reachable from an ordinary
//! app through AAudio; those require the system-level HAL/TinyALSA seam (see
//! `super::tinyalsa`) plus the appropriate telephony audio-route hooks.

use std::ffi::c_void;

use crate::capture::AudioCapture;
use crate::error::{device_err, AudioError};
use crate::sink::AudioSink;
use crate::spec::{f32_to_i16, i16_to_f32, AudioSpec, ASR_SAMPLE_RATE};

const AAUDIO_OK: i32 = 0;
const DIRECTION_OUTPUT: i32 = 0;
const DIRECTION_INPUT: i32 = 1;
const FORMAT_PCM_I16: i32 = 1;
const PERF_MODE_NONE: i32 = 10;
const TIMEOUT_NS: i64 = 1_000_000_000; // 1 s blocking budget per read/write

/// Opaque AAudio handles (ABI-agnostic: callers only pass the pointer through).
#[repr(C)]
pub struct AAudioStreamBuilder {
    _priv: [u8; 0],
}
#[repr(C)]
pub struct AAudioStream {
    _priv: [u8; 0],
}

// Type aliases mirroring the NDK enums (all `int32_t`).
type aaudio_result_t = i32;
type aaudio_direction_t = i32;
type aaudio_format_t = i32;
type aaudio_performance_mode_t = i32;

extern "C" {
    fn AAudio_createStreamBuilder() -> *mut AAudioStreamBuilder;
    fn AAudioStreamBuilder_delete(builder: *mut AAudioStreamBuilder);
    fn AAudioStreamBuilder_setDirection(b: *mut AAudioStreamBuilder, d: aaudio_direction_t);
    fn AAudioStreamBuilder_setSampleRate(b: *mut AAudioStreamBuilder, rate: i32);
    fn AAudioStreamBuilder_setChannelCount(b: *mut AAudioStreamBuilder, channels: i32);
    fn AAudioStreamBuilder_setFormat(b: *mut AAudioStreamBuilder, format: aaudio_format_t);
    fn AAudioStreamBuilder_setPerformanceMode(
        b: *mut AAudioStreamBuilder,
        m: aaudio_performance_mode_t,
    );
    fn AAudioStreamBuilder_openStream(
        b: *mut AAudioStreamBuilder,
        stream: *mut *mut AAudioStream,
    ) -> aaudio_result_t;
    fn AAudioStream_requestStart(s: *mut AAudioStream) -> aaudio_result_t;
    fn AAudioStream_requestStop(s: *mut AAudioStream) -> aaudio_result_t;
    fn AAudioStream_close(s: *mut AAudioStream) -> aaudio_result_t;
    fn AAudioStream_read(
        s: *mut AAudioStream,
        data: *mut c_void,
        num_frames: i32,
        timeout_ns: i64,
    ) -> aaudio_result_t;
    fn AAudioStream_write(
        s: *mut AAudioStream,
        data: *const c_void,
        num_frames: i32,
        timeout_ns: i64,
    ) -> aaudio_result_t;
    fn AAudio_convertResultToText(result: aaudio_result_t) -> *const std::os::raw::c_char;
}

fn result_to_err(context: &str, code: i32) -> AudioError {
    // Only fetch the text when safe; on error code the pointer is valid.
    if code != AAUDIO_OK {
        let msg = unsafe {
            let p = AAudio_convertResultToText(code);
            if p.is_null() {
                String::new()
            } else {
                std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned()
            }
        };
        return device_err(&format!("{context}: {msg}"), code);
    }
    AudioError::Device(context.to_string())
}

/// Open + start a stream with the given direction; returns the raw handle and
/// its actual (requested) rate.
fn open_stream(capture: bool, rate: u32) -> Result<(*mut AAudioStream, AudioSpec), AudioError> {
    let b = unsafe { AAudio_createStreamBuilder() };
    if b.is_null() {
        return Err(AudioError::Device(
            "aaudio: createStreamBuilder failed".into(),
        ));
    }
    unsafe {
        AAudioStreamBuilder_setDirection(
            b,
            if capture {
                DIRECTION_INPUT
            } else {
                DIRECTION_OUTPUT
            },
        );
        AAudioStreamBuilder_setSampleRate(b, rate as i32);
        AAudioStreamBuilder_setChannelCount(b, 1);
        AAudioStreamBuilder_setFormat(b, FORMAT_PCM_I16);
        AAudioStreamBuilder_setPerformanceMode(b, PERF_MODE_NONE);
    }
    let mut stream: *mut AAudioStream = std::ptr::null_mut();
    let open_res = unsafe { AAudioStreamBuilder_openStream(b, &mut stream) };
    unsafe { AAudioStreamBuilder_delete(b) };
    if open_res != AAUDIO_OK || stream.is_null() {
        return Err(result_to_err("aaudio: openStream", open_res));
    }
    let start = unsafe { AAudioStream_requestStart(stream) };
    if start != AAUDIO_OK {
        let e = result_to_err("aaudio: requestStart", start);
        unsafe {
            AAudioStream_close(stream);
        }
        return Err(e);
    }
    let spec = AudioSpec::new(rate, 1);
    Ok((stream, spec))
}

/// Mono I16 (→ f32) microphone capture over AAudio (blocking `read`).
pub struct AAudioCapture {
    stream: *mut AAudioStream,
    spec: AudioSpec,
}

impl AAudioCapture {
    /// Open + start the input stream. Prefer the ASR rate so no resampling is
    /// needed; when the device denies it, route through [`crate::LinearDownsampler`].
    pub fn open(rate: u32) -> Result<Self, AudioError> {
        let spec = AudioSpec::new(rate, 1);
        if !spec.is_valid() {
            return Err(AudioError::InvalidArguments(format!(
                "bad capture rate {rate}"
            )));
        }
        let (stream, spec) = open_stream(true, rate)?;
        Ok(Self { stream, spec })
    }
}

impl Drop for AAudioCapture {
    fn drop(&mut self) {
        if !self.stream.is_null() {
            unsafe {
                AAudioStream_close(self.stream);
            }
            self.stream = std::ptr::null_mut();
        }
    }
}

impl AudioCapture for AAudioCapture {
    fn spec(&self) -> AudioSpec {
        self.spec
    }

    fn read(&mut self, out: &mut [f32]) -> Result<usize, AudioError> {
        if out.is_empty() || self.stream.is_null() {
            return Ok(0);
        }
        let frames = out.len().min(i32::MAX as usize) as i32;
        let mut scratch = vec![0i16; frames as usize];
        let n = unsafe {
            AAudioStream_read(
                self.stream,
                scratch.as_mut_ptr() as *mut c_void,
                frames,
                TIMEOUT_NS,
            )
        };
        if n < 0 {
            return Err(result_to_err("aaudio: read", n));
        }
        let n = n as usize;
        for (dst, src) in out[..n].iter_mut().zip(scratch.iter()) {
            *dst = i16_to_f32(*src);
        }
        Ok(n)
    }
}

/// Mono I16 (from f32) playback over AAudio (blocking `write`).
pub struct AAudioSink {
    stream: *mut AAudioStream,
    spec: AudioSpec,
}

impl AAudioSink {
    pub fn open(rate: u32) -> Result<Self, AudioError> {
        let spec = AudioSpec::new(rate, 1);
        if !spec.is_valid() {
            return Err(AudioError::InvalidArguments(format!(
                "bad playback rate {rate}"
            )));
        }
        let (stream, spec) = open_stream(false, rate)?;
        Ok(Self { stream, spec })
    }
}

impl Drop for AAudioSink {
    fn drop(&mut self) {
        if !self.stream.is_null() {
            unsafe {
                AAudioStream_close(self.stream);
            }
            self.stream = std::ptr::null_mut();
        }
    }
}

impl AudioSink for AAudioSink {
    fn spec(&self) -> AudioSpec {
        self.spec
    }

    fn write(&mut self, samples: &[f32]) -> Result<(), AudioError> {
        if samples.is_empty() || self.stream.is_null() {
            return Ok(());
        }
        let scratch: Vec<i16> = samples.iter().map(|s| f32_to_i16(*s)).collect();
        let frames = scratch.len().min(i32::MAX as usize) as i32;
        let n = unsafe {
            AAudioStream_write(
                self.stream,
                scratch.as_ptr() as *const c_void,
                frames,
                TIMEOUT_NS,
            )
        };
        if n < 0 {
            return Err(result_to_err("aaudio: write", n));
        }
        Ok(())
    }
}

/// Open a capture at the ASR rate — the app path for the AI assistant's
/// real-time listen with no resampling.
pub fn open_asr_mic() -> Result<AAudioCapture, AudioError> {
    AAudioCapture::open(ASR_SAMPLE_RATE)
}

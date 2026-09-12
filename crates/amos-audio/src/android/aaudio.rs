//! **AAudio** NDK capture/playback (feature `aaudio` + Android).
//!
//! Low-latency, app-accessible native audio (the path a shipped AI assistant
//! uses for always-on mic listen). The C API lives in the NDK's
//! `AAudio.h`; these are hand-written, self-contained `extern` bindings (no
//! bindgen, no third-party native crate). S16 frames are widened/narrowed to the
//! mono f32 that AmOS carries on its traits.
//!
//! Two capture models are offered for the microphone:
//!
//! * [`AAudioCapture`] — the original **blocking `AAudioStream_read`** pull path
//!   (the resident voice worker calls `read` in a loop and AAudio delivers a
//!   period per blocking read).
//! * [`AAudioCallbackCapture`] — a capture driven by AAudio's **real-time data
//!   callback** (the actual "hardware sampling callback"). AAudio invokes the
//!   callback on its own high-priority thread whenever a new period of input
//!   frames is ready; the callback widens I16→f32 into a bounded
//!   [`crate::ring::SampleRing`], and [`AudioCapture::read`] drains that ring.
//!   This is the model the always-on voice worker prefers — the hardware *pushes*
//!   samples to us on the real-time clock instead of us polling for them.
//!
//! Call interception / in-call voice streams are *not* reachable from an ordinary
//! app through AAudio; those require the system-level HAL/TinyALSA seam (see
//! `super::tinyalsa`) plus the appropriate telephony audio-route hooks.

use std::ffi::c_void;

use crate::capture::AudioCapture;
use crate::error::{device_err, AudioError};
use crate::ring::SampleRing;
use crate::sink::AudioSink;
use crate::spec::{f32_to_i16, i16_to_f32, AudioSpec, ASR_SAMPLE_RATE};

const AAUDIO_OK: i32 = 0;
const DIRECTION_OUTPUT: i32 = 0;
const DIRECTION_INPUT: i32 = 1;
const FORMAT_PCM_I16: i32 = 1;
const PERF_MODE_NONE: i32 = 10;
const TIMEOUT_NS: i64 = 1_000_000_000; // 1 s blocking budget per read/write

// `aaudio_data_callback_result_t` values (what the data callback returns).
const AAUDIO_CALLBACK_RESULT_CONTINUE: i32 = 0;
#[allow(dead_code)]
const AAUDIO_CALLBACK_RESULT_STOP: i32 = 1;

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
#[allow(non_camel_case_types)]
type aaudio_result_t = i32;
#[allow(non_camel_case_types)]
type aaudio_direction_t = i32;
#[allow(non_camel_case_types)]
type aaudio_format_t = i32;
#[allow(non_camel_case_types)]
type aaudio_performance_mode_t = i32;
#[allow(non_camel_case_types)]
type aaudio_data_callback_result_t = i32;

/// The AAudio data-callback signature (`AAudioStream_dataCallback` in `AAudio.h`):
/// invoked on AAudio's real-time thread with a fresh `numFrames` of input (for a
/// capture) whenever a new period is ready. `user_data` is the opaque pointer
/// passed to `AAudioStreamBuilder_setDataCallback`.
type AaudioDataCallback = unsafe extern "C" fn(
    *mut AAudioStream,
    *mut c_void,
    *mut c_void,
    i32,
) -> aaudio_data_callback_result_t;

// Bind against the NDK's `libaaudio.so` (present from API 26 onward) so that any
// Android binary/`.so` that links this seam resolves the `AAudio_*` symbols at
// build time rather than failing at runtime on the device with an unresolved
// symbol (Android shared libraries tolerate undefined symbols at link time, so
// without this the error would only surface at `dlopen`/call time).
#[link(name = "aaudio")]
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
    // Not called yet (stop-on-drop is `close`), but part of the NDK surface the
    // seam is meant to cover; kept so a graceful pause path needs no new FFI.
    #[allow(dead_code)]
    fn AAudioStream_requestStop(s: *mut AAudioStream) -> aaudio_result_t;
    // Data-callback path: register the real-time producer that fills the ring.
    fn AAudioStreamBuilder_setDataCallback(
        b: *mut AAudioStreamBuilder,
        cb: AaudioDataCallback,
        user_data: *mut c_void,
    );
    // Optional hint: AAudio aims to deliver about this many frames per callback
    // (a ~10 ms period), letting us size the producer path and cadence.
    #[allow(dead_code)]
    fn AAudioStreamBuilder_setFramesPerDataCallback(b: *mut AAudioStreamBuilder, n: i32);
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
    if code != AAUDIO_OK {
        // SAFETY: `AAudio_convertResultToText` returns either NULL or a pointer to a
        // NUL-terminated string owned by the AAudio library (static for the process);
        // the NULL case is handled before `CStr::from_ptr`, so we never dereference an
        // invalid or unterminated pointer, and the borrow lives only inside this block.
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
    // SAFETY: FFI call with no arguments and no aliasing requirements; it returns a
    // builder handle or NULL, and the NULL case is checked immediately below.
    let b = unsafe { AAudio_createStreamBuilder() };
    if b.is_null() {
        return Err(AudioError::Device(
            "aaudio: createStreamBuilder failed".into(),
        ));
    }
    // SAFETY: `b` is a live builder just checked for null and owned solely by this
    // function; the setters only write configuration into it, and nothing else can
    // observe it concurrently.
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
    // SAFETY: `b` is the live, non-null builder from above and `&mut stream` is a valid
    // out-pointer for the duration of the call; on success AAudio writes a handle into
    // it. The builder is not accessed concurrently.
    let open_res = unsafe { AAudioStreamBuilder_openStream(b, &mut stream) };
    // SAFETY: `b` is consumed exactly once here — the AAudio contract is that a builder
    // is deleted after the stream is created and never used again, which this function
    // honours (no later statement touches `b`).
    unsafe { AAudioStreamBuilder_delete(b) };
    if open_res != AAUDIO_OK || stream.is_null() {
        return Err(result_to_err("aaudio: openStream", open_res));
    }
    // SAFETY: `stream` is non-null (checked on the line above) and is a handle produced
    // by a successful `openStream` that this function exclusively owns.
    let start = unsafe { AAudioStream_requestStart(stream) };
    if start != AAUDIO_OK {
        let e = result_to_err("aaudio: requestStart", start);
        // SAFETY: the handle is non-null and not yet closed (we are on the only path
        // that closes it before returning); it is not used after this call.
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
            // SAFETY: guarded by the null check (so never a double close) and the
            // handle came from `open_stream` in this type; it is nulled immediately
            // afterwards so no other path can close it again.
            unsafe {
                AAudioStream_close(self.stream);
            }
            self.stream = std::ptr::null_mut();
        }
    }
}

// SAFETY: an `AAudioStream` handle is not concurrently shareable, but ownership of
// the whole `AAudioCapture` (opened stream + spec) can be moved between threads as
// long as only one thread reads/closes it at a time — precisely how the resident
// capture worker consumes a mic (`amos-audio::source::PlatformMic`, which requires
// `Send`). The stream is opened once, handed to a single worker thread, and closed
// on drop from that thread. No `Sync` is claimed: concurrent `read`/close is UB and
// is prevented by the sole-owner contract of the consumer.
unsafe impl Send for AAudioCapture {}

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
        // SAFETY: `self.stream` is non-null (checked above) and solely owned by this
        // sink/capture; `scratch` holds exactly `frames` i16 elements, which is the
        // buffer AAudio is allowed to write for `num_frames`.
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
            // SAFETY: same contract as the capture's drop — null-guarded, handle owned
            // by this type, nulled right after so it cannot be closed twice.
            unsafe {
                AAudioStream_close(self.stream);
            }
            self.stream = std::ptr::null_mut();
        }
    }
}

// SAFETY: sole-owner handoff of the sink between threads (opened once, written/closed
// by one thread). Not `Sync`; see the `AAudioCapture` rationale.
unsafe impl Send for AAudioSink {}

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
        // SAFETY: `self.stream` is a non-null handle owned by this sink, and `scratch`
        // has at least `frames` initialized i16 elements — AAudio reads no more than
        // that many for `num_frames`.
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

// ---------------------------------------------------------------------------
// Data-callback capture (`AAudioCallbackCapture`)
//
// AAudio can *push* capture samples to us on its own real-time thread via
// `AAudioStream_dataCallback` instead of us polling with a blocking `read`. That
// callback is the "hardware sampling callback": it fires as close to the ADC as
// AAudio can get and hands us a fresh period of frames. We widen I16→f32 there
// and hand the samples to a bounded [`crate::ring::SampleRing`];
// `AudioCapture::read` then drains the ring on the worker thread. The rest of
// AmOS is unchanged — it still sees a plain pull `AudioCapture`, so the resident
// voice worker and `crate::source::PlatformMic` consume this exactly like
// `AAudioCapture`.
// ---------------------------------------------------------------------------

/// Shared state between the AAudio data callback (producer) and
/// [`AudioCapture::read`] (consumer). Owned by the capture; its address is handed
/// to AAudio as `user_data` and must stay valid until the stream is closed.
struct CallbackState {
    /// Bounded ring the callback pushes into and `read` drains from.
    ring: SampleRing,
    /// Reusable I16→f32 widening buffer. Only the single callback thread touches
    /// it, so it can be reused across callbacks with no per-callback allocation.
    scratch: Vec<f32>,
}

/// The real-time AAudio capture callback. Runs on AAudio's high-priority thread
/// whenever a new period of mono I16 frames is ready; widens them to f32 and
/// pushes them into the [`CallbackState::ring`]. Must be allocation-light and
/// non-blocking — the ring and scratch are pre-sized so steady-state never
/// allocates.
///
/// # Safety
///
/// Invoked **only** by AAudio, which guarantees a `user_data` pointer that is alive for
/// as long as the stream stays open (see [`AAudioCallbackCapture`], which keeps the
/// `Box<CallbackState>` alive until after `AAudioStream_close`) and an `audio_data`
/// buffer of `num_frames` I16 samples for the duration of the call. It must never be
/// called directly.
unsafe extern "C" fn aaudio_capture_cb(
    _stream: *mut AAudioStream,
    user_data: *mut c_void,
    audio_data: *mut c_void,
    num_frames: i32,
) -> aaudio_data_callback_result_t {
    // SAFETY: `user_data` always points at a live `CallbackState`: the owning capture
    // keeps it `Box`'d and only drops it after `AAudioStream_close` (which stops the
    // callback), so the pointer is valid for the whole lifetime AAudio may invoke this.
    // This mirrors the same unsafety the seam already documents for its raw stream
    // handles — the sole-owner + closed-before-drop contract is upheld by
    // `AAudioCallbackCapture`.
    let state = unsafe { &mut *(user_data as *mut CallbackState) };
    let n = num_frames.max(0) as usize;
    if audio_data.is_null() || n == 0 {
        return AAUDIO_CALLBACK_RESULT_CONTINUE;
    }
    // SAFETY: the AAudio data-callback contract guarantees `audio_data` points at
    // `num_frames` readable I16 samples when it is non-null (the null/zero case
    // returned above), and the borrow does not outlive this invocation.
    let src = unsafe { std::slice::from_raw_parts(audio_data as *const i16, n) };
    state.scratch.clear();
    for &s in src {
        state.scratch.push(i16_to_f32(s));
    }
    state.ring.push(&state.scratch);
    AAUDIO_CALLBACK_RESULT_CONTINUE
}

/// Build + start an AAudio input stream whose samples arrive on the data
/// callback (registered on the builder before open). Returns the raw handle.
///
/// # Safety
///
/// `user_data` must point at a value that stays alive (and at a stable address) until
/// the returned stream has been closed and stopped — AAudio will hand it to
/// [`aaudio_capture_cb`] on its own thread for as long as the stream is open.
unsafe fn open_callback_stream(
    rate: u32,
    user_data: *mut c_void,
) -> Result<*mut AAudioStream, AudioError> {
    let b = AAudio_createStreamBuilder();
    if b.is_null() {
        return Err(AudioError::Device(
            "aaudio: createStreamBuilder (callback) failed".into(),
        ));
    }
    AAudioStreamBuilder_setDirection(b, DIRECTION_INPUT);
    AAudioStreamBuilder_setSampleRate(b, rate as i32);
    AAudioStreamBuilder_setChannelCount(b, 1);
    AAudioStreamBuilder_setFormat(b, FORMAT_PCM_I16);
    AAudioStreamBuilder_setPerformanceMode(b, PERF_MODE_NONE);
    // ~10 ms per callback: a natural cadence for a real-time assistant listen.
    let frames_per_cb = ((rate as usize) / 100).max(160) as i32;
    AAudioStreamBuilder_setFramesPerDataCallback(b, frames_per_cb);
    AAudioStreamBuilder_setDataCallback(b, aaudio_capture_cb, user_data);

    let mut stream: *mut AAudioStream = std::ptr::null_mut();
    let open_res = AAudioStreamBuilder_openStream(b, &mut stream);
    AAudioStreamBuilder_delete(b);
    if open_res != AAUDIO_OK || stream.is_null() {
        return Err(result_to_err("aaudio: openStream (callback)", open_res));
    }
    let start = AAudioStream_requestStart(stream);
    if start != AAUDIO_OK {
        let e = result_to_err("aaudio: requestStart (callback)", start);
        AAudioStream_close(stream);
        return Err(e);
    }
    Ok(stream)
}

/// Mono microphone capture over AAudio driven by its **real-time data callback**,
/// rather than a blocking `AAudioStream_read` poll. Exposes the same pull
/// [`AudioCapture`] trait, so it is a drop-in source for the resident voice
/// worker / [`crate::source::PlatformMic`].
///
/// The ring capacity is ~100 ms at the requested rate (pre-reserved so the
/// callback never allocates in steady state); `read` drains it with the same ~1 s
/// starvation budget the blocking seam uses, returning `0` (end-of-stream) only
/// when the callback truly stops delivering (stream stopped / device error) — a
/// live mic keeps pushing silence, so it never looks like EOF.
pub struct AAudioCallbackCapture {
    stream: *mut AAudioStream,
    spec: AudioSpec,
    state: Box<CallbackState>,
}

impl AAudioCallbackCapture {
    /// Open + start a data-callback capture at `rate`. Prefer the ASR rate so the
    /// resident worker needs no resampling.
    pub fn open(rate: u32) -> Result<Self, AudioError> {
        let spec = AudioSpec::new(rate, 1);
        if !spec.is_valid() {
            return Err(AudioError::InvalidArguments(format!(
                "bad capture rate {rate}"
            )));
        }
        // ~100 ms of samples at the device rate — enough headroom for the worker's
        // ~10 ms drain cadence to absorb scheduling jitter without over-buffering.
        let ring_cap = ((rate as usize) / 10).max(320);
        // Scratch sized to a full ring so the callback's I16→f32 widening never
        // reallocates under a realistic callback period.
        let state = Box::new(CallbackState {
            ring: SampleRing::new(ring_cap),
            scratch: Vec::with_capacity(ring_cap),
        });
        // The Box gives `state` a stable address for the lifetime of the capture.
        let user_data = &*state as *const CallbackState as *mut c_void;
        // SAFETY: `user_data` is the address of a live `Box<CallbackState>` that the
        // returned `AAudioCallbackCapture` keeps alive until *after* the stream is
        // stopped and closed, which satisfies the callee's contract above.
        let stream = unsafe { open_callback_stream(rate, user_data) }?;
        Ok(Self {
            stream,
            spec,
            state,
        })
    }
}

impl Drop for AAudioCallbackCapture {
    fn drop(&mut self) {
        if !self.stream.is_null() {
            // SAFETY: the handle is non-null and owned by this capture. `requestStop`
            // lets AAudio wind the callback thread down before `close`; `close` then
            // guarantees no further invocation, after which `self.state` (dropped after
            // `stream`) is safe to free.
            unsafe {
                let _ = AAudioStream_requestStop(self.stream);
                AAudioStream_close(self.stream);
            }
            self.stream = std::ptr::null_mut();
        }
    }
}

// SAFETY: an `AAudioStream` handle is not concurrently shareable, but ownership of
// the whole capture (stream + the shared ring state) can be moved between threads
// as long as only one thread reads/closes it at a time — precisely how the
// resident capture worker consumes a mic (`amos-audio::source::PlatformMic`,
// which requires `Send`). The callback producer runs on AAudio's own thread and
// only ever touches the ring via shared references, which is safe. No `Sync` is
// claimed: concurrent `read`/close is UB and is prevented by the sole-owner
// contract of the consumer.
unsafe impl Send for AAudioCallbackCapture {}

impl AudioCapture for AAudioCallbackCapture {
    fn spec(&self) -> AudioSpec {
        self.spec
    }

    fn read(&mut self, out: &mut [f32]) -> Result<usize, AudioError> {
        // Drain whatever the data callback has pushed; waits up to the ring's read
        // budget for a first sample and reports EOF (`0`) only when the callback
        // has genuinely stopped delivering.
        Ok(self.state.ring.read(out))
    }
}

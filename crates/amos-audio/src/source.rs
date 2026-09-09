//! The **platform microphone facade** — one `Send` [`AudioCapture`] that the
//! always-on voice pipeline (`amos-tauri::assistant_voice`) hands straight to its
//! resident capture worker, no matter which backend the build targets.
//!
//! This is the seam that ties the raw Android FFI seams (the `android` module:
//! `AAudioCapture`/`TinyAlsaCapture`, present only on Android) to the resident
//! worker:
//!
//! ```text
//! [ AAudioCapture / TinyAlsaCapture ]   [ mock: FrameMic / SineMic … ]
//!            open_device()                        from_mock()
//!                       │                            │
//!                       └────► PlatformMic (Send, AudioCapture) ◄────┘
//!                                        │ read()
//!                                        ▼
//!              resident worker: 16k down-sample → Payload::Audio → AudioEnd
//! ```
//!
//! * On an Android build the facade opens the **real** device mic:
//!   `AAudioCallbackCapture` (the low-latency app path the AI assistant uses,
//!   driven by AAudio's real-time data callback) when the `aaudio` feature is
//!   compiled in — preferred — otherwise `TinyAlsaCapture` (the system/TinyALSA
//!   seam) behind `tinyalsa`. It asks for 16 kHz so the resident worker needs no
//!   down-sampling.
//! * On a host build there is **no native mic**: [`PlatformMic::open_device`]
//!   returns a clear error rather than silently fabricating audio (honesty rule —
//!   never mistake a host mock for a real microphone). Hosts and demos that want a
//!   source use [`PlatformMic::from_mock`].
//!
//! [`PlatformMic`] is `Send` (not `Sync`): the device captures moved into it are
//! handed to a single worker thread that owns all reads and the final close.

use crate::capture::AudioCapture;
use crate::error::AudioError;
use crate::spec::AudioSpec;

/// Which capture backend this build can open for the platform microphone.
///
/// Resolution is compile-time (`feature` + `target_os`); on a host build there is
/// no native capture backend, so this reports [`Host`](PlatformMicKind::Host)
/// unless a caller explicitly injects a mock ([`Mock`](PlatformMicKind::Mock)).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformMicKind {
    /// Low-latency NDK AAudio capture (Android + `aaudio` feature). The app-side
    /// path an always-on AI assistant uses to listen to the mic in real time.
    Aaudio,
    /// System-level AOSP TinyALSA PCM capture (Android + `tinyalsa` feature). The
    /// seam a system component uses to open the primary mic / call-voice stream.
    TinyAlsa,
    /// No native capture backend compiled for this target (host build). Only
    /// [`PlatformMic::from_mock`] capture is available.
    Host,
    /// An **explicitly injected** host/dev capture ([`PlatformMic::from_mock`]);
    /// distinguishable from [`Host`](PlatformMicKind::Host) (which merely means "no
    /// native backend").
    Mock,
}

impl PlatformMicKind {
    /// The backend compiled into this binary for the current target. Precedence:
    /// AAudio (app path) before TinyALSA (system path) when both are built.
    pub fn detect() -> Self {
        #[cfg(all(feature = "aaudio", target_os = "android"))]
        {
            return Self::Aaudio;
        }
        #[cfg(all(
            all(feature = "tinyalsa", target_os = "android"),
            not(feature = "aaudio")
        ))]
        {
            return Self::TinyAlsa;
        }
        // Host build, or an Android build with no native feature compiled in.
        // When a native backend *is* compiled on Android the branches above always
        // return, so this tail is unreachable there — `#[allow]` is the honest,
        // explicit acknowledgement (never a fabricated native claim).
        #[allow(unreachable_code)]
        Self::Host
    }

    /// A short label for logs / `get_status` (`"aaudio"`, `"tinyalsa"`, `"host"`,
    /// `"mock"`).
    pub const fn label(self) -> &'static str {
        match self {
            Self::Aaudio => "aaudio",
            Self::TinyAlsa => "tinyalsa",
            Self::Host => "host",
            Self::Mock => "mock",
        }
    }

    /// True when this kind is a real device capture (AAudio or TinyALSA).
    pub const fn is_native(self) -> bool {
        matches!(self, Self::Aaudio | Self::TinyAlsa)
    }
}

/// A `Send` microphone source ready for the resident voice worker.
///
/// Wraps either a real device capture (opened by [`Self::open_device`]) or an
/// explicitly-injected mock ([`Self::from_mock`]) behind one [`AudioCapture`],
/// so the always-on pipeline is backend-agnostic and unit-testable on a host.
pub struct PlatformMic {
    kind: PlatformMicKind,
    /// Logging label — `"aaudio"`/`"tinyalsa"` for the real backend, `"mock"` when
    /// built from a host mock.
    label: &'static str,
    /// The sample rate this source delivers (16000 for the ASR fast path).
    native_rate: u32,
    inner: Box<dyn AudioCapture + Send>,
}

impl PlatformMic {
    #[cfg(any(
        all(feature = "aaudio", target_os = "android"),
        all(feature = "tinyalsa", target_os = "android"),
    ))]
    fn boxed(kind: PlatformMicKind, inner: impl AudioCapture + Send + 'static) -> Self {
        let native_rate = inner.spec().sample_rate;
        Self {
            kind,
            label: kind.label(),
            native_rate,
            inner: Box::new(inner),
        }
    }

    /// Open the **real** device mic for the always-on voice pipeline.
    ///
    /// Asks for 16 kHz mono so the resident worker needs no resampling. On an
    /// Android build this returns an AAudio (or TinyALSA) capture; on a host with
    /// no native backend it returns a clear [`AudioError::Device`] describing the
    /// missing backend — never a silent mock.
    pub fn open_device() -> Result<Self, AudioError> {
        #[cfg(all(feature = "aaudio", target_os = "android"))]
        {
            // Prefer the data-callback capture (the AAudio "hardware sampling
            // callback" pushes samples on AAudio's real-time thread into a ring
            // that `read` drains) — the model the always-on voice worker wants.
            // `AAudioCapture` (blocking `AAudioStream_read`) remains available for
            // callers that explicitly prefer the pull model.
            let cap = crate::AAudioCallbackCapture::open(crate::spec::ASR_SAMPLE_RATE)?;
            Ok(Self::boxed(PlatformMicKind::Aaudio, cap))
        }
        #[cfg(all(
            all(feature = "tinyalsa", target_os = "android"),
            not(feature = "aaudio")
        ))]
        {
            let cap = crate::TinyAlsaCapture::open(crate::spec::ASR_SAMPLE_RATE)?;
            Ok(Self::boxed(PlatformMicKind::TinyAlsa, cap))
        }
        #[cfg(not(any(
            all(feature = "aaudio", target_os = "android"),
            all(feature = "tinyalsa", target_os = "android"),
        )))]
        {
            Err(AudioError::Device(
                "no native audio capture backend on this host (compile for Android with \
                 --features aaudio, or tinyalsa). A host cannot open the device mic; use \
                 PlatformMic::from_mock for host/dev/demo capture"
                    .to_string(),
            ))
        }
    }

    /// Wrap an explicitly-provided capture as the mic source — the host / dev /
    /// demo path (e.g. a [`crate::mock::FrameMic`] in tests or CI).
    pub fn from_mock(mic: impl AudioCapture + Send + 'static) -> Self {
        let native_rate = mic.spec().sample_rate;
        Self {
            kind: PlatformMicKind::Mock,
            label: "mock",
            native_rate,
            inner: Box::new(mic),
        }
    }

    /// Which backend family this source belongs to (AAudio / TinyALSA / host mock).
    pub fn kind(&self) -> PlatformMicKind {
        self.kind
    }

    /// A short logging label: `"aaudio"` / `"tinyalsa"` / `"mock"`.
    pub fn backend_label(&self) -> &'static str {
        self.label
    }

    /// The sample rate this source delivers (matches [`AudioCapture::spec`]).
    pub fn native_rate(&self) -> u32 {
        self.native_rate
    }

    /// True when this is a real on-device capture rather than a host mock.
    pub fn is_native(&self) -> bool {
        self.kind.is_native()
    }
}

impl AudioCapture for PlatformMic {
    fn spec(&self) -> AudioSpec {
        self.inner.spec()
    }

    fn read(&mut self, out: &mut [f32]) -> Result<usize, AudioError> {
        self.inner.read(out)
    }
}

#[cfg(test)]
fn _assert_send<T: Send>() {}

#[cfg(test)]
fn _assert_send_platform_mic() {
    _assert_send::<PlatformMic>();
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::{FrameMic, SineMic};

    #[test]
    fn platform_mic_is_send_for_the_resident_worker() {
        // Compile-time guard: spawn_resident_capture requires `C: AudioCapture + Send`.
        _assert_send_platform_mic();
    }

    /// The host build must report `Host` — never guess an Android vendor/backend.
    #[test]
    fn detect_reports_host_on_non_android() {
        #[cfg(not(target_os = "android"))]
        assert_eq!(PlatformMicKind::detect(), PlatformMicKind::Host);
        // Labels are stable regardless of target.
        assert_eq!(PlatformMicKind::Aaudio.label(), "aaudio");
        assert_eq!(PlatformMicKind::TinyAlsa.label(), "tinyalsa");
        assert_eq!(PlatformMicKind::Host.label(), "host");
        assert_eq!(PlatformMicKind::Mock.label(), "mock");
        assert!(PlatformMicKind::Aaudio.is_native());
        assert!(!PlatformMicKind::Host.is_native());
        assert!(!PlatformMicKind::Mock.is_native());
    }

    #[test]
    fn open_device_on_host_is_an_honest_error() {
        #[cfg(not(target_os = "android"))]
        {
            match PlatformMic::open_device() {
                Ok(_) => panic!("a host must not report a device mic"),
                Err(e) => {
                    let msg = e.to_string();
                    assert!(msg.contains("no native audio capture backend"), "{msg}");
                    assert!(
                        msg.contains("from_mock"),
                        "must point at the host escape hatch: {msg}"
                    );
                }
            }
        }
    }

    #[test]
    fn from_mock_acts_as_a_plain_audio_capture() {
        let frames: Vec<f32> = (0..100).map(|i| i as f32 / 100.0).collect();
        let mut mic = PlatformMic::from_mock(FrameMic::new(16_000, frames.clone()));
        assert_eq!(mic.kind(), PlatformMicKind::Mock);
        assert_eq!(mic.backend_label(), "mock");
        assert!(!mic.is_native());
        assert_eq!(mic.native_rate(), 16_000);
        assert_eq!(mic.spec().sample_rate, 16_000);

        let mut out = vec![0.0f32; 100];
        assert_eq!(mic.read(&mut out).unwrap(), 100);
        assert_eq!(out, frames);
        // Reads to EOF report 0.
        assert_eq!(mic.read(&mut out).unwrap(), 0);
    }

    #[test]
    fn from_mock_keeps_the_native_rate_of_its_source() {
        let mut mic = PlatformMic::from_mock(SineMic::new(48_000, 440.0));
        assert_eq!(mic.native_rate(), 48_000);
        // A host 48 kHz mock still down-samples in the resident worker.
        let mut buf = [0.0f32; 480];
        assert_eq!(mic.read(&mut buf).unwrap(), 480);
    }
}

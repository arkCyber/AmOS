//! Direct FFI bindings to the AOSP audio stack, compiled **only** for
//! `target_os = "android"` (with the matching feature). On host builds this
//! whole directory is absent, so the default workspace never links any native
//! audio library.
//!
//! Two backends are provided:
//!
//! * [`tinyalsa`] — capture/playback over AOSP **TinyALSA** (`libtinyalsa`
//!   PCM). This is the layer AudioFlinger / the Audio HAL sit on top of, so it
//!   is the right place for a system component to open the **primary
//!   microphone** and (with the appropriate HAL/DSP hooks) a **call/voice
//!   stream** for real-time translate.
//! * [`aaudio`] — a capture seam over the **AAudio** NDK C API (low-latency,
//!   app-accessible). Ordinary apps cannot open `/dev/snd` directly, so AAudio
//!   is the realistic path for a shipped app to listen to the mic in real time;
//!   the AI-assistant always-on listen should use this.
//!
//! Both implement the same [`crate::AudioCapture`] / [`crate::AudioSink`]
//! traits and deliver **mono f32** to AmOS. They are hand-written `extern`
//! bindings (no `bindgen`) matching the AOSP public headers. They are compiled
//! and validated on an Android/NDK cross-target; CI on a Linux/macOS host only
//! guarantees the rest of the crate.
//!
//! ```bash
//! # Cross-compile the TinyALSA seam for Android (needs the NDK sysroot):
//! cargo build -p amos-audio --features tinyalsa \
//!     --target aarch64-linux-android --release
//! ```

#[cfg(feature = "aaudio")]
pub mod aaudio;
#[cfg(feature = "tinyalsa")]
pub mod tinyalsa;

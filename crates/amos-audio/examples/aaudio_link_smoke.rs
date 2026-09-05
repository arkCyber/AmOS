//! **Build-only** AAudio *link* smoke for the Android NDK.
//!
//! An Android **executable** cannot carry undefined symbols, so linking this
//! example on an Android target forces the linker to resolve every `AAudio_*`
//! extern against the NDK's `libaaudio.so` (via the `#[link(name = "aaudio")]`
//! on the seam). A successful `cargo ndk -t <abi> -P 26 build -p amos-audio
//! --features aaudio --example aaudio_link_smoke` therefore proves the bind is
//! not just hand-written type-correct, but actually links.
//!
//! This is a **link proof only** — it is not meant to be run (running it on a
//! device would open the microphone). On a non-Android host it is a cfg'd no-op
//! so the default workspace build and test run are unaffected.
//!
//! ```bash
//! # Needs cargo-ndk + an NDK, and the rustup target added.
//! cargo ndk -t arm64-v8a -P 26 build -p amos-audio \
//!     --features aaudio --example aaudio_link_smoke
//! ```

fn main() {
    #[cfg(target_os = "android")]
    {
        // Reference the real AAudio seam so the linker must resolve AAudio_*.
        // `let _ =` + drop keeps it a link-only reference; nothing is opened or
        // recorded at this stage.
        let _ = amos_audio::AAudioCapture::open(amos_audio::ASR_SAMPLE_RATE);
        let _ = amos_audio::AAudioSink::open(amos_audio::ASR_SAMPLE_RATE);
    }
    #[cfg(not(target_os = "android"))]
    {
        println!("aaudio_link_smoke: no-op on a non-Android host (see docs)");
    }
}

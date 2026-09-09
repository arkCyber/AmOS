//! **Runtime probe** for the AAudio *data-callback* capture (`AAudioCallbackCapture`).
//!
//! Unlike `aaudio_link_smoke` (link-only proof), this actually **opens the
//! microphone through the data-callback seam and reads real samples**, so a device
//! bring-up engineer can confirm the AAudio real-time callback is firing and
//! streaming mono f32 to `read()` — the first hop of the on-device
//! "mic → assistant" pipeline. It prints how many samples arrived over a ~1 s
//! window and the peak amplitude, and gives an honest diagnostic if nothing came
//! in (e.g. `RECORD_AUDIO` not granted / stream never started).
//!
//! On a non-Android host it is a cfg'd no-op (no native mic), so it never touches
//! the default workspace build/test.
//!
//! ```bash
//! # Needs cargo-ndk + an NDK, and the rustup target added.
//! cargo ndk -t arm64-v8a -P 26 build -p amos-audio \
//!     --features aaudio --example aaudio_callback_probe
//! # Then push the built binary to a device that has granted RECORD_AUDIO and run it.
//! ```

fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "android")]
    {
        use amos_audio::capture::AudioCapture;
        use amos_audio::AAudioCallbackCapture;
        use amos_audio::ASR_SAMPLE_RATE;

        println!(
            "aaudio_callback_probe: opening data-callback mic @ {ASR_SAMPLE_RATE} Hz (mono I16)…"
        );
        let mut cap = AAudioCallbackCapture::open(ASR_SAMPLE_RATE)
            .map_err(|e| format!("AAudioCallbackCapture::open failed: {e}"))?;

        let mut buf = vec![0.0f32; 160]; // 10 ms @ 16 kHz
        let mut total = 0usize;
        let mut peak = 0.0f32;
        let mut eof = false;
        // ~1 s of capture (100 × 10 ms). A live mic streams continuously; if the
        // data callback never fires we hit EOF (read()==0) early and say so.
        for _ in 0..100 {
            let n = cap.read(&mut buf)?;
            if n == 0 {
                eof = true;
                break;
            }
            total += n;
            for &s in &buf[..n] {
                peak = peak.max(s.abs());
            }
        }

        println!(
            "samples read: {total} @ {ASR_SAMPLE_RATE} Hz ({:.2} s)",
            total as f32 / ASR_SAMPLE_RATE as f32
        );
        println!("peak amplitude: {peak:.4}");

        if total == 0 {
            eprintln!("no samples arrived — the AAudio data callback never fired.");
            eprintln!("check RECORD_AUDIO is granted and the app holds the mic.");
        } else if eof {
            eprintln!(
                "capture hit end-of-stream after {total} samples (callback stopped unexpectedly)."
            );
        } else {
            println!(
                "ok: the AAudio data callback streamed real mic samples for the probe window."
            );
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        println!(
            "aaudio_callback_probe: no-op on a non-Android host. Run on a device that has granted RECORD_AUDIO."
        );
    }
    Ok(())
}

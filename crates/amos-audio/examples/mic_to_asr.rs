//! Demo: capture → resample → wire bytes (the exact chain a client uses before
//! pushing `ai_agent` `Payload::Audio` frames to the daemon).
//!
//! Uses a deterministic mock mic (no device needed) at 48 kHz, down-samples to
//! the 16 kHz ASR/wire spec, and encodes little-endian f32 PCM — the format the
//! daemon's bidi recognizer decodes.
//!
//! ```bash
//! cargo run -p amos-audio --example mic_to_asr
//! ```

use amos_audio::capture::AudioCapture;
use amos_audio::mock::SineMic;
use amos_audio::resample::LinearDownsampler;
use amos_audio::spec::encode_f32_le;

fn main() {
    // Simulate a 48 kHz mic; emit a short 440 Hz tone (0.1 s).
    let mut mic = SineMic::new(48_000, 440.0).with_total_samples(4_800);
    let mut buf = vec![0.0f32; 480];
    let mut down = LinearDownsampler::new(48_000, 16_000).expect("48k -> 16k");
    let mut wire = Vec::new();
    let mut raw_samples = 0usize;

    while mic.read(&mut buf).expect("mock mic read") > 0 {
        raw_samples += 480;
        let resampled = down.process(&buf).expect("resample");
        // A live client would push `wire` (or the resampled frames chunked)
        // straight into the Chat stream as Payload::Audio.
        wire.extend_from_slice(&encode_f32_le(&resampled));
    }

    println!("captured {raw_samples} @48 kHz");
    println!(
        "down-sampled to {} samples @16 kHz, wire payload = {} bytes",
        wire.len() / 4,
        wire.len()
    );
    assert_eq!(wire.len() % 4, 0, "f32-le frames are 4 bytes each");
    println!("ok: mic -> resample -> wire bytes");
}

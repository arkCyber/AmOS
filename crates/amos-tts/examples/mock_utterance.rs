//! `mock_utterance` — what the interpretation loop receives from a TTS provider.
//!
//! The text is synthesized with the deterministic mock (no model, no speaker), and what it
//! returns is exactly the contract the pipeline depends on: PCM samples, a sample rate and a
//! channel count. The real engine (`--features piper`) implements the same trait.
//!
//! Usage:
//! ```text
//! cargo run -p amos-tts --example mock_utterance
//! ```

use std::sync::Arc;

use amos_int::{Language, TtsRequest};
use amos_tts::{MockTtsProvider, TtsProvider};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let provider = MockTtsProvider {
        // A soft tone instead of silence, so a demo is audible when the samples are written out.
        beep: true,
        ..Default::default()
    };
    println!("provider: {}", provider.name());

    for (text, lang) in [
        ("你好，Amos", Language::new("zh")),
        ("hello there", Language::new("en")),
    ] {
        let request = TtsRequest {
            text: text.to_string(),
            lang,
            segment_id: 1,
        };
        let audio = provider.synthesize(&request.text, &request.lang).await?;
        let seconds = audio.samples.len() as f64 / f64::from(audio.sample_rate);
        println!(
            "{:<14} -> {} sample(s) @ {} Hz x{} channel(s) = {:.2}s",
            request.text,
            audio.samples.len(),
            audio.sample_rate,
            audio.channels,
            seconds
        );
        let peak = audio.samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        println!("  peak amplitude {peak:.3} (deterministic for the same input)");

        // The same text twice is the same audio: that is what makes this usable in tests.
        let again = provider.synthesize(&request.text, &request.lang).await?;
        println!("  reproducible: {}", again.samples == audio.samples);
    }

    // The provider is object-safe, so a session can hold it behind an `Arc<dyn TtsProvider>`.
    let dynamic: Arc<dyn TtsProvider> = Arc::new(MockTtsProvider::default());
    println!(
        "as a trait object: {} -> {} sample(s) for \"ok\"",
        dynamic.name(),
        dynamic
            .synthesize("ok", &Language::new("en"))
            .await?
            .samples
            .len()
    );
    Ok(())
}

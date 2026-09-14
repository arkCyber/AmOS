//! `recognition_stream` — the mock recognizer driving the pipeline: partials then a final.
//!
//! The engine is fake (no model, no microphone), but the *contract* is the real one: `push_samples`
//! returns growing hypotheses, `is_endpoint` says when an utterance ended, and `AsrPipeline` turns
//! those into the `AsrEvent::Partial`/`Final` pairs the interpretation layer consumes. That is what
//! makes the whole voice loop testable offline.
//!
//! Usage:
//! ```text
//! cargo run -p amos-asr --example recognition_stream
//! ```

use amos_asr::{MockStreamingRecognizer, StreamingRecognizer};

/// One 10 ms frame of silence at 16 kHz — what a microphone would hand over.
fn frame() -> Vec<f32> {
    vec![0.0f32; 160]
}

fn main() {
    let mut recognizer = MockStreamingRecognizer::new(["你", "好", "，Amos"], 2);
    println!("mock recognizer ready (endpoint after 2 words)");

    // Feed frames: each chunk may produce a new hypothesis (stable prefix + unstable tail).
    let mut partials = 0;
    for i in 0..12 {
        if let Some(hypothesis) = recognizer.push_samples(&frame()) {
            partials += 1;
            println!(
                "  frame {i:>2}: stable={:?} text={:?} endpoint={}",
                hypothesis.stable,
                hypothesis.text,
                recognizer.is_endpoint()
            );
        }
        if recognizer.is_endpoint() {
            break;
        }
    }
    println!("hypotheses emitted: {partials}");

    // The final text is produced once, by `finalize`.
    let final_text = recognizer.finalize();
    println!("final: {final_text:?}");

    // Reset starts a new utterance (no state carried over).
    recognizer.reset();
    println!(
        "after reset: text={:?} endpoint={}",
        recognizer.push_samples(&frame()).map(|h| h.text),
        recognizer.is_endpoint()
    );
}

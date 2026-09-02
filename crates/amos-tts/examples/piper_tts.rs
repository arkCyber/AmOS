//! Real Piper TTS synthesis demo (feature `piper`).
//!
//! Synthesizes text to a WAV via [`amos_tts::PiperProvider`]. Requires the model
//! + voice `.onnx.json`, and **espeak-ng** at runtime (`brew install espeak-ng`).
//!
//! ```bash
//! cargo run -p amos-tts --example piper_tts --features piper -- \
//!     "This is a test." models/piper-low/en_US-lessac-low.onnx \
//!     models/piper-low/en_US-lessac-low.onnx.json /tmp/piper_out.wav
//! ```

use std::path::Path;

use amos_int::language::Language;
use amos_tts::{PiperProvider, TtsProvider};

fn write_pcm16_wav(path: &Path, sample_rate: u32, samples: &[f32]) -> std::io::Result<()> {
    let data_len = samples.len() * 2;
    let mut bytes = Vec::with_capacity(44 + data_len);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    bytes.extend_from_slice(&2u16.to_le_bytes()); // block align
    bytes.extend_from_slice(&16u16.to_le_bytes()); // bits
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(data_len as u32).to_le_bytes());
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, bytes)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let text = args.get(1).cloned().unwrap_or_else(|| "Hello, this is a test of local text to speech.".into());
    let model = args.get(2).cloned().unwrap_or_else(|| "models/piper-low/en_US-lessac-low.onnx".into());
    let voice = args.get(3).cloned().unwrap_or_else(|| "models/piper-low/en_US-lessac-low.onnx.json".into());
    let out = args.get(4).cloned().unwrap_or_else(|| "/tmp/piper_out.wav".into());

    println!("loading piper model {model}");
    let provider = PiperProvider::new(model.into(), voice.into())?;
    let audio = provider
        .synthesize(&text, &Language::new("en"))
        .await?;
    write_pcm16_wav(Path::new(&out), audio.sample_rate, &audio.samples)?;
    println!(
        "synthesized {} samples @ {}Hz -> {out} ({:.1}s)",
        audio.samples.len(),
        audio.sample_rate,
        audio.samples.len() as f32 / audio.sample_rate as f32
    );
    Ok(())
}

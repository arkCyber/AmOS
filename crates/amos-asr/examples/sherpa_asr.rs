//! Real sherpa-onnx streaming ASR demo (requires the `sherpa` feature).
//!
//! Reads a 16 kHz mono 16-bit PCM WAV and streams it through
//! [`amos_asr::SherpaOnlineRecognizer`], printing the growing partial
//! hypothesis and the final recognized text.
//!
//! ```bash
//! # 1) fetch a model (or set SHERPA_MODEL_DIR):
//! bash scripts/fetch-models.sh
//! # 2) run:
//! cargo run -p amos-asr --example sherpa_asr --features sherpa -- \
//!     models/sherpa-en-20m/test_wavs/0.wav
//! ```

use std::path::{Path, PathBuf};

use amos_asr::StreamingRecognizer; // bring the trait methods into scope

/// Minimal RIFF/WAVE parser for 16-bit PCM. Returns `(sample_rate, mono f32)`.
fn read_pcm16_wav(path: &Path) -> Result<(u32, Vec<f32>), String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let mut sample_rate = 0u32;
    let mut channels = 1u16;
    let mut bits = 16u16;
    let mut data: Option<&[u8]> = None;
    let mut i = 12;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size = u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
        i += 8;
        match id {
            b"fmt " if size >= 16 => {
                let fmt = u16::from_le_bytes([bytes[i], bytes[i + 1]]);
                channels = u16::from_le_bytes([bytes[i + 2], bytes[i + 3]]);
                sample_rate = u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]);
                bits = u16::from_le_bytes([bytes[i + 14], bytes[i + 15]]);
                if fmt != 1 {
                    return Err("only uncompressed PCM supported".into());
                }
            }
            b"data" => {
                data = Some(&bytes[i..(i + size).min(bytes.len())]);
                break;
            }
            _ => {}
        }
        i += size;
    }
    let data = data.ok_or("no data chunk".to_string())?;
    if bits != 16 {
        return Err("only 16-bit PCM supported".into());
    }
    let frames = data.len() / (channels as usize * 2);
    let mut mono = Vec::with_capacity(frames);
    for f in 0..frames {
        let off = f * channels as usize * 2;
        let s = i16::from_le_bytes([data[off], data[off + 1]]) as f32 / 32767.0;
        mono.push(s);
    }
    Ok((sample_rate, mono))
}

fn main() {
    let wav = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "models/sherpa-en-20m/test_wavs/0.wav".to_string());
    let model_dir = PathBuf::from(std::env::var("SHERPA_MODEL_DIR").unwrap_or_else(|_| "models/sherpa-en-20m".into()));

    let cfg = amos_asr::SherpaOnlineRecognizerConfig {
        tokens: model_dir.join("tokens.txt"),
        encoder: model_dir.join("encoder-epoch-99-avg-1.int8.onnx"),
        decoder: model_dir.join("decoder-epoch-99-avg-1.int8.onnx"),
        joiner: model_dir.join("joiner-epoch-99-avg-1.int8.onnx"),
        num_threads: 2,
        lang: "en".into(),
        ..Default::default()
    };
    println!("loading sherpa model from {}", model_dir.display());
    println!(
        "native: sherpa-onnx {} / onnxruntime {}",
        sherpa_onnx::version(),
        sherpa_onnx::onnxruntime_version()
    );
    let mut recognizer = amos_asr::SherpaOnlineRecognizer::new(cfg).expect("load sherpa model");

    let (sr, samples) = read_pcm16_wav(Path::new(&wav)).expect("read wav");
    println!("audio: {sr} Hz, {} samples ({:.1}s)", samples.len(), samples.len() as f32 / sr as f32);

    // Feed in ~400 ms chunks (streaming decoders need enough buffered audio to
    // produce features/partials; 10 ms per decode is too granular).
    let chunk = 6400; // 400 ms @ 16 kHz
    for c in samples.chunks(chunk) {
        if let Some(h) = recognizer.push_samples(c) {
            println!("  [partial] {}", h.text);
        }
    }
    let final_text = recognizer.finalize();
    println!("FINAL: {}", final_text);
}

//! Whole-buffer sherpa ASR over the bundled model + demo clip (feature `sherpa`).
//! Skipped gracefully when the model files are absent (e.g. CI without models).
#![cfg(feature = "sherpa")]

use std::path::PathBuf;

use amos_asr::sherpa::{decode_pcm16_wav, transcribe_buffer, SherpaOnlineRecognizerConfig};

fn model_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("AMOS_SHERPA_MODEL_DIR") {
        if !d.is_empty() {
            let p = PathBuf::from(d);
            if p.join("tokens.txt").exists() {
                return Some(p);
            }
        }
    }
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models/sherpa-en-20m");
    p.join("tokens.txt").exists().then_some(p)
}

fn config_from(dir: &std::path::Path) -> SherpaOnlineRecognizerConfig {
    SherpaOnlineRecognizerConfig {
        tokens: dir.join("tokens.txt"),
        encoder: dir.join("encoder-epoch-99-avg-1.int8.onnx"),
        decoder: dir.join("decoder-epoch-99-avg-1.int8.onnx"),
        joiner: dir.join("joiner-epoch-99-avg-1.int8.onnx"),
        lang: "en".into(),
        ..Default::default()
    }
}

#[test]
fn transcribe_buffer_recognizes_the_demo_clip() {
    let Some(dir) = model_dir() else {
        eprintln!("skip: sherpa model files not present");
        return;
    };
    let wav = dir.join("test_wavs/0.wav");
    let bytes = std::fs::read(&wav).expect("demo wav readable");
    let (_rate, samples) = decode_pcm16_wav(&bytes).expect("wav decodes");
    assert!(!samples.is_empty(), "wav has audio");

    let text = transcribe_buffer(config_from(&dir), &samples).expect("sherpa transcribe ok");
    assert!(!text.trim().is_empty(), "recognized some text");
    assert!(
        text.to_uppercase().contains("YELLOW LAMPS"),
        "expected demo transcript, got: {text}"
    );
}

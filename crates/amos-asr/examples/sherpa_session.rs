//! Real sherpa streaming ASR driving an `amos_int::Session` (feature `sherpa`).
//!
//! Shows the exact pattern a System UI would use: a composite pipeline
//! (local sherpa ASR + a translate delegate) feeding an `amos_int::Session`;
//! on `EndOfSpeech` the pipeline is flushed so the recognized utterance
//! becomes a finalized (translated) segment.
//!
//! ```bash
//! bash scripts/fetch-models.sh
//! cargo run -p amos-asr --example sherpa_session --features sherpa -- \
//!     models/sherpa-en-20m/test_wavs/0.wav
//! ```

use std::path::{Path, PathBuf};
use std::sync::Arc;

use amos_asr::{sherpa_pipeline, SherpaOnlineRecognizerConfig};
use amos_int::pipeline::Pipeline;
use amos_int::{InterpretationOutput, MockPipeline, Session, SessionConfig, SessionEvent};
use tokio::sync::mpsc;

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
        let size =
            u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
        i += 8;
        match id {
            b"fmt " if size >= 16 => {
                let fmt = u16::from_le_bytes([bytes[i], bytes[i + 1]]);
                channels = u16::from_le_bytes([bytes[i + 2], bytes[i + 3]]);
                sample_rate =
                    u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]);
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let wav = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "models/sherpa-en-20m/test_wavs/0.wav".to_string());
    let model_dir = PathBuf::from(
        std::env::var("SHERPA_MODEL_DIR").unwrap_or_else(|_| "models/sherpa-en-20m".into()),
    );

    let cfg = SherpaOnlineRecognizerConfig {
        tokens: model_dir.join("tokens.txt"),
        encoder: model_dir.join("encoder-epoch-99-avg-1.int8.onnx"),
        decoder: model_dir.join("decoder-epoch-99-avg-1.int8.onnx"),
        joiner: model_dir.join("joiner-epoch-99-avg-1.int8.onnx"),
        num_threads: 2,
        lang: "en".into(),
        ..Default::default()
    };

    // Composite: local sherpa ASR + MockPipeline translate (real translation
    // would use a GrpcPipeline → amos-translate daemon).
    let translate: Arc<dyn Pipeline> = Arc::new(MockPipeline::new("", "en"));
    let pipeline = Box::new(sherpa_pipeline(cfg, Some(translate))?);
    let (mut session, mut rx) = Session::new(SessionConfig::one_way("en", "en"), pipeline);
    session.start().unwrap();
    println!("sherpa model loaded; feeding {}", wav);

    let (_sr, samples) = read_pcm16_wav(Path::new(&wav)).expect("read wav");
    for frame in samples.chunks(6400) {
        session.feed_audio(frame).await?;
    }
    // Flush the recognizer so the utterance becomes a finalized segment.
    session.handle(SessionEvent::EndOfSpeech).await?;
    session.stop().unwrap();

    print_outputs(&mut rx).await;
    println!("session state: {:?}", session.state());
    Ok(())
}

async fn print_outputs(rx: &mut mpsc::Receiver<InterpretationOutput>) {
    while let Ok(Some(o)) =
        tokio::time::timeout(std::time::Duration::from_millis(300), rx.recv()).await
    {
        match o {
            InterpretationOutput::Partial(p) => println!("  [partial] {}", p.text),
            InterpretationOutput::SegmentFinal(s) => {
                println!("  [segment] {}  →  {}", s.source_text, s.target_text)
            }
            InterpretationOutput::Error { message } => println!("  [error] {message}"),
            _ => {}
        }
    }
}

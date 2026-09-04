//! End-to-end: the bidi `Chat` `Payload::Audio` channel run against a **real
//! local sherpa ASR** (feature `asr-sherpa`), over a real Unix Domain Socket.
//!
//! Feeds the checked-in demo clip (`models/sherpa-en-20m/test_wavs/0.wav`) as
//! mono 16 kHz f32 PCM wire frames and asserts the recognized speech is answered
//! — proving mic PCM → bidi audio → on-device ASR → reply is wired end to end.
//!
//! Run: `cargo test -p amos-ai --features asr-sherpa --test bidi_sherpa_audio`.
//! Skipped gracefully when the model files are absent.
#![cfg(feature = "asr-sherpa")]

use amos_proto::ai_agent::{
    ai_agent_client::AiAgentClient, client_message::Payload, ClientMessage,
};
use std::path::PathBuf;
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

fn audio(bytes: &[u8]) -> ClientMessage {
    ClientMessage {
        payload: Some(Payload::Audio(bytes.to_vec())),
    }
}

fn model_dir() -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models/sherpa-en-20m");
    p.join("tokens.txt").exists().then_some(p)
}

async fn connect(
    path: &std::path::Path,
) -> Result<AiAgentClient<tonic::transport::Channel>, String> {
    let owned = path.to_owned();
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| e.to_string())?;
    let channel = endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| e.to_string())?;
    Ok(AiAgentClient::new(channel))
}

/// Collect chunks until the done frame (bounded by a hard timeout so a stalled
/// endpoint can never hang the suite). Returns the concatenated reply.
async fn collect_until_done_or_timeout(
    stream: &mut tonic::Streaming<amos_proto::ai_agent::AgentChunk>,
    timeout: std::time::Duration,
) -> (String, bool) {
    let mut full = String::new();
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return (full, false),
            msg = stream.message() => {
                match msg {
                    Ok(Some(chunk)) => {
                        if !chunk.token.is_empty() {
                            full.push_str(&chunk.token);
                        }
                        if chunk.done {
                            return (full, true);
                        }
                    }
                    _ => return (full, false),
                }
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn bidi_audio_runs_real_sherpa_asr() {
    let Some(dir) = model_dir() else {
        eprintln!("skip: sherpa model files not present");
        return;
    };

    // Read + decode the demo clip (mono 16k). Its transcript contains "YELLOW
    // LAMPS"; sherpa returns it upper-cased.
    let bytes = std::fs::read(dir.join("test_wavs/0.wav")).expect("demo wav readable");
    let (_rate, samples) = amos_asr::sherpa::decode_pcm16_wav(&bytes).expect("wav decodes to PCM");
    assert!(!samples.is_empty(), "wav has audio");

    // Configure the daemon to use the real local sherpa recognizer.
    std::env::set_var("AMOS_ASR_BACKEND", "sherpa");
    std::env::set_var("AMOS_SHERPA_MODEL_DIR", &dir);

    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-bidi-sherpa-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });
    // Wait for the socket to appear.
    for _ in 0..100 {
        if path.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    let mut client = connect(&path).await.expect("connect");
    let (tx, rx) = mpsc::channel(512);
    let mut stream = client
        .chat(ReceiverStream::new(rx))
        .await
        .expect("open bidi chat")
        .into_inner();

    // Push the whole utterance as 400 ms (6400 sample) wire frames...
    for chunk in samples.chunks(6400) {
        tx.send(audio(&f32le(chunk)))
            .await
            .expect("send audio frame");
    }
    // ...then ~4 s of trailing silence. sherpa's decoder asserts on sub-400 ms
    // chunks, so keep 6400-sample (400 ms) frames but send enough of them that
    // the default 2.4 s trailing-silence endpoint is crossed while we are still
    // sending — guaranteeing a frame lands after the boundary.
    for _ in 0..10 {
        let silence = vec![0.0f32; 6400];
        tx.send(audio(&f32le(&silence)))
            .await
            .expect("send silence");
    }

    let (full, done) =
        collect_until_done_or_timeout(&mut stream, std::time::Duration::from_secs(60)).await;
    server.abort();
    let _ = std::fs::remove_file(&path);

    assert!(
        done,
        "audio turn must terminate with a done frame (recognized then answered); got: {full:?}"
    );
    assert!(
        full.to_uppercase().contains("YELLOW"),
        "reply should reference the recognized transcript; got: {full:?}"
    );
}

fn f32le(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

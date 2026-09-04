//! Headless e2e for the assistant **resident voice** streaming link: run a real
//! `amos-ai` daemon (mock ASR) over UDS, open a `VoiceLink` (the exact core the
//! System UI's `assistant_voice_*` commands use), capture from an
//! `amos-audio` 48 kHz source, down-sample to 16 kHz, encode as little-endian
//! f32 `Payload::Audio` and push it — then assert the recognized utterance
//! comes back as an answered turn. No Tauri app, no GUI/WebView.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use amos_ai::server::AiAgentService;
use amos_audio::mock::{FrameMic, SineMic};
use amos_audio::resample::LinearDownsampler;
use amos_audio::spec::encode_f32_le;
use amos_audio::AudioCapture;
use amos_proto::ai_agent::ai_agent_server::AiAgentServer;
use amos_tauri_lib::ai_bridge::AiBridge;
use amos_tauri_lib::assistant_voice::{has_signal, VoiceEvent, VoiceLink};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnixListenerStream;

/// Start a real AI daemon (deterministic mock backend) on a UDS.
async fn spawn_ai_daemon(path: &PathBuf) -> tokio::task::JoinHandle<()> {
    let listener = tokio::net::UnixListener::bind(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let svc = AiAgentService::new().await;
    tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(AiAgentServer::new(svc))
            .serve_with_incoming(UnixListenerStream::new(listener))
            .await
            .unwrap();
    })
}

/// Collect voice events until a predicate matches (bounded so a stall can never
/// hang the suite). Returns whether it matched.
async fn wait_for_event(
    rx: &mut mpsc::Receiver<VoiceEvent>,
    what: impl Fn(&VoiceEvent) -> bool,
) -> Option<VoiceEvent> {
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(15));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return None,
            ev = rx.recv() => match ev {
                Some(e) if what(&e) => return Some(e),
                Some(_) => continue,
                None => return None,
            },
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn resident_voice_streams_audio_and_gets_answered() {
    let _env = ENV_LOCK
        .get_or_init(|| async { tokio::sync::Mutex::new(()) })
        .await
        .lock()
        .await;
    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-tauri-voice-e2e-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    // Point the bridge's UDS client at this daemon (resolved from env on connect).
    std::env::set_var("AMOS_SOCKET", &path);
    std::env::set_var("AMOS_BACKEND", "mock");

    let daemon = spawn_ai_daemon(&path).await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    let bridge = AiBridge::new();

    // A 48 kHz mic the VoiceLink will stream (down-sampled to 16 kHz on the fly).
    let mut mic = SineMic::new(48_000, 440.0).with_total_samples(4_800); // 0.1 s
    let mut downsample = LinearDownsampler::new(48_000, 16_000).expect("48k -> 16k");
    let mut wire = Vec::new();
    let mut buf = [0.0f32; 480];
    loop {
        let n = mic.read(&mut buf).expect("mock mic read");
        if n == 0 {
            break;
        }
        let out = downsample.process(&buf[..n]).expect("resample");
        wire.extend_from_slice(&encode_f32_le(&out));
    }
    // ≥640 samples at 16 kHz reaches the mock recognizer's endpoint.
    assert!(
        wire.len() / 4 >= 640,
        "mock utterance long enough: {}",
        wire.len() / 4
    );

    // Open the resident voice link (no prompt) and stream the audio.
    let (ev_tx, mut ev_rx) = mpsc::channel(64);
    let emit = move |e: VoiceEvent| {
        let _ = ev_tx.try_send(e);
    };
    let link = VoiceLink::open(&bridge, "voice-e2e".into(), emit)
        .await
        .expect("open voice chat stream");

    // Confirm the stream is up, then push the (16 kHz f32-le) audio frame.
    wait_for_event(&mut ev_rx, |e| matches!(e, VoiceEvent::Listening { .. }))
        .await
        .expect("stream reports listening");
    link.feed_bytes(wire).await.expect("feed audio frame");

    // The daemon recognizes "你好，Amos" (mock) and answers; assert the reply
    // references the recognized phrase.
    let done = wait_for_event(&mut ev_rx, |e| matches!(e, VoiceEvent::TurnDone { .. }))
        .await
        .expect("an answered turn arrives");
    if let VoiceEvent::TurnDone { text, .. } = done {
        assert!(
            text.contains("Amos"),
            "reply should reference the recognized phrase; got: {text:?}"
        );
    } else {
        unreachable!("matched TurnDone");
    }

    link.stop().await;
    daemon.abort();
    let _ = std::fs::remove_file(&path);
}

/// Count assistant `TurnDone` events until `need` arrive (or a bounded timeout),
/// returning how many were seen. Used to prove a single resident stream carries
/// multiple successive voice turns.
async fn wait_for_n_turns(rx: &mut mpsc::Receiver<VoiceEvent>, need: usize) -> usize {
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(30));
    tokio::pin!(deadline);
    let mut seen = 0usize;
    loop {
        if seen >= need {
            return seen;
        }
        tokio::select! {
            _ = &mut deadline => return seen,
            ev = rx.recv() => match ev {
                Some(VoiceEvent::TurnDone { .. }) => seen += 1,
                Some(_) => continue,
                None => return seen,
            },
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn resident_stream_answers_multiple_successive_utterances() {
    let _env = ENV_LOCK
        .get_or_init(|| async { tokio::sync::Mutex::new(()) })
        .await
        .lock()
        .await;
    let path: PathBuf = std::env::temp_dir().join(format!(
        "amos-tauri-voice-multi-{}.sock",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);

    std::env::set_var("AMOS_SOCKET", &path);
    std::env::set_var("AMOS_BACKEND", "mock");

    let daemon = spawn_ai_daemon(&path).await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let bridge = AiBridge::new();

    // A synthetic 16 kHz "mic": two short speech bursts (<640 samples so the
    // mock recognizer never auto-finalizes on its own) separated by silence. The
    // client segments each burst with its own energy gate and submits it via
    // `AudioEnd`, so exactly the client decides the two utterance boundaries.
    let speech = vec![0.5f32; 320]; // 20 ms @16k
    let gap = vec![0.0f32; 4800]; // 300 ms @16k
    let mut clip = Vec::new();
    clip.extend_from_slice(&speech);
    clip.extend_from_slice(&gap);
    clip.extend_from_slice(&speech);
    let mut mic = FrameMic::new(16_000, clip);

    let (ev_tx, mut ev_rx) = mpsc::channel(128);
    let emit = move |e: VoiceEvent| {
        let _ = ev_tx.try_send(e);
    };
    let link = VoiceLink::open(&bridge, "voice-multi".into(), emit)
        .await
        .expect("open voice chat stream");

    // Drive the resident loop. Feed the recognizer only the *speech* frames (so
    // the mock's sample-count endpoint never pre-empts the client's boundary);
    // when a speech burst is followed by enough silence, submit it (AudioEnd)
    // and keep listening for the next burst on the same stream.
    let mut chunk = [0.0f32; 160];
    let end_gap_chunks = 10usize; // 100 ms of read silence @ 10 ms/frame
    let mut heard = false;
    let mut silent = 0usize;
    loop {
        let n = mic.read(&mut chunk).expect("mock mic read");
        if n == 0 {
            break;
        }
        let frame = &chunk[..n];
        if has_signal(frame, 0.01) {
            link.feed_bytes(encode_f32_le(frame))
                .await
                .expect("feed audio");
            heard = true;
            silent = 0;
        } else if heard {
            silent += 1;
            if silent >= end_gap_chunks {
                // End of this utterance: force-finalize so the daemon answers.
                link.finish_turn().await.expect("submit utterance");
                heard = false;
                silent = 0;
            }
        }
    }
    // If the trailing silence never crossed the gate, submit any last speech.
    if heard {
        link.finish_turn().await.expect("submit trailing utterance");
    }

    // Both speech bursts must each produce an answered turn on this one stream.
    let answered = wait_for_n_turns(&mut ev_rx, 2).await;
    link.stop().await;
    daemon.abort();
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        answered, 2,
        "a single resident stream should answer both utterances, got {answered}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn resident_thread_submits_and_answers_two_utterances() {
    let _env = ENV_LOCK
        .get_or_init(|| async { tokio::sync::Mutex::new(()) })
        .await
        .lock()
        .await;
    let path: PathBuf = std::env::temp_dir().join(format!(
        "amos-tauri-voice-thread-{}.sock",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);

    std::env::set_var("AMOS_SOCKET", &path);
    std::env::set_var("AMOS_BACKEND", "mock");

    let daemon = spawn_ai_daemon(&path).await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let bridge = AiBridge::new();

    // Two short (<640-sample) speech bursts so only the resident thread's own
    // AudioEnd boundaries (not the mock's sample-count endpoint) finalize turns.
    let mut clip = Vec::new();
    clip.extend_from_slice(&vec![0.5f32; 320]); // 20 ms speech
    clip.extend_from_slice(&vec![0.0f32; 4800]); // 300 ms silence
    clip.extend_from_slice(&vec![0.5f32; 320]); // 20 ms speech

    let (ev_tx, mut ev_rx) = mpsc::channel(128);
    let emit = move |e: VoiceEvent| {
        let _ = ev_tx.try_send(e);
    };
    let link = VoiceLink::open(&bridge, "voice-thread".into(), emit)
        .await
        .expect("open voice chat stream");

    // Spawn the official resident thread (this is the worker a device AAudio
    // capture would feed): it streams + segments + submits each utterance.
    let handle = link
        .spawn_resident(FrameMic::new(16_000, clip), 16_000, 10, false)
        .expect("spawn resident capture thread");

    let answered = wait_for_n_turns(&mut ev_rx, 2).await;
    handle.stop(); // join the finite-capture worker
    daemon.abort();
    let _ = std::fs::remove_file(&path);

    assert_eq!(
        answered, 2,
        "resident thread should drive both utterances to an answer, got {answered}"
    );
}

/// Serialize the env-mutating tests below: they point the bridge at a per-test
/// daemon by setting the process-wide `AMOS_SOCKET`/`AMOS_BACKEND`. The harness
/// runs them in parallel threads of one process, so without a shared lock they
/// would overwrite each other's env and connect to the wrong daemon.
static ENV_LOCK: tokio::sync::OnceCell<tokio::sync::Mutex<()>> = tokio::sync::OnceCell::const_new();

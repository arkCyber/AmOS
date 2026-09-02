//! End-to-end test of the `amos-translate` daemon over a real Unix Domain
//! Socket: starts the server with a mock provider and drives `Translate` /
//! `StreamTranslate` / `GetStatus` through a tonic client.

use amos_proto::translate::{
    translate_in, translator_client::TranslatorClient, StatusRequest, TranslateIn, TranslateRequest,
};
use std::path::PathBuf;
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

async fn connect(
    path: &std::path::Path,
) -> Result<TranslatorClient<tonic::transport::Channel>, String> {
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
    Ok(TranslatorClient::new(channel))
}

async fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..80 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

fn text_seg(s: &str) -> TranslateIn {
    TranslateIn {
        payload: Some(translate_in::Payload::Text(s.to_string())),
    }
}

fn audio_seg(len: usize) -> TranslateIn {
    TranslateIn {
        payload: Some(translate_in::Payload::Audio(vec![0u8; len])),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn translate_and_stream_over_uds() {
    // Use the deterministic mock provider (never touches real Ollama).
    std::env::set_var("AMOS_TRANSLATE_BACKEND", "mock");

    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-translate-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    // Start the daemon with the mock provider (deterministic).
    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_translate::serve(server_path).await.unwrap();
    });
    wait_for_socket(&path).await;

    let mut client = connect(&path).await.expect("connect");

    // Unary translate.
    let resp = client
        .translate(TranslateRequest {
            text: "hello".into(),
            source_lang: "en".into(),
            target_lang: "zh".into(),
        })
        .await
        .expect("translate")
        .into_inner();
    assert_eq!(resp.translated, "[译](en->zh)hello");

    // Status probe.
    let status = client
        .get_status(StatusRequest {})
        .await
        .expect("get_status")
        .into_inner();
    assert!(status.running);
    assert_eq!(status.model, "mock-translator");

    // Bidirectional streaming: two text segments then an audio frame.
    let (tx, rx) = mpsc::channel(16);
    let mut stream = client
        .stream_translate(ReceiverStream::new(rx))
        .await
        .expect("open stream translate")
        .into_inner();
    tx.send(text_seg("one")).await.unwrap();
    tx.send(text_seg("two")).await.unwrap();
    tx.send(audio_seg(8)).await.unwrap();
    drop(tx);

    let mut segments = Vec::new();
    let mut done = false;
    while let Ok(Some(out)) = stream.message().await {
        if !out.segment.is_empty() {
            segments.push(out.segment);
        }
        if out.done {
            done = true;
            break;
        }
    }
    assert!(done, "stream should terminate with done");
    assert_eq!(segments[0], "[译](auto->zh)one");
    assert_eq!(segments[1], "[译](auto->zh)two");
    assert!(
        segments[2].contains("ASR 未接入"),
        "audio frame acknowledged"
    );

    server.abort();
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread")]
async fn transcribe_over_uds_with_recognizer() {
    use amos_proto::translate::translator_server::TranslatorServer;
    use amos_proto::translate::TranscribeRequest;
    use amos_translate::asr::MockRecognizer;
    use amos_translate::provider::MockProvider;
    use amos_translate::TranslateConfig;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;
    use tokio_stream::wrappers::UnixListenerStream;

    let path: PathBuf =
        std::env::temp_dir().join(format!("amos-transcribe-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    // Deterministic daemon: mock provider + mock recognizer, no env dependence.
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let svc = amos_translate::TranslatorService::new(
        Arc::new(MockProvider::default()),
        TranslateConfig::default(),
    )
    .with_recognizer(Arc::new(MockRecognizer::default()));
    let server = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(TranslatorServer::new(svc))
            .serve_with_incoming(UnixListenerStream::new(listener))
            .await
            .unwrap();
    });
    wait_for_socket(&path).await;

    let mut client = connect(&path).await.expect("connect");
    let resp = client
        .transcribe(TranscribeRequest {
            audio: vec![0u8; 8],
            language: "zh".into(),
            format: "wav".into(),
        })
        .await
        .expect("transcribe")
        .into_inner();
    assert!(
        resp.recognized,
        "recognizer should mark transcription recognized"
    );
    assert_eq!(resp.text, "语音转写(模拟)(lang=zh,fmt=wav)");

    server.abort();
    let _ = std::fs::remove_file(&path);
}

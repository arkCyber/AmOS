//! `translate_once` — live smoke against a *running* amos-translate daemon.
//!
//! Connects to a daemon's Unix Domain Socket, sends one real `Translate` RPC and
//! prints the translated text — a quick way to prove the full chain
//! (CLI → daemon → provider → Ollama) works end to end without the GUI.
//!
//! Usage:
//!   cargo run -p amos-translate --example translate_once -- \
//!       /tmp/amos-translate.sock "Hello world" en zh
//! (source/target optional — daemon defaults to auto→zh.)

use std::path::PathBuf;

use amos_proto::translate::translator_client::TranslatorClient;
use amos_proto::translate::TranslateRequest;
use anyhow::{anyhow, Context, Result};
use hyper_util::rt::TokioIo;
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

/// Build a tonic channel that tunnels gRPC over a Unix Domain Socket.
async fn uds_channel(socket: PathBuf) -> Result<tonic::transport::Channel> {
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| anyhow!(e.to_string()))?;
    endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let socket = socket.clone();
            async move {
                let stream = UnixStream::connect(socket).await?;
                Ok::<_, std::io::Error>(TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| anyhow!("daemon not reachable at socket: {e}"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let socket = args
        .first()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("usage: translate_once <socket> <text> [source] [target]"))?;
    let text = args
        .get(1)
        .context("text to translate is required")?
        .to_string();
    let source = args.get(2).cloned().unwrap_or_default();
    let target = args.get(3).cloned().unwrap_or_default();

    let mut client = TranslatorClient::new(uds_channel(socket).await?);
    let resp = client
        .translate(tonic::Request::new(TranslateRequest {
            text,
            source_lang: source,
            target_lang: target,
        }))
        .await
        .map_err(|e| anyhow!("translate RPC failed: {e}"))?
        .into_inner();

    println!("{}", resp.translated);
    if !resp.detected_lang.is_empty() {
        eprintln!("detected_lang={}", resp.detected_lang);
    }
    Ok(())
}

//! gRPC service implementation served over a Unix Domain Socket.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use amos_proto::ai_agent::{
    ai_agent_server::{AiAgent, AiAgentServer},
    AgentChunk, AgentRequest, ClientMessage, StatusReply, StatusRequest,
};
use anyhow::Context;
use tokio::sync::mpsc;
use tokio_stream::wrappers::{ReceiverStream, UnixListenerStream};
use tonic::{Request, Response, Status, Streaming};

/// The AiAgent service implementation backed by the (mock) inference engine.
pub struct AiAgentService {
    model: &'static str,
    start: Instant,
    /// Number of in-flight generation sessions (for `get_status`).
    active_sessions: Arc<AtomicUsize>,
}

impl Default for AiAgentService {
    fn default() -> Self {
        Self::new()
    }
}

impl AiAgentService {
    pub fn new() -> Self {
        Self {
            model: "amos-infer@0.1.0",
            start: Instant::now(),
            active_sessions: Arc::new(AtomicUsize::new(0)),
        }
    }
}

#[tonic::async_trait]
impl AiAgent for AiAgentService {
    type StreamChatStream = ReceiverStream<Result<AgentChunk, Status>>;

    async fn stream_chat(
        &self,
        request: Request<AgentRequest>,
    ) -> Result<Response<Self::StreamChatStream>, Status> {
        let req = request.into_inner();
        tracing::info!(session = %req.session_id, "stream_chat start");

        self.active_sessions.fetch_add(1, Ordering::SeqCst);
        let active = self.active_sessions.clone();

        let (tx, rx) = mpsc::channel(64);
        let session_id = req.session_id.clone();
        let tokens = crate::inference::mock_tokens(&req.prompt);

        tokio::spawn(async move {
            for token in tokens {
                let chunk = AgentChunk {
                    session_id: session_id.clone(),
                    token,
                    done: false,
                    error: String::new(),
                };
                if tx.send(Ok(chunk)).await.is_err() {
                    // Client disconnected; stop generating.
                    active.fetch_sub(1, Ordering::SeqCst);
                    return;
                }
                tokio::time::sleep(crate::inference::TOKEN_INTERVAL).await;
            }
            let final_frame = AgentChunk {
                session_id,
                token: String::new(),
                done: true,
                error: String::new(),
            };
            let _ = tx.send(Ok(final_frame)).await;
            active.fetch_sub(1, Ordering::SeqCst);
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    type ChatStream = ReceiverStream<Result<AgentChunk, Status>>;

    async fn chat(
        &self,
        request: Request<Streaming<ClientMessage>>,
    ) -> Result<Response<Self::ChatStream>, Status> {
        let mut inbound = request.into_inner();
        self.active_sessions.fetch_add(1, Ordering::SeqCst);
        let active = self.active_sessions.clone();
        let (tx, rx) = mpsc::channel(64);

        tokio::spawn(async move {
            // Reader task: forward every inbound message to a local channel so the
            // token loop can detect a `Cancel` *mid-generation* without losing a
            // queued follow-up message.
            let (in_tx, mut in_rx) = mpsc::channel(64);
            let forward = tokio::spawn(async move {
                while let Ok(Some(m)) = inbound.message().await {
                    if in_tx.send(m).await.is_err() {
                        break;
                    }
                }
            });

            // A follow-up message buffered while the previous turn was streaming.
            let mut pending: Option<ClientMessage> = None;

            'outer: loop {
                let msg = if let Some(m) = pending.take() {
                    m
                } else {
                    match in_rx.recv().await {
                        Some(m) => m,
                        None => break, // client closed the outbound half
                    }
                };

                match msg.payload {
                    Some(amos_proto::ai_agent::client_message::Payload::Prompt(p)) => {
                        let tokens = crate::inference::mock_tokens(&p);
                        let mut cancelled = false;
                        for token in tokens {
                            let send_fut = tx.send(Ok(AgentChunk {
                                session_id: String::new(),
                                token,
                                done: false,
                                error: String::new(),
                            }));
                            tokio::select! {
                                r = send_fut => {
                                    if r.is_err() {
                                        // Client disconnected; stop generating.
                                        active.fetch_sub(1, Ordering::SeqCst);
                                        return;
                                    }
                                }
                                maybe = in_rx.recv() => match maybe {
                                    Some(ClientMessage {
                                        payload: Some(
                                            amos_proto::ai_agent::client_message::Payload::Cancel(_),
                                        ),
                                        ..
                                    }) => cancelled = true,
                                    // Buffer any other mid-stream message (e.g. a
                                    // follow-up prompt) for the next turn.
                                    other => pending = other,
                                },
                            }
                            if cancelled {
                                break;
                            }
                            tokio::time::sleep(crate::inference::TOKEN_INTERVAL).await;
                        }
                        if cancelled {
                            // Cancel arrived mid-generation: end the whole stream
                            // without a done frame.
                            break 'outer;
                        }
                        let _ = tx
                            .send(Ok(AgentChunk {
                                session_id: String::new(),
                                token: String::new(),
                                done: true,
                                error: String::new(),
                            }))
                            .await;
                    }
                    Some(amos_proto::ai_agent::client_message::Payload::Audio(audio)) => {
                        // Voice input: ASR isn't wired yet, so acknowledge honestly
                        // instead of silently swallowing the frame.
                        let note = format!(
                            "[语音] 收到 {} 字节音频，ASR 尚未接入，请改用文本输入。",
                            audio.len()
                        );
                        for token in crate::inference::mock_tokens(&note) {
                            if tx
                                .send(Ok(AgentChunk {
                                    session_id: String::new(),
                                    token,
                                    done: false,
                                    error: String::new(),
                                }))
                                .await
                                .is_err()
                            {
                                active.fetch_sub(1, Ordering::SeqCst);
                                return;
                            }
                            tokio::time::sleep(crate::inference::TOKEN_INTERVAL).await;
                        }
                        let _ = tx
                            .send(Ok(AgentChunk {
                                session_id: String::new(),
                                token: String::new(),
                                done: true,
                                error: String::new(),
                            }))
                            .await;
                    }
                    Some(amos_proto::ai_agent::client_message::Payload::Cancel(_)) => {
                        break 'outer;
                    }
                    None => {}
                }
            }
            active.fetch_sub(1, Ordering::SeqCst);
            forward.abort();
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn get_status(
        &self,
        _request: Request<StatusRequest>,
    ) -> Result<Response<StatusReply>, Status> {
        Ok(Response::new(StatusReply {
            running: true,
            model: self.model.to_string(),
            uptime_seconds: self.start.elapsed().as_secs() as i64,
            gpu_util: 0,
            active_sessions: self.active_sessions.load(Ordering::SeqCst) as u32,
        }))
    }
}

/// Bind the UDS, harden its permissions, and run the tonic server until a
/// shutdown signal arrives, then clean up the socket file.
pub async fn serve(path: std::path::PathBuf) -> anyhow::Result<()> {
    let listener = tokio::net::UnixListener::bind(&path)?;

    // Restrict access: only the owning OS user may connect to the daemon.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .context("failed to harden socket permissions")?;
    }

    let incoming = UnixListenerStream::new(listener);
    // The single UDS serves BOTH gRPC services: the AI agent and the Android
    // compat layer, so Tauri talks to the whole OS backend over one connection.
    // The runtime is auto-selected: real Waydroid on device, in-process demo
    // elsewhere (so the whole pipeline works on any host).
    let server = tonic::transport::Server::builder()
        .add_service(AiAgentServer::new(AiAgentService::new()))
        .add_service(amos_android::service::server(amos_android::auto()))
        .serve_with_incoming(incoming);

    tokio::select! {
        result = server => { result?; }
        _ = shutdown_signal() => {
            tracing::info!("shutdown signal received");
        }
    }

    // Remove the socket file so a stale one never blocks the next bind.
    let _ = std::fs::remove_file(&path);
    Ok(())
}

/// Resolves on SIGINT, SIGTERM, or Ctrl-C so the daemon can exit cleanly.
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("install SIGINT handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn session_counter_round_trips() {
        let svc = AiAgentService::new();
        assert_eq!(svc.active_sessions.load(Ordering::SeqCst), 0);
        svc.active_sessions.fetch_add(1, Ordering::SeqCst);
        assert_eq!(svc.active_sessions.load(Ordering::SeqCst), 1);
        svc.active_sessions.fetch_sub(1, Ordering::SeqCst);
        assert_eq!(svc.active_sessions.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn status_reports_running_and_model() {
        let svc = AiAgentService::new();
        let reply = svc
            .get_status(Request::new(StatusRequest {}))
            .await
            .expect("status")
            .into_inner();
        assert!(reply.running);
        assert!(!reply.model.is_empty());
        assert_eq!(reply.active_sessions, 0);
    }
}

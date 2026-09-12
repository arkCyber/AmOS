//! Client-side half of the daemon's TCP shared secret (gap #28 / REQ-A144).
//!
//! Why this test exists: R79 added the daemon-side gate (`x-amos-token`, REQ-A142) and
//! *recorded* that the shell's own TCP client (`amos_tauri_lib::daemon`) did not yet
//! present it — so a daemon started with `AMOS_TCP_TOKEN` would have answered every
//! System-UI RPC with `PermissionDenied`. This boots the real `amos-ai` daemon and drives
//! it through the shell's **real** channel factory, with no manual header anywhere:
//!   • token configured ⇒ `daemon::channel()` is served (the channel attached it);
//!   • same client, token not configured ⇒ `PermissionDenied` — i.e. phase 1 passed
//!     *because of the header*, not because the server was lenient;
//!   • a wrong token ⇒ `PermissionDenied` (the gate is not "any header will do");
//!   • a UDS daemon with `AMOS_TCP_TOKEN` still set ⇒ served, because the token belongs to
//!     the TCP transport only (an unrelated env var must not lock the shell out).
//!
//! Own test binary (its own process): the phases set process-wide env vars and must run
//! in order, and a parallel test could otherwise observe another phase's policy.
//!
//! Honest scope: this proves the *token plumbing* end to end. It does not claim transport
//! security (plaintext h2c, no TLS), and the token remains optional — with none
//! configured the daemon is unauthenticated by explicit choice.

use amos_proto::ai_agent::ai_agent_client::AiAgentClient;
use amos_proto::ai_agent::StatusRequest;
use amos_tauri_lib::daemon::{channel, DaemonChannel};
use std::net::SocketAddr;
use std::path::PathBuf;
use tokio::net::TcpStream;
use tonic::Request;

const SECRET: &str = "client-e2e-secret";

/// A free loopback port (bind + drop; the daemon then binds it).
fn free_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").expect("probe bind");
    l.local_addr().expect("local addr").port()
}

async fn wait_for_tcp(addr: SocketAddr) {
    for _ in 0..200 {
        if TcpStream::connect(addr).await.is_ok() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("daemon never accepted a tcp connection at {addr}");
}

fn socket_arg(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("amos-tauri-tok-{tag}-{}.sock", std::process::id()))
}

/// One `get_status` through a **fresh** channel from the shell's own factory — fresh so each
/// phase observes the env vars as they are *now* (the factory reads them per call, but the
/// typed client must be rebuilt around the new channel).
async fn status_via_shell_channel() -> Result<(), tonic::Status> {
    let ch: DaemonChannel = channel().await.expect("channel from the shell's factory");
    let mut client = AiAgentClient::new(ch);
    client
        .get_status(Request::new(StatusRequest {}))
        .await
        .map(|_| ())
}

#[tokio::test(flavor = "multi_thread")]
async fn the_shells_own_tcp_client_presents_the_shared_secret() {
    std::env::set_var("AMOS_BACKEND", "mock");

    // ---- phase 1: token configured on both sides ⇒ the shell's channel is served ------
    let port = free_port();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().expect("addr");
    std::env::set_var("AMOS_TCP_ADDR", addr.to_string());
    std::env::set_var("AMOS_TCP_TOKEN", SECRET);
    let server =
        tokio::spawn(
            async move { amos_ai::server::serve_with_log_sink(socket_arg("tcp"), None).await },
        );
    wait_for_tcp(addr).await;

    status_via_shell_channel()
        .await
        .expect("the shell's own TCP client presents x-amos-token and is served");

    // ---- phase 2: the same client with no token configured ⇒ refused ------------------
    // Nothing else changed: the daemon still requires the secret, so this failure is
    // evidence that phase 1 succeeded *because the channel attached the header*.
    std::env::remove_var("AMOS_TCP_TOKEN");
    let denied = status_via_shell_channel()
        .await
        .expect_err("without a configured token the shell must be refused");
    assert_eq!(
        denied.code(),
        tonic::Code::PermissionDenied,
        "absent token ⇒ PermissionDenied (got {denied:?})"
    );

    // ---- phase 3: a wrong token is not good enough either ----------------------------
    std::env::set_var("AMOS_TCP_TOKEN", "not-the-secret");
    let denied = status_via_shell_channel()
        .await
        .expect_err("a wrong token must be refused");
    assert_eq!(denied.code(), tonic::Code::PermissionDenied);
    std::env::remove_var("AMOS_TCP_TOKEN");

    server.abort();
    std::env::remove_var("AMOS_TCP_ADDR");
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // ---- phase 4: UDS ignores the token ⇒ a stray AMOS_TCP_TOKEN must not lock us out --
    let path = socket_arg("uds");
    let _ = std::fs::remove_file(&path);
    std::env::set_var("AMOS_SOCKET", &path);
    std::env::set_var("AMOS_TCP_TOKEN", SECRET); // deliberately left set
    let uds_server = tokio::spawn({
        let path = path.clone();
        async move { amos_ai::server::serve_with_log_sink(path, None).await }
    });
    // Wait for the socket file to exist and accept.
    for _ in 0..200 {
        if std::path::Path::new(&path).exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    status_via_shell_channel()
        .await
        .expect("the UDS transport is covered by peer credentials, not the token");

    uds_server.abort();
    std::env::remove_var("AMOS_TCP_TOKEN");
    std::env::remove_var("AMOS_SOCKET");
    let _ = std::fs::remove_file(&path);
}

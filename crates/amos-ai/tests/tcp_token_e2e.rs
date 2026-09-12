//! Daemon e2e: the **TCP transport's** shared-secret gate (gap #28 / REQ-A142).
//!
//! Why this test exists: the UDS transport is protected twice (a 0700 socket file plus
//! the kernel's peer-credential check), but `AMOS_TCP_ADDR` switches the daemon to
//! loopback TCP — reachable by *every* process on the device. This boots the real
//! daemon over TCP and proves the gate at the wire level:
//!   • with `AMOS_TCP_TOKEN` set, a request without the token is refused with
//!     `PermissionDenied`, and the same request *with* the token is served;
//!   • with no token configured, the daemon serves (the documented bring-up flow) —
//!     i.e. the unauthenticated case is a visible choice, not an accident;
//!   • a non-loopback `AMOS_TCP_ADDR` makes the daemon refuse to start at all.
//!
//! Own test binary (its own process) because the phases set process-wide env vars and
//! run sequentially: a parallel test could otherwise observe another phase's policy.
//!
//! Honest scope: this proves the token plumbing and the address policy. It does **not**
//! claim transport security (plaintext h2c, no TLS), and the token stays optional.

use amos_ai::tcp_auth::TOKEN_HEADER;
use amos_proto::ai_agent::ai_agent_client::AiAgentClient;
use amos_proto::ai_agent::StatusRequest;
use std::net::SocketAddr;
use std::path::PathBuf;
use tokio::net::TcpStream;
use tonic::transport::{Channel, Endpoint};
use tonic::Request;

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

async fn client(addr: SocketAddr) -> AiAgentClient<Channel> {
    let channel = Endpoint::try_from(format!("http://{addr}"))
        .expect("endpoint")
        .connect()
        .await
        .expect("tcp connect to the daemon");
    AiAgentClient::new(channel)
}

/// `get_status` with (optionally) the shared secret attached.
async fn status(c: &mut AiAgentClient<Channel>, token: Option<&str>) -> Result<(), tonic::Status> {
    let mut req = Request::new(StatusRequest {});
    if let Some(t) = token {
        req.metadata_mut()
            .insert(TOKEN_HEADER, t.parse().expect("metadata value"));
    }
    c.get_status(req).await.map(|_| ())
}

fn socket_arg(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("amos-ai-tcp-{tag}-{}.sock", std::process::id()))
}

#[tokio::test(flavor = "multi_thread")]
async fn tcp_transport_enforces_the_shared_secret_and_refuses_a_lan_bind() {
    // ---- phase 1: a token is configured ⇒ it is required -------------------------
    let port1 = free_port();
    let addr1: SocketAddr = format!("127.0.0.1:{port1}").parse().expect("addr");
    std::env::set_var("AMOS_TCP_ADDR", addr1.to_string());
    std::env::set_var("AMOS_TCP_TOKEN", "e2e-secret");
    let server1 =
        tokio::spawn(
            async move { amos_ai::server::serve_with_log_sink(socket_arg("tok"), None).await },
        );
    wait_for_tcp(addr1).await;

    let mut c = client(addr1).await;
    let denied = status(&mut c, None)
        .await
        .expect_err("no token must be refused");
    assert_eq!(
        denied.code(),
        tonic::Code::PermissionDenied,
        "absent token ⇒ PermissionDenied (got {denied:?})"
    );
    let wrong = status(&mut c, Some("not-the-secret"))
        .await
        .expect_err("a wrong token must be refused");
    assert_eq!(wrong.code(), tonic::Code::PermissionDenied);
    status(&mut c, Some("e2e-secret"))
        .await
        .expect("the right token is served");

    server1.abort();
    std::env::remove_var("AMOS_TCP_TOKEN");
    // Let the port settle before the next phase binds its own.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // ---- phase 2: no token ⇒ served, but that is the documented open case ---------
    let port2 = free_port();
    let addr2: SocketAddr = format!("127.0.0.1:{port2}").parse().expect("addr");
    std::env::set_var("AMOS_TCP_ADDR", addr2.to_string());
    let server2 = tokio::spawn(async move {
        amos_ai::server::serve_with_log_sink(socket_arg("open"), None).await
    });
    wait_for_tcp(addr2).await;
    let mut c2 = client(addr2).await;
    status(&mut c2, None)
        .await
        .expect("with no token configured the transport is open (warned at startup)");
    server2.abort();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // ---- phase 3: a non-loopback bind never starts --------------------------------
    std::env::set_var("AMOS_TCP_ADDR", "0.0.0.0:19999");
    let err = amos_ai::server::serve_with_log_sink(socket_arg("lan"), None)
        .await
        .expect_err("a LAN bind must be refused");
    assert!(
        err.to_string().contains("loopback") || err.to_string().contains("AMOS_TCP_ALLOW_REMOTE"),
        "the refusal must explain itself: {err}"
    );
    std::env::remove_var("AMOS_TCP_ADDR");

    // ---- and a malformed value is an error, not a silent socket fallback ----------
    std::env::set_var("AMOS_TCP_ADDR", "127.0.0.1");
    let err = amos_ai::server::serve_with_log_sink(socket_arg("bad"), None)
        .await
        .expect_err("a malformed AMOS_TCP_ADDR must fail loudly");
    assert!(err.to_string().contains("AMOS_TCP_ADDR"), "{err}");
    std::env::remove_var("AMOS_TCP_ADDR");
}

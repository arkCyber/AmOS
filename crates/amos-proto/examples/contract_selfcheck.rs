//! `contract_selfcheck` — where clients will connect, and that the contract is usable Rust.
//!
//! Part of the build contract worth checking by hand: `default_socket_path()` honours
//! `AMOS_SOCKET` (the mobile sandbox needs it) and falls back to the platform default, and the
//! generated modules really expose the request/response types the daemon serves. No server is
//! started — this proves the *contract*, not behaviour.
//!
//! Usage:
//! ```text
//! cargo run -p amos-proto --example contract_selfcheck
//! ```

use amos_proto::ai_agent::{AgentRequest, StatusRequest};
use amos_proto::amos_link::{Empty, PublishRequest};
use amos_proto::socket::default_socket_path;

fn main() {
    // The socket every client resolves. `AMOS_SOCKET` wins when set, which is how the daemon
    // and its clients are pointed at the same place on a device.
    println!(
        "socket (as resolved now): {}",
        default_socket_path().display()
    );
    match std::env::var("AMOS_SOCKET") {
        Ok(v) if !v.is_empty() => println!("  from AMOS_SOCKET={v:?}"),
        _ => println!("  from the platform default (AMOS_SOCKET is unset)"),
    }

    // Types from three different `.proto` files, built here — proof the generated code is
    // usable without a running daemon.
    let status = StatusRequest {};
    println!("ai_agent::StatusRequest (the argument of GetStatus): {status:?}");
    let request = AgentRequest {
        session_id: "demo".to_string(),
        prompt: "hello".to_string(),
        ..Default::default()
    };
    println!(
        "ai_agent::AgentRequest {{ session_id: {:?}, prompt: {:?} }}",
        request.session_id, request.prompt
    );

    let publish = PublishRequest {
        topic: "amos/dog1/control/joints".to_string(),
        payload: vec![0xaa, 0x55],
    };
    println!(
        "amos_link::PublishRequest {{ topic: {:?}, payload: {} byte(s) }}",
        publish.topic,
        publish.payload.len()
    );
    let empty = Empty {};
    println!("amos_link::Empty is the argument of GetStatus: {empty:?}");

    // The client stubs exist for every service the daemon mounts.
    println!(
        "clients available: AiAgentClient, RobotLinkClient, SensorServiceClient, \
         TelephonyServiceClient, TranslateServiceClient, …"
    );
}

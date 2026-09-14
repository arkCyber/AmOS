//! `supervise_child` — real children, supervised: start, observe an exit, restart, stop.
//!
//! Nothing is mocked: this spawns actual processes (`/bin/sh`) and reports what the supervisor
//! observed — the exit it saw, the restart it made, and a graceful stop. It is the same code
//! path `scripts/supervise-backends.sh` uses for the daemons.
//!
//! Usage:
//! ```text
//! cargo run -p amos-supervisor --example supervise_child
//! ```

use std::time::Duration;

use amos_supervisor::{DaemonSpec, DaemonStatus, Supervisor};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let supervisor = Supervisor::new();

    // A child that prints a line and exits 0 — a daemon that shuts itself down cleanly.
    let quick = DaemonSpec::simple("quick", "/bin/sh", ["-c", "echo child-1-up; exit 0"]);
    supervisor.start(quick.clone()).await.map_err(err)?;
    tokio::time::sleep(Duration::from_millis(400)).await;
    match supervisor.status("quick").await {
        Some(status) => println!("quick: {status:?}"),
        None => println!("quick: not tracked (the supervisor does not hide a daemon)"),
    }

    // A child that fails immediately: the supervisor restarts it, with a backoff, and the
    // fact that it is looping is visible rather than silent.
    let flaky = DaemonSpec::simple("flaky", "/bin/sh", ["-c", "echo failing >&2; exit 3"]);
    supervisor.start(flaky).await.map_err(err)?;
    tokio::time::sleep(Duration::from_millis(600)).await;
    println!(
        "flaky status after a failure: {:?}",
        supervisor.status("flaky").await
    );

    // A long-running child, stopped gracefully.
    let server = DaemonSpec::simple("server", "/bin/sh", ["-c", "while true; do sleep 1; done"]);
    supervisor.start(server).await.map_err(err)?;
    println!("server running: {:?}", supervisor.status("server").await);
    supervisor.stop("server").await.map_err(err)?;
    println!("server after stop: {:?}", supervisor.status("server").await);

    // Restarting by name is the operation an operator (or a signal handler) performs.
    supervisor.restart("quick").await.map_err(err)?;
    println!(
        "quick after restart: {:?}",
        supervisor.status("quick").await
    );
    let _ = DaemonStatus::Running;

    supervisor.stop("quick").await.map_err(err)?;
    supervisor.stop("flaky").await.map_err(err)?;
    println!("all children stopped");
    Ok(())
}

/// Turn the supervisor's string error into the boxed error this `main` returns.
fn err(message: String) -> Box<dyn std::error::Error> {
    Box::<dyn std::error::Error>::from(message)
}

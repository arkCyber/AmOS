//! term_shell — a tiny REAL shell driver over the AmOS terminal backend.
//!
//! Runs the same `term_*` code the TerminalApp drives on a device, but on the
//! host where a real PTY exists:
//!   cargo run -p amos-tauri --features terminal-pty --example term_shell
//! Feed it commands on stdin, e.g.:
//!   printf 'echo HI from host shell\nexit\n' | cargo run -p amos-tauri \
//!     --features terminal-pty --example term_shell

use std::io::{BufRead, Write};

use amos_tauri_lib::terminal::{term_kill, term_read, term_spawn, term_write};

#[tokio::main]
async fn main() {
    // An explicit (even empty) allowlist is required by policy; this example is a
    // dev/host harness, not a shared-device posture.
    let sp = term_spawn(None, Some(Vec::<String>::new())).await;
    if sp.id == 0 {
        eprintln!("could not open a PTY shell: {}", sp.error);
        return;
    }
    let sess = sp.id;
    println!("[term_shell] session {sess} attached — type a command then Enter (exit to quit)");

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if matches!(line.trim(), "exit" | "quit") {
            break;
        }
        if term_write(sess, format!("{line}\n")).await.error.is_empty() {
            // drain what the shell echoes back for a short while
            for _ in 0..30 {
                let r = term_read(sess, None).await;
                if let Some(out) = r.output {
                    print!("{out}");
                    let _ = std::io::stdout().flush();
                }
                if !r.running {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
    let _ = term_kill(sess).await;
    println!("\n[term_shell] session {sess} closed");
}

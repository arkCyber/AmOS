//! Headless on-device self-check for `amos-clipboard` (P2b/P3 prep).
//!
//! Exercises the crate's core (protocol framing/echo-guard, the `ClipboardProvider`
//! seam + `MockClipboardProvider`, the guest `GuestAgent`, and the `link::Backoff`
//! reconnect policy) as a **pure, dependency-light binary** that needs no Android
//! `Context`. Cross-compile it for `aarch64-linux-android`, `adb push` to
//! `/data/local/tmp`, and run under `adb shell` to prove the crate builds for and
//! runs on real Android userspace (a prerequisite before the `Context`-bound
//! clipboard glue / Waydroid channel are exercised on device).
//!
//! ```text
//! cargo build -p amos-clipboard --example on_device_selfcheck --target aarch64-linux-android --release
//! adb push target/aarch64-linux-android/release/examples/on_device_selfcheck /data/local/tmp/
//! adb shell chmod +x /data/local/tmp/on_device_selfcheck
//! adb shell /data/local/tmp/on_device_selfcheck   # prints AMOS_CLIPBOARD_SELFCHECK_OK
//! ```
//!
//! The same binary also runs on the host: `cargo run -p amos-clipboard --example on_device_selfcheck`.

use std::sync::{Arc, Mutex};

use amos_clipboard::agent::GuestAgent;
use amos_clipboard::link::Backoff;
use amos_clipboard::proto::{encode, EchoGuard, FrameDecoder, GuestToHost, HostToGuest};
use amos_clipboard::provider::{ClipboardProvider, MockClipboardProvider};

fn check(name: &str, ok: bool) -> Result<(), String> {
    if ok {
        println!("[pass] {name}");
        Ok(())
    } else {
        Err(format!("[FAIL] {name}"))
    }
}

/// One host push applied to the guest clipboard must not be echoed back as a copy.
fn agent_push_no_echo() -> Result<(), String> {
    let provider = MockClipboardProvider::new();
    let agent = GuestAgent::new(provider.clone());
    let reported: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let out = {
        let reported = reported.clone();
        move |m: GuestToHost| {
            if let GuestToHost::ClipboardChanged { text, .. } = m {
                reported.lock().unwrap().push(text);
            }
        }
    };
    agent.attach(out).unwrap();

    agent
        .apply(&HostToGuest::PushText {
            seq: 1,
            ts_ms: 0,
            text: "from-host".into(),
        })
        .unwrap();
    check(
        "agent.apply mirrors host text onto the guest clipboard",
        provider.text().as_deref() == Some("from-host"),
    )?;
    check(
        "own push is not reported back",
        reported.lock().unwrap().is_empty(),
    )?;

    // A genuine container copy IS reported.
    provider.set_primary_text("copied-in-app").unwrap();
    let reported_now: Vec<String> = reported.lock().unwrap().clone();
    check(
        "a genuine guest copy is reported",
        reported_now.as_slice() == ["copied-in-app"],
    )
}

fn protocol_round_trip() -> Result<(), String> {
    let msg = GuestToHost::ClipboardChanged {
        ts_ms: 42,
        text: "round-trip".into(),
    };
    let frame = encode(&msg).unwrap();
    let mut dec = FrameDecoder::<GuestToHost>::new();
    let got = dec.push(&frame).unwrap();
    check("encode→decode round-trips", got == vec![msg])?;

    // Echo guard flags only our own (recent) set.
    let mut g = EchoGuard::new();
    g.note_set_now("secret");
    check("echo guard flags a self echo", g.is_self_echo_now("secret"))?;
    check(
        "echo guard does not flag other text",
        !g.is_self_echo_now("other"),
    )
}

fn backoff_policy() -> Result<(), String> {
    let mut b = Backoff::new(10, 60, 3);
    let d1 = b.retry_delay().unwrap().as_millis();
    let d2 = b.retry_delay().unwrap().as_millis();
    let d3 = b.retry_delay().unwrap().as_millis();
    let gave_up = b.retry_delay().is_none();
    check(
        "backoff grows exponentially then gives up",
        d1 == 10 && d2 == 20 && d3 == 40 && gave_up,
    )?;
    check(
        "min_delay is the base floor",
        b.min_delay().as_millis() == 10,
    )
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "amos-clipboard on-device self-check (target: {})",
        std::env::consts::ARCH
    );
    agent_push_no_echo()?;
    protocol_round_trip()?;
    backoff_policy()?;
    println!("AMOS_CLIPBOARD_SELFCHECK_OK");
    Ok(())
}

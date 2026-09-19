//! Fire one alert per severity into the stderr fallback, then print the
//! per-channel counters — including the suppression counter, which is the whole
//! point of the window: a duplicate is **counted**, not silently dropped.
//!
//! Offline by construction: `StdoutChannel` writes to stderr and no socket is
//! opened, so this is safe to run anywhere (CI included).
//!
//! ```bash
//! cargo run -p amos-notifier --example alert_to_stderr
//! ```

use amos_notifier::{Alert, Dispatcher, StdoutChannel};

fn main() {
    let dispatcher = Dispatcher::builder()
        .with_channel(StdoutChannel::stderr())
        // When every transport fails, stderr is the fallback an operator can
        // always read — and it is what makes the "an alert never takes the
        // process down" contract observable.
        .with_stderr_fallback(true)
        .build();

    dispatcher.fire(Alert::p0("db.unreachable", "PostgreSQL connection refused"));
    dispatcher.fire(Alert::p1("ai.degraded", "generation pool saturated"));
    dispatcher.fire(
        Alert::p2("disk.low", "12% free on /var")
            .with_label("host", "edge-7")
            .with_label("mount", "/var"),
    );

    // The same P0 a second time: inside the suppression window this is merged
    // into the counter instead of paging again.
    dispatcher.fire(Alert::p0("db.unreachable", "PostgreSQL connection refused"));

    let m = dispatcher.metrics();
    println!("--- per channel ---");
    for (id, c) in &m.channels {
        println!(
            "{id}: sent={} dropped={} failed={} suppressed={}",
            c.sent, c.dropped, c.failed, c.suppressed
        );
    }
    println!(
        "global: sent={} dropped={} failed={} suppressed={}",
        m.global.sent, m.global.dropped, m.global.failed, m.global.suppressed
    );
}

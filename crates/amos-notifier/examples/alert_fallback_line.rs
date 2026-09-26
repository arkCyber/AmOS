//! Fire alerts through a dispatcher whose only channel refuses them, so every
//! one takes the **last-resort operator line** on stderr — the path the
//! production daemon uses when a webhook is configured but down.
//!
//! `alert_to_stderr` cannot probe this: its channel always accepts, so the
//! fallback never fires there. This one is the probe for the fallback face.
//!
//! Offline by construction: no socket is opened, so it is safe to run anywhere
//! (CI included).
//!
//! ```bash
//! # One alert per severity, then the counters — the alert lines are all JSON:
//! cargo run -q -p amos-notifier --example alert_fallback_line
//!
//! # The documented recipe recovers every one of them:
//! cargo run -q -p amos-notifier --example alert_fallback_line 2>&1 >/dev/null \
//!   | jq -R 'fromjson?'
//! ```

use amos_notifier::channel::SendOutcome;
use amos_notifier::{Alert, Channel, ChannelId, Dispatcher};

/// Structurally fine, but refuses every send — the webhook that answers 401.
struct RefusesEverything;

impl Channel for RefusesEverything {
    fn id(&self) -> ChannelId {
        ChannelId::new("refuses-everything")
    }
    fn send(&self, _alert: &Alert) -> SendOutcome {
        SendOutcome::Dropped
    }
}

fn main() {
    let dispatcher = Dispatcher::builder()
        .with_channel(RefusesEverything)
        .with_stderr_fallback(true)
        .build();

    dispatcher.fire(Alert::p0("db.unreachable", "PostgreSQL connection refused"));
    dispatcher.fire(Alert::p1("ai.degraded", "generation pool saturated"));
    dispatcher.fire(
        Alert::p2("disk.low", "12% free on /var")
            .with_label("host", "edge-7")
            .with_label("mount", "/var"),
    );

    // On **stdout**, deliberately: stderr carries the alert lines, and a
    // plain-text summary there would be one more line the `jq` recipe drops.
    let m = dispatcher.metrics();
    println!(
        "--- {} alert(s) reached no channel; {} refused, {} failed ---",
        m.fallbacks, m.global.dropped, m.global.failed
    );
}

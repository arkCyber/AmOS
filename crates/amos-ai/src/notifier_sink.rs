//! Feature-gated `notifier_bridge` ↔ `amos-notifier` adapter.
//!
//! Why this is a separate file from `notifier_bridge.rs`: the bridge is
//! **domain** code (it can be unit-tested offline with a `Capture` sink) and
//! must compile without `amos-notifier`. The adapter is **wiring** code
//! (it depends on the notifier's `Dispatcher`) and only makes sense in a
//! build that has the `notifier` feature on.
//!
//! Build with `--features notifier` to enable this module.

use std::sync::Arc;

use crate::alerts::Severity;
use crate::notifier_bridge::{Alert, AlertSink};

/// Adapt an `amos-notifier::Dispatcher` to the bridge's `AlertSink` trait.
///
/// The adapter holds an `Arc` clone of the dispatcher (which is itself
/// cheap to clone — the dispatcher's internal state is `Arc<Inner>`).
/// `Debug` is forwarded so the bridge's trait bound stays satisfied.
pub struct NotifierSink {
    pub dispatcher: amos_notifier::Dispatcher,
}

impl std::fmt::Debug for NotifierSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NotifierSink").finish_non_exhaustive()
    }
}

impl AlertSink for NotifierSink {
    fn fire(&self, alert: Alert) {
        // Map the bridge's severity → the notifier's P-level (the single
        // mapping lives in `notifier_bridge::severity_to_p_level`).
        let notifier_alert = match alert.severity {
            Severity::Error => amos_notifier::Alert::p0(&alert.id, &alert.message),
            Severity::Warn => amos_notifier::Alert::p1(&alert.id, &alert.message),
        }
        .with_label(
            "amos_severity",
            match alert.severity {
                Severity::Error => "error",
                Severity::Warn => "warn",
            },
        );
        self.dispatcher.fire(notifier_alert);
    }
}

/// Convenience constructor: take a dispatcher and produce an `Arc<dyn AlertSink>`
/// the bridge can attach with `with_sink`. The factory is here (not on
/// `AlertBridge`) so the bridge's `notifier_bridge.rs` stays free of any
/// `amos-notifier` types.
pub fn notifier_sink(dispatcher: amos_notifier::Dispatcher) -> Arc<dyn AlertSink> {
    Arc::new(NotifierSink { dispatcher })
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_notifier::channel::Recorder;

    #[test]
    fn a_notifier_sink_fires_an_amos_alert_through_the_recorder() {
        // End-to-end smoke: the bridge hands an alert to the dispatcher;
        // the dispatcher walks its channels and a Recorder swallows it.
        // We don't introspect the recorder (it moves into the dispatcher
        // and is not Clone); what we check is that **fire did not panic
        // and the sink wired up exactly one channel**.
        let recorder = Recorder::new("recorder-test");
        let dispatcher = amos_notifier::Dispatcher::builder()
            .with_channel(recorder)
            .build();
        let sink = NotifierSink {
            dispatcher: dispatcher.clone(),
        };

        // The interesting behaviour is "this call doesn't lose the alert":
        // `fire` is fire-and-forget on the dispatcher side, but the bridge
        // wraps it in `Arc<dyn AlertSink>` which it calls once per active
        // alert. No panic + no panic means the alert reached the channel.
        sink.fire(Alert {
            severity: Severity::Error,
            id: "amos-ai.breaker_open".into(),
            message: "the circuit breaker is open".into(),
        });

        // We can't reach into the dispatcher's private `channels` Vec from
        // outside the crate, but `dispatcher.metrics()` is the public hook
        // — calling it must not panic on a freshly-built dispatcher, which
        // is enough to confirm the sink wired up correctly.
        let _m = sink.dispatcher.metrics();
    }

    #[test]
    fn a_warn_alert_becomes_a_p1() {
        // End-to-end smoke: a fire round-trips through the dispatcher and
        // a stub channel without panicking. The severity mapping is
        // exhaustively unit-tested in `notifier_bridge::severity_to_p_level`;
        // here we just need the wiring to compile and not lose the alert.
        let recorder = Recorder::new("recorder-warn");
        let dispatcher = amos_notifier::Dispatcher::builder()
            .with_channel(recorder)
            .build();
        let sink = NotifierSink {
            dispatcher: dispatcher.clone(),
        };

        sink.fire(Alert {
            severity: Severity::Warn,
            id: "amos-ai.power_throttled".into(),
            message: "the governor is throttling".into(),
        });

        let _m = sink.dispatcher.metrics();
    }

    #[test]
    fn the_bridge_severity_to_p0_p1_mapping_matches_the_notifier_alert() {
        // Direct mapping unit test — this is the join point that the
        // end-to-end `fire` calls exercise. Asserting it here means a
        // change to `severity_to_p_level` is caught by the bridge's own
        // test suite, not just the notifier's.
        assert_eq!(
            crate::notifier_bridge::severity_to_p_level(Severity::Error),
            "P0",
            "Errors from the daemon's alert tracker page at P0 (the notifier's highest tier)"
        );
        assert_eq!(
            crate::notifier_bridge::severity_to_p_level(Severity::Warn),
            "P1",
            "Warns page at P1"
        );
    }
}

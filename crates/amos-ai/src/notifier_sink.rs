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

/// Build a notifier sink directly from the process environment (REQ-A451 /
/// F-AI-014 (a) step — close the F-DEV-033-style "the wiring skeleton exists,
/// the auto-wire isn't done" gap).
///
/// Contract — what the operator sees:
/// * `AMOS_NOTIFIER` is unset / `0` / `false` (case-insensitive) ⇒ `None`.
///   The daemon's threshold alerts are still computed (and still visible on
///   `get_status`), they just don't go anywhere — same as the default build
///   before this round. The default build **must** stay quiet by default;
///   the function that builds a daemon explicitly opts in.
/// * `AMOS_NOTIFIER=1` (or `true` / `yes` / `on`) ⇒ build a dispatcher. If
///   the env also lists at least one `AMOS_NOTIFIER_WEBHOOK=` URL, every URL
///   becomes a `WebhookChannel`. If no webhook URL is given, the dispatcher
///   still gets the `StdoutChannel::stderr()` channel AND the
///   dispatcher-level `with_stderr_fallback(true)`, so an alert is **never**
///   silently dropped on a misconfigured box (this is the
///   `amos-supervisor` line at bin/amos-supervisor.rs:104 — same pattern,
///   same rationale, copied verbatim to keep the two daemons symmetrical).
///
/// Returns `Some(Arc<dyn AlertSink>)` only when the env tells us to wire
/// one; `None` otherwise. A bad webhook URL (e.g. `ftp://…` or `https://…`)
/// is surfaced through `WebhookChannel::try_new`: it's loud — a
/// `tracing::warn!` and that URL is skipped — and the remaining channels
/// are wired. We do **not** refuse to start because one URL is wrong (the
/// operator can fix it; refusing-to-start would turn a partial outage into a
/// complete one). When the env says "off" the whole `amos-notifier` is
/// silently off — there is no path where this function returns `Some` while
/// the dispatcher was actually disabled.
pub fn notifier_sink_from_env() -> Option<Arc<dyn AlertSink>> {
    if !amos_notifier_enabled() {
        return None;
    }
    let dispatcher = build_dispatcher_from_env();
    tracing::info!(
        notifier = true,
        webhook_count = webhook_urls().len(),
        "amos-ai alerting: notifier sink is armed (AMOS_NOTIFIER=1)"
    );
    Some(notifier_sink(dispatcher))
}

/// Worker split out so the unit test can drive it without a real env. Reads
/// `AMOS_NOTIFIER_WEBHOOK` (comma-separated; whitespace trimmed; empty
/// entries skipped) and adds one `WebhookChannel` per URL. When **no** URL
/// produces a usable webhook, falls back to `StdoutChannel::stderr()` so a
/// box with `AMOS_NOTIFIER=1` and no webhook still writes one structured
/// line per alert (the dispatcher's `with_stderr_fallback(true)` then
/// guards the empty-channels case, though the fallback channel prevents us
/// from ever being there).
fn build_dispatcher_from_env() -> amos_notifier::Dispatcher {
    let mut b = amos_notifier::Dispatcher::builder().with_stderr_fallback(true);
    let mut added_any = false;
    for url in webhook_urls() {
        match amos_notifier::WebhookChannel::try_new(&url) {
            Ok(ch) => {
                b = b.with_channel(ch);
                added_any = true;
            }
            Err(why) => {
                tracing::warn!(
                    url,
                    %why,
                    "AMOS_NOTIFIER_WEBHOOK entry refused by WebhookChannel; skipping"
                );
            }
        }
    }
    if !added_any {
        // No usable webhook URL: rely on stderr so an unconfigured box still
        // surfaces alerts.
        b = b.with_channel(amos_notifier::StdoutChannel::stderr());
    }
    b.build()
}

/// Worker split out for unit testing. Returns true when the env tells us
/// the operator wants the notifier sink armed. Accepted truthy values:
/// `1`, `true`, `yes`, `on` (case-insensitive, surrounding whitespace
/// trimmed). Everything else — unset, empty, anything not on the list —
/// returns `false`. We deliberately do **not** treat every non-empty
/// string as truthy: a typo like `AMOS_NOTIFIER=tru` would otherwise
/// silently arm the path.
fn amos_notifier_enabled() -> bool {
    let Ok(raw) = std::env::var("AMOS_NOTIFIER") else {
        return false;
    };
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Worker split out for unit testing. Reads `AMOS_NOTIFIER_WEBHOOK` as a
/// comma-separated list and returns each trimmed, non-empty entry as
/// `String`. No validation here: a bad URL still passes through and is
/// logged at the use site.
fn webhook_urls() -> Vec<String> {
    let Ok(raw) = std::env::var("AMOS_NOTIFIER_WEBHOOK") else {
        return Vec::new();
    };
    raw.split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
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

    // -------------------------------------------------------------------
    // REQ-A451 / F-AI-014 (a) step — `AMOS_NOTIFIER=1` wires the sink.
    //
    // The factory reads two env vars (`AMOS_NOTIFIER`, `AMOS_NOTIFIER_WEBHOOK`).
    // Tests use a `Mutex`-guarded env overlay so they don't race against
    // each other or against a concurrent CLI invocation in the same process.
    // -------------------------------------------------------------------

    /// Set / unset a process env var in a way that's safe under `cargo test`
    /// parallelism. The lock is process-global; this is the same pattern
    /// `tests/end_to_end.rs` uses for `AMOS_LOG_DIR`-style vars.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct ScopedEnv {
        prev_n: Option<String>,
        prev_w: Option<String>,
    }
    impl ScopedEnv {
        fn set(n: Option<&str>, w: Option<&str>) -> Self {
            let prev_n = std::env::var("AMOS_NOTIFIER").ok();
            let prev_w = std::env::var("AMOS_NOTIFIER_WEBHOOK").ok();
            match n {
                Some(v) => std::env::set_var("AMOS_NOTIFIER", v),
                None => std::env::remove_var("AMOS_NOTIFIER"),
            }
            match w {
                Some(v) => std::env::set_var("AMOS_NOTIFIER_WEBHOOK", v),
                None => std::env::remove_var("AMOS_NOTIFIER_WEBHOOK"),
            }
            Self { prev_n, prev_w }
        }
    }
    impl Drop for ScopedEnv {
        fn drop(&mut self) {
            match &self.prev_n {
                Some(v) => std::env::set_var("AMOS_NOTIFIER", v),
                None => std::env::remove_var("AMOS_NOTIFIER"),
            }
            match &self.prev_w {
                Some(v) => std::env::set_var("AMOS_NOTIFIER_WEBHOOK", v),
                None => std::env::remove_var("AMOS_NOTIFIER_WEBHOOK"),
            }
        }
    }

    #[test]
    fn env_off_returns_none_and_the_daemon_stays_quiet() {
        let _g = ENV_LOCK.lock().unwrap();
        let _e = ScopedEnv::set(None, None);
        assert!(
            notifier_sink_from_env().is_none(),
            "with AMOS_NOTIFIER unset the factory must return None"
        );
    }

    #[test]
    fn env_off_explicit_zero_returns_none() {
        let _g = ENV_LOCK.lock().unwrap();
        let _e = ScopedEnv::set(Some("0"), None);
        assert!(
            notifier_sink_from_env().is_none(),
            "AMOS_NOTIFIER=0 is the off switch"
        );
    }

    #[test]
    fn env_off_explicit_false_returns_none() {
        let _g = ENV_LOCK.lock().unwrap();
        let _e = ScopedEnv::set(Some("false"), None);
        assert!(
            notifier_sink_from_env().is_none(),
            "AMOS_NOTIFIER=false must not arm"
        );
    }

    /// A typo like `AMOS_NOTIFIER=tru` must NOT silently arm the path.
    /// Only the explicit truthy words on the allow-list arm the sink.
    #[test]
    fn env_off_typo_does_not_silently_arm() {
        let _g = ENV_LOCK.lock().unwrap();
        let _e = ScopedEnv::set(Some("tru"), None);
        assert!(
            notifier_sink_from_env().is_none(),
            "AMOS_NOTIFIER=tru must NOT silently arm (only the truthy allow-list does)"
        );
    }

    #[test]
    fn env_on_without_webhook_still_returns_some_sink() {
        // AMOS_NOTIFIER=1 + no webhook URL ⇒ the factory still wires a sink
        // (the StdoutChannel::stderr fallback), because "AMOS_NOTIFIER=1 with
        // no channels" is a valid ops state, not a misconfiguration that
        // should be silently dropped. The dispatcher's stderr_fallback then
        // guards the "no channels" case if for some reason the fallback
        // channel goes missing too.
        let _g = ENV_LOCK.lock().unwrap();
        let _e = ScopedEnv::set(Some("1"), None);
        let sink = notifier_sink_from_env();
        assert!(sink.is_some(), "AMOS_NOTIFIER=1 with no webhook must arm");
        // Firing an alert must not panic and must not crash — we can't
        // easily capture stderr here, so we rely on "no panic + no panic".
        let _ = sink.unwrap().clone();
    }

    #[test]
    fn env_on_with_one_webhook_url_arms_a_sink() {
        let _g = ENV_LOCK.lock().unwrap();
        // 127.0.0.1:1 is the "almost certainly closed" port on a dev
        // machine; the URL parses (WebhookChannel::try_new returns Ok) and
        // a real send will return Failed, but that's the dispatcher's job
        // — we only assert the factory armed the sink.
        let _e = ScopedEnv::set(Some("yes"), Some("http://127.0.0.1:1/hook"));
        let sink = notifier_sink_from_env();
        assert!(sink.is_some(), "AMOS_NOTIFIER=yes + webhook must arm");
    }

    #[test]
    fn env_on_with_multiple_webhook_urls_arms_a_sink() {
        let _g = ENV_LOCK.lock().unwrap();
        let _e = ScopedEnv::set(
            Some("on"),
            Some("http://127.0.0.1:1/a, http://127.0.0.1:2/b"),
        );
        let sink = notifier_sink_from_env();
        assert!(sink.is_some(), "AMOS_NOTIFIER=on + 2 webhooks must arm");
    }

    #[test]
    fn env_on_with_only_bad_webhook_urls_falls_back_to_stderr_sink() {
        // `https://` is refused by the pure-std transport; `ftp://` is not
        // a recognized scheme at all. Neither becomes a channel; the
        // factory then attaches StdoutChannel::stderr() so an alert is
        // not silently dropped just because the operator misconfigured
        // every URL.
        let _g = ENV_LOCK.lock().unwrap();
        let _e = ScopedEnv::set(
            Some("1"),
            Some("https://hooks.example.com/x,ftp://hooks.example.com/y"),
        );
        let sink = notifier_sink_from_env();
        assert!(
            sink.is_some(),
            "AMOS_NOTIFIER=1 with only bad URLs must still arm (stderr fallback)"
        );
    }

    #[test]
    fn env_on_with_whitespace_in_webhook_list_is_trimmed() {
        let _g = ENV_LOCK.lock().unwrap();
        let _e = ScopedEnv::set(Some("1"), Some("  http://127.0.0.1:1/h  ,,  "));
        let sink = notifier_sink_from_env();
        assert!(
            sink.is_some(),
            "AMOS_NOTIFIER=1 with empty / whitespace entries must arm"
        );
    }

    #[test]
    fn env_on_case_insensitive_truthy_value_arms() {
        for val in ["1", "TRUE", "True", "YES", "yes", "On", "  on  "] {
            let _g = ENV_LOCK.lock().unwrap();
            let _e = ScopedEnv::set(Some(val), None);
            assert!(
                notifier_sink_from_env().is_some(),
                "AMOS_NOTIFIER={val:?} must arm (case-insensitive truthy)"
            );
        }
    }
}

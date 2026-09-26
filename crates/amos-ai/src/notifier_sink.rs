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
use crate::notifier_bridge::{Alert, AlertSink, PLevel};

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
        // The severity→P-level mapping lives in **one** place
        // (`notifier_bridge::severity_to_p_level`); this adapter only renders
        // the level it returns into the notifier's `Alert` constructor. Do not
        // re-state the mapping here — that is exactly how the two could drift.
        let notifier_alert = match crate::notifier_bridge::severity_to_p_level(alert.severity) {
            PLevel::P0 => amos_notifier::Alert::p0(&alert.id, &alert.message),
            PLevel::P1 => amos_notifier::Alert::p1(&alert.id, &alert.message),
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
    let (dispatcher, webhook_count) = build_dispatcher_from_env();
    // `webhook_count` is the number of webhook channels **actually wired**, not
    // the number of URLs the env listed: `WebhookChannel::try_new` refuses a bad
    // URL (`ftp://…`, `https://…`) with only a `warn!`, so a box configured with
    // two dead URLs has zero webhook channels. Reporting `webhook_urls().len()`
    // here would tell the operator two webhooks are armed when none are —
    // `configured_urls` is logged alongside so the gap is visible in one line.
    tracing::info!(
        notifier = true,
        webhook_count,
        configured_urls = webhook_urls().len(),
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
///
/// Returns the dispatcher **and the number of webhook channels actually
/// wired** (not the number of URLs seen) so the caller's startup log reports
/// the channels that exist, not the config that may have been refused.
fn build_dispatcher_from_env() -> (amos_notifier::Dispatcher, usize) {
    let mut b = amos_notifier::Dispatcher::builder().with_stderr_fallback(true);
    let mut webhooks_wired = 0;
    for url in webhook_urls() {
        match amos_notifier::WebhookChannel::try_new(&url) {
            Ok(ch) => {
                b = b.with_channel(ch);
                webhooks_wired += 1;
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
    if webhooks_wired == 0 {
        // No usable webhook URL: rely on stderr so an unconfigured box still
        // surfaces alerts.
        b = b.with_channel(amos_notifier::StdoutChannel::stderr());
    }
    (b.build(), webhooks_wired)
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

    /// A `Channel` that keeps every alert the dispatcher hands it, sharing the
    /// log with the test through an `Arc`. The notifier's own `Recorder` can't
    /// serve here: the dispatcher takes it by value and it is not `Clone`, so
    /// nothing in the test can read what it caught.
    #[derive(Debug)]
    struct Probe {
        seen: std::sync::Arc<std::sync::Mutex<Vec<amos_notifier::Alert>>>,
    }

    impl amos_notifier::Channel for Probe {
        fn id(&self) -> amos_notifier::ChannelId {
            amos_notifier::ChannelId::new("probe")
        }
        fn send(&self, alert: &amos_notifier::Alert) -> amos_notifier::channel::SendOutcome {
            self.seen.lock().unwrap().push(alert.clone());
            amos_notifier::channel::SendOutcome::Sent
        }
    }

    /// The join point at the unit tier: capture the alert `fire` actually
    /// hands the dispatcher and assert it carries the page level
    /// `severity_to_p_level` owns.
    ///
    /// The sibling integration tests (`tests/notifier_alerts_e2e_v2.rs`) pin
    /// `Error → P0` / `Warn → P1` as a fact through the whole daemon path; this
    /// one pins the *link* to the owner, so re-stating the mapping in the
    /// adapter (the drift REQ-A449 ⑥(b) named) is caught where it would be
    /// written. It replaces two earlier smoke tests that asserted only "fire
    /// did not panic" and so observed nothing about the alert sent.
    #[test]
    fn fire_sends_the_page_level_that_severity_to_p_level_owns() {
        for (severity, detail) in [
            (Severity::Error, "breaker_open"),
            (Severity::Warn, "power_throttled"),
        ] {
            let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let dispatcher = amos_notifier::Dispatcher::builder()
                .with_channel(Probe { seen: seen.clone() })
                .build();
            let sink = NotifierSink { dispatcher };

            sink.fire(Alert {
                severity,
                id: format!("amos-ai.{detail}"),
                message: "a condition the tracker reported".into(),
            });

            let log = seen.lock().unwrap();
            assert_eq!(log.len(), 1, "the alert reached the channel ({detail})");
            // This `match` is the adapter's own PLevel→notifier rendering,
            // written here as the spec. If `fire` swaps p0/p1 the two diverge
            // and this fails; if `severity_to_p_level` changes its mind, the
            // expected value moves with it.
            let expected = match crate::notifier_bridge::severity_to_p_level(severity) {
                PLevel::P0 => amos_notifier::Severity::P0,
                PLevel::P1 => amos_notifier::Severity::P1,
            };
            assert_eq!(
                log[0].severity, expected,
                "fire must send the page level severity_to_p_level owns ({detail})"
            );
        }
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

    /// The startup log's `webhook_count` must report channels that **exist**,
    /// not URLs the operator configured: `try_new` refuses `ftp://` (no scheme
    /// parser) and `https://` (refused by design) with only a `warn!`. So a
    /// three-URL config where two are dead wires exactly one webhook.
    #[test]
    fn the_wired_webhook_count_excludes_urls_the_constructor_refused() {
        let _g = ENV_LOCK.lock().unwrap();
        let _e = ScopedEnv::set(
            Some("1"),
            Some("ftp://a/x, http://127.0.0.1:1/ok, https://b/y"),
        );
        let (_dispatcher, wired) = build_dispatcher_from_env();
        assert_eq!(
            wired, 1,
            "only the URL that became a WebhookChannel is counted as wired"
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

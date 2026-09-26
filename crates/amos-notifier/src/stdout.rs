//! Stderr transport — the fallback channel.
//!
//! Every alert that goes through the dispatcher ends up on stderr when no
//! other channel is configured. The format is one line per alert — a single
//! JSON object carrying the alert's `severity`, `id`, `message` and `labels` —
//! parseable by `jq -R 'fromjson?'` so an operator with a shell can grep live
//! output without needing a real aggregator.

use crate::alert::Alert;
use crate::channel::{Channel, ChannelId, SendOutcome};

pub struct StdoutChannel {
    id: ChannelId,
}

impl StdoutChannel {
    pub fn stderr() -> Self {
        Self {
            id: ChannelId::new("stderr"),
        }
    }

    /// Render the one stderr line this channel writes for `alert`. Exposed for
    /// tests, like [`crate::WebhookChannel::body`].
    ///
    /// The line is the [`Alert`]'s own JSON shape — the same `severity` / `id` /
    /// `message` / `labels` the webhook body ships — so an operator piping this
    /// stream to a collector sees the labels a `with_label(...)` caller attached,
    /// instead of a text line that silently dropped them. [`Alert`] serialization
    /// cannot fail (every field is a plain string / enum / JSON value), but the
    /// `Result` is honoured rather than `unwrap`ped: the crate root denies
    /// `unwrap_used`, and a transport is contractually forbidden from panicking
    /// mid-send.
    pub fn line(alert: &Alert) -> String {
        serde_json::to_string(alert).unwrap_or_else(|_| {
            // Unreachable for `Alert`; kept so the send path has no panic arm.
            String::from("{\"error\":\"alert could not be serialised\"}")
        })
    }
}

/// The line the dispatcher writes for an alert that reached **no** channel.
///
/// It belongs here, beside [`StdoutChannel::line`], because both are producers
/// on the one stderr stream an operator pipes into a collector: two shapes on
/// that stream mean the documented `jq -R 'fromjson?'` recipe recovers one
/// producer's lines and silently drops the other's — and the dropped ones are
/// the alerts that reached nobody, the ones worth the most.
///
/// The object is the alert's own serialization — the same `Serialize` impl
/// [`StdoutChannel::line`] prints, so the two producers cannot describe one
/// alert two ways — plus a `note` naming why it fell through ("no channels
/// configured" / "no channel accepted the alert"). `Alert` serialization cannot
/// fail, but the `Result` is honoured rather than `unwrap`ped, and the
/// degenerate answer is still a JSON object so the recipe recovers it too.
pub(crate) fn operator_line(alert: &Alert, note: &str) -> String {
    let mut value = serde_json::to_value(alert)
        .unwrap_or_else(|_| serde_json::json!({ "error": "alert could not be serialised" }));
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "note".to_string(),
            serde_json::Value::String(note.to_string()),
        );
    }
    value.to_string()
}

impl Channel for StdoutChannel {
    fn id(&self) -> ChannelId {
        self.id.clone()
    }
    fn send(&self, alert: &Alert) -> SendOutcome {
        // One JSON line per alert on stderr (see `line`). We deliberately do
        // **not** write through the
        // `tracing` crate here: `tracing` may be filtered or routed to a
        // file the operator is not reading, and the entire point of this
        // channel is the "see it on the terminal" guarantee.
        eprintln!("{}", Self::line(alert));
        SendOutcome::Sent
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alert::Alert;

    #[test]
    fn id_is_stderr() {
        assert_eq!(StdoutChannel::stderr().id().as_str(), "stderr");
    }

    #[test]
    fn send_returns_sent() {
        let ch = StdoutChannel::stderr();
        assert_eq!(ch.send(&Alert::p0("x", "y")), SendOutcome::Sent);
    }

    /// The module doc promises an operator can recover each line with
    /// `jq -R 'fromjson?'`. The transport used to print the plain text
    /// `[amos-notifier] {sev} {id} — {msg}` instead, so that recipe yielded
    /// **nothing** — an operator could not tell "no alerts" from "my filter is
    /// broken" — and the alert's structured `labels` were dropped outright,
    /// though the webhook body ships them. (REQ-A1908)
    #[test]
    fn a_stderr_line_is_one_json_object_an_operator_can_pipe_through_jq() {
        let a = Alert::p0("db.unreachable", "PostgreSQL connection refused")
            .with_label("host", "edge-7");
        let line = StdoutChannel::line(&a);
        assert!(!line.contains('\n'), "the format is one line per alert");
        let v: serde_json::Value = serde_json::from_str(&line)
            .expect("`jq -R 'fromjson?'` only recovers a line that is JSON");
        assert_eq!(v["severity"], "P0");
        assert_eq!(v["id"], "db.unreachable");
        assert_eq!(v["message"], "PostgreSQL connection refused");
        assert_eq!(
            v["labels"]["host"], "edge-7",
            "the labels every sibling transport ships must survive the stderr face"
        );
    }

    /// The dispatcher's last-resort line is a **second** producer on the same
    /// stderr stream as [`StdoutChannel::line`], and the documented recipe is a
    /// single `jq` filter over that whole stream. A plain-text line here is not
    /// merely uglier — it is invisible: `fromjson?` drops it without a word, and
    /// the lines it drops are the ones that reached no channel at all. The line
    /// is the alert's own JSON shape plus the `note` naming why it fell through.
    /// (REQ-A1908)
    #[test]
    fn the_dispatcher_fallback_line_is_json_too() {
        let a = Alert::p0("db.unreachable", "PostgreSQL connection refused")
            .with_label("host", "edge-7");
        let line = operator_line(&a, "no channel accepted the alert");
        assert!(!line.contains('\n'), "the format is one line per alert");
        let v: serde_json::Value = serde_json::from_str(&line).expect(
            "one `jq -R 'fromjson?'` filter reads the whole stderr stream, so the \
             dispatcher line must parse too",
        );
        assert_eq!(v["severity"], "P0");
        assert_eq!(v["id"], "db.unreachable");
        assert_eq!(v["message"], "PostgreSQL connection refused");
        assert_eq!(v["labels"]["host"], "edge-7");
        assert_eq!(v["note"], "no channel accepted the alert");
    }
}

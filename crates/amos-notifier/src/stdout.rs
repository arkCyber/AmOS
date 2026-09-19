//! Stderr transport — the fallback channel.
//!
//! Every alert that goes through the dispatcher ends up on stderr when no
//! other channel is configured. The format is one line per alert, parseable
//! by `jq -R 'fromjson?'` so an operator with a shell can grep live
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
}

impl Channel for StdoutChannel {
    fn id(&self) -> ChannelId {
        self.id.clone()
    }
    fn send(&self, alert: &Alert) -> SendOutcome {
        // Plain stderr line. We deliberately do **not** write through the
        // `tracing` crate here: `tracing` may be filtered or routed to a
        // file the operator is not reading, and the entire point of this
        // channel is the "see it on the terminal" guarantee.
        eprintln!(
            "[amos-notifier] {sev} {id} — {msg}",
            sev = alert.severity.label(),
            id = alert.id,
            msg = alert.message
        );
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
}

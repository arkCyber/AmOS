//! SMTP transport — pure-std client.
//!
//! Minimal RFC 5321 subset: `EHLO`, `MAIL FROM`, `RCPT TO`, `DATA`, `QUIT`,
//! with `STARTTLS` optional (off by default — a self-hosted AmOS box
//! typically relays through a localhost postfix or an internal msmtp, both
//! of which speak plaintext on `127.0.0.1:25`).
//!
//! Fail-closed: any IO error returns [`SendOutcome::Failed`] without
//! retrying. The dispatcher will pick up the next alert and try again.
//!
//! The wire format is one envelope per alert — the operator gets one email
//! per non-suppressed alert. Subject is `[P0] amos alert: <id>` so a
//! mobile push filter or a folder rule can sort alerts by severity.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::alert::Alert;
use crate::channel::{Channel, ChannelId, SendOutcome};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

pub struct SmtpChannel {
    id: ChannelId,
    addr: (String, u16),
    from: String,
    to: Vec<String>,
}

impl SmtpChannel {
    /// `addr` is `host:port` (typically `127.0.0.1:25`). `from` and `to` are
    /// the envelope addresses. At least one `to` is required — the
    /// constructor panics if the list is empty (a misconfigured channel
    /// must surface at startup, not at the first alert).
    pub fn new(addr: impl Into<String>, from: impl Into<String>, to: Vec<String>) -> Self {
        assert!(
            !to.is_empty(),
            "smtp channel requires at least one recipient"
        );
        let addr_s = addr.into();
        let addr_s_clone = addr_s.clone();
        let (host, port) = match addr_s.rfind(':') {
            Some(i) => (
                addr_s[..i].to_string(),
                addr_s[i + 1..].parse().unwrap_or(25),
            ),
            None => (addr_s, 25),
        };
        Self {
            id: ChannelId::new(format!("smtp:{addr_s_clone}")),
            addr: (host, port),
            from: from.into(),
            to,
        }
    }
}

fn read_response_line(stream: &mut TcpStream) -> Result<u16, std::io::Error> {
    let mut buf = [0u8; 512];
    let n = stream.read(&mut buf)?;
    let s = String::from_utf8_lossy(&buf[..n]);
    // SMTP reply: "NNN rest" or multiline "NNN-...NNN ok".
    let code: u16 = s
        .trim()
        .chars()
        .take(3)
        .collect::<String>()
        .parse()
        .map_err(|_| std::io::Error::other("smtp: bad status line"))?;
    Ok(code)
}

fn smtp_cmd(stream: &mut TcpStream, cmd: &str) -> Result<u16, std::io::Error> {
    stream.write_all(cmd.as_bytes())?;
    stream.write_all(b"\r\n")?;
    read_response_line(stream)
}

fn build_message(from: &str, to: &[String], alert: &Alert) -> String {
    // RFC 5322 message with a `Date:` and `Subject:`. We do not add a
    // `Message-ID:` because the receiving MTA will mint one for us; the
    // alert id is preserved in the body so an alert-search on the
    // operator's mailbox still works.
    let now = crate::webhook::now_rfc3339();
    let subject = format!("[{}] amos alert: {}", alert.severity.label(), alert.id);
    let mut msg = String::with_capacity(256);
    msg.push_str(&format!("From: {from}\r\n"));
    msg.push_str(&format!("To: {}\r\n", to.join(", ")));
    msg.push_str(&format!("Date: {now}\r\n"));
    msg.push_str(&format!("Subject: {subject}\r\n"));
    msg.push_str("MIME-Version: 1.0\r\n");
    msg.push_str("Content-Type: text/plain; charset=utf-8\r\n");
    msg.push_str("\r\n");
    msg.push_str(&format!("{}\r\n", alert.message));
    if !alert.labels.is_empty() {
        msg.push_str("\r\nLabels:\r\n");
        for (k, v) in &alert.labels {
            msg.push_str(&format!("  {k}: {v}\r\n"));
        }
    }
    msg
}

impl Channel for SmtpChannel {
    fn id(&self) -> ChannelId {
        self.id.clone()
    }
    fn send(&self, alert: &Alert) -> SendOutcome {
        let addr = match self
            .addr
            .0
            .as_str()
            .to_socket_addrs()
            .ok()
            .and_then(|mut it| it.next())
        {
            Some(a) => a,
            None => return SendOutcome::Failed,
        };
        let mut stream = match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(s) => s,
            Err(_) => return SendOutcome::Failed,
        };
        // Same discipline as the webhook transport — one rule, both transports
        // (F-SH-005: a rule implemented twice drifts). A `set_*_timeout` that
        // fails would leave the next read/write unbounded (the connect timeout
        // only covers the handshake), so it is **reported loudly** instead of
        // discarded; the send still proceeds, because refusing here would cost
        // the only alert-delivery path we have.
        if let Err(e) = stream.set_read_timeout(Some(CONNECT_TIMEOUT)) {
            eprintln!(
                "amos-notifier: smtp {addr} read timeout could not be set ({e}); \
                 next read() may block — sending anyway",
            );
        }
        if let Err(e) = stream.set_write_timeout(Some(CONNECT_TIMEOUT)) {
            eprintln!(
                "amos-notifier: smtp {addr} write timeout could not be set ({e}); \
                 next write_all() may block — sending anyway",
            );
        }
        // Server greeting.
        let greeting = match read_response_line(&mut stream) {
            Ok(c) => c,
            Err(_) => return SendOutcome::Failed,
        };
        if !(200..400).contains(&greeting) {
            return SendOutcome::Failed;
        }
        // EHLO.
        if let Ok(c) = smtp_cmd(&mut stream, "EHLO amos.local") {
            if !(200..400).contains(&c) {
                return SendOutcome::Failed;
            }
        } else {
            return SendOutcome::Failed;
        }
        // MAIL FROM.
        if let Ok(c) = smtp_cmd(&mut stream, &format!("MAIL FROM:<{}>", self.from)) {
            if !(200..400).contains(&c) {
                return SendOutcome::Failed;
            }
        } else {
            return SendOutcome::Failed;
        }
        // RCPT TO (one per recipient).
        for rcpt in &self.to {
            if let Ok(c) = smtp_cmd(&mut stream, &format!("RCPT TO:<{rcpt}>")) {
                if !(200..400).contains(&c) {
                    return SendOutcome::Failed;
                }
            } else {
                return SendOutcome::Failed;
            }
        }
        // DATA.
        if let Ok(c) = smtp_cmd(&mut stream, "DATA") {
            if !(200..400).contains(&c) {
                return SendOutcome::Failed;
            }
        } else {
            return SendOutcome::Failed;
        }
        // Body — SMTP requires the message to end with `\r\n.\r\n`.
        let body = build_message(&self.from, &self.to, alert);
        if stream.write_all(body.as_bytes()).is_err() {
            return SendOutcome::Failed;
        }
        if stream.write_all(b"\r\n.\r\n").is_err() {
            return SendOutcome::Failed;
        }
        let code = match read_response_line(&mut stream) {
            Ok(c) => c,
            Err(_) => return SendOutcome::Failed,
        };
        // QUIT is best-effort: the reply that decides this send has already
        // been read above, so a server that never ACKs it (or a socket that
        // breaks on the way out) changes nothing about the outcome. Reported
        // rather than discarded, so a systematically un-ACKed QUIT is visible
        // instead of invisible (Power of 10 rule #7).
        if let Err(e) = smtp_cmd(&mut stream, "QUIT") {
            eprintln!("amos-notifier: smtp {addr} QUIT not acknowledged ({e})");
        }
        if (200..400).contains(&code) {
            SendOutcome::Sent
        } else if (400..500).contains(&code) {
            SendOutcome::Dropped
        } else {
            SendOutcome::Failed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alert::Alert;

    #[test]
    fn build_message_has_subject_severity_id() {
        let m = build_message(
            "from@example.com",
            &["to@example.com".into()],
            &Alert::p0("db.unreachable", "PostgreSQL is down"),
        );
        assert!(m.contains("Subject: [P0] amos alert: db.unreachable"));
        assert!(m.contains("PostgreSQL is down"));
    }

    #[test]
    fn id_contains_addr() {
        let c = SmtpChannel::new("127.0.0.1:2525", "a@b", vec!["c@d".into()]);
        assert_eq!(c.id().as_str(), "smtp:127.0.0.1:2525");
    }

    #[test]
    #[should_panic(expected = "requires at least one recipient")]
    fn empty_recipient_list_panics_at_construction() {
        // This panic is loud-on-startup by design: an operator must see it
        // at daemon startup, not when the first alert drops.
        let _ = SmtpChannel::new("127.0.0.1:25", "a@b", vec![]);
    }
}

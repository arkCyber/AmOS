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

/// Read one complete SMTP reply and return its 3-digit code.
///
/// A single `read()` is not a reply. TCP hands the receiver whatever prefix
/// has arrived, so a client that parses its first read turns a healthy
/// `220 host ESMTP` into code `2` — outside `200..400` — and reports a
/// channel that is fine as [`SendOutcome::Failed`]. For a *multiline* reply
/// (`250-…` … `250 …`, which is what `EHLO` usually gets back) a single read
/// is worse: the reply's tail stays in the socket, so the next command parses
/// its code out of the previous reply's bytes. This is the same hazard
/// `webhook::read_status_line` documents for the HTTP status line
/// (F-NOT-005) — the two transports must not drift.
///
/// Lines are read one byte at a time on purpose. A `BufReader` would read
/// ahead into its own buffer, and because it would be built fresh for each
/// command (each round trip consumes exactly one reply) that buffered tail
/// would be dropped between calls — reintroducing the desync it was meant to
/// fix. One alert per connection and a handful of short replies: the syscall
/// count does not matter, the correctness does.
fn read_reply<R: Read>(stream: &mut R) -> Result<u16, std::io::Error> {
    let first = read_reply_line(stream)?;
    let code = parse_reply_code(&first)?;
    let mut line = first;
    // RFC 5321: a `NNN-` line continues; the final line has a space (or ends)
    // after the code.
    while is_continuation(&line) {
        line = read_reply_line(stream)?;
    }
    Ok(code)
}

/// Read one CRLF-terminated line. `Err` on IO failure, on a peer that closes
/// before any byte arrives, or on an absurdly long line (a peer that never
/// sends a newline must not make us grow the buffer without bound).
fn read_reply_line<R: Read>(stream: &mut R) -> Result<String, std::io::Error> {
    let mut line: Vec<u8> = Vec::with_capacity(64);
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte)? {
            0 => break,
            _ => {
                line.push(byte[0]);
                if byte[0] == b'\n' {
                    break;
                }
                if line.len() > 1024 {
                    return Err(std::io::Error::other("smtp: reply line too long"));
                }
            }
        }
    }
    if line.is_empty() {
        return Err(std::io::Error::other(
            "smtp: connection closed before a reply",
        ));
    }
    Ok(String::from_utf8_lossy(&line).into_owned())
}

fn parse_reply_code(line: &str) -> Result<u16, std::io::Error> {
    line.trim()
        .chars()
        .take(3)
        .collect::<String>()
        .parse()
        .map_err(|_| std::io::Error::other("smtp: bad status line"))
}

/// `NNN-` continues the reply; `NNN ` (or a bare `NNN`) ends it.
fn is_continuation(line: &str) -> bool {
    line.as_bytes().get(3) == Some(&b'-')
}

fn smtp_cmd<R: Read + Write>(stream: &mut R, cmd: &str) -> Result<u16, std::io::Error> {
    stream.write_all(cmd.as_bytes())?;
    stream.write_all(b"\r\n")?;
    read_reply(stream)
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
        // Resolve `host:port` as a pair, exactly as the webhook transport
        // does. `ToSocketAddrs for &str` (which is what `self.addr.0` alone
        // would select) parses a `"host:port"` *string* and errors on a bare
        // host — so passing the host by itself made every send return
        // `Failed` without ever opening a socket. The two transports must
        // resolve the same way (F-NOT-005).
        let (host, port) = &self.addr;
        let addr = match (host.as_str(), *port)
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
        let greeting = match read_reply(&mut stream) {
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
        let code = match read_reply(&mut stream) {
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

    /// A `Read` that hands out at most `chunk` bytes per call however large a
    /// buffer it is given — the way a real socket delivers a reply split
    /// across segments. A `Cursor` cannot stand in for this: it fills the
    /// whole caller buffer, which is exactly the assumption the single-read
    /// reader wrongly makes.
    struct Dribble {
        data: Vec<u8>,
        pos: usize,
        chunk: usize,
    }

    impl Dribble {
        fn new(data: &[u8], chunk: usize) -> Self {
            Self {
                data: data.to_vec(),
                pos: 0,
                chunk,
            }
        }
    }

    impl Read for Dribble {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = buf.len().min(self.chunk).min(self.data.len() - self.pos);
            buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    /// The greeting arrives one byte at a time. Classifying the first read
    /// sees `"2"` — code 2, outside `200..400` — so a healthy server would be
    /// reported `Failed`.
    #[test]
    fn read_reply_assembles_a_status_line_delivered_one_byte_at_a_time() {
        let mut r = Dribble::new(b"220 host ESMTP\r\n", 1);
        assert_eq!(read_reply(&mut r).unwrap(), 220);
    }

    /// An `EHLO` reply is commonly multiline (`250-…` … `250 ok`). Every
    /// continuation line must be consumed, or the *next* command parses its
    /// code out of this reply's tail.
    #[test]
    fn read_reply_consumes_every_line_of_a_multiline_continuation() {
        let mut r = Dribble::new(b"250-first\r\n250-second\r\n250 ok\r\n220 next\r\n", 3);
        assert_eq!(read_reply(&mut r).unwrap(), 250);
        assert_eq!(
            read_reply(&mut r).unwrap(),
            220,
            "the reply after a multiline continuation was misparsed — the reader left the \
             previous reply's tail in the stream"
        );
    }

    /// A peer that closes without sending anything is an error, not a `0` code.
    #[test]
    fn read_reply_errors_when_the_peer_closes_without_a_reply() {
        let mut r = Dribble::new(b"", 1);
        assert!(read_reply(&mut r).is_err());
    }

    /// End-to-end through [`SmtpChannel::send`] against a server that speaks a
    /// realistic dialogue: the greeting and the *multiline* `EHLO` reply are
    /// each split across two segments. Before this fix the client classified a
    /// single read, so the split lines desynced every later reply and a mail
    /// the server had accepted was reported `Failed` — which the dispatcher
    /// turns into an operator fallback for an alert that really landed.
    #[test]
    fn send_survives_a_greeting_and_multiline_ehlo_split_across_segments() {
        use std::io::{BufRead, BufReader};
        use std::net::TcpListener;
        use std::thread;
        use std::time::Duration;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut w = stream.try_clone().unwrap();
            let mut r = BufReader::new(stream);
            let mut line = String::new();

            // Greeting, split mid-token.
            let _ = w.write_all(b"220 fake ");
            let _ = w.flush();
            thread::sleep(Duration::from_millis(20));
            let _ = w.write_all(b"ESMTP\r\n");

            // EHLO → a multiline reply, split between the two lines.
            r.read_line(&mut line).unwrap();
            let _ = w.write_all(b"250-fake\r\n");
            let _ = w.flush();
            thread::sleep(Duration::from_millis(20));
            let _ = w.write_all(b"250 OK\r\n");

            // MAIL FROM / RCPT TO / DATA, one reply each.
            for (expect, reply) in [
                ("MAIL FROM", "250 OK\r\n"),
                ("RCPT TO", "250 OK\r\n"),
                ("DATA", "354 Send it\r\n"),
            ] {
                line.clear();
                r.read_line(&mut line).unwrap();
                assert!(
                    line.starts_with(expect),
                    "server saw {line:?}, expected {expect}"
                );
                let _ = w.write_all(reply.as_bytes());
            }

            // Body, terminated by "." on its own line.
            loop {
                line.clear();
                r.read_line(&mut line).unwrap();
                if line == ".\r\n" {
                    break;
                }
            }
            let _ = w.write_all(b"250 OK\r\n");

            line.clear();
            r.read_line(&mut line).unwrap(); // QUIT
            let _ = w.write_all(b"221 Bye\r\n");
        });

        let ch = SmtpChannel::new(
            format!("127.0.0.1:{port}"),
            "amos@localhost",
            vec!["ops@localhost".into()],
        );
        assert_eq!(
            ch.send(&Alert::p0("db.unreachable", "down")),
            SendOutcome::Sent
        );
        server.join().unwrap();
    }
}

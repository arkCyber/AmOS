//! Real SMTP sending via `lettre` (feature `live`).
//!
//! A `SendDraft` is turned into a `lettre::Message` and transmitted over SMTP.
//! TLS features are left disabled so the default `live` build stays light; the
//! no-TLS transport (`builder_dangerous`) is what lets us **verify sending
//! offline** against a local SMTP sink in the tests below. Add `rustls-tls` to
//! `lettre` and a `starttls_relay` path when real external relays are needed.

use std::time::{SystemTime, UNIX_EPOCH};

use lettre::message::header::ContentType;
use lettre::message::{Attachment as MailAttachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::SmtpTransport;
use lettre::{Message, Transport};

use crate::error::{MailError, Result};
use crate::model::{Address, SendDraft, SendReceipt};

/// SMTP relay configuration.
#[derive(Clone, Debug)]
pub struct SmtpConfig {
    /// Server host (e.g. `smtp.example.com` or `127.0.0.1`).
    pub host: String,
    /// Server port (587 / 465, or an ephemeral local port in tests).
    pub port: u16,
    /// Optional AUTH username.
    pub username: Option<String>,
    /// Optional AUTH password.
    pub password: Option<String>,
    /// Use STARTTLS (`starttls_relay`). Required for real relays such as Gmail.
    pub tls: bool,
}

impl SmtpConfig {
    /// A relay with no authentication (best for a local/trusted server).
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            username: None,
            password: None,
            tls: false,
        }
    }

    /// Set AUTH credentials.
    pub fn credentials(mut self, username: impl Into<String>, password: impl Into<String>) -> Self {
        self.username = Some(username.into());
        self.password = Some(password.into());
        self
    }

    /// Require STARTTLS (for real relays such as `smtp.gmail.com`).
    pub fn tls(mut self) -> Self {
        self.tls = true;
        self
    }
}

/// Render an [`Address`] as a `lettre` mailbox string.
fn mailbox_for(a: &Address) -> std::result::Result<Mailbox, String> {
    let rendered = if a.name.trim().is_empty() {
        a.email.clone()
    } else {
        format!("{} <{}>", a.name, a.email)
    };
    rendered
        .parse::<Mailbox>()
        .map_err(|e| format!("invalid mailbox {rendered:?}: {e}"))
}

/// Build a `lettre::Message` from a draft (no network involved).
fn build_message(draft: &SendDraft) -> std::result::Result<Message, MailError> {
    if !draft.has_recipients() {
        return Err(MailError::NoRecipient);
    }
    let from = draft.from.as_ref().ok_or(MailError::MissingSender)?;
    let mut builder = Message::builder();
    builder = builder
        .from(mailbox_for(from).map_err(provider_err)?)
        .subject(draft.subject.clone());
    for to in &draft.to {
        builder = builder.to(mailbox_for(to).map_err(provider_err)?);
    }
    for cc in &draft.cc {
        builder = builder.cc(mailbox_for(cc).map_err(provider_err)?);
    }
    for bcc in &draft.bcc {
        builder = builder.bcc(mailbox_for(bcc).map_err(provider_err)?);
    }
    // The declared HTML alternative must reach the wire: when the draft carries
    // one, transmit a `multipart/alternative` so the relay sees both bodies.
    // Previously only `body_plain` was ever rendered, so `SendDraft::html(..)`
    // was silently dropped — a declared capability with no code path.
    if draft.attachments.is_empty() {
        return match draft.body_html.clone() {
            Some(html) => builder
                .multipart(MultiPart::alternative_plain_html(
                    draft.body_plain.clone(),
                    html,
                ))
                .map_err(provider_err),
            None => builder.body(draft.body_plain.clone()).map_err(provider_err),
        };
    }
    // With attachments the message is `multipart/mixed`: the body first (an
    // alternative when an HTML body exists, else a single `text/plain` part),
    // then one part per attached file. A draft whose `attachments` were built by
    // the caller — the CLI `--attach` path reads the file's bytes into them —
    // used to reach `build_message` and vanish: the loop over `draft.attachments`
    // did not exist, so the relay got a message with no files (REQ-A1691).
    let mut mixed = match draft.body_html.clone() {
        Some(html) => MultiPart::mixed().multipart(MultiPart::alternative_plain_html(
            draft.body_plain.clone(),
            html,
        )),
        None => MultiPart::mixed().singlepart(SinglePart::plain(draft.body_plain.clone())),
    };
    for att in &draft.attachments {
        // An unparseable MIME type is a refusal, not a silent fallback to
        // `text/plain`: the sender declared a type and we cannot honour it.
        let content_type: ContentType = att.mime.parse().map_err(provider_err)?;
        mixed = mixed.singlepart(
            MailAttachment::new(att.filename.clone()).body(att.data.clone(), content_type),
        );
    }
    builder.multipart(mixed).map_err(provider_err)
}

fn provider_err<E: std::fmt::Display>(e: E) -> MailError {
    MailError::Provider(e.to_string())
}

/// Send a draft over SMTP and return a receipt (id is informational; SMTP has
/// no server-side mailbox, so it is derived from the current time).
pub fn send(cfg: &SmtpConfig, draft: &SendDraft) -> Result<SendReceipt> {
    let msg = build_message(draft)?;

    let mailer = if cfg.tls {
        // STARTTLS transport (real relays such as smtp.gmail.com).
        let mut builder = SmtpTransport::starttls_relay(&cfg.host)
            .map_err(provider_err)?
            .port(cfg.port);
        if let (Some(user), Some(pass)) = (&cfg.username, &cfg.password) {
            builder = builder.credentials(Credentials::new(user.clone(), pass.clone()));
        }
        builder.build()
    } else {
        let mut builder = SmtpTransport::builder_dangerous(&cfg.host).port(cfg.port);
        if let (Some(user), Some(pass)) = (&cfg.username, &cfg.password) {
            builder = builder.credentials(Credentials::new(user.clone(), pass.clone()));
        }
        builder.build()
    };
    mailer.send(&msg).map_err(provider_err)?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok(SendReceipt {
        id: format!("smtp-{now}"),
        date: now,
        // `mailer.send` above returned Ok: the relay accepted the message for
        // delivery. That is the only path that may claim `delivered`.
        delivered: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Attachment;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};

    fn reply(s: &mut TcpStream, line: &str) {
        let _ = s.write_all(line.as_bytes());
        let _ = s.flush();
    }

    /// Serve one very small SMTP conversation, capturing the message DATA.
    fn handle(mut s: TcpStream, cap: &Mutex<Vec<String>>) {
        reply(&mut s, "220 localhost ESMTP amos\r\n");
        let reader = BufReader::new(s.try_clone().unwrap());
        let mut collecting = false;
        let mut data: Vec<String> = Vec::new();
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let t = line.trim_end_matches(['\r', '\n']);
            let upper = t.to_uppercase();
            if collecting {
                if t == "." {
                    cap.lock().unwrap().extend(data.drain(..));
                    reply(&mut s, "250 2.0.0 Ok: queued\r\n");
                    collecting = false;
                } else {
                    data.push(t.to_string());
                }
                continue;
            }
            if upper.starts_with("EHLO") || upper.starts_with("HELO") {
                reply(&mut s, "250-localhost\r\n250 8BITMIME\r\n");
            } else if upper.starts_with("MAIL FROM") || upper.starts_with("RCPT TO") {
                reply(&mut s, "250 Ok\r\n");
            } else if upper == "DATA" {
                collecting = true;
                reply(&mut s, "354 End data with <CR><LF>.<CR><LF>\r\n");
            } else if upper == "QUIT" {
                reply(&mut s, "221 Bye\r\n");
                break;
            } else {
                reply(&mut s, "250 Ok\r\n");
            }
        }
    }

    fn run_sink() -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let cap: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let cap2 = Arc::clone(&cap);
        std::thread::spawn(move || {
            if let Ok(stream) = listener.incoming().next().unwrap() {
                handle(stream, &cap2);
            }
        });
        (port, cap)
    }

    #[test]
    fn send_delivers_to_a_local_smtp_sink() {
        let (port, cap) = run_sink();
        let cfg = SmtpConfig::new("127.0.0.1", port);
        let draft = SendDraft {
            from: Some(Address::new("Alice", "a@x.io").unwrap()),
            to: vec![Address::bare("bob@y.io").unwrap()],
            subject: "Hello from live".into(),
            body_plain: "body text for the sink".into(),
            ..SendDraft::default()
        };

        let rcpt = send(&cfg, &draft).unwrap();
        assert!(rcpt.id.starts_with("smtp-"));
        assert!(
            rcpt.delivered,
            "the relay accepted the message, so this is the one path that may \
             claim delivery"
        );

        std::thread::sleep(std::time::Duration::from_millis(200));
        let text = cap.lock().unwrap().join("\n").to_lowercase();
        assert!(text.contains("hello from live"), "subject missing:\n{text}");
        assert!(text.contains("bob@y.io"), "recipient missing:\n{text}");
        assert!(
            text.contains("body text for the sink"),
            "body missing:\n{text}"
        );
    }

    #[test]
    fn html_body_is_transmitted_as_a_multipart_alternative() {
        // `SendDraft::html(..)` must actually reach the wire. Before this fix
        // `build_message` rendered only `body_plain`, so the declared HTML body
        // was silently dropped on the only transmit path there is.
        let (port, cap) = run_sink();
        let cfg = SmtpConfig::new("127.0.0.1", port);
        let draft = SendDraft::new(
            vec![Address::bare("bob@y.io").unwrap()],
            "rich",
            "plain fallback",
        )
        .unwrap()
        .from(Address::bare("a@x.io").unwrap())
        .html("<b>rich</b>");

        send(&cfg, &draft).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let text = cap.lock().unwrap().join("\n").to_lowercase();
        assert!(
            text.contains("multipart/alternative"),
            "no alternative part:\n{text}"
        );
        assert!(text.contains("<b>rich</b>"), "html body missing:\n{text}");
        assert!(
            text.contains("plain fallback"),
            "plain fallback missing:\n{text}"
        );
    }

    #[test]
    fn an_attachment_reaches_the_wire_as_a_base64_part() {
        // `draft.attachments` (as the CLI `--attach` builds them) must actually
        // be transmitted. Before this fix `build_message` never looked at the
        // field, so a file the user attached was silently dropped on the only
        // transmit path there is.
        let (port, cap) = run_sink();
        let cfg = SmtpConfig::new("127.0.0.1", port);
        // Bytes that are not 7-bit clean, so the transfer encoding is base64 and
        // the payload is recognisable on the wire.
        let data = vec![0x00u8, 0x01, 0x02, 0xff];
        let draft = SendDraft::new(
            vec![Address::bare("bob@y.io").unwrap()],
            "with file",
            "see attach",
        )
        .unwrap()
        .from(Address::bare("a@x.io").unwrap())
        .attach(Attachment {
            filename: "notes.bin".into(),
            mime: "application/octet-stream".into(),
            data: data.clone(),
        });

        send(&cfg, &draft).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let text = cap.lock().unwrap().join("\n").to_lowercase();
        assert!(
            text.contains("multipart/mixed"),
            "an attachment forces multipart/mixed:\n{text}"
        );
        assert!(
            text.contains("filename=\"notes.bin\""),
            "the attachment's name must reach the relay:\n{text}"
        );
        assert!(
            text.contains("content-transfer-encoding: base64"),
            "a binary payload must be base64-encoded as a part:\n{text}"
        );
        // base64 of `00 01 02 ff` is `AAEC/w==`.
        assert!(
            text.contains("aaec/w=="),
            "the attachment's bytes must be transmitted:\n{text}"
        );
    }

    #[test]
    fn an_html_body_plus_an_attachment_keeps_both() {
        // The alternative (plain+html) body nests inside the mixed message; the
        // fix must not trade one for the other.
        let (port, cap) = run_sink();
        let cfg = SmtpConfig::new("127.0.0.1", port);
        let draft = SendDraft::new(
            vec![Address::bare("bob@y.io").unwrap()],
            "rich+file",
            "plain fallback",
        )
        .unwrap()
        .from(Address::bare("a@x.io").unwrap())
        .html("<b>rich</b>")
        .attach(Attachment {
            filename: "notes.txt".into(),
            mime: "text/plain".into(),
            data: b"payload-bytes".to_vec(),
        });

        send(&cfg, &draft).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let text = cap.lock().unwrap().join("\n").to_lowercase();
        assert!(text.contains("multipart/mixed"), "no mixed part:\n{text}");
        assert!(
            text.contains("multipart/alternative"),
            "the html alternative must survive alongside the file:\n{text}"
        );
        assert!(
            text.contains("filename=\"notes.txt\""),
            "the file must still be attached:\n{text}"
        );
    }

    #[test]
    fn an_unparseable_attachment_mime_is_a_refusal() {
        // A declared type we cannot honour is an error, not a silent fallback.
        let draft = SendDraft::new(vec![Address::bare("bob@y.io").unwrap()], "bad", "body")
            .unwrap()
            .from(Address::bare("a@x.io").unwrap())
            .attach(Attachment {
                filename: "x.bin".into(),
                mime: "not a mime type".into(),
                data: vec![1, 2, 3],
            });
        let err =
            build_message(&draft).expect_err("an unparseable attachment MIME must be refused");
        assert!(
            matches!(err, MailError::Provider(_)),
            "the refusal must name the provider error: {err:?}"
        );
    }
}

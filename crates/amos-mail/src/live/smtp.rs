//! Real SMTP sending via `lettre` (feature `live`).
//!
//! A `SendDraft` is turned into a `lettre::Message` and transmitted over SMTP.
//! TLS features are left disabled so the default `live` build stays light; the
//! no-TLS transport (`builder_dangerous`) is what lets us **verify sending
//! offline** against a local SMTP sink in the tests below. Add `rustls-tls` to
//! `lettre` and a `starttls_relay` path when real external relays are needed.

use std::time::{SystemTime, UNIX_EPOCH};

use lettre::message::Mailbox;
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
    builder.body(draft.body_plain.clone()).map_err(provider_err)
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;
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

        std::thread::sleep(std::time::Duration::from_millis(200));
        let text = cap.lock().unwrap().join("\n").to_lowercase();
        assert!(text.contains("hello from live"), "subject missing:\n{text}");
        assert!(text.contains("bob@y.io"), "recipient missing:\n{text}");
        assert!(
            text.contains("body text for the sink"),
            "body missing:\n{text}"
        );
    }
}

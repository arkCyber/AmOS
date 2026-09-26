//! A [`crate::MailProvider`] that pairs the IMAP read side with the SMTP send
//! side, so the **same** provider can both read the mailbox and deliver a draft.
//!
//! `LiveImapProvider` (read-only) made `MailProvider::send` structurally
//! impossible to satisfy — it always returned an error — and the CLI delivered
//! by calling `smtp::send` *directly*, bypassing the provider seam. So the trait
//! method every caller reaches through [`crate::MailClient::send`] could never
//! work on a live account: a capability with no implementation (REQ-A1770).
//!
//! This provider closes that gap. It holds the read side ([`LiveImapProvider`],
//! optional) and a [`SmtpConfig`]; read operations delegate to the IMAP module,
//! and `send` delegates to [`smtp::send`]. Built with a send-only SMTP relay it
//! reports `name() == "smtp"`; with both halves it is `"imap+smtp"` — the id the
//! Tauri bridge's status already promises.

use async_trait::async_trait;

use crate::error::{MailError, Result};
use crate::live::imap_provider::LiveImapProvider;
use crate::live::smtp::{self, SmtpConfig};
use crate::model::{Email, EmailSummary, SendDraft, SendReceipt};
use crate::MailProvider;

/// A live provider over IMAP (read) and SMTP (send).
#[derive(Clone, Debug)]
pub struct ImapSmtpProvider {
    /// The read half. `None` builds a send-only provider (the CLI `send --smtp`
    /// path has a relay but no mailbox to read).
    imap: Option<LiveImapProvider>,
    smtp: SmtpConfig,
}

impl ImapSmtpProvider {
    /// Pair an IMAP read side with an SMTP relay.
    pub fn new(imap: LiveImapProvider, smtp: SmtpConfig) -> Self {
        Self {
            imap: Some(imap),
            smtp,
        }
    }

    /// A provider with only the SMTP relay: `send` works, reads are refused.
    pub fn send_only(smtp: SmtpConfig) -> Self {
        Self { imap: None, smtp }
    }

    /// The read half, or a refusal naming *why* it is absent (this provider was
    /// built for sending). Returning `Ok(empty)` instead would make an
    /// unconfigured account read as an empty mailbox.
    fn reader(&self) -> Result<&LiveImapProvider> {
        self.imap.as_ref().ok_or_else(|| {
            MailError::Provider(
                "live: this provider was built for sending only — no IMAP account is configured"
                    .into(),
            )
        })
    }
}

#[async_trait]
impl MailProvider for ImapSmtpProvider {
    fn name(&self) -> &'static str {
        if self.imap.is_some() {
            "imap+smtp"
        } else {
            "smtp"
        }
    }

    async fn list_mailboxes(&self) -> Result<Vec<String>> {
        self.reader()?.list_mailboxes().await
    }

    async fn list(&self, mailbox: &str, limit: Option<usize>) -> Result<Vec<EmailSummary>> {
        self.reader()?.list(mailbox, limit).await
    }

    async fn search(&self, mailbox: &str, query: &str) -> Result<Vec<EmailSummary>> {
        self.reader()?.search(mailbox, query).await
    }

    async fn fetch(&self, mailbox: &str, id: &str) -> Result<Email> {
        self.reader()?.fetch(mailbox, id).await
    }

    async fn fetch_attachment(
        &self,
        mailbox: &str,
        email_id: &str,
        attachment_id: &str,
    ) -> Result<Vec<u8>> {
        self.reader()?
            .fetch_attachment(mailbox, email_id, attachment_id)
            .await
    }

    /// Deliver through the SMTP relay. This is the seam a live `MailClient::send`
    /// reaches; before this provider existed it could only ever error.
    async fn send(&self, draft: SendDraft) -> Result<SendReceipt> {
        smtp::send(&self.smtp, &draft)
    }

    async fn set_seen(&self, mailbox: &str, id: &str, seen: bool) -> Result<()> {
        self.reader()?.set_seen(mailbox, id, seen).await
    }

    async fn set_flagged(&self, mailbox: &str, id: &str, flagged: bool) -> Result<()> {
        self.reader()?.set_flagged(mailbox, id, flagged).await
    }

    async fn set_answered(&self, mailbox: &str, id: &str, answered: bool) -> Result<()> {
        self.reader()?.set_answered(mailbox, id, answered).await
    }

    async fn delete(&self, mailbox: &str, id: &str) -> Result<()> {
        self.reader()?.delete(mailbox, id).await
    }

    async fn move_to(&self, mailbox: &str, id: &str, target: &str) -> Result<()> {
        self.reader()?.move_to(mailbox, id, target).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::Account;
    use crate::live::imap::ImapConfig;
    use crate::model::Address;
    use crate::MailClient;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};

    fn account() -> Account {
        Account::new("demo", "Me", Address::bare("me@x.io").unwrap()).unwrap()
    }

    /// A local SMTP sink that captures the DATA section of one message.
    fn smtp_sink() -> (u16, Arc<Mutex<Vec<String>>>) {
        fn reply(s: &mut TcpStream, line: &str) {
            let _ = s.write_all(line.as_bytes());
            let _ = s.flush();
        }
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

    /// The seam's `send` must actually reach the relay. Before this provider the
    /// only live `MailProvider::send` always errored, so a caller using
    /// `MailClient::send` could never send on a live account (REQ-A1770).
    #[tokio::test]
    async fn send_through_the_provider_seam_reaches_the_relay() {
        let (port, cap) = smtp_sink();
        let provider = ImapSmtpProvider::send_only(SmtpConfig::new("127.0.0.1", port));
        let client = MailClient::new(provider, account());

        // No sender set: `MailClient::send` fills it from the account, so this
        // also proves the seam uses the account the same way the mock does.
        let draft = SendDraft::new(
            vec![Address::bare("bob@y.io").unwrap()],
            "via seam",
            "sent through MailProvider::send",
        )
        .unwrap();
        let rcpt = client
            .send(draft)
            .await
            .expect("the provider seam must deliver over SMTP");
        assert!(
            rcpt.delivered,
            "the relay accepted the message; this is the one path that may claim delivery"
        );

        std::thread::sleep(std::time::Duration::from_millis(200));
        let text = cap.lock().unwrap().join("\n").to_lowercase();
        assert!(text.contains("via seam"), "subject missing:\n{text}");
        assert!(
            text.contains("sent through mailprovider::send"),
            "body missing:\n{text}"
        );
        assert!(text.contains("bob@y.io"), "recipient missing:\n{text}");
    }

    /// A send-only provider has no mailbox to read: it must say so, not answer
    /// as an empty inbox.
    #[tokio::test]
    async fn reads_on_a_send_only_provider_are_refused_not_empty() {
        let provider = ImapSmtpProvider::send_only(SmtpConfig::new("127.0.0.1", 25));
        let client = MailClient::new(provider, account());
        let err = client
            .inbox(None)
            .await
            .expect_err("a send-only provider must refuse a read, not report an empty inbox");
        match err {
            MailError::Provider(m) => assert!(
                m.contains("sending only"),
                "the refusal must name the reason: {m}"
            ),
            other => panic!("expected a provider refusal, got {other:?}"),
        }
        assert_eq!(client.provider_name(), "smtp");
    }

    /// With both halves attached the provider reports the `"imap+smtp"` id the
    /// Tauri bridge's status already promises, and reads delegate to IMAP.
    #[tokio::test]
    async fn a_paired_provider_reads_over_imap_and_reports_imap_plus_smtp() {
        use std::io::{BufRead, BufReader as StdBufReader, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok(mut stream) = listener.incoming().next().unwrap() {
                let _ = stream.write_all(b"* OK ready\r\n");
                let _ = stream.flush();
                let mut reader = StdBufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    let tag = line.split_whitespace().next().unwrap_or("").to_string();
                    let upper = line.to_uppercase();
                    let send = |stream: &mut std::net::TcpStream, data: &[u8]| {
                        let _ = stream.write_all(data);
                        let _ = stream.flush();
                    };
                    if upper.contains("LIST") {
                        send(&mut stream, b"* LIST () \"/\" \"INBOX\"\r\n");
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    } else {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    }
                }
            }
        });

        let provider = ImapSmtpProvider::new(
            LiveImapProvider::new(ImapConfig::new("127.0.0.1", port, "u", "p")),
            SmtpConfig::new("127.0.0.1", 25),
        );
        let client = MailClient::new(provider, account());
        assert_eq!(client.provider_name(), "imap+smtp");
        let boxes = client.mailboxes().await.unwrap();
        assert!(boxes.iter().any(|b| b == "INBOX"), "{boxes:?}");
    }
}

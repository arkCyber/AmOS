//! A read-side [`crate::MailProvider`] over a live IMAP server (feature `live`).
//!
//! Bridges the engine seam to real IMAP for the operations we can do reliably
//! today: list mailboxes, list INBOX summaries (headers), and mark read/unread.
//! Everything else returns a clear "not implemented over live yet" error rather
//! than pretending to work. It is verified offline against a canned local IMAP
//! server; connecting a real server (Dovecot/GreenMail/etc.) is still needed to
//! prove full wire compatibility with real messages.

use async_trait::async_trait;

use crate::error::{MailError, Result};
use crate::live::imap;
use crate::model::{Email, EmailFlags, EmailSummary, SendDraft, SendReceipt, INBOX};
use crate::MailProvider;

/// A `MailProvider` that talks to a real IMAP server per operation.
#[derive(Clone, Debug)]
pub struct LiveImapProvider {
    cfg: imap::ImapConfig,
}

impl LiveImapProvider {
    pub fn new(cfg: imap::ImapConfig) -> Self {
        Self { cfg }
    }
}

fn seq_of(id: &str) -> Result<u32> {
    id.strip_prefix("seq-")
        .ok_or_else(|| MailError::Provider(format!("live: expected a seq-<N> id, got {id:?}")))?
        .parse()
        .map_err(|_| MailError::Provider(format!("live: bad seq id {id:?}")))
}

#[async_trait]
impl MailProvider for LiveImapProvider {
    fn name(&self) -> &'static str {
        "live-imap"
    }

    async fn list_mailboxes(&self) -> Result<Vec<String>> {
        imap::list_mailboxes(&self.cfg).await
    }

    async fn list(&self, mailbox: &str, limit: Option<usize>) -> Result<Vec<EmailSummary>> {
        if mailbox != INBOX {
            return Err(MailError::Provider(format!(
                "live: listing {mailbox:?} is not yet supported (only INBOX)"
            )));
        }
        imap::fetch_inbox_summaries(&self.cfg, limit.unwrap_or(200)).await
    }

    async fn fetch(&self, mailbox: &str, id: &str) -> Result<Email> {
        if mailbox != INBOX {
            return Err(MailError::Provider(format!(
                "live: fetching from {mailbox:?} is not yet supported (only INBOX)"
            )));
        }
        let seq = seq_of(id)?;
        // Find the matching summary for headers, then attach the body.
        let summaries = imap::fetch_inbox_summaries(&self.cfg, 500).await?;
        let summary = summaries
            .into_iter()
            .find(|s| s.id == id)
            .unwrap_or(EmailSummary {
                id: format!("seq-{seq}"),
                mailbox: INBOX.into(),
                from: None,
                to: Vec::new(),
                subject: String::new(),
                date: 0,
                flags: EmailFlags::default(),
                attachment_count: 0,
            });
        let body_plain = imap::fetch_message_body(&self.cfg, seq).await?;
        Ok(Email {
            summary,
            body_plain,
            body_html: None,
            attachments: Vec::new(),
        })
    }

    async fn fetch_attachment(&self, _m: &str, _e: &str, _a: &str) -> Result<Vec<u8>> {
        Err(MailError::Provider(
            "live: attachment download not yet supported".into(),
        ))
    }

    async fn send(&self, _draft: SendDraft) -> Result<SendReceipt> {
        Err(MailError::Provider(
            "live: sending is handled by the SMTP provider, not IMAP".into(),
        ))
    }

    async fn set_seen(&self, mailbox: &str, id: &str, seen: bool) -> Result<()> {
        if mailbox != INBOX {
            return Err(MailError::Provider(format!(
                "live: set_seen on {mailbox:?} not yet supported"
            )));
        }
        let seq = seq_of(id)?;
        imap::store_seen(&self.cfg, seq, seen).await
    }

    async fn set_flagged(&self, mailbox: &str, id: &str, flagged: bool) -> Result<()> {
        if mailbox != INBOX {
            return Err(MailError::Provider(format!(
                "live: set_flagged on {mailbox:?} not yet supported"
            )));
        }
        let seq = seq_of(id)?;
        imap::store_flagged(&self.cfg, seq, flagged).await
    }

    async fn search(&self, _mailbox: &str, _query: &str) -> Result<Vec<EmailSummary>> {
        Err(MailError::Provider(
            "live: server-side search not yet supported".into(),
        ))
    }

    async fn delete(&self, mailbox: &str, id: &str) -> Result<()> {
        if mailbox != INBOX {
            return Err(MailError::Provider(format!(
                "live: delete on {mailbox:?} not yet supported"
            )));
        }
        let seq = seq_of(id)?;
        imap::delete_message(&self.cfg, seq).await
    }

    async fn move_to(&self, mailbox: &str, id: &str, target: &str) -> Result<()> {
        if mailbox != INBOX {
            return Err(MailError::Provider(format!(
                "live: move from {mailbox:?} not yet supported"
            )));
        }
        let seq = seq_of(id)?;
        imap::move_message(&self.cfg, seq, target).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::Account;
    use crate::live::imap::ImapConfig;
    use crate::model::Address;
    use crate::MailClient;

    fn account() -> Account {
        Account::new("demo", "Me", Address::bare("me@x.io").unwrap()).unwrap()
    }

    #[tokio::test]
    async fn mailboxes_via_live_provider() {
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
                    if upper.contains("LOGIN") || upper.contains("SELECT") {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    } else if upper.contains("LIST") {
                        send(&mut stream, b"* LIST () \"/\" \"INBOX\"\r\n");
                        send(&mut stream, b"* LIST () \"/\" \"Sent\"\r\n");
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    } else {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    }
                }
            }
        });

        let provider = LiveImapProvider::new(ImapConfig::new("127.0.0.1", port, "u", "p"));
        let client = MailClient::new(provider, account());
        let boxes = client.mailboxes().await.unwrap();
        assert!(boxes.iter().any(|b| b == "INBOX"), "{boxes:?}");
        assert!(boxes.iter().any(|b| b == "Sent"), "{boxes:?}");
    }

    #[tokio::test]
    async fn set_seen_via_live_provider() {
        use std::io::{BufRead, BufReader as StdBufReader, Write};
        use std::net::TcpListener;
        use std::sync::{Arc, Mutex};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let cmds: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let cmds2 = Arc::clone(&cmds);
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
                    if upper.contains("STORE") {
                        cmds2.lock().unwrap().push(line.trim().to_string());
                    }
                    let send = |stream: &mut std::net::TcpStream, data: &[u8]| {
                        let _ = stream.write_all(data);
                        let _ = stream.flush();
                    };
                    send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                }
            }
        });

        let provider = LiveImapProvider::new(ImapConfig::new("127.0.0.1", port, "u", "p"));
        let client = MailClient::new(provider, account());
        client.set_seen(INBOX, "seq-1", true).await.unwrap();
        let got = cmds.lock().unwrap().clone();
        assert!(got.iter().any(|c| c.contains("+FLAGS (\\Seen)")), "{got:?}");
    }
}

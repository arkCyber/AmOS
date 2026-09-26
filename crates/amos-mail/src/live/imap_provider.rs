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
use crate::model::{Email, EmailSummary, SendDraft, SendReceipt, INBOX};
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

fn uid_of(id: &str) -> Result<u32> {
    id.strip_prefix("uid-")
        .ok_or_else(|| MailError::Provider(format!("live: expected a uid-<N> id, got {id:?}")))?
        .parse()
        .map_err(|_| MailError::Provider(format!("live: bad uid id {id:?}")))
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
        let uid = uid_of(id)?;
        // Find the matching summary for headers, then attach the body. A message
        // that is not in the list does not exist: synthesising an empty summary
        // would make the screen draw a blank mail (no sender, no subject, epoch
        // date) as if the server had answered with one (REQ-A1692).
        let summaries = imap::fetch_inbox_summaries(&self.cfg, 500).await?;
        let summary =
            summaries
                .into_iter()
                .find(|s| s.id == id)
                .ok_or_else(|| MailError::NotFound {
                    mailbox: INBOX.to_string(),
                    id: id.to_string(),
                })?;
        let body_plain = imap::fetch_message_body(&self.cfg, uid).await?;
        // The opened message draws one chip per attachment, so the list must be
        // read from the message's `BODYSTRUCTURE` rather than handed back empty:
        // an empty `Vec` claims "this message has no files" for a message the
        // inbox row shows with `📎 2` (REQ-A1845).
        let attachments = imap::fetch_attachment_meta(&self.cfg, uid).await?;
        Ok(Email {
            summary,
            body_plain,
            body_html: None,
            attachments,
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
        let uid = uid_of(id)?;
        imap::store_seen(&self.cfg, uid, seen).await
    }

    async fn set_flagged(&self, mailbox: &str, id: &str, flagged: bool) -> Result<()> {
        if mailbox != INBOX {
            return Err(MailError::Provider(format!(
                "live: set_flagged on {mailbox:?} not yet supported"
            )));
        }
        let uid = uid_of(id)?;
        imap::store_flagged(&self.cfg, uid, flagged).await
    }

    async fn set_answered(&self, mailbox: &str, id: &str, answered: bool) -> Result<()> {
        if mailbox != INBOX {
            return Err(MailError::Provider(format!(
                "live: set_answered on {mailbox:?} not yet supported"
            )));
        }
        let uid = uid_of(id)?;
        imap::store_answered(&self.cfg, uid, answered).await
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
        let uid = uid_of(id)?;
        imap::delete_message(&self.cfg, uid).await
    }

    async fn move_to(&self, mailbox: &str, id: &str, target: &str) -> Result<()> {
        if mailbox != INBOX {
            return Err(MailError::Provider(format!(
                "live: move from {mailbox:?} not yet supported"
            )));
        }
        let uid = uid_of(id)?;
        imap::move_message(&self.cfg, uid, target).await
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

    /// A `uid-<N>` that is not in the mailbox does not exist: `fetch` must say
    /// `NotFound`, not hand back a synthesised empty message (no sender, no
    /// subject, epoch date) that the screen would draw as a real blank mail
    /// (REQ-A1692).
    #[tokio::test]
    async fn fetch_of_an_absent_uid_is_not_found_not_a_blank_message() {
        use std::io::{BufRead, BufReader as StdBufReader, Write};
        use std::net::TcpListener;

        let h1 = "From: Ada <ada@x.io>\r\nSubject: Hi\r\n";
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
                    if upper.contains("LOGIN") {
                        send(&mut stream, format!("{tag} OK login\r\n").as_bytes());
                    } else if upper.contains("SELECT") {
                        send(&mut stream, b"* 1 EXISTS\r\n");
                        send(&mut stream, format!("{tag} OK [READ-WRITE]\r\n").as_bytes());
                    } else if upper.contains("SEARCH") {
                        send(&mut stream, b"* SEARCH 42\r\n");
                        send(&mut stream, format!("{tag} OK search\r\n").as_bytes());
                    } else if upper.contains("FETCH") {
                        send(
                            &mut stream,
                            b"* 5 FETCH (UID 42 FLAGS () BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM SUBJECT)] {",
                        );
                        send(&mut stream, format!("{}}}\r\n", h1.len()).as_bytes());
                        send(&mut stream, h1.as_bytes());
                        send(&mut stream, b")\r\n");
                        send(&mut stream, format!("{tag} OK fetch\r\n").as_bytes());
                    } else if upper.contains("LOGOUT") {
                        send(&mut stream, format!("{tag} OK bye\r\n").as_bytes());
                        break;
                    } else {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    }
                }
            }
        });

        let provider = LiveImapProvider::new(ImapConfig::new("127.0.0.1", port, "u", "p"));
        let client = MailClient::new(provider, account());
        // The mailbox holds uid-42 only; ask for a uid that is not there.
        let err = client
            .fetch(INBOX, "uid-99")
            .await
            .expect_err("an absent uid must not become a blank message");
        assert_eq!(
            err,
            MailError::NotFound {
                mailbox: INBOX.to_string(),
                id: "uid-99".to_string(),
            },
            "the refusal must name the missing message"
        );
    }

    /// Opening a message the inbox row already counts two files for must carry
    /// those two attachments, read from the message's `BODYSTRUCTURE` — not hand
    /// back an empty list, which the opened-message screen draws as "no files".
    /// One `fetch` opens three sessions in turn (summaries, body, attachments)
    /// and the fake server answers each by the command it sees, so the test also
    /// fails if the provider stops asking the server for the structure.
    #[tokio::test]
    async fn fetch_carries_the_messages_attachment_metadata() {
        use std::io::{BufRead, BufReader as StdBufReader, Write};
        use std::net::TcpListener;

        let headers = "From: Ada <ada@x.io>\r\nTo: Me <me@x.io>\r\nSubject: Hi\r\n";
        let body = "hello there";
        // One text part then two attached files. The same structure rides the
        // summary reply too, so the row's own count is the premise this test
        // starts from: 📎 2 on the row, and two chips when it is opened.
        let structure = "((\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 4 NIL NIL NIL NIL)(\"APPLICATION\" \"PDF\" (\"NAME\" \"report.pdf\") NIL NIL \"BASE64\" 900 NIL (\"ATTACHMENT\" (\"FILENAME\" \"report.pdf\")) NIL NIL)(\"IMAGE\" \"PNG\" (\"NAME\" \"shot.png\") NIL NIL \"BASE64\" 40 NIL (\"ATTACHMENT\" (\"FILENAME\" \"shot.png\")) NIL NIL) \"MIXED\" (\"BOUNDARY\" \"b1\") NIL NIL)";

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for _ in 0..3 {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
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
                    if upper.contains("LOGIN") {
                        send(&mut stream, format!("{tag} OK login\r\n").as_bytes());
                    } else if upper.contains("SELECT") {
                        send(&mut stream, b"* 1 EXISTS\r\n");
                        send(&mut stream, format!("{tag} OK [READ-WRITE]\r\n").as_bytes());
                    } else if upper.contains("SEARCH") {
                        send(&mut stream, b"* SEARCH 42\r\n");
                        send(&mut stream, format!("{tag} OK search\r\n").as_bytes());
                    } else if upper.contains("HEADER.FIELDS") {
                        send(
                            &mut stream,
                            format!(
                                "* 5 FETCH (UID 42 FLAGS () INTERNALDATE \"15-Sep-2025 10:30:00 +0000\" BODYSTRUCTURE {structure} BODY[HEADER.FIELDS (FROM TO SUBJECT DATE)] {{"
                            )
                            .as_bytes(),
                        );
                        send(&mut stream, format!("{}}}\r\n", headers.len()).as_bytes());
                        send(&mut stream, headers.as_bytes());
                        send(&mut stream, b")\r\n");
                        send(&mut stream, format!("{tag} OK fetch\r\n").as_bytes());
                    } else if upper.contains("BODYSTRUCTURE") {
                        send(
                            &mut stream,
                            format!("* 5 FETCH (UID 42 BODYSTRUCTURE {structure})\r\n").as_bytes(),
                        );
                        send(&mut stream, format!("{tag} OK fetch\r\n").as_bytes());
                    } else if upper.contains("BODY.PEEK[TEXT]") {
                        send(&mut stream, b"* 5 FETCH (BODY[TEXT] {");
                        send(&mut stream, format!("{}}}\r\n", body.len()).as_bytes());
                        send(&mut stream, body.as_bytes());
                        send(&mut stream, b")\r\n");
                        send(&mut stream, format!("{tag} OK fetch\r\n").as_bytes());
                    } else if upper.contains("LOGOUT") {
                        send(&mut stream, format!("{tag} OK bye\r\n").as_bytes());
                        break;
                    } else {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    }
                }
            }
        });

        let provider = LiveImapProvider::new(ImapConfig::new("127.0.0.1", port, "u", "p"));
        let client = MailClient::new(provider, account());
        let email = client.fetch(INBOX, "uid-42").await.unwrap();
        // The premise: the row the user tapped counted two files...
        assert_eq!(email.summary.attachment_count, 2, "inbox row: 📎 2");
        // ...so the opened message must carry them, with their real shape.
        assert_eq!(email.attachments.len(), 2, "{:?}", email.attachments);
        assert_eq!(email.attachments[0].filename, "report.pdf");
        assert_eq!(email.attachments[0].mime, "application/pdf");
        assert_eq!(email.attachments[0].size, 900);
        assert_eq!(email.attachments[1].filename, "shot.png");
        assert_eq!(email.attachments[1].mime, "image/png");
        assert_eq!(email.attachments[1].size, 40);
        assert_ne!(
            email.attachments[0].id, email.attachments[1].id,
            "two chips must not share an id"
        );
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
        client.set_seen(INBOX, "uid-1", true).await.unwrap();
        let got = cmds.lock().unwrap().clone();
        assert!(got.iter().any(|c| c.contains("+FLAGS (\\Seen)")), "{got:?}");
    }

    #[tokio::test]
    async fn set_answered_via_live_provider() {
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
        client.set_answered(INBOX, "uid-1", true).await.unwrap();
        let got = cmds.lock().unwrap().clone();
        assert!(
            got.iter().any(|c| c.contains("+FLAGS (\\Answered)")),
            "{got:?}"
        );
    }
}

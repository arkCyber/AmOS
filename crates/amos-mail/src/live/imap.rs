//! Real IMAP reading (feature `live`).
//!
//! Speaks the real IMAP protocol over TCP, with optional implicit TLS
//! (`ImapConfig::tls()` for e.g. `imap.gmail.com:993`). Commands so far:
//! LOGIN/SELECT/SEARCH (unseen & all), LIST, FETCH (headers & body), STORE
//! (Seen/Flagged), delete (\Deleted + EXPUNGE) and move (COPY + delete). Each
//! operation is verified offline against a tiny in-process IMAP server in the
//! tests; TLS itself needs a real server to confirm the handshake.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use rustls::pki_types::ServerName;
use rustls::RootCertStore;
use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf,
};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream as ClientTlsStream;
use tokio_rustls::TlsConnector;

use crate::error::{MailError, Result};
use crate::model::{Address, EmailFlags, EmailSummary};

/// IMAP server configuration.
#[derive(Clone, Debug)]
pub struct ImapConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    /// Use implicit TLS (e.g. `imap.gmail.com:993`).
    pub tls: bool,
}

impl ImapConfig {
    pub fn new(
        host: impl Into<String>,
        port: u16,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Self {
        Self {
            host: host.into(),
            port,
            username: username.into(),
            password: password.into(),
            tls: false,
        }
    }

    /// Require implicit TLS (for real servers such as `imap.gmail.com`).
    pub fn tls(mut self) -> Self {
        self.tls = true;
        self
    }
}

/// Send one line and flush.
async fn cmd<W: AsyncWrite + Unpin>(w: &mut W, line: &str) -> std::io::Result<()> {
    w.write_all(line.as_bytes()).await?;
    w.write_all(b"\r\n").await?;
    w.flush().await
}

/// Read lines until a *tagged* response for `tag` arrives; return that line.
async fn await_tag<R: AsyncRead + Unpin>(
    r: &mut BufReader<R>,
    tag: &str,
) -> std::result::Result<String, MailError> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = r
            .read_line(&mut line)
            .await
            .map_err(|e| MailError::Provider(format!("imap read: {e}")))?;
        if n == 0 {
            return Err(MailError::Provider("imap: connection closed".into()));
        }
        if line.starts_with(tag) {
            return Ok(line);
        }
    }
}

/// Quote an IMAP string safely (no literals needed for typical credentials).
fn imap_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// Connect, log in, select the inbox and return the number of unseen messages.
pub async fn count_unseen(cfg: &ImapConfig) -> Result<u64> {
    let mut s = open_session(cfg).await?;

    // SEARCH UNSEEN.
    cmd(&mut s.write, "a3 SEARCH UNSEEN")
        .await
        .map_err(|e| MailError::Provider(format!("imap search write: {e}")))?;
    let mut count: u64 = 0;
    loop {
        let mut line = String::new();
        let n = s
            .reader
            .read_line(&mut line)
            .await
            .map_err(|e| MailError::Provider(format!("imap search read: {e}")))?;
        if n == 0 {
            return Err(MailError::Provider("imap: closed during search".into()));
        }
        if line.starts_with("* SEARCH") {
            count = line
                .split_whitespace()
                .skip(2)
                .filter_map(|tok| tok.parse::<u64>().ok())
                .count() as u64;
        } else if line.starts_with("a3 ") {
            if !line.contains("OK") {
                return Err(MailError::Provider(format!("imap search failed: {line:?}")));
            }
            return Ok(count);
        }
    }
}

/// Sequence numbers from a `* SEARCH …` response line.
fn parse_search_nums(line: &str) -> Vec<u32> {
    line.split_whitespace()
        .skip(2)
        .filter_map(|tok| tok.parse().ok())
        .collect()
}

/// Parse an RFC-ish `Name <email>` (or bare email) header value.
fn parse_addr(raw: &str) -> Option<Address> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(open) = raw.find('<') {
        let email = raw[open + 1..].split('>').next().unwrap_or("").to_string();
        let name = raw[..open].trim().to_string();
        return Address::new(name, email).ok();
    }
    Address::new("", raw).ok()
}

/// Grab the trailing IMAP literal size `{N}` from a line, if any.
fn literal_size(line: &str) -> Option<usize> {
    let start = line.rfind('{')?;
    let end = line[start..].find('}')? + start;
    line[start + 1..end].parse().ok()
}

/// Connect to the INBOX of a live IMAP server and fetch header summaries for up
/// to `max` newest messages. Verified offline against a canned local server.
pub async fn fetch_inbox_summaries(cfg: &ImapConfig, max: usize) -> Result<Vec<EmailSummary>> {
    let mut s = open_session(cfg).await?;
    let mut line = String::new();

    // SEARCH ALL to learn which sequence numbers exist.
    cmd(&mut s.write, "a3 SEARCH ALL")
        .await
        .map_err(|e| MailError::Provider(format!("imap search write: {e}")))?;
    let mut seqs: Vec<u32> = Vec::new();
    loop {
        line.clear();
        let n = s
            .reader
            .read_line(&mut line)
            .await
            .map_err(|e| MailError::Provider(format!("imap search read: {e}")))?;
        if n == 0 {
            return Err(MailError::Provider("imap: closed during search".into()));
        }
        if line.starts_with("* SEARCH") {
            seqs = parse_search_nums(&line);
        } else if line.starts_with("a3 ") {
            break;
        }
    }
    if seqs.is_empty() {
        return Ok(Vec::new());
    }
    let take = seqs.len().min(max.max(1));
    let wanted = seqs[seqs.len() - take..].to_vec();

    // FETCH headers + flags for those sequence numbers in one round trip.
    let list = wanted
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join(",");
    cmd(
        &mut s.write,
        &format!("a4 FETCH {list} (FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])"),
    )
    .await
    .map_err(|e| MailError::Provider(format!("imap fetch write: {e}")))?;

    let mut out: Vec<EmailSummary> = Vec::new();
    loop {
        line.clear();
        let n = s
            .reader
            .read_line(&mut line)
            .await
            .map_err(|e| MailError::Provider(format!("imap fetch read: {e}")))?;
        if n == 0 {
            return Err(MailError::Provider("imap: closed during fetch".into()));
        }
        if line.starts_with("a4 ") {
            break; // tagged completion
        }
        if !line.starts_with("* ") {
            continue;
        }
        // Untagged FETCH response: capture literal body if present.
        let Some(size) = literal_size(&line) else {
            continue;
        };
        let mut header_bytes = vec![0u8; size];
        s.reader
            .read_exact(&mut header_bytes)
            .await
            .map_err(|e| MailError::Provider(format!("imap literal read: {e}")))?;
        let header = String::from_utf8_lossy(&header_bytes);
        let seq = line
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        let seen = line.contains("\\Seen") || line.contains("\\seen");

        let mut subject = String::new();
        let mut from = None;
        for hline in header.lines() {
            let hline = hline.trim_end_matches('\r');
            if let Some(v) = hline.strip_prefix("Subject:") {
                subject = v.trim().to_string();
            } else if let Some(v) = hline.strip_prefix("From:") {
                from = parse_addr(v);
            }
        }
        out.push(EmailSummary {
            id: format!("seq-{seq}"),
            mailbox: "INBOX".into(),
            from,
            to: Vec::new(),
            subject,
            date: 0,
            flags: EmailFlags {
                seen,
                flagged: false,
                answered: false,
            },
            attachment_count: 0,
        });
    }
    Ok(out)
}

/// A TCP stream, optionally wrapped in implicit TLS.
#[allow(clippy::large_enum_variant)]
enum ConnStream {
    Plain(TcpStream),
    Tls(ClientTlsStream<TcpStream>),
}

impl AsyncRead for ConnStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            ConnStream::Plain(s) => Pin::new(s).poll_read(cx, buf),
            ConnStream::Tls(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for ConnStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            ConnStream::Plain(s) => Pin::new(s).poll_write(cx, buf),
            ConnStream::Tls(s) => Pin::new(s).poll_write(cx, buf),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            ConnStream::Plain(s) => Pin::new(s).poll_flush(cx),
            ConnStream::Tls(s) => Pin::new(s).poll_flush(cx),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            ConnStream::Plain(s) => Pin::new(s).poll_shutdown(cx),
            ConnStream::Tls(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

/// Connect to the server, wrapping the socket in implicit TLS when configured.
async fn connect_stream(cfg: &ImapConfig) -> Result<ConnStream> {
    let tcp = TcpStream::connect((cfg.host.as_str(), cfg.port))
        .await
        .map_err(|e| MailError::Provider(format!("imap connect {}:{}: {e}", cfg.host, cfg.port)))?;
    if !cfg.tls {
        return Ok(ConnStream::Plain(tcp));
    }
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));
    let name = ServerName::try_from(cfg.host.clone())
        .map_err(|e| MailError::Provider(format!("imap tls server name: {e}")))?;
    let tls = connector
        .connect(name, tcp)
        .await
        .map_err(|e| MailError::Provider(format!("imap tls handshake: {e}")))?;
    Ok(ConnStream::Tls(tls))
}

/// An open IMAP connection (already logged in and in the INBOX).
struct Session {
    reader: BufReader<tokio::io::ReadHalf<ConnStream>>,
    write: tokio::io::WriteHalf<ConnStream>,
}

/// Connect, greet, `LOGIN` and `SELECT INBOX`.
async fn open_session(cfg: &ImapConfig) -> Result<Session> {
    let stream = connect_stream(cfg).await?;
    let (read, write) = tokio::io::split(stream);
    let mut reader = BufReader::new(read);

    let mut line = String::new();
    let n = reader
        .read_line(&mut line)
        .await
        .map_err(|e| MailError::Provider(format!("imap greeting: {e}")))?;
    if n == 0 || !line.contains("OK") {
        return Err(MailError::Provider("imap: bad greeting".into()));
    }

    let mut write = write;
    cmd(
        &mut write,
        &format!(
            "a1 LOGIN {} {}",
            imap_quote(&cfg.username),
            imap_quote(&cfg.password)
        ),
    )
    .await
    .map_err(|e| MailError::Provider(format!("imap login write: {e}")))?;
    let tagged = await_tag(&mut reader, "a1 ").await?;
    if !tagged.contains("OK") {
        return Err(MailError::Provider(format!(
            "imap login failed: {tagged:?}"
        )));
    }

    cmd(&mut write, "a2 SELECT INBOX")
        .await
        .map_err(|e| MailError::Provider(format!("imap select write: {e}")))?;
    let tagged = await_tag(&mut reader, "a2 ").await?;
    if !tagged.contains("OK") {
        return Err(MailError::Provider(format!(
            "imap select failed: {tagged:?}"
        )));
    }

    Ok(Session { reader, write })
}

/// Fetch the plain-text body of a message by its IMAP sequence number.
pub async fn fetch_message_body(cfg: &ImapConfig, seq: u32) -> Result<String> {
    let mut s = open_session(cfg).await?;
    cmd(&mut s.write, &format!("a3 FETCH {seq} (BODY.PEEK[TEXT])"))
        .await
        .map_err(|e| MailError::Provider(format!("imap body write: {e}")))?;
    let mut body = String::new();
    loop {
        let mut line = String::new();
        let n = s
            .reader
            .read_line(&mut line)
            .await
            .map_err(|e| MailError::Provider(format!("imap body read: {e}")))?;
        if n == 0 {
            return Err(MailError::Provider("imap: closed during body fetch".into()));
        }
        if line.starts_with("a3 ") {
            if !line.contains("OK") {
                return Err(MailError::Provider(format!("imap body failed: {line:?}")));
            }
            return Ok(body);
        }
        if let Some(size) = literal_size(&line) {
            let mut bytes = vec![0u8; size];
            s.reader
                .read_exact(&mut bytes)
                .await
                .map_err(|e| MailError::Provider(format!("imap body literal read: {e}")))?;
            body.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
}

/// Mark an IMAP message read (`+FLAGS (\Seen)`) or unread (`-FLAGS`).
pub async fn store_seen(cfg: &ImapConfig, seq: u32, seen: bool) -> Result<()> {
    let mut s = open_session(cfg).await?;
    let sign = if seen { "+" } else { "-" };
    cmd(
        &mut s.write,
        &format!("a3 STORE {seq} {sign}FLAGS (\\Seen)"),
    )
    .await
    .map_err(|e| MailError::Provider(format!("imap store write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a3 ").await?;
    if !tagged.contains("OK") {
        return Err(MailError::Provider(format!(
            "imap store failed: {tagged:?}"
        )));
    }
    Ok(())
}

/// Star / unstar an IMAP message (`\Flagged`).
pub async fn store_flagged(cfg: &ImapConfig, seq: u32, flagged: bool) -> Result<()> {
    let mut s = open_session(cfg).await?;
    let sign = if flagged { "+" } else { "-" };
    cmd(
        &mut s.write,
        &format!("a3 STORE {seq} {sign}FLAGS (\\Flagged)"),
    )
    .await
    .map_err(|e| MailError::Provider(format!("imap store write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a3 ").await?;
    if !tagged.contains("OK") {
        return Err(MailError::Provider(format!(
            "imap store failed: {tagged:?}"
        )));
    }
    Ok(())
}

/// Delete an IMAP message: mark `\Deleted` then `EXPUNGE`.
pub async fn delete_message(cfg: &ImapConfig, seq: u32) -> Result<()> {
    let mut s = open_session(cfg).await?;
    cmd(&mut s.write, &format!("a3 STORE {seq} +FLAGS (\\Deleted)"))
        .await
        .map_err(|e| MailError::Provider(format!("imap delete store write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a3 ").await?;
    if !tagged.contains("OK") {
        return Err(MailError::Provider(format!(
            "imap delete store failed: {tagged:?}"
        )));
    }
    cmd(&mut s.write, "a4 EXPUNGE")
        .await
        .map_err(|e| MailError::Provider(format!("imap expunge write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a4 ").await?;
    if !tagged.contains("OK") {
        return Err(MailError::Provider(format!(
            "imap expunge failed: {tagged:?}"
        )));
    }
    Ok(())
}

/// Move an IMAP message to another mailbox: `COPY`, then delete the original.
pub async fn move_message(cfg: &ImapConfig, seq: u32, target: &str) -> Result<()> {
    let mut s = open_session(cfg).await?;
    cmd(
        &mut s.write,
        &format!("a3 COPY {seq} \"{}\"", target.replace('"', "\\\"")),
    )
    .await
    .map_err(|e| MailError::Provider(format!("imap copy write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a3 ").await?;
    if !tagged.contains("OK") {
        return Err(MailError::Provider(format!("imap copy failed: {tagged:?}")));
    }
    cmd(&mut s.write, &format!("a4 STORE {seq} +FLAGS (\\Deleted)"))
        .await
        .map_err(|e| MailError::Provider(format!("imap move store write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a4 ").await?;
    if !tagged.contains("OK") {
        return Err(MailError::Provider(format!(
            "imap move store failed: {tagged:?}"
        )));
    }
    cmd(&mut s.write, "a5 EXPUNGE")
        .await
        .map_err(|e| MailError::Provider(format!("imap expunge write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a5 ").await?;
    if !tagged.contains("OK") {
        return Err(MailError::Provider(format!(
            "imap expunge failed: {tagged:?}"
        )));
    }
    Ok(())
}

/// Parse a mailbox name out of an untagged `* LIST …` line (quoted names).
fn parse_list_line(line: &str) -> Option<String> {
    let end = line.rfind('"')?;
    let head = &line[..end];
    let start = head.rfind('"')?;
    Some(head[start + 1..].to_string())
}

/// List mailboxes on a live IMAP server (`LIST "" *`), INBOX first.
pub async fn list_mailboxes(cfg: &ImapConfig) -> Result<Vec<String>> {
    let mut s = open_session(cfg).await?;
    cmd(&mut s.write, "a3 LIST \"\" *")
        .await
        .map_err(|e| MailError::Provider(format!("imap list write: {e}")))?;
    let mut names: Vec<String> = Vec::new();
    loop {
        let mut line = String::new();
        let n = s
            .reader
            .read_line(&mut line)
            .await
            .map_err(|e| MailError::Provider(format!("imap list read: {e}")))?;
        if n == 0 {
            return Err(MailError::Provider("imap: closed during list".into()));
        }
        if line.starts_with("a3 ") {
            if !line.contains("OK") {
                return Err(MailError::Provider(format!("imap list failed: {line:?}")));
            }
            break;
        }
        if line.starts_with("* LIST") {
            if let Some(name) = parse_list_line(&line) {
                if !names.iter().any(|n| n == &name) {
                    names.push(name);
                }
            }
        }
    }
    // Present INBOX first, keep a stable order otherwise.
    names.sort();
    if let Some(pos) = names.iter().position(|n| n == "INBOX") {
        names.swap(0, pos);
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader as StdBufReader, Write};
    use std::net::TcpListener;

    /// A tiny IMAP server that answers LOGIN/SELECT/SEARCH(UNSEEN) with canned
    /// data and returns `reply_search` as the untagged `* SEARCH` numbers.
    fn spawn_imap(reply_search: &str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let reply_search = reply_search.to_string();
        std::thread::spawn(move || {
            if let Ok(mut stream) = listener.incoming().next().unwrap() {
                let _ = stream.write_all(b"* OK IMAP4rev1 ready\r\n");
                let _ = stream.flush();
                let mut line = String::new();
                let mut reader = StdBufReader::new(stream.try_clone().unwrap());
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
                    let tag = trimmed.split_whitespace().next().unwrap_or("").to_string();
                    let upper = trimmed.to_uppercase();
                    let ok = |stream: &mut std::net::TcpStream, extra: &str| {
                        let _ = stream.write_all(extra.as_bytes());
                        let _ = stream.write_all(format!("{tag} OK done\r\n").as_bytes());
                        let _ = stream.flush();
                    };
                    if upper.contains("LOGIN") {
                        ok(&mut stream, "");
                    } else if upper.contains("SELECT") {
                        ok(&mut stream, "* 3 EXISTS\r\n");
                    } else if upper.contains("SEARCH") {
                        let extra = if reply_search.is_empty() {
                            String::new()
                        } else {
                            format!("* SEARCH {reply_search}\r\n")
                        };
                        ok(&mut stream, &extra);
                    } else if upper.contains("LOGOUT") {
                        let _ = stream.write_all(format!("{tag} OK bye\r\n").as_bytes());
                        let _ = stream.flush();
                        break;
                    } else {
                        ok(&mut stream, "");
                    }
                }
            }
        });
        port
    }

    #[tokio::test]
    async fn counts_unseen_over_a_local_imap_server() {
        let port = spawn_imap("1 3");
        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        assert_eq!(count_unseen(&cfg).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn counts_zero_when_nothing_unseen() {
        let port = spawn_imap("");
        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        assert_eq!(count_unseen(&cfg).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn fetch_headers_parses_subject_from_and_seen_flags() {
        use std::io::{BufRead, BufReader as StdBufReader, Write};
        use std::net::TcpListener;

        let h1 = "From: Ada <ada@x.io>\r\nSubject: Hi\r\n";
        let h2 = "From: Grace <grace@x.io>\r\nSubject: Build\r\n";
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
                        send(&mut stream, b"* 2 EXISTS\r\n");
                        send(&mut stream, format!("{tag} OK [READ-WRITE]\r\n").as_bytes());
                    } else if upper.contains("SEARCH") {
                        send(&mut stream, b"* SEARCH 1 2\r\n");
                        send(&mut stream, format!("{tag} OK search\r\n").as_bytes());
                    } else if upper.contains("FETCH") {
                        send(
                            &mut stream,
                            b"* 1 FETCH (FLAGS (\\Seen) BODY[HEADER.FIELDS (FROM SUBJECT)] {",
                        );
                        send(&mut stream, format!("{}}}\r\n", h1.len()).as_bytes());
                        send(&mut stream, h1.as_bytes());
                        send(&mut stream, b")\r\n");
                        send(
                            &mut stream,
                            b"* 2 FETCH (FLAGS () BODY[HEADER.FIELDS (FROM SUBJECT)] {",
                        );
                        send(&mut stream, format!("{}}}\r\n", h2.len()).as_bytes());
                        send(&mut stream, h2.as_bytes());
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

        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        let msgs = fetch_inbox_summaries(&cfg, 10).await.unwrap();
        assert_eq!(msgs.len(), 2, "msgs={msgs:?}");
        assert!(msgs[0].flags.seen, "first message should be seen");
        assert!(!msgs[1].flags.seen);
        assert_eq!(msgs[0].subject, "Hi");
        assert_eq!(msgs[1].subject, "Build");
        assert_eq!(msgs[0].from.as_ref().unwrap().email, "ada@x.io");
        assert_eq!(msgs[0].from.as_ref().unwrap().name, "Ada");
        assert_eq!(msgs[0].id, "seq-1");
        assert_eq!(msgs[1].mailbox, "INBOX");
    }

    #[tokio::test]
    async fn fetch_message_body_returns_literal_text() {
        use std::io::{BufRead, BufReader as StdBufReader, Write};
        use std::net::TcpListener;

        let body = "Hello IMAP body";
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
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    } else if upper.contains("FETCH") {
                        send(&mut stream, b"* 1 FETCH (BODY[TEXT] {");
                        send(&mut stream, format!("{}}}\r\n", body.len()).as_bytes());
                        send(&mut stream, body.as_bytes());
                        send(&mut stream, b")\r\n");
                        send(&mut stream, format!("{tag} OK fetch\r\n").as_bytes());
                    } else if upper.contains("LOGOUT") {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                        break;
                    } else {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    }
                }
            }
        });

        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        let got = fetch_message_body(&cfg, 1).await.unwrap();
        assert_eq!(got, "Hello IMAP body");
    }

    #[tokio::test]
    async fn store_seen_sends_the_right_flag_command() {
        use std::io::{BufRead, BufReader as StdBufReader, Write};
        use std::net::TcpListener;
        use std::sync::{Arc, Mutex};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen_cmds: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen2 = Arc::clone(&seen_cmds);
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
                        seen2.lock().unwrap().push(line.trim().to_string());
                    }
                    let send = |stream: &mut std::net::TcpStream, data: &[u8]| {
                        let _ = stream.write_all(data);
                        let _ = stream.flush();
                    };
                    if upper.contains("LOGIN")
                        || upper.contains("SELECT")
                        || upper.contains("STORE")
                    {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    } else if upper.contains("LOGOUT") {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                        break;
                    } else {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    }
                }
            }
        });

        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        store_seen(&cfg, 1, true).await.unwrap();
        let cmds = seen_cmds.lock().unwrap().clone();
        assert!(
            cmds.iter().any(|c| c.contains("+FLAGS (\\Seen)")),
            "{cmds:?}"
        );
    }

    #[tokio::test]
    async fn list_mailboxes_over_a_local_server() {
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
                    if upper.contains("LOGIN") {
                        send(&mut stream, format!("{tag} OK login\r\n").as_bytes());
                    } else if upper.contains("SELECT") {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    } else if upper.contains("LIST") {
                        for m in ["INBOX", "Sent", "Archive", "Trash"] {
                            send(
                                &mut stream,
                                format!("* LIST (\\HasNoChildren) \"/\" \"{m}\"\r\n").as_bytes(),
                            );
                        }
                        send(&mut stream, format!("{tag} OK list\r\n").as_bytes());
                    } else if upper.contains("LOGOUT") {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                        break;
                    } else {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    }
                }
            }
        });

        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        let boxes = list_mailboxes(&cfg).await.unwrap();
        assert_eq!(boxes.first().map(String::as_str), Some("INBOX"));
        assert!(boxes.iter().any(|b| b == "Sent"), "{boxes:?}");
        assert!(boxes.iter().any(|b| b == "Archive"), "{boxes:?}");
        assert!(boxes.iter().any(|b| b == "Trash"), "{boxes:?}");
        assert_eq!(boxes.len(), 4);
    }

    #[tokio::test]
    async fn store_flagged_sends_the_flag_command() {
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

        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        store_flagged(&cfg, 1, true).await.unwrap();
        let got = cmds.lock().unwrap().clone();
        assert!(
            got.iter().any(|c| c.contains("+FLAGS (\\Flagged)")),
            "{got:?}"
        );
    }

    #[tokio::test]
    async fn delete_message_marks_deleted_and_expunges() {
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
                    if upper.contains("STORE") || upper.contains("EXPUNGE") {
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

        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        delete_message(&cfg, 1).await.unwrap();
        let got = cmds.lock().unwrap().clone();
        assert!(
            got.iter().any(|c| c.contains("+FLAGS (\\Deleted)")),
            "{got:?}"
        );
        assert!(got.iter().any(|c| c.contains("EXPUNGE")), "{got:?}");
    }

    #[tokio::test]
    async fn move_message_copies_then_deletes() {
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
                    if upper.contains("COPY")
                        || upper.contains("STORE")
                        || upper.contains("EXPUNGE")
                    {
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

        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        move_message(&cfg, 1, "Archive").await.unwrap();
        let got = cmds.lock().unwrap().clone();
        assert!(
            got.iter().any(|c| c.contains("COPY 1 \"Archive\"")),
            "{got:?}"
        );
        assert!(
            got.iter().any(|c| c.contains("+FLAGS (\\Deleted)")),
            "{got:?}"
        );
        assert!(got.iter().any(|c| c.contains("EXPUNGE")), "{got:?}");
    }
}

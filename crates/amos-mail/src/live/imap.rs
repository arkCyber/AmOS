//! Real IMAP reading (feature `live`).
//!
//! Speaks the real IMAP protocol over TCP, with optional implicit TLS
//! (`ImapConfig::tls()` for e.g. `imap.gmail.com:993`). Commands so far:
//! LOGIN/SELECT, `UID SEARCH`, LIST, `UID FETCH` (headers & body), `UID STORE`
//! (Seen/Flagged/Answered), delete (\Deleted + EXPUNGE) and move (`UID COPY` +
//! delete). Messages are addressed by **UID**, never by sequence number, so an
//! id stays valid when the mailbox changes under us (`count_unseen` is the one
//! exception: it only counts, and hands no id out). Each operation is verified
//! offline against a tiny in-process IMAP server in the tests; TLS itself needs
//! a real server to confirm the handshake.

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
use crate::model::{Address, AttachmentMeta, EmailFlags, EmailSummary};

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
            if !tagged_status_ok(&line) {
                return Err(MailError::Provider(format!("imap search failed: {line:?}")));
            }
            return Ok(count);
        }
    }
}

/// The numbers a `* SEARCH …` response carries. When the command that produced
/// it was `UID SEARCH` (the one we send), these are **UIDs**, not sequence
/// numbers — the same tokens, but stable across EXPUNGE / new arrivals.
fn parse_search_nums(line: &str) -> Vec<u32> {
    line.split_whitespace()
        .skip(2)
        .filter_map(|tok| tok.parse().ok())
        .collect()
}

/// The `UID <n>` item of an untagged `* n FETCH (…)` response (RFC 3501 §7.4.2).
///
/// A UID FETCH response echoes the message's UID as an explicit `UID <number>`
/// data item; the leading `* <n>` is the **sequence** number. Reading the UID
/// item (not the leading sequence number) is what makes the id we hand out
/// stable: a sequence number shifts when an earlier message is expunged or a
/// new one arrives, so an id built from it can point at a *different* message
/// later — the defect `seq-{N}` shipped (REQ-A1690).
fn response_uid(line: &str) -> Option<u32> {
    let mut toks = line.split_whitespace();
    while let Some(tok) = toks.next() {
        // The item list opens with `(`, which servers glue to the first item:
        // the token we see is `(UID`, not `UID`.
        if tok.trim_start_matches('(').eq_ignore_ascii_case("UID") {
            return toks
                .next()
                .and_then(|v| v.trim_end_matches(')').parse().ok());
        }
    }
    None
}

/// The `INTERNALDATE "…"` item of an untagged FETCH response (RFC 3501 §7.4.2):
/// the server's own record of when the message arrived. It is a quoted string
/// that contains spaces, so it is sliced out by its quotes, not by token.
fn response_internaldate(line: &str) -> Option<&str> {
    let lower = line.to_ascii_lowercase();
    let at = lower.find("internaldate")? + "internaldate".len();
    let rest = line[at..].trim_start().strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(&rest[..end])
}

/// Count the attachment parts in an IMAP `BODYSTRUCTURE` item (RFC 3501 §7.4.2).
///
/// A part's `Content-Disposition` appears in the structure as a parenthesised
/// pair whose first element is the disposition type — `("ATTACHMENT" ("FILENAME"
/// "notes.pdf"))` — so a part is an attachment exactly when a quoted `ATTACHMENT`
/// token is preceded (ignoring spaces) by `(`. That rule is deliberate: a part
/// parameter whose *value* merely happens to be the word (e.g. `("FILENAME"
/// "attachment")`) is preceded by the closing quote of the parameter name, not by
/// `(`, so it does not count — a file named `attachment` is one file, not two.
///
/// The scan is bounded to the structure that follows the `BODYSTRUCTURE` item
/// name, stopping at the `BODY[…]` literal item, so header text elsewhere on the
/// response cannot be counted as structure.
///
/// Returns `None` when the reply carries no `BODYSTRUCTURE` item at all. The item
/// is requested, so its absence means the count was **not observed** — and the
/// caller must not fold that into `0`, a claim the user reads as "this mail has
/// no attachments" (REQ-A1822).
fn response_attachment_count(line: &str) -> Option<usize> {
    let lower = line.to_ascii_lowercase();
    let at = lower.find("bodystructure")? + "bodystructure".len();
    let end = lower[at..]
        .find("body[")
        .map(|i| at + i)
        .unwrap_or(line.len());
    let structure = &line[at..end];
    let bytes = structure.as_bytes();
    let mut count = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            let Some(close) = structure[i + 1..].find('"') else {
                break;
            };
            let token = &structure[i + 1..i + 1 + close];
            // The nearest non-space character before the opening quote.
            let before = structure[..i]
                .trim_end_matches([' ', '\t'])
                .as_bytes()
                .last()
                .copied();
            if token.eq_ignore_ascii_case("attachment") && before == Some(b'(') {
                count += 1;
            }
            i = i + 1 + close + 1;
        } else {
            i += 1;
        }
    }
    Some(count)
}

/// The `BODYSTRUCTURE` item of an untagged FETCH response, as the raw
/// s-expression text: a parenthesised list, or `NIL` for a bodyless message.
///
/// `None` when the reply carries no such item at all — the caller distinguishes
/// "the server said this message has no body" from "we were not told".
fn bodystructure_item(line: &str) -> Option<&str> {
    let lower = line.to_ascii_lowercase();
    let after = lower.find("bodystructure")? + "bodystructure".len();
    let trimmed = line[after..].trim_start();
    if trimmed.len() >= 3 && trimmed.as_bytes()[..3].eq_ignore_ascii_case(b"nil") {
        return Some("NIL");
    }
    if !trimmed.starts_with('(') {
        return None;
    }
    // Balanced-paren slice, ignoring parens inside quoted strings.
    let bytes = trimmed.as_bytes();
    let mut depth = 0i32;
    let mut in_quote = false;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => in_quote = !in_quote,
            b'\\' if in_quote => i += 1,
            b'(' if !in_quote => depth += 1,
            b')' if !in_quote => {
                depth -= 1;
                if depth == 0 {
                    return Some(&trimmed[..=i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// One node of a `BODYSTRUCTURE` s-expression: a list, a quoted string, or an
/// unquoted atom (`NIL`, a number).
#[derive(Debug, Clone)]
enum Sexp {
    List(Vec<Sexp>),
    Str(String),
    Atom(String),
}

impl Sexp {
    fn as_str(&self) -> Option<&str> {
        match self {
            Sexp::Str(s) | Sexp::Atom(s) => Some(s),
            Sexp::List(_) => None,
        }
    }
}

fn sexp_skip_ws(b: &[u8], i: &mut usize) {
    while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\r' | b'\n') {
        *i += 1;
    }
}

fn sexp_parse_node(b: &[u8], i: &mut usize) -> Option<Sexp> {
    sexp_skip_ws(b, i);
    match b.get(*i)? {
        b'(' => {
            *i += 1;
            let mut items = Vec::new();
            loop {
                sexp_skip_ws(b, i);
                if b.get(*i) == Some(&b')') {
                    *i += 1;
                    return Some(Sexp::List(items));
                }
                items.push(sexp_parse_node(b, i)?);
            }
        }
        b'"' => {
            *i += 1;
            let mut out: Vec<u8> = Vec::new();
            loop {
                match b.get(*i)? {
                    b'"' => {
                        *i += 1;
                        return Some(Sexp::Str(String::from_utf8_lossy(&out).to_string()));
                    }
                    // A quoted string escapes `"` and `\` with a backslash.
                    b'\\' => {
                        *i += 1;
                        out.push(*b.get(*i)?);
                        *i += 1;
                    }
                    c => {
                        out.push(*c);
                        *i += 1;
                    }
                }
            }
        }
        _ => {
            let start = *i;
            while *i < b.len() && !matches!(b[*i], b' ' | b'\t' | b'\r' | b'\n' | b'(' | b')') {
                *i += 1;
            }
            Some(Sexp::Atom(
                String::from_utf8_lossy(&b[start..*i]).to_string(),
            ))
        }
    }
}

/// A value from an IMAP parameter list, whose names and values alternate:
/// `("CHARSET" "US-ASCII" "NAME" "report.pdf")`. `NIL` has no parameters.
fn param_value(params: &Sexp, key: &str) -> Option<String> {
    let Sexp::List(items) = params else {
        return None;
    };
    for pair in items.chunks(2) {
        let [k, v] = pair else { break };
        if k.as_str()?.eq_ignore_ascii_case(key) {
            return v.as_str().map(str::to_string);
        }
    }
    None
}

/// Walk a parsed `BODYSTRUCTURE` and push one [`AttachmentMeta`] per part whose
/// `Content-Disposition` is `attachment` (RFC 3501 §7.4.2).
///
/// `multipart/*` nests its parts as the leading list elements; `message/rfc822`
/// parts are recursed into through their encapsulated body. A 1part is
/// `type subtype params id desc encoding octets …`, so the MIME type is the first
/// two strings and the size is the grammar's **mandatory** octet count — a part
/// that claims an `attachment` disposition without a readable octet count is a
/// structure we cannot describe, and it makes the whole walk `None` rather than
/// reporting a fabricated `0`-byte file.
fn collect_attachment_parts(node: &Sexp, out: &mut Vec<AttachmentMeta>) -> Option<()> {
    let Sexp::List(items) = node else {
        // `NIL` — a bodyless message: no parts, and not a malformed structure.
        return Some(());
    };
    match items.first() {
        // multipart/*: the parts come first, then the subtype string.
        Some(Sexp::List(_)) => {
            for it in items {
                match it {
                    Sexp::List(_) => collect_attachment_parts(it, out)?,
                    _ => break,
                }
            }
            return Some(());
        }
        // message/rfc822 keeps its encapsulated message's body at index 8.
        Some(Sexp::Str(t)) if t.eq_ignore_ascii_case("MESSAGE") => {
            if let Some(body) = items.get(8) {
                collect_attachment_parts(body, out)?;
            }
        }
        Some(Sexp::Str(_)) => {}
        _ => return Some(()),
    }
    let disposition = items.iter().find_map(|it| {
        let Sexp::List(d) = it else { return None };
        let kind = d.first()?.as_str()?;
        kind.eq_ignore_ascii_case("attachment").then_some(d)
    });
    let Some(d) = disposition else {
        return Some(());
    };
    let mime = format!(
        "{}/{}",
        items.first()?.as_str()?.to_ascii_lowercase(),
        items.get(1)?.as_str()?.to_ascii_lowercase()
    );
    let size = items.get(6)?.as_str()?.parse::<u64>().ok()?;
    let id = format!("part-{}", out.len() + 1);
    // The disposition's own `FILENAME` parameter, else the part's `NAME`, else
    // the part id — an obvious placeholder, never a filename we did not read.
    let filename = d
        .get(1)
        .and_then(|p| param_value(p, "filename"))
        .or_else(|| items.get(2).and_then(|p| param_value(p, "name")))
        .unwrap_or_else(|| id.clone());
    out.push(AttachmentMeta {
        id,
        filename,
        mime,
        size,
    });
    Some(())
}

/// The attachment metadata an IMAP `BODYSTRUCTURE` describes.
///
/// `None` means the text could not be read as one structure (or a part claiming
/// an `attachment` disposition had no readable size) — the caller must report
/// that, not fold it into "this message has no attachments" (REQ-A1845).
fn parse_attachment_meta(structure: &str) -> Option<Vec<AttachmentMeta>> {
    let bytes = structure.as_bytes();
    let mut i = 0usize;
    let root = sexp_parse_node(bytes, &mut i)?;
    sexp_skip_ws(bytes, &mut i);
    if i != bytes.len() {
        return None; // trailing junk after the structure
    }
    let mut out = Vec::new();
    collect_attachment_parts(&root, &mut out)?;
    Some(out)
}
/// Whether an IMAP status line reports success — the **status word** is `OK`.
///
/// A completion line is `<tag> OK|NO|BAD [text]` (RFC 3501 §7.1); the greeting is
/// the untagged `* OK …`, one token shorter but with the status word in the same
/// position. Reading the status **word** (not "the line contains `OK`") is what
/// makes a refusal a refusal: `NO`/`BAD` mean the server did not do the thing, and
/// a reason that merely mentions `OK` must not be mistaken for a success.
///
/// One definition, applied at every completion site — the SEARCH/FETCH loops below
/// used to accept *any* tagged reply, which turned a refused search into an empty
/// inbox (REQ-A1681).
fn tagged_status_ok(line: &str) -> bool {
    matches!(
        line.split_whitespace().nth(1),
        Some(word) if word.eq_ignore_ascii_case("OK")
    )
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

/// Parse an address-**list** header (`To:`, e.g. `"Ada" <a@x.io>, b@y.io`) into
/// addresses, splitting only on the commas **between** entries.
///
/// A comma inside a quoted display name (`"Doe, John" <j@x.io>`) or inside the
/// angle-bracketed address is part of one entry, not a separator: a naive
/// `split(',')` cuts `"Doe` off and hands `Address::new` a fragment it refuses,
/// so the recipient vanishes from a line the UI renders. Order is preserved, and
/// an entry that does not parse is skipped rather than fabricated — the same rule
/// [`parse_addr`] applies to one entry (REQ-A1793).
fn parse_addr_list(raw: &str) -> Vec<Address> {
    let mut out: Vec<Address> = Vec::new();
    let mut entry = String::new();
    let mut in_quotes = false;
    let mut in_angle = false;
    for ch in raw.chars() {
        match ch {
            // A quote inside `<...>` is not a display-name delimiter.
            '"' if !in_angle => {
                in_quotes = !in_quotes;
                entry.push(ch);
            }
            '<' if !in_quotes => {
                in_angle = true;
                entry.push(ch);
            }
            '>' if !in_quotes => {
                in_angle = false;
                entry.push(ch);
            }
            ',' if !in_quotes && !in_angle => {
                if let Some(a) = parse_addr(&entry) {
                    out.push(a);
                }
                entry.clear();
            }
            _ => entry.push(ch),
        }
    }
    if let Some(a) = parse_addr(&entry) {
        out.push(a);
    }
    out
}

/// Grab the trailing IMAP literal size `{N}` from a line, if any.
fn literal_size(line: &str) -> Option<usize> {
    let start = line.rfind('{')?;
    let end = line[start..].find('}')? + start;
    line[start + 1..end].parse().ok()
}

/// Lowercased contents of the `FLAGS (...)` group on a FETCH response line, or
/// the whole line lowercased when no group is present.
fn flag_group(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let Some(start) = lower.find("flags (") else {
        return lower;
    };
    let after = &lower[start + "flags (".len()..];
    match after.find(')') {
        Some(end) => after[..end].to_string(),
        None => after.to_string(),
    }
}

/// Month number from a three-letter English abbreviation (RFC 5322 `month`).
fn month_number(abbr: &str) -> Option<u32> {
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let lower = abbr.to_ascii_lowercase();
    MONTHS
        .iter()
        .position(|m| *m == lower)
        .map(|i| i as u32 + 1)
}

/// The timezone offset (in seconds east of UTC) named by an RFC 5322 `zone`, or
/// `0` for the ones that mean UTC.
///
/// Covers the numeric form (`+0800` / `-0430`) and the obsolete-but-common named
/// zones a real server still emits; an unrecognised name is treated as UTC
/// (offset `0`), which is the RFC 5322 default when no zone is present.
fn zone_offset_secs(zone: &str) -> i64 {
    let z = zone.trim();
    if z.is_empty() {
        return 0;
    }
    let (sign, digits) = match z.as_bytes()[0] {
        b'+' => (1i64, &z[1..]),
        b'-' => (-1i64, &z[1..]),
        _ => (0, z),
    };
    if sign != 0 {
        // `+HHMM` — the only numeric form RFC 5322 allows.
        if digits.len() == 4 && digits.bytes().all(|b| b.is_ascii_digit()) {
            let hh: i64 = digits[..2].parse().unwrap_or(0);
            let mm: i64 = digits[2..].parse().unwrap_or(0);
            return sign * (hh * 3600 + mm * 60);
        }
        return 0;
    }
    match z.to_ascii_uppercase().as_str() {
        "UT" | "GMT" | "UTC" | "Z" => 0,
        "EST" => -5 * 3600,
        "EDT" => -4 * 3600,
        "CST" => -6 * 3600,
        "CDT" => -5 * 3600,
        "MST" => -7 * 3600,
        "MDT" => -6 * 3600,
        "PST" => -8 * 3600,
        "PDT" => -7 * 3600,
        _ => 0,
    }
}

/// Days from the Unix epoch (1970-01-01) to civil date `y-m-d` (Howard Hinnant's
/// `days_from_civil`; negative for dates before 1970).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 }; // [0, 11]
    let doy = (153 * i64::from(mp) + 2) / 5 + i64::from(d) - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

/// Parse an RFC 5322 `Date:` value into Unix epoch seconds (UTC).
///
/// Real servers emit `Ddd, DD Mon YYYY HH:MM:SS ±ZZZZ` (the weekday optional, a
/// 2-digit year or a named zone also legal); parenthesised comments are ignored.
/// Returns `None` for anything it cannot parse so the caller can fall back to a
/// date it *did* observe — the server's receipt time — instead of inventing one;
/// the same honesty rule the rest of the crate follows.
fn rfc5322_epoch(raw: &str) -> Option<i64> {
    // Drop parenthesised comments (`… (PDT)`, nested one level deep) without
    // allocating a scanner state machine.
    let mut cleaned = String::with_capacity(raw.len());
    let mut depth = 0u32;
    for ch in raw.chars() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => cleaned.push(ch),
            _ => {}
        }
    }
    let toks: Vec<&str> = cleaned.split_whitespace().collect();
    // A leading `Ddd,` weekday is optional; drop it when present.
    let toks = match toks.split_first() {
        Some((first, rest)) if first.len() == 4 && first.ends_with(',') && !rest.is_empty() => rest,
        _ => &toks[..],
    };
    if toks.len() < 4 {
        return None;
    }
    let day: u32 = toks[0].parse().ok()?;
    let month = month_number(toks[1])?;
    let mut year: i64 = toks[2].parse().ok()?;
    // Two-digit years: RFC 5322 maps 00-49 → 2000-2049 and 50-99 → 1950-1999.
    if year < 100 {
        year += if year < 50 { 2000 } else { 1900 };
    }
    let mut hms = toks[3].split(':');
    let hh: i64 = hms.next()?.parse().ok()?;
    let mm: i64 = hms.next()?.parse().ok()?;
    let ss: i64 = hms.next().unwrap_or("0").parse().ok()?;
    let zone = toks.get(4).copied().unwrap_or("");
    if day == 0 || day > 31 || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let secs = days_from_civil(year, month, day) * 86_400 + hh * 3600 + mm * 60 + ss;
    Some(secs - zone_offset_secs(zone))
}

/// Parse an IMAP `INTERNALDATE` value (RFC 3501 `date-time`) into Unix epoch
/// seconds (UTC).
///
/// The form is `DD-Mon-YYYY HH:MM:SS ±ZZZZ` — no weekday, and the day is
/// space-padded — so it is split on its own separators rather than by the
/// RFC 5322 parser above. The server records this for every message in a
/// selected mailbox, which is what makes it the honest fallback when the
/// `Date:` header is absent or unparseable. `None` for anything it cannot parse.
fn internal_date_epoch(raw: &str) -> Option<i64> {
    let toks: Vec<&str> = raw.split_whitespace().collect();
    let mut date = toks.first()?.split('-');
    let day: u32 = date.next()?.trim().parse().ok()?;
    let month = month_number(date.next()?)?;
    let year: i64 = date.next()?.parse().ok()?;
    let mut hms = toks.get(1)?.split(':');
    let hh: i64 = hms.next()?.parse().ok()?;
    let mm: i64 = hms.next()?.parse().ok()?;
    let ss: i64 = hms.next().unwrap_or("0").parse().ok()?;
    if day == 0 || day > 31 || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let zone = toks.get(2).copied().unwrap_or("");
    let secs = days_from_civil(year, month, day) * 86_400 + hh * 3600 + mm * 60 + ss;
    Some(secs - zone_offset_secs(zone))
}

/// Connect to the INBOX of a live IMAP server and fetch header summaries for up
/// to `max` newest messages. Verified offline against a canned local server.
pub async fn fetch_inbox_summaries(cfg: &ImapConfig, max: usize) -> Result<Vec<EmailSummary>> {
    let mut s = open_session(cfg).await?;
    let mut line = String::new();

    // UID SEARCH ALL to learn which messages exist. The reply's numbers are
    // UIDs, so the ids we build from them survive the mailbox changing under us
    // (REQ-A1690); a plain `SEARCH ALL` would hand back sequence numbers.
    cmd(&mut s.write, "a3 UID SEARCH ALL")
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
            // A refused SEARCH (`NO`/`BAD`) must not read as "the mailbox is empty":
            // the untagged `* SEARCH` line may be absent entirely, and `seqs` would
            // stay empty → `Ok(vec![])` → an inbox drawn as having no mail (REQ-A1681).
            if !tagged_status_ok(&line) {
                return Err(MailError::Provider(format!("imap search failed: {line:?}")));
            }
            break;
        }
    }
    if seqs.is_empty() {
        return Ok(Vec::new());
    }
    let take = seqs.len().min(max.max(1));
    let wanted = seqs[seqs.len() - take..].to_vec();

    // UID FETCH headers + flags for those messages in one round trip. `UID` is
    // requested explicitly so the response echoes each message's UID back — that
    // item, not the leading sequence number, is what the summary id is built
    // from. `INTERNALDATE` is requested too: it is the server's own record of
    // when the message arrived, the honest date for a message whose `Date:`
    // header is absent or unreadable. `TO` is in the field list because the
    // summary carries the recipients and both surfaces that open a message render
    // them (the UI's 「收件人」 line, the CLI's `To:`): leaving it out made the
    // engine hardcode `to: []`, so every message read over a live account opened
    // addressed to nobody (REQ-A1793). `BODYSTRUCTURE` is requested because the
    // summary carries `attachment_count`, and the structure is the only item that
    // tells a message with files from one without — without requesting it the
    // engine wrote a hard `0`, i.e. claimed "no attachments" for every live message
    // while having asked nothing (REQ-A1822).
    let list = wanted
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join(",");
    cmd(
        &mut s.write,
        &format!(
            "a4 UID FETCH {list} (UID FLAGS INTERNALDATE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])"
        ),
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
            // A refused FETCH means the summaries we did collect are partial, not the
            // mailbox: report the refusal instead of returning a short list as if it
            // were the whole answer (REQ-A1681).
            if !tagged_status_ok(&line) {
                return Err(MailError::Provider(format!("imap fetch failed: {line:?}")));
            }
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
        // A UID FETCH response must carry the `UID <n>` item we asked for. If it
        // does not, we have no stable id to hand out — neither the leading
        // sequence number (it drifts) nor a fabricated `0` may stand in, so the
        // malformed response is an error (REQ-A1690).
        let Some(uid) = response_uid(&line) else {
            return Err(MailError::Provider(format!(
                "imap: UID FETCH reply without a UID item: {line:?}"
            )));
        };
        // The server reports every set flag on one `FLAGS (...)` group; system
        // flags are case-insensitive (RFC 3501 §2.3.2). Scan only that group so
        // header text elsewhere on the response line cannot spoof a flag.
        let flags = flag_group(&line);
        let seen = flags.contains("\\seen");
        let flagged = flags.contains("\\flagged");
        let answered = flags.contains("\\answered");

        let mut subject = String::new();
        let mut from = None;
        // The recipients, from the `To:` header this FETCH now asks for. A summary
        // with no `To:` header keeps the empty list — that is a message the server
        // says has no such field, not one whose recipients we failed to read.
        let mut to: Vec<Address> = Vec::new();
        // `email.date` is documented as "Unix epoch seconds" and every consumer
        // reads it as a real timestamp: the mock provider sorts newest-first on it
        // (`MockMailProvider`), and `MailApp.svelte::fmtDate` renders
        // `new Date(date * 1000)`. So an unreadable `Date:` header must **not** be
        // folded to `0` — that is the epoch, a date no message was sent at, and
        // the parser returns `None` for exactly that case *so the caller can tell
        // "no date" from "1970-01-01"*. The server knows a truthful date for every
        // message in a selected mailbox: `INTERNALDATE`, its receipt time. Prefer
        // the sender's `Date:` (what a mail client shows), fall back to the receipt
        // time; only a reply carrying neither (a protocol violation) leaves the
        // documented `0`.
        let mut header_date: Option<i64> = None;
        for hline in header.lines() {
            let hline = hline.trim_end_matches('\r');
            if let Some(v) = hline.strip_prefix("Subject:") {
                subject = v.trim().to_string();
            } else if let Some(v) = hline.strip_prefix("From:") {
                from = parse_addr(v);
            } else if let Some(v) = hline.strip_prefix("To:") {
                to = parse_addr_list(v);
            } else if let Some(v) = hline.strip_prefix("Date:") {
                header_date = rfc5322_epoch(v);
            }
        }
        let date = header_date
            .or_else(|| response_internaldate(&line).and_then(internal_date_epoch))
            .unwrap_or(0);
        // The attachment count comes from the `BODYSTRUCTURE` item this FETCH now
        // asks for. Its absence is not "no attachments": the server was asked, so a
        // reply without it means the count was never observed, and `0` would be a
        // fabricated "this mail has no files" — the same shape as the UID item above
        // (REQ-A1822).
        let Some(attachment_count) = response_attachment_count(&line) else {
            return Err(MailError::Provider(format!(
                "imap: FETCH reply without a BODYSTRUCTURE item: {line:?}"
            )));
        };
        out.push(EmailSummary {
            id: format!("uid-{uid}"),
            mailbox: "INBOX".into(),
            from,
            to,
            subject,
            date,
            flags: EmailFlags {
                seen,
                flagged,
                answered,
            },
            attachment_count,
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
    if n == 0 || !tagged_status_ok(&line) {
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
    if !tagged_status_ok(&tagged) {
        return Err(MailError::Provider(format!(
            "imap login failed: {tagged:?}"
        )));
    }

    cmd(&mut write, "a2 SELECT INBOX")
        .await
        .map_err(|e| MailError::Provider(format!("imap select write: {e}")))?;
    let tagged = await_tag(&mut reader, "a2 ").await?;
    if !tagged_status_ok(&tagged) {
        return Err(MailError::Provider(format!(
            "imap select failed: {tagged:?}"
        )));
    }

    Ok(Session { reader, write })
}

/// Fetch the plain-text body of a message by its IMAP **UID**.
pub async fn fetch_message_body(cfg: &ImapConfig, uid: u32) -> Result<String> {
    let mut s = open_session(cfg).await?;
    cmd(
        &mut s.write,
        &format!("a3 UID FETCH {uid} (BODY.PEEK[TEXT])"),
    )
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
            if !tagged_status_ok(&line) {
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

/// Fetch a message's attachment metadata by its IMAP **UID**, from the message's
/// `BODYSTRUCTURE`.
///
/// The opened-message screen draws one chip per [`AttachmentMeta`]. Before this
/// the live path handed back an empty list for every message, so a message the
/// inbox row showed as `📎 2` opened with no attachments at all — a silent "there
/// are none" for a message the same account had just counted two files in
/// (REQ-A1845).
pub async fn fetch_attachment_meta(cfg: &ImapConfig, uid: u32) -> Result<Vec<AttachmentMeta>> {
    let mut s = open_session(cfg).await?;
    cmd(&mut s.write, &format!("a4 UID FETCH {uid} (BODYSTRUCTURE)"))
        .await
        .map_err(|e| MailError::Provider(format!("imap attachments write: {e}")))?;
    loop {
        let mut line = String::new();
        let n = s
            .reader
            .read_line(&mut line)
            .await
            .map_err(|e| MailError::Provider(format!("imap attachments read: {e}")))?;
        if n == 0 {
            return Err(MailError::Provider(
                "imap: closed during attachment fetch".into(),
            ));
        }
        if line.starts_with("a4 ") {
            if !tagged_status_ok(&line) {
                return Err(MailError::Provider(format!(
                    "imap attachments failed: {line:?}"
                )));
            }
            // The item was requested; a reply without it did not answer the
            // question, so it must not become "no attachments" (REQ-A1822).
            return Err(MailError::Provider(format!(
                "imap: FETCH reply without a BODYSTRUCTURE item: {line:?}"
            )));
        }
        if !line.starts_with("* ") {
            continue;
        }
        let Some(structure) = bodystructure_item(&line) else {
            continue;
        };
        return parse_attachment_meta(structure).ok_or_else(|| {
            MailError::Provider(format!("imap: unreadable BODYSTRUCTURE: {structure:?}"))
        });
    }
}
/// Mark an IMAP message read (`+FLAGS (\Seen)`) or unread (`-FLAGS`), by UID.
pub async fn store_seen(cfg: &ImapConfig, uid: u32, seen: bool) -> Result<()> {
    let mut s = open_session(cfg).await?;
    let sign = if seen { "+" } else { "-" };
    cmd(
        &mut s.write,
        &format!("a3 UID STORE {uid} {sign}FLAGS (\\Seen)"),
    )
    .await
    .map_err(|e| MailError::Provider(format!("imap store write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a3 ").await?;
    if !tagged_status_ok(&tagged) {
        return Err(MailError::Provider(format!(
            "imap store failed: {tagged:?}"
        )));
    }
    Ok(())
}

/// Star / unstar an IMAP message (`\Flagged`), by UID.
pub async fn store_flagged(cfg: &ImapConfig, uid: u32, flagged: bool) -> Result<()> {
    let mut s = open_session(cfg).await?;
    let sign = if flagged { "+" } else { "-" };
    cmd(
        &mut s.write,
        &format!("a3 UID STORE {uid} {sign}FLAGS (\\Flagged)"),
    )
    .await
    .map_err(|e| MailError::Provider(format!("imap store write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a3 ").await?;
    if !tagged_status_ok(&tagged) {
        return Err(MailError::Provider(format!(
            "imap store failed: {tagged:?}"
        )));
    }
    Ok(())
}

/// Mark an IMAP message replied (`\Answered`) or clear it (`-FLAGS`), by UID.
pub async fn store_answered(cfg: &ImapConfig, uid: u32, answered: bool) -> Result<()> {
    let mut s = open_session(cfg).await?;
    let sign = if answered { "+" } else { "-" };
    cmd(
        &mut s.write,
        &format!("a3 UID STORE {uid} {sign}FLAGS (\\Answered)"),
    )
    .await
    .map_err(|e| MailError::Provider(format!("imap store write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a3 ").await?;
    if !tagged_status_ok(&tagged) {
        return Err(MailError::Provider(format!(
            "imap store failed: {tagged:?}"
        )));
    }
    Ok(())
}

/// Delete an IMAP message by UID: mark `\Deleted` then `EXPUNGE`.
pub async fn delete_message(cfg: &ImapConfig, uid: u32) -> Result<()> {
    let mut s = open_session(cfg).await?;
    cmd(
        &mut s.write,
        &format!("a3 UID STORE {uid} +FLAGS (\\Deleted)"),
    )
    .await
    .map_err(|e| MailError::Provider(format!("imap delete store write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a3 ").await?;
    if !tagged_status_ok(&tagged) {
        return Err(MailError::Provider(format!(
            "imap delete store failed: {tagged:?}"
        )));
    }
    cmd(&mut s.write, "a4 EXPUNGE")
        .await
        .map_err(|e| MailError::Provider(format!("imap expunge write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a4 ").await?;
    if !tagged_status_ok(&tagged) {
        return Err(MailError::Provider(format!(
            "imap expunge failed: {tagged:?}"
        )));
    }
    Ok(())
}

/// Move an IMAP message to another mailbox by UID: `COPY`, then delete.
pub async fn move_message(cfg: &ImapConfig, uid: u32, target: &str) -> Result<()> {
    let mut s = open_session(cfg).await?;
    cmd(
        &mut s.write,
        &format!("a3 UID COPY {uid} \"{}\"", target.replace('"', "\\\"")),
    )
    .await
    .map_err(|e| MailError::Provider(format!("imap copy write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a3 ").await?;
    if !tagged_status_ok(&tagged) {
        return Err(MailError::Provider(format!("imap copy failed: {tagged:?}")));
    }
    cmd(
        &mut s.write,
        &format!("a4 UID STORE {uid} +FLAGS (\\Deleted)"),
    )
    .await
    .map_err(|e| MailError::Provider(format!("imap move store write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a4 ").await?;
    if !tagged_status_ok(&tagged) {
        return Err(MailError::Provider(format!(
            "imap move store failed: {tagged:?}"
        )));
    }
    cmd(&mut s.write, "a5 EXPUNGE")
        .await
        .map_err(|e| MailError::Provider(format!("imap expunge write: {e}")))?;
    let tagged = await_tag(&mut s.reader, "a5 ").await?;
    if !tagged_status_ok(&tagged) {
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
            if !tagged_status_ok(&line) {
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
                        send(&mut stream, b"* SEARCH 11 12\r\n");
                        send(&mut stream, format!("{tag} OK search\r\n").as_bytes());
                    } else if upper.contains("FETCH") {
                        send(
                            &mut stream,
                            b"* 1 FETCH (UID 11 FLAGS (\\Seen) BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM SUBJECT)] {",
                        );
                        send(&mut stream, format!("{}}}\r\n", h1.len()).as_bytes());
                        send(&mut stream, h1.as_bytes());
                        send(&mut stream, b")\r\n");
                        send(
                            &mut stream,
                            b"* 2 FETCH (UID 12 FLAGS () BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM SUBJECT)] {",
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
        // The id is the message's UID, echoed by the server's `UID` item — not the
        // leading sequence number and not the search's token (REQ-A1690).
        assert_eq!(msgs[0].id, "uid-11");
        assert_eq!(msgs[1].id, "uid-12");
        assert_eq!(msgs[1].mailbox, "INBOX");
    }

    /// The summary carries the message's recipients, and both surfaces that open a
    /// message render them (the UI's 「收件人」 line, the CLI's `To:`). The engine used
    /// to hardcode `to: Vec::new()`, so every message read over a live account opened
    /// addressed to nobody — while the module doc promises live operations return a
    /// clear error rather than *pretending* (REQ-A1793).
    #[tokio::test]
    async fn fetch_headers_populate_the_recipients() {
        use std::io::{BufRead, BufReader as StdBufReader, Write};
        use std::net::TcpListener;
        use std::sync::{Arc, Mutex};

        // A quoted display name containing a comma: the split must happen at the
        // separator *between* entries, not at every comma.
        let h1 = "From: Ada <ada@x.io>\r\nTo: \"Doe, John\" <j@x.io>, bob@y.io\r\nSubject: Hi\r\n";
        // No `To:` header at all — the empty list, and never a fabricated entry.
        let h2 = "From: Grace <grace@x.io>\r\nSubject: Build\r\n";
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
                    if upper.contains("FETCH") {
                        cmds2.lock().unwrap().push(line.trim().to_string());
                    }
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
                        send(&mut stream, b"* SEARCH 11 12\r\n");
                        send(&mut stream, format!("{tag} OK search\r\n").as_bytes());
                    } else if upper.contains("FETCH") {
                        send(
                            &mut stream,
                            b"* 1 FETCH (UID 11 FLAGS () BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM TO SUBJECT)] {",
                        );
                        send(&mut stream, format!("{}}}\r\n", h1.len()).as_bytes());
                        send(&mut stream, h1.as_bytes());
                        send(&mut stream, b")\r\n");
                        send(
                            &mut stream,
                            b"* 2 FETCH (UID 12 FLAGS () BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM TO SUBJECT)] {",
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

        // The recipients are read, in order, out of a list whose first entry has a
        // comma inside its quoted display name.
        assert_eq!(msgs[0].to.len(), 2, "both recipients: {:?}", msgs[0].to);
        assert_eq!(msgs[0].to[0].email, "j@x.io");
        assert_eq!(msgs[0].to[0].name, "\"Doe, John\"");
        assert_eq!(msgs[0].to[1].email, "bob@y.io", "order is preserved");

        // Positive control for the *other* half of the rule: a message with no `To:`
        // header keeps the empty list — no fabricated recipient stands in.
        assert!(
            msgs[1].to.is_empty(),
            "an absent To: header is an empty list, not an invented one: {:?}",
            msgs[1].to
        );

        // The request itself is the contract: `TO` must be in the FETCH field list,
        // or a real server never sends the header back. (The in-process fixture answers
        // with the same header bytes whatever is asked, so parsing alone cannot prove
        // the field was requested.)
        let fetch = cmds.lock().unwrap().join("\n").to_uppercase();
        assert!(
            fetch.contains("HEADER.FIELDS (FROM TO SUBJECT DATE)"),
            "the FETCH must request TO: {fetch}"
        );
    }

    /// The separator rule for an address list, on its own: a comma inside a quoted
    /// display name or inside `<...>` is part of one entry (REQ-A1793).
    #[test]
    fn address_lists_split_only_between_entries() {
        let got = parse_addr_list("\"Doe, John\" <j@x.io>, bob@y.io");
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0].email, "j@x.io");
        assert_eq!(got[1].email, "bob@y.io");

        // An entry that does not parse is skipped, never fabricated.
        let got = parse_addr_list("a@x.io, not-an-address, b@y.io");
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0].email, "a@x.io");
        assert_eq!(got[1].email, "b@y.io");

        // An empty header is an empty list.
        assert!(parse_addr_list("   ").is_empty());
    }

    #[tokio::test]
    async fn fetch_headers_reads_flagged_and_answered_from_the_flags_group() {
        use std::io::{BufRead, BufReader as StdBufReader, Write};
        use std::net::TcpListener;

        // Message 1 carries all three system flags on one FLAGS group; message 2
        // carries none, but its *subject* mentions `\Seen` — a naive whole-line
        // scan would wrongly mark it seen.
        let h1 = "From: Ada <ada@x.io>\r\nSubject: Trip\r\n";
        let h2 = "From: Grace <grace@x.io>\r\nSubject: Re: \\Seen not a flag\r\n";
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
                        send(&mut stream, b"* SEARCH 11 12\r\n");
                        send(&mut stream, format!("{tag} OK search\r\n").as_bytes());
                    } else if upper.contains("FETCH") {
                        send(
                            &mut stream,
                            b"* 1 FETCH (UID 11 FLAGS (\\Seen \\Flagged \\Answered) BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM SUBJECT)] {",
                        );
                        send(&mut stream, format!("{}}}\r\n", h1.len()).as_bytes());
                        send(&mut stream, h1.as_bytes());
                        send(&mut stream, b")\r\n");
                        send(
                            &mut stream,
                            b"* 2 FETCH (UID 12 FLAGS () BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM SUBJECT)] {",
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
        assert!(msgs[0].flags.seen, "m1 \\Seen");
        assert!(msgs[0].flags.flagged, "m1 \\Flagged must survive the wire");
        assert!(
            msgs[0].flags.answered,
            "m1 \\Answered must survive the wire"
        );
        assert!(!msgs[1].flags.seen, "m2 has no \\Seen in its FLAGS group");
        assert!(!msgs[1].flags.flagged);
        assert!(!msgs[1].flags.answered);
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
        // The id we are handed is a UID, so every mutation must travel as a UID
        // command — a plain `STORE 1` would flag whatever message currently sits
        // at sequence 1, not the one the user opened (REQ-A1690).
        assert!(
            cmds.iter().any(|c| c.to_uppercase().contains("UID STORE")),
            "the store must address the message by UID: {cmds:?}"
        );
    }

    /// The id is the UID the server echoes, not the leading sequence number: here
    /// the message sits at sequence `5` but carries UID `42`, so the two differ and
    /// only reading the `UID` item yields `uid-42` (the old code produced `seq-5`).
    #[tokio::test]
    async fn the_summary_id_is_the_uid_not_the_sequence_number() {
        use std::io::{BufRead, BufReader as StdBufReader, Write};
        use std::net::TcpListener;
        use std::sync::{Arc, Mutex};

        let h1 = "From: Ada <ada@x.io>\r\nSubject: Hi\r\n";
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
                        cmds2.lock().unwrap().push(line.trim().to_string());
                        // Sequence 5, UID 42 — the two numbers must not be confused.
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

        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        let msgs = fetch_inbox_summaries(&cfg, 10).await.unwrap();
        assert_eq!(msgs.len(), 1, "msgs={msgs:?}");
        assert_eq!(
            msgs[0].id, "uid-42",
            "the id must be the UID the server echoed, not the sequence 5"
        );
        let issued = cmds.lock().unwrap().clone();
        assert!(
            issued
                .iter()
                .any(|c| c.to_uppercase().contains("UID FETCH")),
            "the summary fetch must address the mailbox by UID: {issued:?}"
        );
    }

    /// A UID FETCH reply that omits its `UID` item is a protocol violation: with no
    /// stable id to hand out we must not fall back to the drifting sequence number
    /// (nor fabricate `0`) — the malformed reply is an error (REQ-A1690).
    #[tokio::test]
    async fn a_uid_fetch_without_a_uid_item_is_an_error() {
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
                        // No `UID` item — malformed for a UID FETCH.
                        send(
                            &mut stream,
                            b"* 5 FETCH (FLAGS () BODY[HEADER.FIELDS (FROM SUBJECT)] {",
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

        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        let err = fetch_inbox_summaries(&cfg, 10)
            .await
            .expect_err("a UID FETCH reply without a UID item must not be accepted");
        assert!(
            format!("{err}").contains("without a UID item"),
            "the malformed reply must be named: {err}"
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
    async fn store_answered_sends_the_answered_flag_command() {
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
        store_answered(&cfg, 1, true).await.unwrap();
        let got = cmds.lock().unwrap().clone();
        assert!(
            got.iter().any(|c| c.contains("+FLAGS (\\Answered)")),
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

    // ---- Date: header (RFC 5322) → epoch seconds -----------------------------

    #[test]
    fn rfc5322_dates_convert_to_epoch_seconds() {
        // References verified with `date -u -j -f "%Y-%m-%d %H:%M:%S"`.
        assert_eq!(
            rfc5322_epoch("Mon, 15 Sep 2025 10:30:00 +0000"),
            Some(1_757_932_200),
            "the canonical weekday-prefixed numeric-zone form"
        );
        assert_eq!(
            rfc5322_epoch("15 Sep 2025 10:30:00 +0000"),
            Some(1_757_932_200),
            "the weekday is optional"
        );
        assert_eq!(
            rfc5322_epoch("Mon, 1 Jan 2024 00:00:00 GMT"),
            Some(1_704_067_200),
            "a named UTC zone and a 1-digit day"
        );
        assert_eq!(rfc5322_epoch("Thu, 1 Jan 1970 00:00:00 +0000"), Some(0));
        // A one-hour-negative zone shifts the epoch the other way.
        assert_eq!(
            rfc5322_epoch("Mon, 15 Sep 2025 10:30:00 -0700"),
            Some(1_757_932_200 + 7 * 3600)
        );
        // A parenthesised comment (`-0700 (PDT)`) is ignored, not parsed as data.
        assert_eq!(
            rfc5322_epoch("Mon, 15 Sep 2025 10:30:00 -0700 (PDT)"),
            Some(1_757_932_200 + 7 * 3600)
        );
    }

    #[test]
    fn an_unparseable_date_is_none_not_a_fabricated_epoch() {
        // The caller must be able to tell "no date" from "1970-01-01", so junk
        // yields `None` rather than silently collapsing to 0.
        for bad in [
            "",
            "not a date",
            "Mon, 15 Foo 2025 10:30:00 +0000",
            "Mon, 15 Sep 2025",
            "Mon, 40 Sep 2025 10:30:00 +0000",
        ] {
            assert_eq!(rfc5322_epoch(bad), None, "{bad:?} must not parse");
        }
    }

    #[tokio::test]
    async fn fetch_headers_carries_the_real_message_date() {
        use std::io::{BufRead, BufReader as StdBufReader, Write};
        use std::net::TcpListener;
        use std::sync::{Arc, Mutex};

        // Two messages with distinct Date headers; both must surface their own
        // epoch, not the 0 the live path used to hardcode.
        let h1 = "From: Ada <ada@x.io>\r\nSubject: Hi\r\nDate: Mon, 15 Sep 2025 10:30:00 +0000\r\n";
        let h2 =
            "From: Grace <grace@x.io>\r\nSubject: Build\r\nDate: Mon, 1 Jan 2024 00:00:00 GMT\r\n";
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let fetches: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let fetches2 = Arc::clone(&fetches);
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
                        send(&mut stream, b"* SEARCH 11 12\r\n");
                        send(&mut stream, format!("{tag} OK search\r\n").as_bytes());
                    } else if upper.contains("FETCH") {
                        fetches2.lock().unwrap().push(line.trim().to_string());
                        send(
                            &mut stream,
                            b"* 1 FETCH (UID 11 FLAGS () BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {",
                        );
                        send(&mut stream, format!("{}}}\r\n", h1.len()).as_bytes());
                        send(&mut stream, h1.as_bytes());
                        send(&mut stream, b")\r\n");
                        send(
                            &mut stream,
                            b"* 2 FETCH (UID 12 FLAGS () BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {",
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

        // The client must actually *request* the DATE header — a regression to
        // `(FROM SUBJECT)` would leave `date` at 0 even though the parser works
        // (the F-SH-093 defect). Asserted here, not in the server thread, so a
        // failure surfaces as a red test instead of a hang.
        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        let msgs = fetch_inbox_summaries(&cfg, 10).await.unwrap();
        let issued = fetches.lock().unwrap().clone();
        assert!(
            issued.iter().any(|c| c.to_uppercase().contains("DATE")),
            "FETCH must ask for the DATE header field: {issued:?}"
        );
        assert_eq!(msgs.len(), 2, "msgs={msgs:?}");
        assert_eq!(
            msgs[0].date, 1_757_932_200,
            "message 1's own Date, not the hardcoded 0"
        );
        assert_eq!(msgs[1].date, 1_704_067_200, "message 2's own Date");
    }

    /// A message whose `Date:` header is absent (or unparseable) must not be handed
    /// a fabricated epoch date. Every consumer reads `EmailSummary::date` as a real
    /// timestamp — the mock provider sorts newest-first on it and
    /// `MailApp.svelte::fmtDate` renders `new Date(date * 1000)`, i.e. `1970-01-01`
    /// for a `0` — and `rfc5322_epoch` returns `None` *precisely* so the caller can
    /// tell "no date" from "1970-01-01" (`an_unparseable_date_is_none_not_a_fabricated_epoch`).
    /// The `unwrap_or(0)` at the call site collapsed that distinction. The honest
    /// date is the one the server always knows: `INTERNALDATE`, the receipt time.
    #[tokio::test]
    async fn a_message_without_a_date_header_uses_the_servers_internal_date() {
        use std::io::{BufRead, BufReader as StdBufReader, Write};
        use std::net::TcpListener;
        use std::sync::{Arc, Mutex};

        // m1 carries no `Date:` header at all; m2 carries one that must win over a
        // deliberately different INTERNALDATE.
        let h1 = "From: Ada <ada@x.io>\r\nSubject: Hi\r\n";
        let h2 =
            "From: Grace <grace@x.io>\r\nSubject: Build\r\nDate: Mon, 1 Jan 2024 00:00:00 GMT\r\n";
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let fetches: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let fetches2 = Arc::clone(&fetches);
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
                        send(&mut stream, b"* SEARCH 11 12\r\n");
                        send(&mut stream, format!("{tag} OK search\r\n").as_bytes());
                    } else if upper.contains("FETCH") {
                        fetches2.lock().unwrap().push(line.trim().to_string());
                        send(
                            &mut stream,
                            b"* 1 FETCH (UID 11 FLAGS () INTERNALDATE \"15-Sep-2025 10:30:00 +0000\" BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {",
                        );
                        send(&mut stream, format!("{}}}\r\n", h1.len()).as_bytes());
                        send(&mut stream, h1.as_bytes());
                        send(&mut stream, b")\r\n");
                        send(
                            &mut stream,
                            b"* 2 FETCH (UID 12 FLAGS () INTERNALDATE \"01-Jan-2000 00:00:00 +0000\" BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {",
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
        assert_eq!(
            msgs[0].date, 1_757_932_200,
            "a message with no Date header must take the server's receipt time, not a fabricated 0"
        );
        assert_eq!(
            msgs[1].date, 1_704_067_200,
            "a parseable Date header must win over the receipt time"
        );
        let issued = fetches.lock().unwrap().clone();
        assert!(
            issued
                .iter()
                .any(|c| c.to_uppercase().contains("INTERNALDATE")),
            "the summary FETCH must ask for INTERNALDATE: {issued:?}"
        );
    }

    /// The summary's `attachment_count` must be read from the message's
    /// `BODYSTRUCTURE`, not written as a flat `0`. Before this the live path never
    /// requested the structure and hardcoded `0`, so every live message — including
    /// one with files — listed as having no attachments (REQ-A1822).
    #[tokio::test]
    async fn an_attachment_reaches_the_summary_count() {
        use std::io::{BufRead, BufReader as StdBufReader, Write};
        use std::net::TcpListener;
        use std::sync::{Arc, Mutex};

        // m1 is a plain text message; m2 is multipart/mixed carrying two attached
        // files (their disposition is `attachment`).
        let h1 = "From: Ada <ada@x.io>\r\nSubject: plain\r\n";
        let h2 = "From: Grace <grace@x.io>\r\nSubject: files\r\n";
        let fetches: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let fetches2 = Arc::clone(&fetches);
        let bs1 =
            "(\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 5 1 NIL NIL NIL NIL)";
        let bs2 = "((\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 5 1 NIL NIL NIL NIL)(\"APPLICATION\" \"PDF\" (\"NAME\" \"notes.pdf\") NIL NIL \"BASE64\" 900 12 (\"ATTACHMENT\" (\"FILENAME\" \"notes.pdf\")) NIL NIL NIL)(\"IMAGE\" \"PNG\" (\"NAME\" \"shot.png\") NIL NIL \"BASE64\" 40 2 (\"ATTACHMENT\" (\"FILENAME\" \"shot.png\")) NIL NIL NIL) \"MIXED\" (\"BOUNDARY\" \"b1\") NIL NIL NIL)";
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
                        send(&mut stream, b"* SEARCH 11 12\r\n");
                        send(&mut stream, format!("{tag} OK search\r\n").as_bytes());
                    } else if upper.contains("FETCH") {
                        fetches2.lock().unwrap().push(line.trim().to_string());
                        send(
                            &mut stream,
                            format!(
                                "* 1 FETCH (UID 11 FLAGS () BODYSTRUCTURE {bs1} BODY[HEADER.FIELDS (FROM SUBJECT)] {{"
                            )
                            .as_bytes(),
                        );
                        send(&mut stream, format!("{}}}\r\n", h1.len()).as_bytes());
                        send(&mut stream, h1.as_bytes());
                        send(&mut stream, b")\r\n");
                        send(
                            &mut stream,
                            format!(
                                "* 2 FETCH (UID 12 FLAGS () BODYSTRUCTURE {bs2} BODY[HEADER.FIELDS (FROM SUBJECT)] {{"
                            )
                            .as_bytes(),
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
        assert_eq!(
            msgs[0].attachment_count, 0,
            "a plain message carries no attachments"
        );
        assert_eq!(
            msgs[1].attachment_count, 2,
            "the two attached files must be counted, not folded to 0"
        );
        let issued = fetches.lock().unwrap().clone();
        assert!(
            issued
                .iter()
                .any(|c| c.to_uppercase().contains("BODYSTRUCTURE")),
            "the summary FETCH must ask for BODYSTRUCTURE: {issued:?}"
        );
    }

    /// A FETCH reply that omits the `BODYSTRUCTURE` item we asked for does not mean
    /// "no attachments": the count was never observed, and returning `0` would claim
    /// every message has no files. It is reported like the missing `UID` item above
    /// (REQ-A1822).
    #[tokio::test]
    async fn a_fetch_reply_without_a_bodystructure_is_an_error() {
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
                        send(&mut stream, b"* SEARCH 11\r\n");
                        send(&mut stream, format!("{tag} OK search\r\n").as_bytes());
                    } else if upper.contains("FETCH") {
                        // No `BODYSTRUCTURE` item, though the command asks for it.
                        send(
                            &mut stream,
                            b"* 1 FETCH (UID 11 FLAGS () BODY[HEADER.FIELDS (FROM SUBJECT)] {",
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

        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        let err = fetch_inbox_summaries(&cfg, 10)
            .await
            .expect_err("a reply with no BODYSTRUCTURE must not become 'no attachments'");
        assert!(
            format!("{err}").contains("BODYSTRUCTURE"),
            "the missing item must be named: {err}"
        );
    }

    /// The count reads the part's *disposition*, not any quoted word: a part whose
    /// filename merely happens to be `attachment` is not a second attachment, and an
    /// `INLINE` part is not one at all.
    #[test]
    fn the_attachment_count_reads_the_disposition_not_a_filename() {
        let line = |bs: &str| {
            format!(
                "* 1 FETCH (UID 11 FLAGS () BODYSTRUCTURE {bs} BODY[HEADER.FIELDS (FROM)] {{3}}"
            )
        };
        // A plain text message has no attachment part.
        assert_eq!(
            response_attachment_count(&line(
                "(\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 5 1 NIL NIL NIL NIL)"
            )),
            Some(0)
        );
        // One attached file.
        assert_eq!(
            response_attachment_count(&line(
                "((\"TEXT\" \"PLAIN\" NIL NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL)(\"APPLICATION\" \"PDF\" (\"NAME\" \"n.pdf\") NIL NIL \"BASE64\" 9 1 (\"ATTACHMENT\" (\"FILENAME\" \"n.pdf\")) NIL NIL NIL) \"MIXED\" NIL NIL NIL)"
            )),
            Some(1)
        );
        // Two attached files nested under multipart/mixed.
        assert_eq!(
            response_attachment_count(&line(
                "((\"TEXT\" \"PLAIN\" NIL NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL)(\"IMAGE\" \"PNG\" (\"NAME\" \"a.png\") NIL NIL \"BASE64\" 4 1 (\"ATTACHMENT\" (\"FILENAME\" \"a.png\")) NIL NIL NIL)(\"APPLICATION\" \"ZIP\" (\"NAME\" \"b.zip\") NIL NIL \"BASE64\" 4 1 (\"ATTACHMENT\" (\"FILENAME\" \"b.zip\")) NIL NIL NIL) \"MIXED\" NIL NIL NIL)"
            )),
            Some(2)
        );
        // Negative control 1: a *filename* equal to the word is not a disposition.
        assert_eq!(
            response_attachment_count(&line(
                "(\"APPLICATION\" \"OCTET-STREAM\" (\"NAME\" \"attachment\") NIL NIL \"BASE64\" 9 1 \"INLINE\" NIL NIL NIL)"
            )),
            Some(0)
        );
        // Negative control 2: an INLINE image is not an attachment.
        assert_eq!(
            response_attachment_count(&line(
                "(\"IMAGE\" \"PNG\" (\"NAME\" \"pic.png\") NIL NIL \"BASE64\" 4 1 (\"INLINE\" (\"FILENAME\" \"pic.png\")) NIL NIL NIL)"
            )),
            Some(0)
        );
        // A disposition with no parameters still counts (the `(` directly precedes it).
        assert_eq!(
            response_attachment_count(&line(
                "(\"APPLICATION\" \"OCTET-STREAM\" NIL NIL NIL \"BASE64\" 9 1 (\"ATTACHMENT\") NIL NIL NIL)"
            )),
            Some(1)
        );
        // `BODYSTRUCTURE NIL` is a bodyless message: a measured zero, not unknown.
        assert_eq!(
            response_attachment_count(
                "* 1 FETCH (UID 11 FLAGS () BODYSTRUCTURE NIL BODY[HEADER.FIELDS (FROM)] {3}"
            ),
            Some(0)
        );
        // No `BODYSTRUCTURE` item at all is *not observed* — not zero.
        assert_eq!(
            response_attachment_count("* 1 FETCH (UID 11 FLAGS (\\Seen))"),
            None
        );
    }

    /// The opened message's attachment chips come from the same structure the
    /// inbox count does: one chip per `attachment`-disposed part, with the MIME
    /// type, the filename and the part's real octet count (REQ-A1845).
    #[test]
    fn attachment_metadata_is_read_from_the_body_structure() {
        let two = "((\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 5 1 NIL NIL NIL NIL)(\"APPLICATION\" \"PDF\" (\"NAME\" \"notes.pdf\") NIL NIL \"BASE64\" 900 12 (\"ATTACHMENT\" (\"FILENAME\" \"notes.pdf\")) NIL NIL NIL)(\"IMAGE\" \"PNG\" (\"NAME\" \"shot.png\") NIL NIL \"BASE64\" 40 2 (\"ATTACHMENT\" (\"FILENAME\" \"shot.png\")) NIL NIL NIL) \"MIXED\" (\"BOUNDARY\" \"b1\") NIL NIL NIL)";
        let got = parse_attachment_meta(two).expect("a readable structure");
        assert_eq!(got.len(), 2, "both attached files: {got:?}");
        assert_eq!(got[0].filename, "notes.pdf");
        assert_eq!(got[0].mime, "application/pdf");
        assert_eq!(got[0].size, 900, "the part's own octet count");
        assert_eq!(got[1].filename, "shot.png");
        assert_eq!(got[1].mime, "image/png");
        assert_eq!(got[1].size, 40);
        assert_ne!(got[0].id, got[1].id, "two chips need two ids");
        // A plain text message has no attachment part.
        assert!(parse_attachment_meta(
            "(\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 5 1 NIL NIL NIL NIL)"
        )
        .unwrap()
        .is_empty());
        // `NIL` is a bodyless message: a measured zero, not a failure.
        assert!(parse_attachment_meta("NIL").unwrap().is_empty());
        // A name that merely *is* the word is not a disposition.
        assert!(parse_attachment_meta(
            "(\"APPLICATION\" \"OCTET-STREAM\" (\"NAME\" \"attachment\") NIL NIL \"BASE64\" 9 1 (\"INLINE\" (\"FILENAME\" \"attachment\")) NIL NIL NIL)"
        )
        .unwrap()
        .is_empty());
        // A disposition with no filename falls back to the part's `NAME`.
        let named = parse_attachment_meta(
            "(\"APPLICATION\" \"ZIP\" (\"NAME\" \"b.zip\") NIL NIL \"BASE64\" 4 1 (\"ATTACHMENT\" NIL) NIL NIL NIL)",
        )
        .unwrap();
        assert_eq!(named[0].filename, "b.zip");
        assert_eq!(named[0].size, 4);
        // An `attachment` part with no readable octet count is a structure we
        // cannot describe — refused, not reported as a 0-byte file.
        assert!(parse_attachment_meta(
            "(\"APPLICATION\" \"PDF\" (\"NAME\" \"n.pdf\") NIL NIL \"BASE64\" NIL NIL (\"ATTACHMENT\" (\"FILENAME\" \"n.pdf\")) NIL NIL NIL)"
        )
        .is_none());
        // Trailing junk is not a structure either.
        assert!(parse_attachment_meta("(\"TEXT\" \"PLAIN\") garbage").is_none());
    }

    /// The `BODYSTRUCTURE` item is sliced by its own parentheses — a paren inside
    /// a quoted filename must not end it early, and an absent item is `None`
    /// rather than an empty structure.
    #[test]
    fn the_body_structure_item_is_sliced_by_its_parens() {
        let line = "* 1 FETCH (UID 11 BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM)] {3}";
        assert_eq!(
            bodystructure_item(line),
            Some("(\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL)")
        );
        assert_eq!(
            bodystructure_item("* 1 FETCH (UID 11 BODYSTRUCTURE NIL)"),
            Some("NIL")
        );
        assert_eq!(bodystructure_item("* 1 FETCH (UID 11 FLAGS ())"), None);
        assert_eq!(
            bodystructure_item(
                "* 1 FETCH (BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"NAME\" \"a)b\") NIL))"
            ),
            Some("(\"TEXT\" \"PLAIN\" (\"NAME\" \"a)b\") NIL)")
        );
    }

    #[test]
    fn an_internal_date_is_parsed_and_a_junk_one_is_none() {
        assert_eq!(
            internal_date_epoch("15-Sep-2025 10:30:00 +0000"),
            Some(1_757_932_200)
        );
        // The day field is space-padded inside the quotes; the zone shifts the epoch.
        assert_eq!(
            internal_date_epoch("15-Sep-2025 10:30:00 -0700"),
            Some(1_757_932_200 + 7 * 3600)
        );
        for bad in [
            "",
            "not a date",
            "15-Foo-2025 10:30:00 +0000",
            "40-Sep-2025 10:30:00 +0000",
            "15-Sep-2025",
        ] {
            assert_eq!(internal_date_epoch(bad), None, "{bad:?} must not parse");
        }
        assert_eq!(
            response_internaldate(
                "* 1 FETCH (UID 11 FLAGS () INTERNALDATE \"15-Sep-2025 10:30:00 +0000\" BODY[] {3}"
            ),
            Some("15-Sep-2025 10:30:00 +0000")
        );
        assert_eq!(response_internaldate("* 1 FETCH (UID 11 FLAGS ())"), None);
    }

    /// The status **word** is what decides, not "the line mentions `OK`" (REQ-A1681).
    #[test]
    fn a_completion_is_ok_only_when_the_status_word_is_ok() {
        // Positive controls: the tagged completion and the untagged greeting, plus
        // case-insensitivity (servers are not required to shout).
        assert!(tagged_status_ok("a3 OK done"));
        assert!(tagged_status_ok("* OK IMAP4rev1 ready"));
        assert!(tagged_status_ok("a4 ok [read-write]"));
        // The refusals that used to read as success.
        assert!(!tagged_status_ok("a3 NO [AUTHENTICATIONFAILED] locked"));
        assert!(!tagged_status_ok("a4 BAD command unknown"));
        // The negative control for the old `contains("OK")`: a refusal whose *reason*
        // mentions OK must not be a success.
        assert!(
            !tagged_status_ok("a3 NO the mailbox is OK but locked"),
            "a reason that mentions OK is not a status of OK"
        );
        // Non-completion lines: the status word is not in second position.
        assert!(!tagged_status_ok("* 3 EXISTS"));
        assert!(!tagged_status_ok("* SEARCH 1 2"));
        assert!(!tagged_status_ok(""));
    }

    /// A server that answers the header flow with caller-chosen status words, so a
    /// refused SEARCH/FETCH can be exercised (the OK path is covered above).
    fn spawn_imap_flow(search_status: &str, fetch_status: &str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let search_status = search_status.to_string();
        let fetch_status = fetch_status.to_string();
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
                        send(&mut stream, b"* SEARCH 11 12\r\n");
                        send(
                            &mut stream,
                            format!("{tag} {search_status} search\r\n").as_bytes(),
                        );
                    } else if upper.contains("FETCH") {
                        let h1 = "From: Ada <ada@x.io>\r\nSubject: Hi\r\n";
                        send(
                            &mut stream,
                            b"* 1 FETCH (UID 11 FLAGS (\\Seen) BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"US-ASCII\") NIL NIL \"7BIT\" 1 1 NIL NIL NIL NIL) BODY[HEADER.FIELDS (FROM SUBJECT)] {",
                        );
                        send(&mut stream, format!("{}}}\r\n", h1.len()).as_bytes());
                        send(&mut stream, h1.as_bytes());
                        send(&mut stream, b")\r\n");
                        send(
                            &mut stream,
                            format!("{tag} {fetch_status} fetch\r\n").as_bytes(),
                        );
                    } else if upper.contains("LOGOUT") {
                        send(&mut stream, format!("{tag} OK bye\r\n").as_bytes());
                        break;
                    } else {
                        send(&mut stream, format!("{tag} OK\r\n").as_bytes());
                    }
                }
            }
        });
        port
    }

    /// A refused SEARCH is an error, not "no mail". The old loop broke on *any*
    /// `a3 …` line, so a `NO` search returned `Ok(vec![])` — an empty inbox that no
    /// server ever described (REQ-A1681).
    #[tokio::test]
    async fn a_refused_search_is_an_error_not_an_empty_inbox() {
        let port = spawn_imap_flow("NO", "OK");
        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        let err = fetch_inbox_summaries(&cfg, 10)
            .await
            .expect_err("a refused SEARCH must not read as an empty mailbox");
        assert!(
            format!("{err}").contains("search failed"),
            "the refusal must be named: {err}"
        );
    }

    /// `count_unseen` keeps the same rule (it already checked `OK`; this pins that the
    /// shared definition still says no to a `NO`).
    #[tokio::test]
    async fn a_refused_unseen_search_is_an_error_too() {
        let port = spawn_imap_flow("NO", "OK");
        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        assert!(count_unseen(&cfg).await.is_err());
    }

    /// A refused FETCH is an error, not a short list: the summaries collected before
    /// the `BAD` are partial, and returning them as the inbox is the same false-empty
    /// shape one step later (REQ-A1681).
    #[tokio::test]
    async fn a_refused_fetch_is_an_error_not_a_partial_list() {
        let port = spawn_imap_flow("OK", "BAD");
        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        let err = fetch_inbox_summaries(&cfg, 10)
            .await
            .expect_err("a refused FETCH must not return the partial list");
        assert!(
            format!("{err}").contains("fetch failed"),
            "the refusal must be named: {err}"
        );
    }

    /// Positive control: the very same flow with `OK` statuses still returns the rows,
    /// so the checks above are not just "always refuse".
    #[tokio::test]
    async fn an_ok_flow_still_returns_the_rows() {
        let port = spawn_imap_flow("OK", "OK");
        let cfg = ImapConfig::new("127.0.0.1", port, "user", "secret");
        let msgs = fetch_inbox_summaries(&cfg, 10).await.unwrap();
        assert_eq!(msgs.len(), 1, "the one fetched row must survive: {msgs:?}");
    }
}

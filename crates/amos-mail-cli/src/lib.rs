//! `amos-mail-cli` — Amos email **CLI**.
//!
//! A thin headless front-end over [`amos_mail::MailClient`], currently driving
//! the deterministic offline [`MockMailProvider`]. It is the "CLI half" of the
//! tauri + CLI strategy: the *same* engine this binary uses is what the Tauri
//! System-UI bridge will call.
//!
//! ```text
//! $ amos-mail-cli demo                      # offline sample: inbox -> read -> send
//! $ amos-mail-cli mailboxes
//! $ amos-mail-cli list --limit 10
//! $ amos-mail-cli read m3
//! $ amos-mail-cli send --to ada@x.io --subject "Hi" --body "hello"
//! $ amos-mail-cli delete m3
//! ```
//!
//! Subcommand parsing lives in [`parse_args`] and execution in [`dispatch`]
//! (generic over any [`MailProvider`], so a live IMAP/SMTP backend can drop in
//! without changing the CLI code). The core is exposed for unit tests that run
//! entirely in memory.
//!
//! *Note:* the default backend is the in-memory mock; each invocation starts
//! empty unless you `seed` demo mail via [`demo`]. A persistent or live backend
//! is a later milestone.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use std::path::PathBuf;

use amos_mail::{Account, Address, MailClient, MailProvider, MockMailProvider, INBOX};
use anyhow::{anyhow, Context, Result};

/// CLI usage text.
pub const USAGE: &str = "\
amos-mail-cli — Amos email client CLI (offline MockMailProvider by default)

USAGE:
    amos-mail-cli [--store <PATH>] <SUBCOMMAND> [OPTIONS]

SUBCOMMANDS:
    mailboxes                 List selectable mailboxes
    list [--mailbox M] [--limit N]
                              List message summaries, newest first (default INBOX)
    search <QUERY> [--mailbox M] [--limit N]
                              Search by sender/recipient/subject/body, newest first
    read  <ID> [--mailbox M]  Fetch a message and mark it read
    read-all [--mailbox M]    Mark every message in a mailbox as read
    imap-unseen --host H [--port N] --user U --pass P [--tls]
                              Report unseen count on a live IMAP server (--features live)
    show  <ID> [--mailbox M]  Fetch a message without changing read state
    send  --to <ADDR> [--to ...] [--cc ...] --subject S --body B
                              Compose and send (default sender: Amos Demo <me@amos.local>)
                              [--from <EMAIL>] [--attach <PATH>]...
    star  <ID> on|off         Star / unstar a message
    archive <ID> [--mailbox M] Move a message into Archive
    trash  <ID> [--mailbox M] Move a message into Trash (recoverable)
    delete <ID> [--mailbox M] Permanently delete a message
    demo                      Print an offline sample session (seed -> list -> read -> send)
    help                      Show this help

OPTIONS:
    -h, --help                Show this help
    --store <PATH>            Persist the mailbox store to this JSON file (can appear
                              anywhere before/after the subcommand). Without it mail is
                              ephemeral (reset each run). Also honors $AMOS_MAIL_STORE.
";

/// One CLI operation, fully parsed and ready to execute against a client.
#[derive(Clone, Debug)]
pub enum Op {
    /// Print `USAGE`.
    Help,
    /// Print an offline demo session (seed + read + send) over one mock store.
    Demo,
    /// List mailbox names.
    Mailboxes,
    /// List summaries in a mailbox.
    List {
        mailbox: String,
        limit: Option<usize>,
    },
    /// Search summaries in a mailbox (sender/recipient/subject/body).
    Search {
        mailbox: String,
        query: String,
        limit: Option<usize>,
    },
    /// Fetch and mark read.
    Read { mailbox: String, id: String },
    /// Fetch without changing read state.
    Show { mailbox: String, id: String },
    /// Compose + send.
    Send(SendArgs),
    /// Star / unstar.
    Star {
        mailbox: String,
        id: String,
        on: bool,
    },
    /// Delete a message.
    Delete { mailbox: String, id: String },
    /// Move a message into `Archive`.
    Archive { mailbox: String, id: String },
    /// Move a message into `Trash`.
    Trash { mailbox: String, id: String },
    /// Mark every message in a mailbox as read.
    ReadAll { mailbox: String },
    /// Report the number of unseen messages on a real IMAP server (live).
    ImapUnseen {
        host: String,
        port: u16,
        user: String,
        pass: String,
        tls: bool,
    },
}

/// Parsed `send` arguments (raw email/path strings — validated at execution).
#[derive(Clone, Debug, Default)]
pub struct SendArgs {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub body: String,
    /// Override the sender (defaults to the demo account).
    pub from: Option<String>,
    /// File paths to attach.
    pub attachments: Vec<PathBuf>,
    /// `host:port` of an SMTP relay. When set (and built with `--features live`)
    /// the draft is sent over real SMTP instead of the mock store.
    pub smtp: Option<String>,
    /// Optional SMTP AUTH username.
    pub smtp_user: Option<String>,
    /// Optional SMTP AUTH password.
    pub smtp_pass: Option<String>,
    /// Use STARTTLS (for real relays such as Gmail).
    pub smtp_tls: bool,
}

/// The default demo account identity (used as the sender).
pub fn default_account() -> Result<Account> {
    let email = Address::bare("me@amos.local")?;
    Ok(Account::new("demo", "Amos Demo", email)?)
}

/// Take the next token as the value for an option, or error.
fn need<'a>(it: &mut impl Iterator<Item = &'a String>, opt: &str) -> Result<String> {
    it.next()
        .cloned()
        .ok_or_else(|| anyhow!("{opt} requires a value"))
}

/// Parse `list [--mailbox M] [--limit N]`.
fn parse_list<'a>(it: &mut impl Iterator<Item = &'a String>) -> Result<Op> {
    let mut mailbox = INBOX.to_string();
    let mut limit = None;
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--mailbox" => mailbox = need(it, "--mailbox")?,
            "--limit" => {
                let raw = need(it, "--limit")?;
                limit = Some(
                    raw.parse::<usize>()
                        .map_err(|_| anyhow!("--limit must be a number, got {raw:?}"))?,
                );
            }
            "-h" | "--help" => return Ok(Op::Help),
            other => return Err(anyhow!("list: unknown option {other:?}")),
        }
    }
    Ok(Op::List { mailbox, limit })
}

/// Parse `search <QUERY> [--mailbox M] [--limit N]`.
fn parse_search<'a>(it: &mut impl Iterator<Item = &'a String>) -> Result<Op> {
    let mut mailbox = INBOX.to_string();
    let mut query = None;
    let mut limit = None;
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--mailbox" => mailbox = need(it, "--mailbox")?,
            "--limit" => {
                let raw = need(it, "--limit")?;
                limit = Some(
                    raw.parse::<usize>()
                        .map_err(|_| anyhow!("--limit must be a number, got {raw:?}"))?,
                );
            }
            "-h" | "--help" => return Ok(Op::Help),
            other => {
                if query.replace(other.to_string()).is_some() {
                    return Err(anyhow!("search: unexpected extra argument {other:?}"));
                }
            }
        }
    }
    let query = query.ok_or_else(|| anyhow!("search needs a <QUERY> (try: search invoice)"))?;
    Ok(Op::Search {
        mailbox,
        query,
        limit,
    })
}

/// Parse `read`/`show <ID> [--mailbox M]`.
fn parse_fetch<'a>(it: &mut impl Iterator<Item = &'a String>, show: bool) -> Result<Op> {
    let mut mailbox = INBOX.to_string();
    let mut id = None;
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--mailbox" => mailbox = need(it, "--mailbox")?,
            "-h" | "--help" => return Ok(Op::Help),
            other => {
                if id.replace(other.to_string()).is_some() {
                    return Err(anyhow!("unexpected extra argument {other:?}"));
                }
            }
        }
    }
    let id = id.ok_or_else(|| anyhow!("missing message ID (try: read <ID>)"))?;
    if show {
        Ok(Op::Show { mailbox, id })
    } else {
        Ok(Op::Read { mailbox, id })
    }
}

/// Parse `star <ID> on|off [--mailbox M]` and `delete <ID> [--mailbox M]`.
fn parse_id_action<'a>(it: &mut impl Iterator<Item = &'a String>, star: bool) -> Result<Op> {
    let mut mailbox = INBOX.to_string();
    let mut id = None;
    let mut flag: Option<bool> = None;
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--mailbox" => mailbox = need(it, "--mailbox")?,
            "on" if star => flag = Some(true),
            "off" if star => flag = Some(false),
            "-h" | "--help" => return Ok(Op::Help),
            other => {
                if id.replace(other.to_string()).is_some() {
                    return Err(anyhow!("unexpected extra argument {other:?}"));
                }
            }
        }
    }
    let id = id.ok_or_else(|| {
        anyhow!(
            "missing message ID (try: {} <ID>)",
            if star { "star" } else { "delete" }
        )
    })?;
    if star {
        let on = flag.ok_or_else(|| anyhow!("star needs an on|off action"))?;
        Ok(Op::Star { mailbox, id, on })
    } else {
        Ok(Op::Delete { mailbox, id })
    }
}

/// Parse `archive|trash <ID> [--mailbox M]`.
fn parse_move<'a>(it: &mut impl Iterator<Item = &'a String>, archive: bool) -> Result<Op> {
    let mut mailbox = INBOX.to_string();
    let mut id = None;
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--mailbox" => mailbox = need(it, "--mailbox")?,
            "-h" | "--help" => return Ok(Op::Help),
            other => {
                if id.replace(other.to_string()).is_some() {
                    return Err(anyhow!("unexpected extra argument {other:?}"));
                }
            }
        }
    }
    let id = id.ok_or_else(|| {
        anyhow!(
            "missing message ID (try: {} <ID>)",
            if archive { "archive" } else { "trash" }
        )
    })?;
    if archive {
        Ok(Op::Archive { mailbox, id })
    } else {
        Ok(Op::Trash { mailbox, id })
    }
}

/// Parse `read-all [--mailbox M]`.
fn parse_read_all<'a>(it: &mut impl Iterator<Item = &'a String>) -> Result<Op> {
    let mut mailbox = INBOX.to_string();
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--mailbox" => mailbox = need(it, "--mailbox")?,
            "-h" | "--help" => return Ok(Op::Help),
            other => return Err(anyhow!("read-all: unknown option {other:?}")),
        }
    }
    Ok(Op::ReadAll { mailbox })
}

/// Parse `imap-unseen --host H --port N --user U --pass P`.
fn parse_imap_unseen<'a>(it: &mut impl Iterator<Item = &'a String>) -> Result<Op> {
    let mut host = None;
    let mut port = 143u16;
    let mut user = None;
    let mut pass = None;
    let mut tls = false;
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--host" => host = Some(need(it, "--host")?),
            "--port" => {
                let raw = need(it, "--port")?;
                port = raw
                    .parse()
                    .map_err(|_| anyhow!("--port must be a number, got {raw:?}"))?;
            }
            "--user" => user = Some(need(it, "--user")?),
            "--pass" => pass = Some(need(it, "--pass")?),
            "--tls" => tls = true,
            "-h" | "--help" => return Ok(Op::Help),
            other => return Err(anyhow!("imap-unseen: unknown option {other:?}")),
        }
    }
    let host = host.ok_or_else(|| anyhow!("imap-unseen needs --host <HOST>"))?;
    let user = user.ok_or_else(|| anyhow!("imap-unseen needs --user <USER>"))?;
    let pass = pass.ok_or_else(|| anyhow!("imap-unseen needs --pass <PASS>"))?;
    Ok(Op::ImapUnseen {
        host,
        port,
        user,
        pass,
        tls,
    })
}

/// Parse the `send` subcommand flags.
fn parse_send<'a>(it: &mut impl Iterator<Item = &'a String>) -> Result<Op> {
    let mut args = SendArgs::default();
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--to" => args.to.push(need(it, "--to")?),
            "--cc" => args.cc.push(need(it, "--cc")?),
            "--subject" => args.subject = need(it, "--subject")?,
            "--body" => args.body = need(it, "--body")?,
            "--from" => args.from = Some(need(it, "--from")?),
            "--smtp" => args.smtp = Some(need(it, "--smtp")?),
            "--smtp-user" => args.smtp_user = Some(need(it, "--smtp-user")?),
            "--smtp-pass" => args.smtp_pass = Some(need(it, "--smtp-pass")?),
            "--smtp-tls" => args.smtp_tls = true,
            "--attach" => args.attachments.push(PathBuf::from(need(it, "--attach")?)),
            "-h" | "--help" => return Ok(Op::Help),
            other => return Err(anyhow!("send: unknown option {other:?}")),
        }
    }
    if args.to.is_empty() {
        return Err(anyhow!("send requires at least one --to <ADDR>"));
    }
    Ok(Op::Send(args))
}

/// Parse CLI arguments (first token is the subcommand). A leading/embedded
/// `--store <PATH>` pair is dropped here (ignored for dispatch) so the store
/// flag can appear anywhere; [`store_path`] reads it back off the raw args.
pub fn parse_args(args: &[String]) -> Result<Op> {
    let filtered: Vec<String> = {
        let mut out = Vec::new();
        let mut it = args.iter();
        while let Some(a) = it.next() {
            if a == "--store" {
                let _ = it.next();
            } else {
                out.push(a.clone());
            }
        }
        out
    };
    let mut rest = filtered.iter();
    let Some(cmd) = rest.next() else {
        return Ok(Op::Help);
    };
    match cmd.as_str() {
        "help" | "-h" | "--help" => Ok(Op::Help),
        "demo" => Ok(Op::Demo),
        "mailboxes" => Ok(Op::Mailboxes),
        "list" => parse_list(&mut rest),
        "search" => parse_search(&mut rest),
        "read" => parse_fetch(&mut rest, false),
        "read-all" => parse_read_all(&mut rest),
        "imap-unseen" => parse_imap_unseen(&mut rest),
        "show" => parse_fetch(&mut rest, true),
        "star" => parse_id_action(&mut rest, true),
        "delete" => parse_id_action(&mut rest, false),
        "archive" => parse_move(&mut rest, true),
        "trash" => parse_move(&mut rest, false),
        "send" => parse_send(&mut rest),
        other => Err(anyhow!(
            "unknown subcommand {other:?} (try: amos-mail-cli help)"
        )),
    }
}

/// Resolve a persistent store path: `--store <PATH>` wins, else the
/// `AMOS_MAIL_STORE` env var. Returns `None` for an ephemeral (in-memory) store.
pub fn store_path(args: &[String]) -> Option<PathBuf> {
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--store" {
            return args.get(i + 1).map(PathBuf::from);
        }
        i += 1;
    }
    std::env::var("AMOS_MAIL_STORE")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/// Render a header/recipient address, or `-` when absent.
fn addr_or_dash(a: &Option<Address>) -> String {
    a.as_ref()
        .map(|x| x.to_string())
        .unwrap_or_else(|| "-".to_string())
}

/// Render a recipient list.
fn addr_list(addrs: &[Address]) -> String {
    if addrs.is_empty() {
        "-".to_string()
    } else {
        addrs
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// One-line summary of a message.
fn summary_line(s: &amos_mail::EmailSummary) -> String {
    let unread = if s.flags.seen { "" } else { "  [unread]" };
    let star = if s.flags.flagged { "* " } else { "" };
    let n_att = if s.attachment_count == 0 {
        String::new()
    } else {
        format!("  [{} attachment(s)]", s.attachment_count)
    };
    format!(
        "{star}{:<6} {}  {}{}{}",
        s.id,
        addr_or_dash(&s.from),
        s.subject,
        n_att,
        unread
    )
}

/// A full multi-line rendering of one message.
fn message_block(e: &amos_mail::Email) -> String {
    let mut out = Vec::new();
    out.push(format!("From:    {}", addr_or_dash(&e.summary.from)));
    out.push(format!("To:      {}", addr_list(&e.summary.to)));
    out.push(format!("Subject: {}", e.summary.subject));
    out.push(format!(
        "Date:    {}  ({})",
        e.summary.date,
        if e.summary.flags.seen {
            "read"
        } else {
            "unread"
        }
    ));
    for a in &e.attachments {
        out.push(format!(
            "Attach:  {} ({}, {} B)",
            a.filename, a.mime, a.size
        ));
    }
    out.push(String::new());
    for line in e.body_plain.lines() {
        out.push(line.to_string());
    }
    out.join("\n")
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Execute `op` against a client and return the lines to print.
///
/// Generic over the provider so a future live backend works unchanged.
pub async fn dispatch<P: MailProvider>(client: &MailClient<P>, op: Op) -> Result<Vec<String>> {
    match op {
        Op::Help => Ok(vec![USAGE.to_string()]),
        Op::Demo => Ok(vec![
            "(run `amos-mail-cli demo` — it seeds and plays its own offline session)".to_string(),
        ]),
        Op::Mailboxes => Ok(client.mailboxes().await?),
        Op::List { mailbox, limit } => {
            let msgs = client.list(&mailbox, limit).await?;
            let mut out = Vec::new();
            out.push(format!(
                "Mailbox {mailbox:?}: {} message(s){}",
                msgs.len(),
                match limit {
                    Some(n) => format!(" (showing at most {n})"),
                    None => String::new(),
                }
            ));
            if msgs.is_empty() {
                out.push("  (empty)".to_string());
            } else {
                for s in &msgs {
                    out.push(summary_line(s));
                }
            }
            Ok(out)
        }
        Op::Search {
            mailbox,
            query,
            limit,
        } => {
            let msgs = client.search(&mailbox, &query, limit).await?;
            let mut out = Vec::new();
            out.push(format!(
                "Search {query:?} in {mailbox:?}: {} match(es){}",
                msgs.len(),
                match limit {
                    Some(n) => format!(" (showing at most {n})"),
                    None => String::new(),
                }
            ));
            if msgs.is_empty() {
                out.push("  (no matches)".to_string());
            } else {
                for s in &msgs {
                    out.push(summary_line(s));
                }
            }
            Ok(out)
        }
        Op::Read { mailbox, id } => {
            let e = client.read(&mailbox, &id).await?;
            Ok(vec![message_block(&e)])
        }
        Op::ReadAll { mailbox } => {
            let n = client.mark_all_seen(&mailbox).await?;
            Ok(vec![format!("marked {n} message(s) as read in {mailbox}")])
        }
        Op::ImapUnseen { .. } => Err(anyhow!(
            "imap-unseen talks to a live IMAP server; run with --features live (handled by `run`)"
        )),
        Op::Show { mailbox, id } => {
            let e = client.fetch(&mailbox, &id).await?;
            Ok(vec![message_block(&e)])
        }
        Op::Send(args) => {
            #[cfg(feature = "live")]
            if args.smtp.is_some() {
                return smtp_send_lines(client, &args);
            }
            #[cfg(not(feature = "live"))]
            if args.smtp.is_some() {
                return Err(anyhow!("send --smtp requires the `live` feature"));
            }
            let draft = build_draft(client, &args)?;
            let receipt = client.send(draft).await?;
            Ok(vec![format!("sent as {} (stored in Sent)", receipt.id)])
        }
        Op::Star { mailbox, id, on } => {
            client.set_flagged(&mailbox, &id, on).await?;
            Ok(vec![format!(
                "{} {id} in {mailbox}",
                if on { "starred" } else { "unstarred" }
            )])
        }
        Op::Delete { mailbox, id } => {
            client.delete(&mailbox, &id).await?;
            Ok(vec![format!("deleted {id} from {mailbox}")])
        }
        Op::Archive { mailbox, id } => {
            client.archive(&mailbox, &id).await?;
            Ok(vec![format!("archived {id} from {mailbox}")])
        }
        Op::Trash { mailbox, id } => {
            client.trash(&mailbox, &id).await?;
            Ok(vec![format!("trashed {id} from {mailbox}")])
        }
    }
}

/// Build a sendable [`amos_mail::SendDraft`] from CLI args, starting from the
/// account sender and validating recipient addresses.
fn build_draft<P: MailProvider>(
    client: &MailClient<P>,
    a: &SendArgs,
) -> Result<amos_mail::SendDraft> {
    let mut draft = client.compose(&a.subject, &a.body);
    if let Some(from) = &a.from {
        draft.from = Some(Address::bare(from)?);
    }
    for raw in a.to.iter().chain(a.cc.iter()) {
        let addr = Address::bare(raw).context("invalid recipient address")?;
        let is_cc = a.cc.iter().any(|c| c == raw);
        if is_cc {
            draft.cc.push(addr);
        } else {
            draft.to.push(addr);
        }
    }
    for path in &a.attachments {
        let data = std::fs::read(path)
            .with_context(|| format!("cannot read attachment {}", path.display()))?;
        let filename = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "attachment".to_string());
        let mime = guess_mime(&filename);
        draft.attachments.push(amos_mail::Attachment {
            filename,
            mime,
            data,
        });
    }
    Ok(draft)
}

/// Send a draft over real SMTP (only built with the `live` feature).
#[cfg(feature = "live")]
fn smtp_send_lines<P: MailProvider>(client: &MailClient<P>, a: &SendArgs) -> Result<Vec<String>> {
    let target = a
        .smtp
        .as_ref()
        .ok_or_else(|| anyhow!("missing --smtp target"))?;
    let (host, port) = target
        .rsplit_once(':')
        .ok_or_else(|| anyhow!("--smtp must be host:port, got {target:?}"))?;
    let port: u16 = port
        .parse()
        .map_err(|_| anyhow!("--smtp port is not a number: {port:?}"))?;

    let mut cfg = amos_mail::live::SmtpConfig::new(host, port);
    if a.smtp_tls {
        cfg = cfg.tls();
    }
    if let Some(user) = &a.smtp_user {
        cfg = cfg.credentials(user.clone(), a.smtp_pass.clone().unwrap_or_default());
    }
    let draft = build_draft(client, a)?;
    let rcpt = amos_mail::live::smtp::send(&cfg, &draft)?;
    Ok(vec![format!("sent via SMTP {host}:{port} as {}", rcpt.id)])
}

fn guess_mime(filename: &str) -> String {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".txt") || lower.ends_with(".md") || lower.ends_with(".log") {
        "text/plain"
    } else if lower.ends_with(".html") || lower.ends_with(".htm") {
        "text/html"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else {
        "application/octet-stream"
    }
    .to_string()
}

/// Seed a few demo messages into `provider` (used by [`demo`] and tests).
fn seed_demo(p: &MockMailProvider) -> Result<()> {
    let me = Address::bare("me@amos.local")?;
    p.deliver(
        Some(Address::new("Ada", "ada@x.io")?),
        vec![me.clone()],
        "Welcome to Amos Mail",
        "Hi! This is your first offline message.\nClick compose to reply.",
        1_700_000_000,
    )?;
    p.deliver(
        Some(Address::new("Grace", "grace@x.io")?),
        vec![me],
        "Re: build report",
        "Build is green. Shipping the CLI today.",
        1_700_010_000,
    )?;
    Ok(())
}

/// Run the `demo` subcommand: seed mail, then list/read/send over one store.
pub async fn demo_lines() -> Result<Vec<String>> {
    let p = MockMailProvider::new();
    seed_demo(&p)?;
    let client = MailClient::new(p.clone(), default_account()?);

    let mut out = Vec::new();
    out.push("== mailboxes ==".to_string());
    for line in dispatch(&client, Op::Mailboxes).await? {
        out.push(format!("  {line}"));
    }
    out.push(String::new());
    out.push("== inbox (newest first) ==".to_string());
    for line in dispatch(
        &client,
        Op::List {
            mailbox: INBOX.to_string(),
            limit: None,
        },
    )
    .await?
    {
        out.push(line);
    }
    out.push(String::new());

    let inbox = client.inbox(None).await?;
    if let Some(first) = inbox.first() {
        out.push("== read first message ==".to_string());
        out.push(String::new());
        for line in dispatch(
            &client,
            Op::Read {
                mailbox: INBOX.to_string(),
                id: first.id.clone(),
            },
        )
        .await?
        {
            out.push(line);
        }
        out.push(String::new());
        out.push("== reply (send) ==".to_string());
        for line in dispatch(
            &client,
            Op::Send(SendArgs {
                to: vec!["ada@x.io".to_string()],
                subject: "Re: Welcome to Amos Mail".to_string(),
                body: "Thanks, looking good!".to_string(),
                ..SendArgs::default()
            }),
        )
        .await?
        {
            out.push(line);
        }
    }
    Ok(out)
}

/// `amos-mail-cli run` entry shared by the binary and tests: parse + execute.
///
/// With a persistent store (`--store <PATH>` or `AMOS_MAIL_STORE`) the mock
/// provider is loaded before the command runs and saved again afterwards, so
/// state survives across invocations.
pub async fn run(args: &[String]) -> Result<Vec<String>> {
    let op = parse_args(args)?;
    match op {
        Op::Demo => demo_lines().await,
        Op::Help => Ok(vec![USAGE.to_string()]),
        op => {
            #[cfg(feature = "live")]
            if let Op::ImapUnseen {
                host,
                port,
                user,
                pass,
                tls,
            } = &op
            {
                let mut cfg = amos_mail::live::ImapConfig::new(
                    host.clone(),
                    *port,
                    user.clone(),
                    pass.clone(),
                );
                if *tls {
                    cfg = cfg.tls();
                }
                let n = amos_mail::live::count_unseen(&cfg).await?;
                return Ok(vec![format!(
                    "{n} unseen message(s) in INBOX on {host}:{port}"
                )]);
            }
            let store = store_path(args);
            let provider = match &store {
                Some(path) => MockMailProvider::open_file(path)?,
                None => MockMailProvider::new(),
            };
            let client = MailClient::new(provider, default_account()?);
            let lines = dispatch(&client, op).await?;
            if let Some(path) = &store {
                client.provider().save_file(path)?;
            }
            Ok(lines)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_mail::SENT;

    fn s(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn parse_known_subcommands() {
        assert!(matches!(parse_args(&s(&[])).unwrap(), Op::Help));
        assert!(matches!(
            parse_args(&s(&["mailboxes"])).unwrap(),
            Op::Mailboxes
        ));
        assert!(matches!(
            parse_args(&s(&["list", "--mailbox", "INBOX", "--limit", "5"])).unwrap(),
            Op::List { limit: Some(5), .. }
        ));
        assert!(matches!(
            parse_args(&s(&["read", "m1"])).unwrap(),
            Op::Read { id, .. } if id == "m1"
        ));
        assert!(matches!(
            parse_args(&s(&["star", "m1", "on"])).unwrap(),
            Op::Star { on: true, .. }
        ));
    }

    #[test]
    fn parse_rejects_bad_input() {
        assert!(parse_args(&s(&["nope"])).is_err());
        assert!(parse_args(&s(&["list", "--limit", "x"])).is_err());
        assert!(parse_args(&s(&["read"])).is_err(), "missing id");
        assert!(parse_args(&s(&["star", "m1"])).is_err(), "missing action");
        assert!(
            parse_args(&s(&["send", "--subject", "x"])).is_err(),
            "no --to"
        );
    }

    /// A client whose mock inbox holds two seeded demo messages.
    fn seeded_client() -> MailClient<MockMailProvider> {
        let p = MockMailProvider::new();
        seed_demo(&p).unwrap();
        MailClient::new(p, default_account().unwrap())
    }

    #[tokio::test]
    async fn dispatch_lists_newest_first() {
        let client = seeded_client();
        let lines = dispatch(
            &client,
            Op::List {
                mailbox: INBOX.to_string(),
                limit: None,
            },
        )
        .await
        .unwrap();
        let joined = lines.join("\n");
        assert!(joined.contains("2 message(s)"), "{joined}");
        // newest first => Grace's later message precedes Ada's.
        let grace = joined.find("build report").unwrap();
        let ada = joined.find("Welcome to Amos Mail").unwrap();
        assert!(grace < ada, "newest should sort first");
    }

    #[tokio::test]
    async fn dispatch_read_marks_seen_and_renders_body() {
        let client = seeded_client();
        let inbox = client.inbox(None).await.unwrap();
        let first = &inbox[0];

        let lines = dispatch(
            &client,
            Op::Read {
                mailbox: INBOX.to_string(),
                id: first.id.clone(),
            },
        )
        .await
        .unwrap();
        let block = lines.join("\n");
        assert!(block.contains("Shipping the CLI today"), "{block}");

        let again = client.inbox(None).await.unwrap();
        assert!(again[0].flags.seen, "read() marks seen");
    }

    #[tokio::test]
    async fn dispatch_send_puts_copy_in_sent() {
        let client = seeded_client();
        let lines = dispatch(
            &client,
            Op::Send(SendArgs {
                to: vec!["ada@x.io".to_string()],
                subject: "Heads up".to_string(),
                body: "see you soon".to_string(),
                ..SendArgs::default()
            }),
        )
        .await
        .unwrap();
        assert!(lines[0].starts_with("sent as m"), "{lines:?}");

        let sent = client.list(SENT, None).await.unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].subject, "Heads up");
    }

    #[tokio::test]
    async fn run_demo_plays_a_session() {
        let lines = demo_lines().await.unwrap();
        let joined = lines.join("\n");
        assert!(joined.contains("INBOX"));
        assert!(joined.contains("read first message"));
        assert!(joined.contains("Shipping the CLI today"));
        assert!(joined.contains("sent as m"));
    }

    #[tokio::test]
    async fn run_routes_help_and_mailboxes() {
        let help = run(&s(&[])).await.unwrap();
        assert!(help.join("\n").contains("SUBCOMMANDS"));
        let boxes = run(&s(&["mailboxes"])).await.unwrap();
        assert!(boxes.iter().any(|l| l.contains("INBOX")), "{boxes:?}");
    }

    #[test]
    fn guess_mime_is_deterministic() {
        assert_eq!(guess_mime("a.txt"), "text/plain");
        assert_eq!(guess_mime("pic.PNG"), "image/png");
        assert_eq!(guess_mime("blob"), "application/octet-stream");
    }

    #[tokio::test]
    async fn store_flag_persists_between_runs() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let store = std::env::temp_dir().join(format!(
            "amos-mail-cli-store-{}-{nonce}.json",
            std::process::id()
        ));
        let path = store.to_str().expect("temp path is utf-8").to_string();

        // 1. Send into the store (flag placed *before* the subcommand).
        let out = run(&s(&[
            "--store",
            &path,
            "send",
            "--to",
            "them@x.io",
            "--subject",
            "persisted",
            "--body",
            "hi",
        ]))
        .await
        .unwrap();
        assert!(out.join("\n").contains("sent as m1"), "{out:?}");

        // 2. A *separate* invocation lists the same store → message survived.
        let listed = run(&s(&["list", "--mailbox", "Sent", "--store", &path]))
            .await
            .unwrap();
        let joined = listed.join("\n");
        assert!(joined.contains("persisted"), "{listed:?}");

        // 3. parse_args tolerates --store in any position (here: after subcommand).
        let _ = parse_args(&s(&["list", "--mailbox", "Sent", "--store", &path])).unwrap();

        let _ = std::fs::remove_file(&store);
    }

    #[tokio::test]
    async fn search_returns_matching_summaries() {
        let client = seeded_client();
        let lines = dispatch(
            &client,
            Op::Search {
                mailbox: INBOX.to_string(),
                query: "green".to_string(),
                limit: None,
            },
        )
        .await
        .unwrap();
        let joined = lines.join("\n");
        assert!(joined.contains("1 match"), "{joined}");
        assert!(joined.contains("Re: build report"), "{joined}");

        // A body/subject miss yields no matches.
        let none = dispatch(
            &client,
            Op::Search {
                mailbox: INBOX.to_string(),
                query: "unrelated-xyz".to_string(),
                limit: None,
            },
        )
        .await
        .unwrap();
        assert!(none.join("\n").contains("(no matches)"));
    }

    #[test]
    fn parse_search_needs_a_query_and_reads_flags() {
        assert!(matches!(
            parse_args(&s(&["search", "invoice", "--mailbox", "Sent", "--limit", "3"])).unwrap(),
            Op::Search {
                query,
                limit: Some(3),
                mailbox,
                ..
            } if query == "invoice" && mailbox == "Sent"
        ));
        assert!(parse_args(&s(&["search"])).is_err(), "query is required");
    }

    #[tokio::test]
    async fn archive_and_trash_via_cli_move_between_mailboxes() {
        let client = seeded_client();
        let inbox = client.inbox(None).await.unwrap();
        let first = &inbox[0];
        let source = first.mailbox.clone();
        let id = first.id.clone();

        let out = dispatch(
            &client,
            Op::Archive {
                mailbox: source,
                id: id.clone(),
            },
        )
        .await
        .unwrap();
        assert!(out.join("\n").contains("archived"));
        assert!(client.inbox(None).await.unwrap().iter().all(|m| m.id != id));
        let arch = client.list("Archive", None).await.unwrap();
        assert_eq!(arch.len(), 1);
        assert_eq!(arch[0].id, id);

        let out = dispatch(
            &client,
            Op::Trash {
                mailbox: "Archive".into(),
                id: id.clone(),
            },
        )
        .await
        .unwrap();
        assert!(out.join("\n").contains("trashed"));
        let trash = client.list("Trash", None).await.unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, id);
    }

    #[test]
    fn parse_archive_trash_need_id() {
        assert!(matches!(
            parse_args(&s(&["archive", "m1"])).unwrap(),
            Op::Archive { id, .. } if id == "m1"
        ));
        assert!(parse_args(&s(&["trash"])).is_err(), "needs an id");
    }

    #[tokio::test]
    async fn read_all_marks_every_message_and_is_idempotent() {
        let client = seeded_client(); // two unread demo messages
        let out = dispatch(
            &client,
            Op::ReadAll {
                mailbox: INBOX.to_string(),
            },
        )
        .await
        .unwrap();
        assert!(out.join("\n").contains("marked 2"), "{out:?}");
        assert!(client
            .inbox(None)
            .await
            .unwrap()
            .iter()
            .all(|m| m.flags.seen));

        let again = dispatch(
            &client,
            Op::ReadAll {
                mailbox: INBOX.to_string(),
            },
        )
        .await
        .unwrap();
        assert!(again.join("\n").contains("marked 0"), "{again:?}");
    }

    #[cfg(feature = "live")]
    #[tokio::test]
    async fn send_with_smtp_reaches_a_local_relay() {
        // Minimal SMTP sink on an ephemeral port.
        use std::io::{BufRead, BufReader, Write};
        use std::net::{TcpListener, TcpStream};
        use std::sync::{Arc, Mutex};

        fn reply(s: &mut TcpStream, line: &str) {
            let _ = s.write_all(line.as_bytes());
            let _ = s.flush();
        }
        fn serve(mut s: TcpStream, cap: &Mutex<Vec<String>>) {
            reply(&mut s, "220 localhost ESMTP\r\n");
            let mut collecting = false;
            let mut data: Vec<String> = Vec::new();
            for line in BufReader::new(s.try_clone().unwrap())
                .lines()
                .map_while(Result::ok)
            {
                let t = line.trim_end_matches(['\r', '\n']);
                let u = t.to_uppercase();
                if collecting {
                    if t == "." {
                        cap.lock().unwrap().extend(data.drain(..));
                        reply(&mut s, "250 Ok queued\r\n");
                        collecting = false;
                    } else {
                        data.push(t.to_string());
                    }
                    continue;
                }
                if u.starts_with("EHLO") || u.starts_with("HELO") {
                    reply(&mut s, "250-localhost\r\n250 8BITMIME\r\n");
                } else if u.starts_with("MAIL FROM") || u.starts_with("RCPT TO") {
                    reply(&mut s, "250 Ok\r\n");
                } else if u == "DATA" {
                    collecting = true;
                    reply(&mut s, "354 go\r\n");
                } else if u == "QUIT" {
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
                serve(stream, &cap2);
            }
        });

        let client = seeded_client();
        let out = dispatch(
            &client,
            Op::Send(SendArgs {
                to: vec!["relay@example.com".to_string()],
                subject: "via smtp".to_string(),
                body: "hello over real smtp".to_string(),
                smtp: Some(format!("127.0.0.1:{port}")),
                ..SendArgs::default()
            }),
        )
        .await
        .unwrap();
        assert!(out.join("\n").contains("sent via SMTP"), "{out:?}");

        std::thread::sleep(std::time::Duration::from_millis(200));
        let text = cap.lock().unwrap().join("\n").to_lowercase();
        assert!(text.contains("via smtp"), "subject not delivered:\n{text}");
        assert!(
            text.contains("hello over real smtp"),
            "body not delivered:\n{text}"
        );
    }

    #[cfg(feature = "live")]
    #[tokio::test]
    async fn imap_unseen_reports_count_from_a_local_server() {
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
                    let tagged = format!("{tag} OK done\r\n");
                    if upper.contains("LOGIN") {
                        let _ = stream.write_all(tagged.as_bytes());
                    } else if upper.contains("SELECT") {
                        let _ = stream.write_all(b"* 3 EXISTS\r\n");
                        let _ = stream.write_all(tagged.as_bytes());
                    } else if upper.contains("SEARCH") {
                        let _ = stream.write_all(b"* SEARCH 1 3\r\n");
                        let _ = stream.write_all(tagged.as_bytes());
                    } else if upper.contains("LOGOUT") {
                        let _ = stream.write_all(tagged.as_bytes());
                        break;
                    } else {
                        let _ = stream.write_all(tagged.as_bytes());
                    }
                    let _ = stream.flush();
                }
            }
        });

        let out = run(&s(&[
            "imap-unseen",
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--user",
            "u",
            "--pass",
            "p",
        ]))
        .await
        .unwrap();
        assert!(out.join("\n").contains("2 unseen"), "{out:?}");
    }
}

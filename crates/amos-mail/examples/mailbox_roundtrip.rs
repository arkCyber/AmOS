//! `mailbox_roundtrip` — a whole mailbox round trip on the in-memory provider.
//!
//! No server, no credentials: [`MockMailProvider`] is a real, in-memory mailbox (not a
//! stub with canned strings), so send → list → read → delete run exactly as the CLI and
//! the Tauri bridge drive them. What this proves is the *engine's* rules — the Sent copy,
//! unread state, address rendering — not the IMAP/SMTP wire (that is the `live` feature).
//!
//! Usage:
//! ```text
//! cargo run -p amos-mail --example mailbox_roundtrip
//! ```

use amos_mail::{Account, Address, MailClient, MockMailProvider, INBOX};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let provider = MockMailProvider::new();

    // Two incoming messages, delivered straight into INBOX (newest first by date).
    let ada = Address::new("Ada Lovelace", "ada@example.com")?;
    let me = Address::bare("me@amos.local")?;
    provider.deliver(
        Some(ada.clone()),
        vec![me.clone()],
        "Welcome to Amos Mail",
        "Hi there — the client engine ships today.",
        1_700_000_000,
    )?;
    provider.deliver(
        Some(ada.clone()),
        vec![me.clone()],
        "Build report",
        "Green across the board.",
        1_700_005_000,
    )?;

    let account = Account::new("demo", "Amos Demo", me)?;
    let client = MailClient::new(provider.clone(), account);

    println!("provider:  {}", client.provider_name());
    println!("sender:    {}", client.account().sender_address());
    println!("mailboxes: {:?}", client.mailboxes().await?);

    let inbox = client.inbox(None).await?;
    println!("\ninbox ({} message(s), newest first):", inbox.len());
    for m in &inbox {
        println!(
            "  {}  {:<22}  from {:<28}  unread={}",
            m.id,
            m.subject,
            m.from
                .as_ref()
                .map(|a| a.to_string())
                .unwrap_or_else(|| "(unknown)".to_string()),
            !m.flags.seen,
        );
    }

    // `read` fetches the body *and* marks the message seen — one act, not two.
    let first = inbox[0].id.clone();
    let opened = client.read(INBOX, &first).await?;
    println!("\nread {first}: \"{}\"", opened.body_plain);
    let unread = client
        .inbox(None)
        .await?
        .iter()
        .filter(|m| !m.flags.seen)
        .count();
    println!("unread after read: {unread}");

    // `compose` fills the sender from the account; `send` stores a copy in Sent.
    let mut draft = client.compose("Re: Welcome to Amos Mail", "Thanks — looking good!");
    draft.to.push(ada);
    let receipt = client.send(draft).await?;
    println!("\nsent {} (date {})", receipt.id, receipt.date);
    println!(
        "sent folder now holds {} message(s)",
        client.sent(None).await?.len()
    );

    // `delete` really removes it (Trash/Archive are explicit `trash`/`archive` calls).
    let before = client.inbox(None).await?.len();
    client.delete(INBOX, &first).await?;
    println!(
        "\ndeleted {first}: inbox {before} -> {}",
        client.inbox(None).await?.len()
    );
    Ok(())
}

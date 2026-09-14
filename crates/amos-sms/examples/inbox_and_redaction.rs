//! `inbox_and_redaction` — the SMS model on the offline provider, plus its two rules.
//!
//! Reads the seeded mock (threads per folder, counts, one conversation), then shows the two
//! rules that protect a user: a message too long for the protocol is **refused** rather than
//! silently truncated, and a bank sender's balances are masked before they reach a UI surface.
//!
//! Usage:
//! ```text
//! cargo run -p amos-sms --example inbox_and_redaction
//! ```

use amos_sms::redact::{is_bank_sender, redact_balances, redact_for};
use amos_sms::validate::{segment_count, validate_text};
use amos_sms::{MockSms, SmsFolder, SmsProvider};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let provider = MockSms::seeded();
    println!("provider: {}", provider.name());

    // Per-folder thread counts: exactly what the inbox tabs show.
    let counts = provider.counts()?;
    for folder in SmsFolder::ALL {
        println!("{folder:?}: {} thread(s)", counts.of(folder));
    }

    // The inbox, newest first — and one thread's messages.
    let threads = provider.snapshot(SmsFolder::Inbox)?;
    for thread in threads.iter().take(3) {
        println!(
            "thread {} <{}> unread={} last={:?}",
            thread.id, thread.address, thread.unread, thread.last_text
        );
    }
    if let Some(first) = threads.first() {
        println!("conversation with {}:", first.address);
        for message in provider.messages(&first.id, Some(SmsFolder::Inbox))? {
            println!(
                "  [{}] {}",
                if message.from_me { "me" } else { "them" },
                message.text
            );
        }
    }

    // Validation: the protocol ceiling is refused, not truncated.
    for (label, text) in [
        ("short", "hello there".to_string()),
        ("too long", "x".repeat(2000)),
    ] {
        match validate_text(&text) {
            Ok(()) => println!(
                "validate_text({label}) -> ok, {segment_count} segment(s)",
                segment_count = segment_count(&text)
            ),
            Err(e) => println!("validate_text({label}) refused: {e}"),
        }
    }

    // Redaction: a bank message's balances never reach a notification or a lock screen.
    let bank = "Your account balance is 12,345.67 CNY and available limit 8,000.00 CNY";
    let sender = "BankAlerts";
    println!("is_bank_sender({sender:?})={}", is_bank_sender(sender));
    println!("redact_balances -> {}", redact_balances(bank));
    println!("redact_for -> {}", redact_for(sender, bank));

    // And a non-bank sender is passed through (the honest half of a heuristic).
    println!(
        "redact_for(\"Ada\", …) -> {}",
        redact_for("Ada", "balance is 12,345.67 CNY")
    );

    // Sending on the mock is recorded, never a fake delivery claim.
    provider.send("13800138000", "on my way")?;
    println!(
        "after send, sent threads: {}",
        provider.snapshot(SmsFolder::Sent)?.len()
    );
    Ok(())
}

//! `block_calls_and_sms` — rules in, verdicts out, with the refusals visible.
//!
//! Shows what the blocklist does *and* what it refuses to do: an exact rule covering both
//! channels, a prefix rule scoped to calls, the `+CC`/bare-number equivalence, a too-short
//! prefix being **rejected** (a rule that would block a whole country is not accepted), and
//! the JSON round trip the settings UI and the Android screening service share.
//!
//! Usage:
//! ```text
//! cargo run -p amos-blocklist --example block_calls_and_sms
//! ```

use amos_blocklist::{Blocklist, Channel, MatchKind};

/// A fixed clock for the LRU bookkeeping (the rules are pure; only age uses it).
const NOW_MS: i64 = 1_700_000_000_000;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut list = Blocklist::new();
    println!(
        "empty list: block_unknown={} rules={}",
        list.block_unknown(),
        list.len()
    );

    // A telemarketer, written with the country code; calls and SMS both blocked.
    let rule = list.add(
        "+8613800138000",
        MatchKind::Exact,
        Channel::Both,
        "telemarketer",
        NOW_MS,
    )?;
    println!("added exact rule id={} pattern={}", rule.id, rule.pattern);

    // A premium-rate prefix, calls only (SMS from it is left alone).
    let prefix = list.add(
        "400",
        MatchKind::Prefix,
        Channel::Call,
        "premium-calls",
        NOW_MS + 1,
    )?;
    println!(
        "added prefix rule id={} pattern={}",
        prefix.id, prefix.pattern
    );

    // A rule short enough to block a country is refused, not stored.
    match list.add(
        "86",
        MatchKind::Prefix,
        Channel::Both,
        "too-broad",
        NOW_MS + 2,
    ) {
        Ok(r) => println!("UNEXPECTED: accepted too-broad rule {}", r.id),
        Err(e) => println!("refused a too-broad prefix: {e}"),
    }

    // The same subscriber, written the way a carrier delivers it — equivalence is the
    // rule's job, not the caller's.
    for (address, channel) in [
        ("13800138000", Channel::Call),
        ("+8613800138000", Channel::Call),
        ("13800138000", Channel::Sms),
        ("4001234567", Channel::Call),
        ("4001234567", Channel::Sms), // the prefix rule is calls-only
        ("13911112222", Channel::Call),
    ] {
        let verdict = match list.check(address, channel) {
            Some(amos_blocklist::BlockReason::Rule { label, pattern, .. }) => {
                format!("BLOCKED by {label} ({pattern})")
            }
            Some(amos_blocklist::BlockReason::Unknown) => "BLOCKED (unknown number)".to_string(),
            None => "allowed".to_string(),
        };
        println!("{:>15} {:?} -> {verdict}", address, channel);
    }

    // The list is data: whatever the UI writes is what Android's filter reads.
    let json = list.to_json();
    let reloaded = Blocklist::from_json(&json, amos_blocklist::DEFAULT_CAP)?;
    println!(
        "JSON round trip: {} rule(s) before, {} after (identical={})",
        list.len(),
        reloaded.len(),
        reloaded.to_json() == json
    );
    Ok(())
}

//! Balance redaction on the SMS **display** path (privacy, fail-safe).
//!
//! Requirement (REQ-A41): when a received bank message states a balance, the
//! amount must never be rendered by AmOS — the amount region is replaced with
//! [`REDACTION`] (`***`). The platform SMS store is never modified and the
//! *send* path is untouched: this module only rewrites text at the read/display
//! boundary (the Tauri bridge is the single funnel to the UI).
//!
//! Two rules, both deterministic and content-driven:
//!
//! * **Rule A (every sender).** A balance keyword (CJK: 余额/余款/结余/餘額/…
//!   with no word-boundary concept; Latin: `balance(s)`/`bal`/`remaining`/
//!   `avail(able)`, ASCII-case-insensitive and word-bounded) followed — within
//!   a bounded filler window of separators and short filler words (`:`, `是`,
//!   `is`, …) — by an amount (optional sign + currency + digits + currency
//!   suffix) has that **amount region** replaced with [`REDACTION`]. The
//!   keyword itself stays visible (`余额：***`), so the reader keeps the
//!   context without the number.
//! * **Rule B (bank senders only, [`is_bank_sender`]).** Any currency amount
//!   directly following a `:`/`：` field separator is masked as well: bank
//!   messages are machine-formatted (`账户资金: 50,000.00`), and a field whose
//!   value is a currency amount in a bank SMS is fail-safe metadata even when
//!   our keyword list misses the label.
//!
//! Engineering properties (audited, each pinned by a test):
//!
//! * **Bounded.** Single left-to-right pass, O(n); one amount span ≤
//!   [`MAX_AMOUNT_SPAN`] bytes; output length is input length plus at most
//!   `2` bytes per masked span. No regex, no recursion, no unbounded loops.
//! * **Panic-free.** No `unwrap`/`expect`/indexing outside proven boundaries;
//!   every slice happens on a `char` boundary (full-width digits are honestly
//!   *not* recognized rather than risked — a documented limitation that fails
//!   toward *less* masking only for exotic inputs, never toward corruption).
//! * **Idempotent.** `redact(redact(x)) == redact(x)`: `***` contains no
//!   keyword and no digit, so a second pass is a no-op (safe to apply at
//!   several layers).
//! * **Fail-safe direction.** Over-masking (a friend writing “余额只剩 100 元”
//!   also shows `***`) is accepted; a missed balance in a bank message is the
//!   failure this module exists to prevent.
//! * **Honest.** Text without a match is returned borrowed — no allocation,
//!   no rewrite, no fabricated `***`.

use std::borrow::Cow;

/// The mask shown instead of a balance amount.
pub const REDACTION: &str = "***";

/// Hard cap on one amount span (sign + currency + digits + suffix), bytes.
const MAX_AMOUNT_SPAN: usize = 32;
/// Hard cap on filler units consumed between a keyword and its amount.
const MAX_FILLER_UNITS: usize = 8;
/// Hard cap on spaces skipped after a `:` field separator (Rule B).
const MAX_FIELD_SPACES: usize = 2;

/// CJK balance keywords — substring match (CJK has no word boundaries).
const CJK_KEYWORDS: [&str; 6] = ["余额", "余款", "结余", "餘額", "餘款", "結餘"];
/// Latin balance keywords — ASCII case-insensitive, word-bounded.
const LATIN_KEYWORDS: [&str; 6] = [
    "balance",
    "balances",
    "bal",
    "remaining",
    "avail",
    "available",
];
/// Short filler words allowed between a keyword and its amount (Latin).
const FILLER_LATIN: [&str; 5] = ["is", "of", "was", "now", "only"];
/// Short filler words allowed between a keyword and its amount (CJK).
const FILLER_CJK: [&str; 4] = ["是", "为", "仅", "还有"];
/// Currency symbols accepted right before an amount.
const CURRENCY_SYMBOLS: [char; 5] = ['¥', '￥', '$', '€', '£'];
/// 3-letter currency codes accepted right before an amount.
const CURRENCY_CODES: [&str; 9] = [
    "CNY", "RMB", "USD", "EUR", "GBP", "JPY", "HKD", "INR", "KRW",
];
/// Currency words accepted right after an amount (CJK, substring).
const SUFFIX_CJK: [&str; 6] = ["元", "圆", "美元", "港元", "日元", "欧元"];
/// Currency words accepted right after an amount (Latin, word-bounded).
const SUFFIX_LATIN: [&str; 11] = [
    "YUAN", "DOLLARS", "DOLLAR", "RMB", "CNY", "USD", "EUR", "GBP", "JPY", "HKD", "KRW",
];

/// Classify a sender as a bank / financial-service shortcode or sender id.
///
/// Two honest, deliberately narrow families (anything unclassifiable is
/// `false` — Rule A still protects those threads by content):
///
/// * **Numeric** senders: a 5-digit `95xxx` customer-service shortcode
///   (`95588` ICBC, `95533` CCB, `95188` Alipay, …). Separator forms a UI may
///   show (`(95588)`, `95 588`) are tolerated. Carrier numbers (`10086`) and
///   mobile numbers are **not** banks. `106xxx` gateway senders are
///   deliberately *not* classified (that prefix is shared with every bulk
///   sender) — their balances are still masked by Rule A whenever the text
///   mentions one.
/// * **Alphanumeric** sender ids (GSM style): any id containing `BANK`, or
///   exactly one of a small, documented ticker list (`ICBC`, `CCB`, `ABC`,
///   `BOC`, `BOCOM`, `PSBC`, `CMB`, `CITIC`, `SPDB`, `CIB`, `SPABANK`, `GDB`,
///   `CGB`, `HSBC`, `CITI`, `DBS`).
pub fn is_bank_sender(address: &str) -> bool {
    let addr = address.trim();
    if addr.is_empty() {
        return false;
    }
    let mut digits = String::with_capacity(addr.len());
    let mut numeric_form = true;
    for c in addr.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
        } else if !matches!(c, '+' | '-' | ' ' | '(' | ')' | '.') {
            numeric_form = false;
        }
    }
    if numeric_form {
        return digits.len() == 5 && digits.starts_with("95");
    }
    if !addr.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false; // mixed forms (e.g. "TM-ALIPAY") stay unclassified
    }
    let upper = addr.to_ascii_uppercase();
    if upper.contains("BANK") {
        return true;
    }
    matches!(
        upper.as_str(),
        "ICBC"
            | "CCB"
            | "ABC"
            | "BOC"
            | "BOCOM"
            | "PSBC"
            | "CMB"
            | "CITIC"
            | "SPDB"
            | "CIB"
            | "SPABANK"
            | "GDB"
            | "CGB"
            | "HSBC"
            | "CITI"
            | "DBS"
    )
}

/// Rule A only: mask balance amounts after balance keywords (any sender).
pub fn redact_balances(text: &str) -> Cow<'_, str> {
    redact_with(text, false)
}

/// Full policy: Rule A for every sender, plus Rule B (`:`-field amounts) when
/// `sender` classifies as a bank ([`is_bank_sender`]). An unknown/empty sender
/// degrades to Rule A only — content masking never depends on the sender.
pub fn redact_for<'a>(sender: &str, text: &'a str) -> Cow<'a, str> {
    redact_with(text, is_bank_sender(sender))
}

fn redact_with(text: &str, strict: bool) -> Cow<'_, str> {
    let mut spans: Vec<(usize, usize)> = Vec::new();
    collect_keyword_spans(text, &mut spans);
    if strict {
        collect_field_spans(text, &mut spans);
    }
    if spans.is_empty() {
        return Cow::Borrowed(text);
    }
    spans.sort_unstable();
    let mut out = String::with_capacity(text.len());
    let mut pos = 0usize;
    for (s, e) in spans {
        if s < pos {
            continue; // overlaps a span already masked (e.g. Rule A + Rule B)
        }
        out.push_str(&text[pos..s]);
        out.push_str(REDACTION);
        pos = e;
    }
    out.push_str(&text[pos..]);
    Cow::Owned(out)
}

/// Rule A: at every keyword occurrence, try to mask the amount that follows.
fn collect_keyword_spans(text: &str, spans: &mut Vec<(usize, usize)>) {
    let mut prev: Option<char> = None;
    for (i, ch) in text.char_indices() {
        for kw in CJK_KEYWORDS {
            if text[i..].starts_with(kw) {
                if let Some(span) = after_keyword(text, i + kw.len()) {
                    spans.push(span);
                }
            }
        }
        // Latin keywords need word boundaries on both sides: `global` must not
        // arm on `bal`, `unbalance 100` must not mask.
        let prev_ok = !prev.is_some_and(|c| c.is_ascii_alphanumeric());
        if prev_ok {
            for kw in LATIN_KEYWORDS {
                if ascii_ci_eq(text, i, kw) {
                    let after = i + kw.len();
                    let next_ok = char_at(text, after).map_or(true, |c| !c.is_ascii_alphanumeric());
                    if next_ok {
                        if let Some(span) = after_keyword(text, after) {
                            spans.push(span);
                        }
                    }
                }
            }
        }
        prev = Some(ch);
    }
}

/// Rule B: any amount directly after a `:`/`：` field separator.
fn collect_field_spans(text: &str, spans: &mut Vec<(usize, usize)>) {
    for (i, ch) in text.char_indices() {
        if ch != ':' && ch != '：' {
            continue;
        }
        let j = skip_spaces(text, i + ch.len_utf8(), MAX_FIELD_SPACES);
        if let Some(span) = amount_span_at(text, j) {
            spans.push(span);
        }
    }
}

/// Skip bounded filler (separator runs + short filler words) after a keyword,
/// then return the amount span if one really starts there.
fn after_keyword(text: &str, kw_end: usize) -> Option<(usize, usize)> {
    let mut i = kw_end;
    for _ in 0..MAX_FILLER_UNITS {
        let j = skip_filler_punct(text, i);
        if j > i {
            i = j;
            continue;
        }
        match filler_word_end(text, i) {
            Some(j) => i = j,
            None => break,
        }
    }
    amount_span_at(text, i)
}

/// One amount region: `[sign] [currency] digits [currency suffix]`, requiring
/// at least one ASCII digit. Returns the whole region (so `-$50.00元` is fully
/// masked) or `None` when no digit is present (then nothing is masked — the
/// keyword alone stays readable).
fn amount_span_at(text: &str, start: usize) -> Option<(usize, usize)> {
    let mut i = start;
    if matches!(char_at(text, i), Some('-' | '+')) {
        i += 1;
    }
    if let Some(j) = currency_prefix_end(text, i) {
        i = skip_spaces(text, j, 1);
    }
    let (_, digits_end) = digits_core(text, i)?;
    let end = currency_suffix_end(text, digits_end).unwrap_or(digits_end);
    Some((start, end))
}

/// A run of digits/`,`/`.` that starts and ends with a digit, ≥1 digit total,
/// ≤[`MAX_AMOUNT_SPAN`] bytes. Byte-scanning is boundary-safe: only ASCII
/// digits/separators advance the cursor, and `start` is always a char boundary.
fn digits_core(text: &str, start: usize) -> Option<(usize, usize)> {
    let b = text.as_bytes();
    let mut j = start;
    let mut digits = 0usize;
    while j < b.len() && j - start < MAX_AMOUNT_SPAN {
        let c = b[j];
        if c.is_ascii_digit() {
            digits += 1;
            j += 1;
        } else if c == b'.' || c == b',' {
            j += 1;
        } else {
            break;
        }
    }
    if digits == 0 {
        return None;
    }
    while j > start && !b[j - 1].is_ascii_digit() {
        j -= 1; // the span must end on a digit (`100.` masks as `100`)
    }
    Some((start, j))
}

fn currency_prefix_end(text: &str, i: usize) -> Option<usize> {
    if let Some(c) = char_at(text, i) {
        if CURRENCY_SYMBOLS.contains(&c) {
            return Some(i + c.len_utf8());
        }
    }
    for code in CURRENCY_CODES {
        if word_bounded_at(text, i, code) {
            return Some(i + code.len());
        }
    }
    None
}

fn currency_suffix_end(text: &str, i: usize) -> Option<usize> {
    if let Some(j) = suffix_at(text, i) {
        return Some(j);
    }
    // One optional space (“500 元”, “500 USD”) — never more.
    if char_at(text, i) == Some(' ') {
        if let Some(j) = suffix_at(text, i + 1) {
            return Some(j);
        }
    }
    None
}

fn suffix_at(text: &str, i: usize) -> Option<usize> {
    for w in SUFFIX_CJK {
        if text[i..].starts_with(w) {
            return Some(i + w.len());
        }
    }
    for w in SUFFIX_LATIN {
        if word_bounded_at(text, i, w) {
            return Some(i + w.len());
        }
    }
    None
}

/// A separator/filler run: spaces and light punctuation only. Digits, letters
/// and CJK stop the run, so filler can never swallow an amount's neighbours
/// into the mask.
fn skip_filler_punct(text: &str, mut i: usize) -> usize {
    while let Some(c) = char_at(text, i) {
        if matches!(
            c,
            ' ' | '\t' | ':' | '：' | '=' | '~' | '*' | '-' | '.' | ',' | '·' | '、' | '\u{3000}'
        ) {
            i += c.len_utf8();
        } else {
            break;
        }
    }
    i
}

fn filler_word_end(text: &str, i: usize) -> Option<usize> {
    for w in FILLER_LATIN {
        if word_bounded_at(text, i, w) {
            return Some(i + w.len());
        }
    }
    for w in FILLER_CJK {
        if text[i..].starts_with(w) {
            return Some(i + w.len());
        }
    }
    None
}

fn skip_spaces(text: &str, mut i: usize, max: usize) -> usize {
    for _ in 0..max {
        match char_at(text, i) {
            Some(' ') | Some('\t') | Some('\u{3000}') => i += 1,
            _ => break,
        }
    }
    i
}

/// ASCII case-insensitive prefix match at a char boundary (`kw` is ASCII).
fn ascii_ci_eq(text: &str, i: usize, kw: &str) -> bool {
    let b = text.as_bytes();
    let k = kw.as_bytes();
    if i >= b.len() || b.len() - i < k.len() {
        return false;
    }
    b[i..i + k.len()]
        .iter()
        .zip(k.iter())
        .all(|(a, c)| a.eq_ignore_ascii_case(c))
}

/// ASCII case-insensitive `kw` at `i` whose next char is not a Latin letter
/// (`USD` matches in `USD500`/`USD 5`, not in `USDX`).
fn word_bounded_at(text: &str, i: usize, kw: &str) -> bool {
    if !ascii_ci_eq(text, i, kw) {
        return false;
    }
    char_at(text, i + kw.len()).map_or(true, |c| !c.is_ascii_alphabetic())
}

fn char_at(text: &str, i: usize) -> Option<char> {
    text[i..].chars().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(sender: &str, text: &str) -> String {
        redact_for(sender, text).into_owned()
    }

    // ---- Rule A: CJK keyword + amount -------------------------------------

    #[test]
    fn cn_keyword_masks_thousand_separated_amount_with_suffix() {
        assert_eq!(
            masked("10086", "您的账户余额1,234.56元，请知悉"),
            "您的账户余额***，请知悉"
        );
    }

    #[test]
    fn cn_colon_and_spaces_are_kept_visible() {
        assert_eq!(masked("13800138000", "余额： 5000.00"), "余额： ***");
        assert_eq!(masked("13800138000", "当前余额 8000 元"), "当前余额 ***");
    }

    #[test]
    fn transaction_amounts_are_not_balances_and_stay_visible() {
        assert_eq!(
            masked("95588", "您消费100.00元，余额5,000.00元"),
            "您消费100.00元，余额***"
        );
        assert_eq!(masked("13800138000", "消费100.00元"), "消费100.00元");
    }

    #[test]
    fn keyword_without_amount_is_left_untouched() {
        assert_eq!(
            masked("95533", "您的余额不足，请及时充值"),
            "您的余额不足，请及时充值"
        );
    }

    #[test]
    fn traditional_and_variant_keywords_are_covered() {
        assert_eq!(masked("95533", "結餘 100.50"), "結餘 ***");
        assert_eq!(masked("95533", "余款300付清"), "余款***付清");
    }

    #[test]
    fn every_occurrence_is_masked() {
        assert_eq!(
            masked("10086", "余额100元，可用余额200元"),
            "余额***，可用余额***"
        );
    }

    #[test]
    fn currency_forms_mask_without_leaking_digits() {
        // Rule A consumes `-` as filler, so the minus stays visible; the
        // amount itself is fully masked either way.
        assert_eq!(masked("95588", "余额 -$50.00"), "余额 -***");
        // Rule B sees the sign directly after the field separator.
        assert_eq!(masked("95588", "资金:-$50.00元"), "资金:***");
    }

    // ---- Rule A: Latin keywords -------------------------------------------

    #[test]
    fn en_balance_with_filler_word_and_currency() {
        assert_eq!(
            masked("13800138000", "Your balance is $1,234.56."),
            "Your balance is ***."
        );
        assert_eq!(
            masked("13800138000", "remaining: 300.50 USD"),
            "remaining: ***"
        );
        assert_eq!(
            masked("13800138000", "Avail Bal: INR 500 only"),
            "Avail Bal: *** only"
        );
    }

    #[test]
    fn latin_keywords_respect_word_boundaries() {
        // `bal` inside `global` / `balance` inside `unbalance` must not arm.
        assert_eq!(
            masked("13800138000", "the global balance sheet"),
            "the global balance sheet"
        );
        assert_eq!(masked("13800138000", "unbalance 100"), "unbalance 100");
    }

    // ---- Rule B: bank-sender `:`-field amounts ----------------------------

    #[test]
    fn bank_sender_masks_colon_fields_even_without_keywords() {
        assert_eq!(masked("95533", "账户资金: 50,000.00"), "账户资金: ***");
        // The very same text from a personal number keeps its number (Rule A
        // only) — the strict field rule is keyed to sender classification.
        assert_eq!(
            masked("13800138000", "账户资金: 50,000.00"),
            "账户资金: 50,000.00"
        );
    }

    #[test]
    fn fullwidth_colon_fields_are_covered_too() {
        assert_eq!(masked("95588", "账户资金：￥80,000"), "账户资金：***");
    }

    // ---- Sender classification --------------------------------------------

    #[test]
    fn bank_sender_classification() {
        assert!(is_bank_sender("95588"));
        assert!(is_bank_sender("95188"));
        assert!(is_bank_sender("(95588)"));
        assert!(is_bank_sender("HKBANK"));
        assert!(is_bank_sender("icbcbank"));
        assert!(is_bank_sender("HSBC"));
        assert!(!is_bank_sender("10086"));
        assert!(!is_bank_sender("13800138000"));
        assert!(!is_bank_sender(""));
        // Unclassifiable mixed forms are honestly `false` (Rule A still holds).
        assert!(!is_bank_sender("TM-ALIPAY"));
    }

    // ---- Engineering properties -------------------------------------------

    #[test]
    fn no_match_returns_the_borrowed_input() {
        let text = "晚上回家吃饭吗？";
        assert!(matches!(redact_balances(text), Cow::Borrowed(_)));
    }

    #[test]
    fn redaction_is_idempotent() {
        for (sender, text) in [
            ("95588", "余额1,234.56元，账户资金: 9,999.00"),
            ("13800138000", "Your balance is $50."),
            ("95533", "資金：12345"),
        ] {
            let once = masked(sender, text);
            let twice = masked(sender, &once);
            assert_eq!(once, twice, "second pass must be a no-op");
            assert!(matches!(redact_for(sender, &once), Cow::Borrowed(_)));
        }
    }

    #[test]
    fn adversarial_inputs_never_panic_and_stay_idempotent() {
        for (sender, text) in [
            ("95588", ""),
            ("95588", "余额"),
            ("95588", "余额:"),
            ("95588", "余额::::"),
            ("95588", ":::::-¥$"),
            ("95588", "balance"),
            ("95588", "bal"),
            ("95588", ":"),
            ("95588", "¥"),
            ("95588", "-$"),
            ("95588", "¥$"),
            ("95588", "😀余额😀100😀"),
            ("95588", "余额界100元界"),
            ("95588", "余额１００"), // full-width digits: honest no-match
            ("95588", "余额 100."),
            ("95588", "余额 .50元"),
            ("95588", "余额 1.2.3"),
            ("95588", "余额500usdx"),
            ("95588", "余额 500 美元"),
            ("95588", "余额 ... 500"),
            ("95588", "余额,利息 500"),
        ] {
            let once = masked(sender, text);
            assert_eq!(masked(sender, &once), once, "{text:?} not idempotent");
            assert!(
                once.len() <= text.len().max(3) * 2 + 8,
                "{text:?} → {once:?}: output must stay bounded"
            );
        }
    }

    #[test]
    fn amounts_next_to_keywords_are_masked_in_odd_shapes() {
        assert_eq!(masked("95588", "余额100"), "余额***");
        assert_eq!(masked("95588", "余额 100."), "余额 ***.");
        // A leading `.` is filler and stays visible; digits + 元 are masked.
        assert_eq!(masked("95588", "余额 .50元"), "余额 .***");
        assert_eq!(masked("95588", "余额 1.2.3"), "余额 ***");
        assert_eq!(masked("95588", "余额 ... 500"), "余额 ... ***");
        assert_eq!(masked("95588", "余额 500 美元"), "余额 ***");
        assert_eq!(masked("95588", "余额500usdx"), "余额***usdx");
        // Non-filler CJK/emoji between keyword and amount changes the meaning —
        // honestly left unmasked (bounded filler window), never corrupted.
        assert_eq!(masked("95588", "余额,利息 500"), "余额,利息 500");
        assert_eq!(masked("95588", "😀余额😀100😀"), "😀余额😀100😀");
    }

    #[test]
    fn many_repetitions_stay_bounded_and_correct() {
        let text = "余额1".repeat(200);
        let out = masked("95588", &text);
        assert_eq!(out, "余额***".repeat(200));
        assert!(out.len() <= text.len() * 2 + 8, "output must stay bounded");
    }

    #[test]
    fn full_width_digits_are_an_honest_limitation() {
        // Documented: full-width digits are not recognized — less masking, no
        // corruption. The keyword stays visible, nothing crashes.
        assert_eq!(masked("95588", "余额１００"), "余额１００");
    }
}

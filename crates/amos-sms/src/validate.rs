//! Input validation + segmentation for SMS sends (pure, no I/O).
//!
//! Validated at the **domain boundary** so every provider (mock, Android glue,
//! future backends) agrees on what a legal send is, and so a bad request fails
//! deterministically *before* it can reach the radio. Defense in depth: the
//! Kotlin glue re-checks and the platform `SmsManager` is the final gate.
//!
//! Limits are conservative and explicit:
//!
//! * [`MAX_TEXT_CHARS`] — 1600 characters ≈ 10 GSM-7 segments. Longer input is
//!   rejected rather than silently truncated (truncation would corrupt the
//!   user's message) or sprayed as an unbounded multipart.
//! * [`MAX_ADDRESS_DIGITS`] — 20 digits: E.164 allows at most 15, shortcodes and
//!   service ids are shorter; bounded so a malformed address cannot be an
//!   unbounded string.
//!
//! Nothing here fabricates success: invalid input is an honest
//! [`SmsError::Invalid`].

use crate::error::SmsError;

/// Maximum characters accepted in one send (≈10 GSM-7 segments / 23 UCS-2).
pub const MAX_TEXT_CHARS: usize = 1600;
/// GSM-7 single-segment payload (7-bit alphabet).
pub const GSM7_SINGLE: usize = 160;
/// GSM-7 per-segment payload once concatenation headers are added (UDH).
pub const GSM7_MULTI: usize = 153;
/// UCS-2 (non-GSM alphabet, e.g. Chinese/emoji) single-segment payload.
pub const UCS2_SINGLE: usize = 70;
/// UCS-2 per-segment payload with concatenation headers (UDH).
pub const UCS2_MULTI: usize = 67;
/// Maximum digits in an address (E.164 is ≤15; shortcodes are shorter).
pub const MAX_ADDRESS_DIGITS: usize = 20;
/// Minimum digits in an address (shortest real shortcode is 3).
pub const MIN_ADDRESS_DIGITS: usize = 3;

/// Normalize a user-typed address to the digits/`+` form the radio expects,
/// then validate it. Separators a human may type (`-`, spaces, `(`, `)`, `.`)
/// are stripped; a single leading `+` is preserved. Returns the normalized
/// address so callers cannot accidentally send the raw user string.
///
/// Rejects — with an explicit reason — blank input, non-digit content, a `+`
/// that is not leading, and too few/too many digits.
pub fn normalize_address(address: &str) -> Result<String, SmsError> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return Err(SmsError::Invalid("blank SMS address".into()));
    }
    let mut out = String::with_capacity(trimmed.len());
    for (i, ch) in trimmed.chars().enumerate() {
        match ch {
            '+' if i == 0 => out.push('+'),
            c if c.is_ascii_digit() => out.push(c),
            '-' | ' ' | '(' | ')' | '.' => {}
            other => {
                return Err(SmsError::Invalid(format!(
                    "invalid character {other:?} in SMS address"
                )))
            }
        }
    }
    let digits = out.chars().filter(char::is_ascii_digit).count();
    if digits < MIN_ADDRESS_DIGITS {
        return Err(SmsError::Invalid(format!(
            "SMS address has only {digits} digit(s); at least {MIN_ADDRESS_DIGITS} required"
        )));
    }
    if digits > MAX_ADDRESS_DIGITS {
        return Err(SmsError::Invalid(format!(
            "SMS address has {digits} digits; limit is {MAX_ADDRESS_DIGITS}"
        )));
    }
    Ok(out)
}

/// Validate a message body: rejects blank, over-long and NUL-bearing text.
pub fn validate_text(text: &str) -> Result<(), SmsError> {
    if text.trim().is_empty() {
        return Err(SmsError::Invalid("blank SMS text".into()));
    }
    if text.contains('\0') {
        return Err(SmsError::Invalid("NUL byte in SMS text".into()));
    }
    let n = text.chars().count();
    if n > MAX_TEXT_CHARS {
        return Err(SmsError::Invalid(format!(
            "SMS text is {n} characters; limit is {MAX_TEXT_CHARS}"
        )));
    }
    Ok(())
}

/// Whether `c` is a GSM 03.38 **extension**-table character. These travel as
/// `ESC` + the character, so each occupies **two** septets, not one.
fn is_gsm7_extension(c: char) -> bool {
    matches!(
        c,
        '\u{0c}' | '^' | '{' | '}' | '\\' | '[' | ']' | '~' | '|' | '€'
    )
}

/// Septet count of a GSM-7 message: one per basic char, **two** per extension
/// char (`is_gsm7_extension`). The escape is real payload — charging it is what
/// keeps [`segment_count`] honest for `^`/`{`/`~`/… instead of undercounting.
fn gsm7_units(text: &str) -> usize {
    text.chars()
        .map(|c| if is_gsm7_extension(c) { 2 } else { 1 })
        .sum()
}

/// `true` when every character is in the GSM 03.38 7-bit alphabet (basic or
/// extension table), i.e. the message can travel as GSM-7 instead of UCS-2.
///
/// This is a **fixed table**, not "is ASCII". `[ \ ] ^` and `{ | } ~` are ASCII
/// graphics too, but they travel as *extension* chars (see
/// [`is_gsm7_extension`]), so `is_ascii_graphic` is right for them. The
/// **backtick** (U+0060) is the one ASCII graphic in **neither** table — the
/// basic set has `¿` at that position — so it is excluded by name; claiming it as
/// GSM-7 let [`segment_count`] undercount a body the platform would send as
/// UCS-2. `€` is the mirror case: an extension char that must **not** be pushed
/// to UCS-2 (REQ-A1781).
pub fn is_gsm7(text: &str) -> bool {
    text.chars().all(|c| {
        (c.is_ascii_graphic() && c != '`')
            || c == ' '
            || matches!(
                c,
                '@' | '$'
                    | '_'
                    | '€'
                    | '¡'
                    | '£'
                    | '¥'
                    | 'è'
                    | 'é'
                    | 'ù'
                    | 'ì'
                    | 'ò'
                    | 'Ç'
                    | 'Ø'
                    | 'ø'
                    | 'Å'
                    | 'å'
                    | 'Δ'
                    | 'Φ'
                    | 'Γ'
                    | 'Λ'
                    | 'Ω'
                    | 'Π'
                    | 'Ψ'
                    | 'Σ'
                    | 'Θ'
                    | 'Ξ'
                    | 'Æ'
                    | 'æ'
                    | 'ß'
                    | 'É'
                    | '¤'
                    | '§'
                    | '¿'
                    | 'Ä'
                    | 'Ö'
                    | 'Ñ'
                    | 'Ü'
                    | 'ä'
                    | 'ö'
                    | 'ñ'
                    | 'ü'
                    | 'à'
                    | '\n'
                    | '\r'
                    | '\t'
                    | '\u{1b}'
                    | '\u{0c}'
            )
    })
}

/// Number of SMS segments `text` will occupy (1 for empty text, so a "0/1"
/// counter style stays honest). GSM-7 ⇒ 160 single / 153 concatenated septets
/// (extension chars count double — see [`gsm7_units`]); otherwise UCS-2 ⇒ 70
/// single / 67 concatenated code units. Pure arithmetic — the Kotlin glue
/// performs the actual split. (REQ-A585)
pub fn segment_count(text: &str) -> usize {
    let gsm = is_gsm7(text);
    let (single, multi) = if gsm {
        (GSM7_SINGLE, GSM7_MULTI)
    } else {
        (UCS2_SINGLE, UCS2_MULTI)
    };
    let units = if gsm {
        gsm7_units(text)
    } else {
        text.encode_utf16().count() // an emoji outside the BMP costs 2
    };
    if units <= single {
        1
    } else {
        units.div_ceil(multi)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_separators_and_keeps_plus() {
        assert_eq!(
            normalize_address(" +86 138-0013-8000 ").unwrap(),
            "+8613800138000"
        );
        assert_eq!(normalize_address("(10086)").unwrap(), "10086");
        assert_eq!(normalize_address("10086.").unwrap(), "10086");
    }

    #[test]
    fn rejects_bad_addresses_honestly() {
        assert!(normalize_address("").is_err());
        assert!(normalize_address("   ").is_err());
        assert!(normalize_address("abc").is_err()); // letters
        assert!(normalize_address("12").is_err()); // too few digits
        assert!(normalize_address("+").is_err()); // lone plus
        assert!(normalize_address(&"1".repeat(MAX_ADDRESS_DIGITS + 1)).is_err());
        assert!(normalize_address("86+138").is_err()); // `+` not leading
    }

    #[test]
    fn accepts_shortcode_and_e164() {
        assert!(normalize_address("10086").is_ok()); // shortcode
        assert!(normalize_address("+8613800138000").is_ok()); // E.164
        assert!(normalize_address("106942053200156").is_ok()); // 15-digit service id
    }

    #[test]
    fn rejects_blank_and_oversized_text() {
        assert!(validate_text("").is_err());
        assert!(validate_text("  \n ").is_err());
        assert!(validate_text("hi\0there").is_err());
        assert!(validate_text(&"a".repeat(MAX_TEXT_CHARS)).is_ok());
        assert!(validate_text(&"a".repeat(MAX_TEXT_CHARS + 1)).is_err());
    }

    #[test]
    fn counts_segments_for_gsm7_and_ucs2() {
        assert_eq!(segment_count(""), 1);
        assert_eq!(segment_count("hi"), 1);
        assert_eq!(segment_count(&"a".repeat(GSM7_SINGLE)), 1);
        assert_eq!(segment_count(&"a".repeat(GSM7_SINGLE + 1)), 2);
        // 313 chars: concatenated parts hold 153 each → 3 segments.
        assert_eq!(segment_count(&"a".repeat(GSM7_SINGLE + GSM7_MULTI)), 3);
        // Chinese is UCS-2: 70 chars fit one segment.
        assert_eq!(segment_count(&"中".repeat(UCS2_SINGLE)), 1);
        assert_eq!(segment_count(&"中".repeat(UCS2_SINGLE + 1)), 2);
        // An emoji is outside the BMP → counts as 2 UTF-16 units.
        assert_eq!(segment_count("😀"), 1);
        assert_eq!(segment_count(&"😀".repeat(36)), 2); // 72 units > 70
    }

    #[test]
    fn gsm7_detection() {
        assert!(is_gsm7("Hello, world! 123"));
        assert!(is_gsm7("price: £5"));
        assert!(!is_gsm7("中文"));
        assert!(!is_gsm7("😀"));
    }

    /// The GSM-7 alphabet is a **fixed table**, not "ASCII". Every ASCII graphic
    /// char is GSM-7 *except* the backtick (U+0060), which is in neither the basic
    /// nor the extension table — a body containing one must travel as UCS-2. And
    /// `€` **is** GSM-7 (extension table: ESC + char), so it must not be pushed to
    /// UCS-2. [`segment_count`] mirrors what the platform's `divideMessage` will
    /// actually send, so a misclassified body makes the counter on the receipt
    /// disagree with the radio (REQ-A1781).
    #[test]
    fn gsm7_is_the_gsm_table_not_ascii_the_backtick_and_the_euro() {
        // Over-claim: the backtick is not representable in GSM-7 at all.
        assert!(!is_gsm7("`"), "a backtick is in neither GSM-7 table");
        assert!(!is_gsm7("code `x`"), "one backtick makes the body UCS-2");
        assert!(
            is_gsm7("code x"),
            "positive control: the same body without it"
        );

        // The undercount that followed: 80 backticks are UCS-2, not one 160-septet
        // segment — the platform sends 2 parts, so the counter must say 2.
        assert_eq!(segment_count(&"`".repeat(UCS2_SINGLE)), 1);
        assert_eq!(segment_count(&"`".repeat(UCS2_SINGLE + 1)), 2);

        // Under-claim: `€` is a GSM-7 extension char (ESC + char ⇒ 2 septets), so
        // 80 of them fill exactly one segment instead of being sent as UCS-2.
        assert!(
            is_gsm7("€5"),
            "the euro sign is in the GSM-7 extension table"
        );
        assert_eq!(segment_count(&"€".repeat(GSM7_SINGLE / 2)), 1);
        assert_eq!(segment_count(&"€".repeat(GSM7_SINGLE / 2 + 1)), 2);
    }

    #[test]
    fn gsm7_extension_chars_cost_two_septets() {
        // `^ { } [ ] ~ | \` and form-feed are GSM-7 *extension* characters:
        // they travel as ESC + char, i.e. two septets each. A single segment
        // holds 160 septets, so 80 extension chars fit exactly and 81 do not.
        assert_eq!(segment_count(&"^".repeat(GSM7_SINGLE / 2)), 1);
        assert_eq!(segment_count(&"^".repeat(GSM7_SINGLE / 2 + 1)), 2);
        // Every ASCII extension char is charged the same way, and form-feed too.
        for c in ['^', '{', '}', '[', ']', '~', '|', '\\', '\u{0c}'] {
            let text = c.to_string().repeat(GSM7_SINGLE / 2 + 1);
            assert_eq!(segment_count(&text), 2, "extension char {c:?} undercounted");
        }
        // A plain ASCII message of the same length is still one segment.
        assert_eq!(segment_count(&"a".repeat(GSM7_SINGLE / 2 + 1)), 1);
    }
}

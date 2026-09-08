//! Small, dependency-free text helpers shared by the model, the chunker and the
//! CLI: character counting, whitespace collapsing and an **approximate token
//! estimator** used to size RAG chunks for a local model's context window.
//!
//! # Honest caveat
//!
//! A real 7B checkpoint tokenises with a learned BPE/Unigram vocabulary, so no
//! closed-form estimator is exact. This crate makes a deterministic, documented
//! *heuristic*: one CJK codepoint ≈ 1 token, non-CJK characters ≈ ¼ token each.
//! That is good enough to (a) report "about N tokens" and (b) pick chunk sizes
//! that keep whole pages' contexts under a model's budget without splitting a
//! CJK character mid-sequence. Never treat the number as a byte-exact
//! count — it is a planner, not a tokeniser.

/// A rough "tokeniser" intended to be *internally consistent* with
/// [`estimate_tokens`]: it reports how many model-ish tokens a chunk of text
/// would contribute to a context window.
pub fn estimate_tokens(s: &str) -> usize {
    let mut weight: f64 = 0.0;
    for c in s.chars() {
        if is_cjk(c) {
            weight += 1.0;
        } else {
            // ~4 Latin characters per token (including surrounding whitespace).
            weight += 0.25;
        }
    }
    weight.round() as usize
}

/// Characters that a typical multilingual 7B model scores close to one token
/// per character. Covers CJK Unified Ideographs, compat/full-width forms,
/// kana, hangul and CJK punctuation.
pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x2E80..=0x2EFF   // CJK radicals
        | 0x3000..=0x303F // CJK punctuation
        | 0x3040..=0x30FF // hiragana + katakana
        | 0x31C0..=0x31EF
        | 0x3200..=0x32FF
        | 0x3300..=0x33FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF // CJK unified ideographs
        | 0xF900..=0xFAFF // CJK compat ideographs
        | 0xFE30..=0xFE4F
        | 0xFF00..=0xFFEF // full-width forms
        | 0x20000..=0x2A6DF
        | 0x2F800..=0x2FA1F
    )
}

/// Number of Unicode scalar values in `s`.
pub fn count_chars(s: &str) -> usize {
    s.chars().count()
}

/// Trim each line and replace runs of inner whitespace with a single space.
/// Keeps `\n` line breaks so the chunker can cut on them.
pub fn normalize_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for ch in s.chars() {
        if ch == '\n' {
            out.push('\n');
            in_space = false;
        } else if ch.is_whitespace() {
            in_space = true;
        } else {
            if in_space && !out.is_empty() && !out.ends_with('\n') {
                out.push(' ');
            }
            in_space = false;
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_string_is_zero_tokens() {
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn ascii_is_about_a_quarter_token_per_char() {
        // 8 ascii chars * 0.25 = 2.0 → 2
        assert_eq!(estimate_tokens("eightish"), 2);
        assert_eq!(estimate_tokens("abcd"), 1);
    }

    #[test]
    fn cjk_is_one_token_per_char() {
        // 4 han characters → 4 tokens
        assert_eq!(estimate_tokens("人工智能"), 4);
        assert_eq!(estimate_tokens("你好世界"), 4);
    }

    #[test]
    fn mixed_text_sums_both_kinds() {
        // "AI操作系统" = 2 ascii (0.5) + 4 cjk (4) ≈ 4.5 → round 5
        let n = estimate_tokens("AI操作系统");
        assert!((4..=5).contains(&n), "got {n}");
    }

    #[test]
    fn count_chars_is_unicode_aware() {
        assert_eq!(count_chars(""), 0);
        assert_eq!(count_chars("héllo"), 5);
        assert_eq!(count_chars("你好"), 2);
    }

    #[test]
    fn normalize_collapses_inner_spaces_keeps_lines() {
        assert_eq!(normalize_whitespace("a   b\tc"), "a b c");
        assert_eq!(normalize_whitespace("one\n\n  two "), "one\n\ntwo");
    }
}

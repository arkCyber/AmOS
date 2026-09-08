//! RAG chunking: cut an extracted document into passages small enough for a
//! local 7B model's context window, keeping page anchors and an optional
//! overlap between consecutive chunks so a retrieval step does not lose the
//! sentence that bridges two chunks.
//!
//! The budget is measured in [`estimate_tokens`] — the same documented heuristic
//! used everywhere else — so a caller can cap a window with `target_tokens`
//! regardless of script (CJK ≈ 1 token/char, Latin ≈ ¼).

use serde::{Deserialize, Serialize};

use crate::model::ParsedPdf;
use crate::util::{count_chars, estimate_tokens, is_cjk};

/// One retrieval unit, sized to fit a model context.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Chunk {
    /// 0-based index across the whole document.
    pub index: usize,
    /// Page numbers (1-based) the chunk touches, ascending.
    pub page_numbers: Vec<usize>,
    pub text: String,
    pub char_count: usize,
    /// Approximate model tokens ([`estimate_tokens`]).
    pub est_tokens: usize,
}

/// How large a chunk may be and how much tail of the previous chunk to carry
/// into the next one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkConfig {
    /// Target chunk size in *estimated* tokens.
    pub target_tokens: usize,
    /// Approximate tokens of overlap carried from one chunk to the next.
    pub overlap_tokens: usize,
}

impl Default for ChunkConfig {
    fn default() -> Self {
        Self {
            target_tokens: 512,
            overlap_tokens: 64,
        }
    }
}

/// A flat text segment tagged with the page it came from.
struct Seg {
    page: usize,
    toks: usize,
    text: String,
}

/// Chunk an extracted document. Every returned chunk has `est_tokens <=
/// target_tokens` (a single oversized paragraph is pre-split to honour that).
pub fn chunk_document(doc: &ParsedPdf, cfg: &ChunkConfig) -> Vec<Chunk> {
    let target = cfg.target_tokens.max(1);
    let mut segs: Vec<Seg> = Vec::new();
    for page in &doc.pages {
        for line in page.text.split('\n') {
            if line.trim().is_empty() {
                continue;
            }
            let toks = estimate_tokens(line);
            if toks <= target {
                segs.push(Seg {
                    page: page.number,
                    toks,
                    text: line.to_string(),
                });
            } else {
                for piece in split_long(line, target) {
                    if piece.trim().is_empty() {
                        continue;
                    }
                    segs.push(Seg {
                        page: page.number,
                        toks: estimate_tokens(&piece),
                        text: piece,
                    });
                }
            }
        }
    }

    let mut chunks: Vec<Chunk> = Vec::new();
    let mut idx = 0;
    let mut chunk_index = 0;
    while idx < segs.len() {
        // Greedily accumulate segments, measuring the *actual joined text* each
        // step so the newline/whitespace between lines is counted in the budget
        // (keeps the strict `est_tokens <= target` invariant true).
        let mut text = segs[idx].text.clone();
        let mut end = idx + 1;
        while end < segs.len() {
            let mut cand = String::with_capacity(text.len() + segs[end].text.len() + 1);
            cand.push_str(&text);
            cand.push('\n');
            cand.push_str(&segs[end].text);
            if estimate_tokens(&cand) > target {
                break;
            }
            text = cand;
            end += 1;
        }

        let mut pages: Vec<usize> = segs[idx..end].iter().map(|s| s.page).collect();
        pages.sort_unstable();
        pages.dedup();

        chunks.push(Chunk {
            index: chunk_index,
            page_numbers: pages,
            char_count: count_chars(&text),
            est_tokens: estimate_tokens(&text),
            text,
        });
        chunk_index += 1;

        // Next window starts with up to `overlap_tokens` of this chunk's tail
        // (approximated by the per-segment estimates).
        let mut s = end;
        let mut ov = 0usize;
        while s > idx {
            let t = segs[s - 1].toks;
            if ov + t > cfg.overlap_tokens {
                break;
            }
            ov += t;
            s -= 1;
        }
        idx = if s == idx { end } else { s };
    }
    chunks
}

/// Split one oversized line into pieces each estimated at ≤ `max` tokens.
/// Uses the same per-character weights as [`estimate_tokens`] so boundaries are
/// script-aware (a CJK char is never split from its own sequence).
fn split_long(s: &str, max: usize) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut cur = String::new();
    let mut w = 0.0f64;
    for ch in s.chars() {
        let cw = if is_cjk(ch) { 1.0 } else { 0.25 };
        if w + cw > max as f64 && !cur.is_empty() {
            pieces.push(std::mem::take(&mut cur));
            w = 0.0;
        }
        cur.push(ch);
        w += cw;
    }
    if !cur.is_empty() {
        pieces.push(cur);
    }
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ParsedPage, ParsedPdf};

    fn doc_of(texts: &[&str]) -> ParsedPdf {
        let pages = texts
            .iter()
            .enumerate()
            .map(|(i, t)| ParsedPage::new(i + 1, t.to_string()))
            .collect();
        ParsedPdf::from_pages("t.pdf".to_string(), pages, vec![])
    }

    /// 60 unique short lines, each ~2 estimated tokens.
    fn numbered_lines(n: usize) -> String {
        (0..n)
            .map(|i| format!("item{i:04}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn small_budget_still_chunks_everything_without_loss() {
        let text = numbered_lines(60);
        let doc = doc_of(&[text.as_str()]);
        let chunks = chunk_document(
            &doc,
            &ChunkConfig {
                target_tokens: 6,
                overlap_tokens: 0,
            },
        );
        assert!(chunks.len() > 1);
        for c in &chunks {
            assert!(c.est_tokens <= 6, "chunk had {} tokens", c.est_tokens);
        }
        // No line is lost, dropped or duplicated (lines stay intact).
        let mut recovered: Vec<&str> = chunks.iter().flat_map(|c| c.text.lines()).collect();
        recovered.sort_unstable();
        let mut expected: Vec<&str> = text.lines().collect();
        expected.sort_unstable();
        assert_eq!(recovered, expected);
    }

    #[test]
    fn zero_overlap_is_disjoint() {
        let text = numbered_lines(20);
        let doc = doc_of(&[text.as_str()]);
        let chunks = chunk_document(
            &doc,
            &ChunkConfig {
                target_tokens: 5,
                overlap_tokens: 0,
            },
        );
        assert!(chunks.len() > 1);
        for pair in chunks.windows(2) {
            for la in pair[0].text.lines() {
                assert!(
                    !pair[1].text.lines().any(|lb| lb == la),
                    "overlap leaked: {la}"
                );
            }
        }
    }

    #[test]
    fn overlap_carries_tail_into_next_chunk() {
        let text = numbered_lines(40);
        let doc = doc_of(&[text.as_str()]);
        let chunks = chunk_document(
            &doc,
            &ChunkConfig {
                target_tokens: 6,
                overlap_tokens: 3,
            },
        );
        assert!(chunks.len() > 1);
        // The previous chunk's final line reappears at the start of the next one.
        let prev_last = chunks[0].text.lines().next_back().unwrap_or("");
        let next_first = chunks[1].text.lines().next().unwrap_or("");
        assert_eq!(prev_last, next_first, "expected an overlapping shared line");
    }

    #[test]
    fn chunk_preserves_page_anchors_across_pages() {
        // Each page has 10 short (~2 token) lines. With a 10-token budget a chunk
        // that starts near the end of page 1 naturally reaches into page 2, so
        // some chunk must carry both page numbers.
        let doc = doc_of(&[numbered_lines(10).as_str(), numbered_lines(10).as_str()]);
        let chunks = chunk_document(
            &doc,
            &ChunkConfig {
                target_tokens: 10,
                overlap_tokens: 0,
            },
        );
        assert!(chunks.len() > 1);
        assert!(chunks
            .iter()
            .any(|c| c.page_numbers.contains(&1) && c.page_numbers.contains(&2)));
        for c in &chunks {
            assert!(c.page_numbers.iter().all(|&p| p == 1 || p == 2));
        }
    }

    #[test]
    fn empty_document_yields_no_chunks() {
        let doc = doc_of(&[""]);
        let chunks = chunk_document(&doc, &ChunkConfig::default());
        assert!(chunks.is_empty());
    }

    #[test]
    fn cjk_is_split_but_never_mid_char() {
        let text = "汉".repeat(50); // 50 tokens by our heuristic
        let doc = doc_of(&[text.as_str()]);
        let chunks = chunk_document(
            &doc,
            &ChunkConfig {
                target_tokens: 10,
                overlap_tokens: 0,
            },
        );
        let total: usize = chunks.iter().map(|c| c.est_tokens).sum();
        assert_eq!(total, 50);
        for c in &chunks {
            assert!(c.est_tokens <= 10);
            assert_eq!(c.text.chars().count(), c.char_count);
        }
    }

    #[test]
    fn split_long_respects_max() {
        let long = "abcdefghij".repeat(100); // 1000 ascii chars ≈ 250 tokens
        let pieces = split_long(&long, 40);
        assert!(pieces.len() > 1);
        for p in &pieces {
            assert!(estimate_tokens(p) <= 40);
        }
    }

    #[test]
    fn chunking_is_deterministic_and_idempotent() {
        let doc = doc_of(&[numbered_lines(60).as_str(), numbered_lines(20).as_str()]);
        let cfg = ChunkConfig {
            target_tokens: 9,
            overlap_tokens: 3,
        };
        let a = chunk_document(&doc, &cfg);
        let b = chunk_document(&doc, &cfg);
        assert_eq!(a, b, "two runs over the same input must be identical");
    }

    #[test]
    fn chunk_indices_are_contiguous() {
        let doc = doc_of(&[numbered_lines(60).as_str()]);
        let chunks = chunk_document(
            &doc,
            &ChunkConfig {
                target_tokens: 6,
                overlap_tokens: 0,
            },
        );
        for (i, c) in chunks.iter().enumerate() {
            assert_eq!(c.index, i, "chunk indices must be 0..n contiguous");
        }
    }
}

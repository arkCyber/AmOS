//! Serialisable data model for an extracted PDF.
//!
//! This is what the RAG/ingestion layer and the CLI talk to. Every scalar that
//! matters for routing a page to a model's context window (`char_count`,
//! `est_tokens`) is pre-computed so a consumer never re-scans text.

use serde::{Deserialize, Serialize};

use crate::util::{count_chars, estimate_tokens};

/// The text + best-effort structure of one page.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ParsedPage {
    /// 1-based page number, in document order.
    pub number: usize,
    /// Extracted text in (approximate) reading order, `\n`-terminated lines.
    pub text: String,
    /// Number of Unicode scalar values in [`ParsedPage::text`].
    pub char_count: usize,
    /// Approximate model tokens ([`crate::util::estimate_tokens`]).
    pub est_tokens: usize,
    /// Tables detected from the page layout (may be empty).
    pub tables: Vec<Table>,
}

impl ParsedPage {
    /// New empty page (used by tests / empty documents).
    pub fn empty(number: usize) -> Self {
        Self {
            number,
            ..Self::default()
        }
    }

    /// Wrap an extracted text, pre-computing counts and starting with no tables.
    pub fn new(number: usize, text: String) -> Self {
        let char_count = count_chars(&text);
        let est_tokens = estimate_tokens(&text);
        Self {
            number,
            text,
            char_count,
            est_tokens,
            tables: Vec::new(),
        }
    }

    /// Recompute `char_count`/`est_tokens` after a caller mutates `text`.
    pub fn refresh_metrics(&mut self) {
        self.char_count = count_chars(&self.text);
        self.est_tokens = estimate_tokens(&self.text);
    }
}

/// A rectangular table found in a page's layout. Cells are best-effort; a cell
/// that was empty on the page is an empty string, so row widths can differ.
///
/// When [`Table::header`] is true, `rows[0]` **is** the header row (so CSV
/// consumers print it as-is and Markdown consumers treat it as the heading).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Table {
    /// Number of the page the table starts on (1-based).
    pub page_number: usize,
    /// Whether `rows[0]` is the header row.
    pub header: bool,
    /// All rows; the first is the header when `header` is true.
    pub rows: Vec<Vec<String>>,
}

impl Table {
    /// Serialise as RFC-4180-ish CSV (no BOM, LF line endings). A field that
    /// contains a comma/quote/newline is wrapped in double quotes (doubling any
    /// embedded quote). Every row is written, including a header row when set.
    pub fn to_csv(&self) -> String {
        let mut out = String::new();
        let mut first = true;
        for row in &self.rows {
            if !first {
                out.push('\n');
            }
            push_csv_row(&mut out, row);
            first = false;
        }
        out
    }

    /// Serialise as a GitHub-flavoured Markdown table. When `header` is set the
    /// first row becomes the heading and a `---` separator is emitted. Body-only
    /// tables still render as `| … |` rows (no separator).
    pub fn to_markdown(&self) -> String {
        let width = self.rows.iter().map(|r| r.len()).max().unwrap_or(0);
        if width == 0 {
            return String::new();
        }
        let mut out = String::new();
        if self.header {
            if let Some(head) = self.rows.first() {
                push_md_row(&mut out, head, width);
            }
            out.push('\n');
            for i in 0..width {
                if i > 0 {
                    out.push('|');
                }
                out.push_str(" --- ");
            }
            out.push('\n');
            for row in self.rows.iter().skip(1) {
                push_md_row(&mut out, row, width);
                out.push('\n');
            }
        } else {
            for row in &self.rows {
                push_md_row(&mut out, row, width);
                out.push('\n');
            }
        }
        out
    }
}

fn push_csv_row(out: &mut String, cells: &[String]) {
    let mut first = true;
    for cell in cells {
        if !first {
            out.push(',');
        }
        first = false;
        let needs_quote =
            cell.contains(',') || cell.contains('"') || cell.contains('\n') || cell.contains('\r');
        if needs_quote {
            out.push('"');
            for c in cell.chars() {
                if c == '"' {
                    out.push('"');
                }
                out.push(c);
            }
            out.push('"');
        } else {
            out.push_str(cell);
        }
    }
}

fn push_md_row(out: &mut String, row: &[String], width: usize) {
    for i in 0..width {
        if i > 0 {
            out.push('|');
        }
        let cell = row.get(i).map(|s| s.as_str()).unwrap_or("");
        let escaped = cell.replace('|', "\\|").replace('\n', " ");
        out.push_str(&escaped);
    }
}

/// The extracted result of one PDF file.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ParsedPdf {
    /// Display name of the source (file name or "bytes"), for logging/UX.
    pub source_name: String,
    pub page_count: usize,
    pub pages: Vec<ParsedPage>,
    /// Total over all pages.
    pub total_char_count: usize,
    /// Total approximate tokens over all pages.
    pub total_est_tokens: usize,
    /// Non-fatal notes (e.g. a page whose content stream failed to decode was
    /// reported empty rather than failing the whole document).
    pub warnings: Vec<String>,
}

impl ParsedPdf {
    /// Assemble from already-extracted pages, computing totals.
    pub fn from_pages(source_name: String, pages: Vec<ParsedPage>, warnings: Vec<String>) -> Self {
        let page_count = pages.len();
        let total_char_count = pages.iter().map(|p| p.char_count).sum();
        let total_est_tokens = pages.iter().map(|p| p.est_tokens).sum();
        Self {
            source_name,
            page_count,
            pages,
            total_char_count,
            total_est_tokens,
            warnings,
        }
    }

    /// Concatenate every page with a blank line between pages — the stream a
    /// model would receive for a short document, and the input to
    /// [`crate::chunk::chunk_document`].
    pub fn full_text(&self) -> String {
        let mut parts = Vec::with_capacity(self.pages.len());
        for p in &self.pages {
            if !p.text.is_empty() {
                parts.push(p.text.as_str());
            }
        }
        parts.join("\n\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_new_precomputes_metrics() {
        let p = ParsedPage::new(1, "hello 你好".to_string());
        // h e l l o ' ' 你 好 = 8 chars (space is a char)
        assert_eq!(p.char_count, 8);
        assert_eq!(p.number, 1);
        assert!(p.est_tokens > 0);
    }

    #[test]
    fn totals_are_sums() {
        let pages = vec![
            ParsedPage::new(1, "abc".into()),
            ParsedPage::new(2, "def".into()),
        ];
        let doc = ParsedPdf::from_pages("t.pdf".into(), pages, vec![]);
        assert_eq!(doc.page_count, 2);
        assert_eq!(doc.total_char_count, 6);
        // "abc" = 3 × 0.25 = 0.75 → 1 per page → 2 total
        assert_eq!(doc.total_est_tokens, 2);
    }

    #[test]
    fn full_text_joins_pages_with_blank_line() {
        let doc = ParsedPdf::from_pages(
            "t.pdf".into(),
            vec![
                ParsedPage::new(1, "a".into()),
                ParsedPage::new(2, "b".into()),
            ],
            vec![],
        );
        assert_eq!(doc.full_text(), "a\n\nb");
    }

    #[test]
    fn empty_pages_do_not_add_separators() {
        let doc = ParsedPdf::from_pages(
            "t.pdf".into(),
            vec![ParsedPage::empty(1), ParsedPage::empty(2)],
            vec![],
        );
        assert_eq!(doc.full_text(), "");
        assert_eq!(doc.page_count, 2);
    }

    #[test]
    fn csv_escapes_commas_and_quotes() {
        let t = Table {
            page_number: 1,
            header: false,
            rows: vec![
                vec!["a,b".into(), "quote\"d".into()],
                vec!["plain".into(), "two words".into()],
            ],
        };
        let csv = t.to_csv();
        assert_eq!(csv, "\"a,b\",\"quote\"\"d\"\nplain,two words");
    }

    #[test]
    fn markdown_header_pads_and_escapes() {
        let t = Table {
            page_number: 1,
            header: true,
            rows: vec![
                vec!["Name".into(), "A|B".into()],
                vec!["alice".into(), "1".into()],
            ],
        };
        let md = t.to_markdown();
        assert!(md.contains("A\\|B"));
        assert!(md.contains("---"));
        // header line first
        assert!(md.starts_with("Name|A\\|B\n"));
    }

    #[test]
    fn markdown_body_only_has_no_separator() {
        let t = Table {
            page_number: 1,
            header: false,
            rows: vec![vec!["a".into(), "b".into()]],
        };
        let md = t.to_markdown();
        assert_eq!(md, "a|b\n");
        assert!(!md.contains("---"));
    }

    #[test]
    fn zero_page_document_is_well_formed() {
        let d = ParsedPdf::from_pages("empty.pdf".into(), vec![], vec![]);
        assert_eq!(d.page_count, 0);
        assert_eq!(d.full_text(), "");
        assert_eq!(d.total_char_count, 0);
        assert_eq!(d.total_est_tokens, 0);
        assert!(d.pages.is_empty());
    }
}

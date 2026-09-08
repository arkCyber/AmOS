//! The extraction core: load a PDF with `lopdf` and squeeze its text out.
//!
//! Canonical text per page comes from `lopdf`'s `Document::extract_text`, which
//! tracks each `Tf` font switch and decodes text through that font's encoding
//! (including `ToUnicode` cmaps), so it is the layer that survives real-world /
//! CJK PDFs. On top of that we optionally run the cheap layout/table pass for
//! tabular discovery.
//!
//! Soft failures are local: one unreadable page yields a warning + empty text,
//! not a failed document, which is the behaviour an ingestion queue wants.

use std::path::Path;

use lopdf::{Document, ObjectId};

use crate::error::{PdfError, Result};
use crate::layout::{ascii_text, rows_from_ops_decoded};
use crate::model::{ParsedPage, ParsedPdf, Table};
use crate::table::detect_tables;

/// Behaviour switches for one extraction run.
#[derive(Clone, Debug)]
pub struct Options {
    /// Display name used on [`ParsedPdf::source_name`]; defaults to `"bytes"`.
    pub source_name: Option<String>,
    /// Run the layout/table pass (adds [`ParsedPage::tables`]).
    pub detect_tables: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            source_name: None,
            detect_tables: true,
        }
    }
}

/// Facade mirroring the AmOS crate style: construct once, parse many sources.
#[derive(Clone, Debug, Default)]
pub struct PdfParser {
    options: Options,
}

impl PdfParser {
    /// A parser with default options (table detection on, name auto).
    pub fn new() -> Self {
        Self {
            options: Options::default(),
        }
    }

    /// Build from explicit options (e.g. a custom `source_name`).
    pub fn from_options(options: Options) -> Self {
        Self { options }
    }

    /// Turn table detection on/off.
    pub fn with_tables(mut self, on: bool) -> Self {
        self.options.detect_tables = on;
        self
    }

    /// Parse an in-memory PDF buffer.
    pub fn parse_bytes(&self, bytes: &[u8]) -> Result<ParsedPdf> {
        let source = self
            .options
            .source_name
            .clone()
            .unwrap_or_else(|| "bytes".to_string());
        extract_bytes(bytes, source, self.options.detect_tables)
    }

    /// Parse a PDF file from disk.
    pub fn parse_path<P: AsRef<Path>>(&self, path: P) -> Result<ParsedPdf> {
        let path = path.as_ref();
        let name = self.options.source_name.clone().unwrap_or_else(|| {
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("bytes")
                .to_string()
        });
        let bytes = std::fs::read(path)?;
        extract_bytes(&bytes, name, self.options.detect_tables)
    }
}

/// Extract from an in-memory buffer.
pub fn extract_bytes(bytes: &[u8], source_name: String, detect_tables: bool) -> Result<ParsedPdf> {
    if !looks_like_pdf(bytes) {
        return Err(PdfError::Parse(
            "missing %PDF header (not a PDF, or empty)".into(),
        ));
    }
    let doc = Document::load_mem(bytes)?;
    extract_document(&doc, &source_name, detect_tables)
}

/// Extract from a file path.
pub fn extract_path<P: AsRef<Path>>(path: P) -> Result<ParsedPdf> {
    let path = path.as_ref();
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("bytes")
        .to_string();
    let bytes = std::fs::read(path)?;
    extract_bytes(&bytes, name, true)
}

/// Extract every page from an already-loaded `lopdf` document.
pub fn extract_document(doc: &Document, source_name: &str, do_tables: bool) -> Result<ParsedPdf> {
    let page_ids = doc.get_pages();
    let page_count = page_ids.len();
    let mut pages = Vec::with_capacity(page_count);
    let mut warnings = Vec::new();

    for page_number in 1..=page_count as u32 {
        let text = match doc.extract_text(&[page_number]) {
            Ok(t) => t,
            Err(e) => {
                warnings.push(format!(
                    "page {page_number}: text decode failed ({e}); reported empty"
                ));
                String::new()
            }
        };

        let mut page = ParsedPage::new(page_number as usize, text);

        if do_tables {
            if let Some(page_id) = page_ids.get(&page_number) {
                match tables_for_page(doc, *page_id, page.number) {
                    Ok((tables, fallback_cells)) => {
                        page.tables = tables;
                        if fallback_cells > 0 {
                            // No silent data loss: surface the degradation so the
                            // caller knows text may be lossy (ASCII fallback).
                            warnings.push(format!(
                                "page {page_number}: {fallback_cells} text element(s) decoded \
                                 with ASCII fallback (font/encoding unavailable) — may be lossy"
                            ));
                        }
                    }
                    Err(e) => warnings.push(format!("page {page_number}: table pass failed ({e})")),
                }
            }
        }

        pages.push(page);
    }

    Ok(ParsedPdf::from_pages(
        source_name.to_string(),
        pages,
        warnings,
    ))
}

/// Table pass for one page: decode the content stream's cells **font-aware**
/// (each `Tf` selects the font's encoding, incl. `ToUnicode` cmaps — the same
/// power as `extract_text`, but keeping the per-cell geometry).
///
/// Returns the detected tables plus a count of cells that could **not** be
/// decoded under their font/encoding and had to fall back to [`ascii_text`]
/// (lossy). The caller MUST surface a non-zero count (no silent data loss).
fn tables_for_page(
    doc: &Document,
    page_id: ObjectId,
    page_number: usize,
) -> Result<(Vec<Table>, usize)> {
    let content = doc.get_and_decode_page_content(page_id)?;
    let fonts = doc.get_page_fonts(page_id).unwrap_or_default();
    let mut fallback_cells = 0usize;

    let mut decode = |font: Option<&[u8]>, bytes: &[u8]| -> String {
        let decoded = font
            .and_then(|n| fonts.get(n))
            .and_then(|font_dict| font_dict.get_font_encoding(doc).ok())
            .and_then(|enc| Document::decode_text(&enc, bytes).ok());
        match decoded {
            Some(text) => text,
            None => {
                fallback_cells += 1;
                ascii_text(bytes)
            }
        }
    };
    let rows = rows_from_ops_decoded(&content.operations, &mut decode);
    Ok((detect_tables(page_number, &rows), fallback_cells))
}

/// Quick structural sanity check before handing bytes to the parser.
fn looks_like_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-")
}

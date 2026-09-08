//! Error type for the PDF data-extraction pipeline.
//!
//! A parse either loads a whole document into [`crate::ParsedPdf`] or fails with
//! one of these. Per-page *soft* failures (one broken content stream in an
//! otherwise readable file) do **not** abort the document — they surface as
//! [`crate::ParsedPdf::warnings`] and the affected page is reported honestly
//! (possibly empty), which is the behaviour an ingestion queue wants.

use std::fmt;

/// Errors produced while reading + extracting a PDF.
#[derive(Debug)]
pub enum PdfError {
    /// Reading the underlying bytes failed (path-level API only).
    Io(std::io::Error),
    /// The bytes could not be parsed as a PDF structure (wrong magic, truncated
    /// cross-reference table, …).
    Parse(String),
    /// An underlying parser (`lopdf`) error we bubble up verbatim.
    Lopdf(lopdf::Error),
    /// The caller asked for something the file does not contain.
    NotFound(String),
}

impl fmt::Display for PdfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PdfError::Io(e) => write!(f, "cannot read PDF source: {e}"),
            PdfError::Parse(msg) => write!(f, "not a readable PDF: {msg}"),
            PdfError::Lopdf(e) => write!(f, "PDF structure error: {e}"),
            PdfError::NotFound(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for PdfError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            PdfError::Io(e) => Some(e),
            PdfError::Lopdf(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for PdfError {
    fn from(e: std::io::Error) -> Self {
        PdfError::Io(e)
    }
}

impl From<lopdf::Error> for PdfError {
    fn from(e: lopdf::Error) -> Self {
        PdfError::Lopdf(e)
    }
}

/// Convenience alias used across the crate.
pub type Result<T> = std::result::Result<T, PdfError>;

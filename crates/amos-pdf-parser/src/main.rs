//! `amos-pdf-parser` binary: print extracted PDF text / JSON for the AmOS
//! offline RAG data-extraction pipeline.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]
#![forbid(unsafe_code)]

use std::process::ExitCode;

fn main() -> ExitCode {
    ExitCode::from(amos_pdf_parser::cli::entry() as u8)
}

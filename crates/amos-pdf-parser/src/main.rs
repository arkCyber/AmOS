//! `amos-pdf-parser` binary: print extracted PDF text / JSON for the AmOS
//! offline RAG data-extraction pipeline.

#![forbid(unsafe_code)]

use std::process::ExitCode;

fn main() -> ExitCode {
    ExitCode::from(amos_pdf_parser::cli::entry() as u8)
}

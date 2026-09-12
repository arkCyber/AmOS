//! Command-line interface for the AmOS offline RAG PDF data-extraction pipeline.
//!
//! Reads one PDF (a path or `-` for stdin) and prints its extracted text,
//! optionally as JSON (whole document + RAG chunks sized for a model's context).
//!
//! Usage:
//! ```text
//! amos-pdf-parser [OPTIONS] <FILE|->         # FILE or - (stdin)
//!   --format text|json    output format (default text)
//!   --chunks              also emit RAG chunks (requires --format json)
//!   --token-target N      target tokens per chunk (default 512)
//!   --overlap N           tokens of overlap between chunks (default 64)
//!   --no-tables           skip the best-effort table pass
//!   -h, --help
//! ```

use std::io::Read;

use serde::Serialize;

use crate::chunk::{chunk_document, Chunk, ChunkConfig};
use crate::extract::{Options, PdfParser};
use crate::model::ParsedPdf;

pub const USAGE: &str = "\
amos-pdf-parser - squeeze text (and tables) out of a PDF for a local LLM

USAGE:
    amos-pdf-parser [OPTIONS] <FILE|->

    <FILE>   path to a .pdf file, or `-` to read the bytes from stdin.

OPTIONS:
    --format text|json     output format (default: text)
    --chunks               emit RAG chunks too (only meaningful with --format json)
    --token-target N       target tokens per chunk   (default 512)
    --overlap N            tokens of overlap between chunks (default 64)
    --no-tables            skip the best-effort table pass
    -h, --help             show this help
    -V, --version          print version and exit";

/// JSON payload when `--format json` is requested.
#[derive(Serialize)]
struct JsonOut<'a> {
    #[serde(flatten)]
    doc: &'a ParsedPdf,
    #[serde(skip_serializing_if = "Option::is_none")]
    chunks: Option<Vec<Chunk>>,
}

struct Cli {
    files: Vec<String>,
    format: String,
    chunks: bool,
    token_target: usize,
    overlap: usize,
    no_tables: bool,
    help: bool,
    version: bool,
}

impl Default for Cli {
    fn default() -> Self {
        Self {
            files: Vec::new(),
            format: "text".to_string(),
            chunks: false,
            token_target: 512,
            overlap: 64,
            no_tables: false,
            help: false,
            version: false,
        }
    }
}

/// Entry point returning a process exit code (call from `main`).
pub fn entry() -> i32 {
    match run() {
        Ok(()) => 0,
        Err(msg) => {
            eprintln!("amos-pdf-parser: {msg}");
            1
        }
    }
}

fn run() -> Result<(), String> {
    let cli = parse_args(std::env::args().skip(1).collect())?;
    if cli.help {
        println!("{USAGE}");
        return Ok(());
    }
    if cli.version {
        // Self-describing artifacts: the release bundle's `--version` is how a
        // deployed binary is identified (scripts/release-artifacts.sh checks it).
        println!("amos-pdf-parser {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if cli.files.is_empty() {
        return Err(format!("no input file given.\n\n{USAGE}"));
    }
    if cli.files.len() > 1 {
        return Err(format!("expected one input file, got {}", cli.files.len()));
    }
    if cli.format != "text" && cli.format != "json" {
        return Err(format!(
            "unknown --format '{}' (expected text or json)",
            cli.format
        ));
    }
    if cli.chunks && cli.format != "json" {
        return Err("--chunks only makes sense with --format json".to_string());
    }
    if cli.token_target == 0 {
        return Err("--token-target must be >= 1".to_string());
    }

    // Read the input.
    let input = &cli.files[0];
    let (bytes, name) = if input == "-" {
        let mut buf = Vec::new();
        std::io::stdin()
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
        (buf, "stdin".to_string())
    } else {
        let bytes = std::fs::read(input).map_err(|e| format!("cannot read {input}: {e}"))?;
        let name = std::path::Path::new(input)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(input)
            .to_string();
        (bytes, name)
    };

    let parser = PdfParser::from_options(Options {
        source_name: Some(name.clone()),
        detect_tables: !cli.no_tables,
    });
    let doc = parser.parse_bytes(&bytes).map_err(|e| e.to_string())?;

    if cli.format == "json" {
        let chunks = if cli.chunks {
            Some(chunk_document(
                &doc,
                &ChunkConfig {
                    target_tokens: cli.token_target,
                    overlap_tokens: cli.overlap,
                },
            ))
        } else {
            None
        };
        let out = JsonOut { doc: &doc, chunks };
        let json = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?;
        println!("{json}");
    } else {
        // text
        if !doc.warnings.is_empty() {
            eprintln!("warnings:");
            for w in &doc.warnings {
                eprintln!("  - {w}");
            }
        }
        for page in &doc.pages {
            println!("==== Page {} ====", page.number);
            println!("{}", page.text);
        }
    }
    Ok(())
}

fn parse_args(args: Vec<String>) -> Result<Cli, String> {
    let mut cli = Cli::default();
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => cli.help = true,
            "-V" | "--version" => cli.version = true,
            "--chunks" => cli.chunks = true,
            "--no-tables" => cli.no_tables = true,
            "--format" => {
                cli.format = it.next().ok_or("--format needs a value (text|json)")?;
            }
            "--token-target" => {
                let v = it.next().ok_or("--token-target needs a value")?;
                cli.token_target = v.parse().map_err(|_| format!("bad --token-target '{v}'"))?;
            }
            "--overlap" => {
                let v = it.next().ok_or("--overlap needs a value")?;
                cli.overlap = v.parse().map_err(|_| format!("bad --overlap '{v}'"))?;
            }
            other if other.starts_with('-') && other.len() > 1 && other != "-" => {
                return Err(format!("unknown option '{other}'.\n\n{USAGE}"));
            }
            other => cli.files.push(other.to_string()),
        }
    }
    Ok(cli)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn version_flag_is_recognised_and_needs_no_input_file() {
        // A released artifact must be able to say what it is, so `--version` must work
        // without the <FILE> the parser otherwise requires
        // (scripts/release-artifacts.sh checks every staged binary).
        let cli = parse_args(args(&["--version"])).unwrap();
        assert!(cli.version);
        assert!(cli.files.is_empty());
        assert!(parse_args(args(&["-V"])).unwrap().version);
        assert!(!parse_args(args(&["x.pdf"])).unwrap().version);
        assert!(
            !parse_args(args(&["--format", "json", "-"]))
                .unwrap()
                .version
        );
    }

    #[test]
    fn help_and_version_are_independent_flags() {
        let h = parse_args(args(&["-h"])).unwrap();
        assert!(h.help && !h.version);
        let v = parse_args(args(&["-V"])).unwrap();
        assert!(!v.help && v.version);
        // Both documented in USAGE (honesty: help must describe every flag).
        assert!(USAGE.contains("-V, --version"));
    }

    #[test]
    fn unknown_options_still_fail() {
        assert!(parse_args(args(&["--nope"])).is_err());
    }
}

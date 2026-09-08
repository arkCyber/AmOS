//! End-to-end integration tests: build a *real* PDF with `lopdf`'s writer, then
//! push it through `amos-pdf-parser`'s public API and assert on the extracted
//! text + detected tables.
//!
//! Building the fixture with a PDF writer (rather than embedding hand-made
//! bytes) guarantees a structurally valid file with correct xref tables and
//! compressed content streams, so these tests exercise the same decode path a
//! real document uses.

use amos_pdf_parser::{chunk_document, PdfError, PdfParser};
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};

/// Assemble a 2-page PDF and render it to bytes.
///
/// * Page 1: one line of prose (`Hello AmOS RAG page 1`).
/// * Page 2: a 3×2 table (`Name/Score`, `alice/95`, `bob/88`) whose cells are
///   placed at their own origins — the layout our table detector expects.
fn build_pdf_bytes() -> Vec<u8> {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();

    // A standard-14 Type1 font — no font file to embed.
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Courier",
        "Encoding" => "WinAnsiEncoding",
    });
    let resources_id = doc.add_object(dictionary! {
        "Font" => dictionary! {
            "F1" => font_id,
        },
    });

    let page1_content = doc.add_object(Stream::new(
        dictionary! {},
        Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 700.into()]),
                Operation::new("Tj", vec![Object::string_literal("Hello AmOS RAG page 1")]),
                Operation::new("ET", vec![]),
            ],
        }
        .encode()
        .unwrap(),
    ));

    // Page 2 table content: each cell is a separate text object at its origin.
    let mut ops = vec![
        Operation::new("BT", vec![]),
        Operation::new("Tf", vec!["F1".into(), 12.into()]),
    ];
    for (x, y, text) in [
        (72.0, 700.0, "Name"),
        (250.0, 700.0, "Score"),
        (72.0, 680.0, "alice"),
        (250.0, 680.0, "95"),
        (72.0, 660.0, "bob"),
        (250.0, 660.0, "88"),
    ] {
        ops.push(Operation::new(
            "Tm",
            vec![1.into(), 0.into(), 0.into(), 1.into(), x.into(), y.into()],
        ));
        ops.push(Operation::new("Tj", vec![Object::string_literal(text)]));
    }
    // A WinAnsi-encoded byte (0xE9 = 'é') proves font-aware decode: the cell
    // must come out as real Unicode 'é', NOT the ASCII fallback U+FFFD.
    ops.push(Operation::new(
        "Tm",
        vec![
            1.into(),
            0.into(),
            0.into(),
            1.into(),
            72.0.into(),
            640.0.into(),
        ],
    ));
    ops.push(Operation::new(
        "Tj",
        vec![Object::String(
            b"caf\xe9".to_vec(),
            lopdf::StringFormat::Literal,
        )],
    ));
    ops.push(Operation::new(
        "Tm",
        vec![
            1.into(),
            0.into(),
            0.into(),
            1.into(),
            250.0.into(),
            640.0.into(),
        ],
    ));
    ops.push(Operation::new("Tj", vec![Object::string_literal("5")]));
    ops.push(Operation::new("ET", vec![]));
    let page2_content = doc.add_object(Stream::new(
        dictionary! {},
        Content { operations: ops }.encode().unwrap(),
    ));

    let page1_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "Contents" => page1_content,
        "Resources" => resources_id,
        "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
    });
    let page2_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "Contents" => page2_content,
        "Resources" => resources_id,
        "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
    });

    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page1_id.into(), page2_id.into()],
            "Count" => 2,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        }),
    );

    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);
    doc.compress();

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

#[test]
fn parses_a_real_pdf_and_extracts_text() {
    let bytes = build_pdf_bytes();
    let parser = PdfParser::new();
    let doc = parser.parse_bytes(&bytes).expect("valid PDF should parse");

    assert_eq!(doc.source_name, "bytes");
    assert_eq!(doc.page_count, 2);
    assert!(
        doc.warnings.is_empty(),
        "unexpected warnings: {:?}",
        doc.warnings
    );

    // Page 1 text round-trips through the font-aware extractor.
    assert_eq!(doc.pages[0].number, 1);
    assert!(
        doc.pages[0].text.contains("Hello AmOS RAG page 1"),
        "page 1 text was: {:?}",
        doc.pages[0].text
    );
    assert!(doc.pages[0].char_count > 0);
    assert!(doc.pages[0].est_tokens > 0);
}

#[test]
fn detects_a_table_from_page_layout() {
    let bytes = build_pdf_bytes();
    let doc = PdfParser::new().parse_bytes(&bytes).expect("valid PDF");
    let page2 = &doc.pages[1];
    assert_eq!(page2.tables.len(), 1, "expected one table on page 2");
    let table = &page2.tables[0];
    assert!(table.header);
    assert_eq!(table.rows.len(), 4);
    assert_eq!(table.rows[0], vec!["Name".to_string(), "Score".to_string()]);
    assert_eq!(table.rows[1], vec!["alice".to_string(), "95".to_string()]);
    assert_eq!(table.rows[2], vec!["bob".to_string(), "88".to_string()]);
    // Font-aware decode: the WinAnsi 0xE9 byte must survive as real 'é'.
    assert_eq!(table.rows[3], vec!["café".to_string(), "5".to_string()]);
    // No cell was degraded to the ASCII-fallback replacement character.
    assert!(
        !table.rows.iter().flatten().any(|c| c.contains('\u{fffd}')),
        "font-aware decode degraded a cell: {:?}",
        table.rows
    );

    let md = table.to_markdown();
    assert!(md.contains("Name|Score"));
    let csv = table.to_csv();
    assert!(csv.contains("Name,Score"));
}

#[test]
fn tables_can_be_disabled() {
    let bytes = build_pdf_bytes();
    let doc = PdfParser::new()
        .with_tables(false)
        .parse_bytes(&bytes)
        .expect("valid PDF");
    assert!(doc.pages[1].tables.is_empty());
    // Text extraction is unaffected.
    assert!(doc.pages[0].text.contains("Hello AmOS"));
}

#[test]
fn chunks_the_document_into_budgeted_units() {
    let bytes = build_pdf_bytes();
    let doc = PdfParser::new().parse_bytes(&bytes).expect("valid PDF");
    let cfg = amos_pdf_parser::ChunkConfig {
        target_tokens: 12,
        overlap_tokens: 2,
    };
    let chunks = chunk_document(&doc, &cfg);
    assert!(!chunks.is_empty());
    for c in &chunks {
        assert!(
            c.est_tokens <= 12,
            "chunk {} has {} tokens",
            c.index,
            c.est_tokens
        );
        assert!(c.page_numbers.iter().all(|&p| (1..=2).contains(&p)));
    }
}

#[test]
fn invalid_bytes_is_rejected() {
    let err = PdfParser::new()
        .parse_bytes(b"this is not a pdf")
        .unwrap_err();
    assert!(matches!(err, PdfError::Parse(_)));
    // Empty input also fails the magic check.
    assert!(PdfParser::new().parse_bytes(&[]).is_err());
}

#[test]
fn parse_path_reads_a_file() {
    use std::io::Write;
    let path = std::env::temp_dir().join(format!("amos-pdf-parser-it-{}.pdf", std::process::id()));
    let mut f = std::fs::File::create(&path).unwrap();
    f.write_all(&build_pdf_bytes()).unwrap();
    f.flush().unwrap();

    let doc = PdfParser::new()
        .parse_path(&path)
        .expect("file should parse");
    assert_eq!(doc.page_count, 2);
    assert!(doc.source_name.ends_with(".pdf"));

    let _ = std::fs::remove_file(&path);
}

#[test]
fn lossy_decode_is_surfaced_not_silent() {
    // A text show with NO `Tf` (no font context) can only be ASCII-decoded. The
    // crate MUST report this degradation instead of silently emitting U+FFFD.
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Courier",
        "Encoding" => "WinAnsiEncoding",
    });
    let resources_id = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font_id } });

    let content = Content {
        operations: vec![
            Operation::new("BT", vec![]),
            Operation::new("Td", vec![72.into(), 700.into()]),
            Operation::new(
                "Tj",
                vec![Object::String(
                    "你好".as_bytes().to_vec(),
                    lopdf::StringFormat::Literal,
                )],
            ),
            Operation::new("ET", vec![]),
        ],
    }
    .encode()
    .unwrap();
    let content_id = doc.add_object(Stream::new(dictionary! {}, content));
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "Contents" => content_id,
        "Resources" => resources_id,
        "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
            "Resources" => resources_id,
        }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    doc.compress();

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();

    let parsed = PdfParser::new().parse_bytes(&bytes).unwrap();
    assert!(
        parsed.warnings.iter().any(|w| w.contains("ASCII fallback")),
        "lossy decode must be surfaced in warnings, got {:?}",
        parsed.warnings
    );
}

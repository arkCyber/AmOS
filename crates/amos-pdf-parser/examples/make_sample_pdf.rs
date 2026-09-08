//! Generate a small sample PDF (2 pages: one prose page + one table page) and
//! save it to a path, so you can exercise the pipeline by hand:
//!
//! ```text
//! cargo run -p amos-pdf-parser --example make_sample_pdf -- /tmp/sample.pdf
//! cargo run -p amos-pdf-parser -- /tmp/sample.pdf                 # text
//! cargo run -p amos-pdf-parser -- --format json --chunks /tmp/sample.pdf
//! ```

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use std::error::Error;

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "sample.pdf".to_string());

    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Courier",
        "Encoding" => "WinAnsiEncoding",
    });
    let resources_id = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font_id } });

    // Page 1: prose.
    let p1_content = doc.add_object(Stream::new(
        dictionary! {},
        Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 760.into()]),
                Operation::new("Tj", vec![Object::string_literal("AmOS offline RAG demo")]),
                Operation::new("Td", vec![0.into(), (-20).into()]),
                Operation::new(
                    "Tj",
                    vec![Object::string_literal(
                        "This text was squeezed out of a PDF for a local 7B model.",
                    )],
                ),
                Operation::new("ET", vec![]),
            ],
        }
        .encode()?,
    ));

    // Page 2: a small table (each cell at its own origin).
    let mut ops = vec![
        Operation::new("BT", vec![]),
        Operation::new("Tf", vec!["F1".into(), 12.into()]),
    ];
    for (x, y, text) in [
        (72.0, 760.0, "Model"),
        (260.0, 760.0, "Params"),
        (72.0, 740.0, "qwen2.5"),
        (260.0, 740.0, "7B"),
        (72.0, 720.0, "hermes"),
        (260.0, 720.0, "3B"),
    ] {
        ops.push(Operation::new(
            "Tm",
            vec![1.into(), 0.into(), 0.into(), 1.into(), x.into(), y.into()],
        ));
        ops.push(Operation::new("Tj", vec![Object::string_literal(text)]));
    }
    ops.push(Operation::new("ET", vec![]));
    let p2_content = doc.add_object(Stream::new(
        dictionary! {},
        Content { operations: ops }.encode()?,
    ));

    let mut page_ids: Vec<ObjectId> = Vec::new();
    for content_id in [p1_content, p2_content] {
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        });
        page_ids.push(page_id);
    }

    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.iter().map(|&id| id.into()).collect::<Vec<Object>>(),
            "Count" => page_ids.len() as i64,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        }),
    );

    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    doc.compress();

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes)?;
    std::fs::write(&path, &bytes)?;
    println!("wrote sample PDF ({} pages) to {}", page_ids.len(), path);
    Ok(())
}

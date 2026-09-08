//! A layout pass over a page's content operators that produces positioned rows
//! and cells for table discovery.
//!
//! The canonical text for RAG ingestion comes from `lopdf`'s `extract_text`
//! (font-aware, so the one to trust for CJK / real-world docs). This module
//! supplies the *geometry*: it tracks the text matrix's translation and treats
//! each text-show as a cell at an (x, y) anchor, then buckets the cells into
//! rows.
//!
//! Cell **text** decoding is pluggable:
//! * [`rows_from_ops`] decodes with the bundled ASCII fallback
//!   ([`ascii_text`]) — cheap and deterministic for host tests / when no font
//!   context is available.
//! * [`rows_from_ops_decoded`] lets the caller supply a per-font decoder. The
//!   extractor uses this to honour each `Tf` font's encoding (including
//!   `ToUnicode` cmaps) via `lopdf`, so real (incl. CJK) cell text survives.
//!
//! # Honest caveats
//!
//! * `cm` (concatenate-matrix) transforms and exact glyph widths are **not**
//!   modelled, so columns are estimated from text-origin x positions. Perfectly
//!   reliable only for producers that place each cell at its own origin
//!   (reportlab/weasyprint/iText-style tables) — the common case for generated
//!   PDFs.
//! * Scanned/image PDFs have no text at all and need OCR.

use lopdf::content::Operation;
use lopdf::Object;

/// A single cell / span of text placed on the page.
#[derive(Clone, Debug, PartialEq)]
pub struct Cell {
    /// Approximate text-origin x in points (bottom-left user space).
    pub x: f32,
    /// Approximate baseline y in points (bottom-left user space; grows upward).
    pub y: f32,
    /// Cell text (decoded per the chosen decoder; see module docs).
    pub text: String,
}

/// One physical line: cells sharing a baseline, sorted left → right.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// Representative baseline (first cell's y).
    pub baseline_y: f32,
    pub cells: Vec<Cell>,
}

/// Approximate leading factor used when the content relies on `T*`/`'` with no
/// explicit `TL` (real PDFs usually set it, so this is only a fallback).
const DEFAULT_LEADING_FACTOR: f32 = 1.2;
/// Tolerance (points) for deciding two origins share a baseline.
const Y_TOLERANCE: f32 = 4.0;

/// Turn a decoded page's content operations into top-to-bottom reading rows,
/// decoding cell bytes with the bundled ASCII fallback ([`ascii_text`]).
pub fn rows_from_ops(ops: &[Operation]) -> Vec<Row> {
    let mut decode = |_: Option<&[u8]>, bytes: &[u8]| ascii_text(bytes);
    rows_from_ops_decoded(ops, &mut decode)
}

/// Like [`rows_from_ops`], but cell bytes are decoded by the supplied decoder,
/// which receives the *current font resource name* (the `Tf` operand, e.g.
/// `b"F1"`) alongside the raw bytes, so a caller can decode per-font.
pub fn rows_from_ops_decoded<F>(ops: &[Operation], decode: &mut F) -> Vec<Row>
where
    F: FnMut(Option<&[u8]>, &[u8]) -> String,
{
    let mut cells = Vec::new();
    let mut x: f32 = 0.0;
    let mut y: f32 = 0.0;
    let mut line_x: f32 = 0.0;
    let mut font_size: f32 = 12.0;
    let mut leading: Option<f32> = None;
    // Current font resource name selected by the last `Tf`.
    let mut cur_font: Option<Vec<u8>> = None;

    for op in ops {
        match op.operator.as_str() {
            "Tf" => {
                if let Some(name) = op.operands.first().and_then(as_name) {
                    cur_font = Some(name.to_vec());
                }
                if let Some(size) = op.operands.get(1).and_then(as_f32) {
                    font_size = size;
                }
            }
            "TL" => {
                leading = op.operands.first().and_then(as_f32);
            }
            "Td" | "TD" => {
                let tx = op.operands.first().and_then(as_f32).unwrap_or(0.0);
                let ty = op.operands.get(1).and_then(as_f32).unwrap_or(0.0);
                x += tx;
                y += ty;
                line_x = x;
            }
            "Tm" => {
                let e = op.operands.get(4).and_then(as_f32).unwrap_or(x);
                let f = op.operands.get(5).and_then(as_f32).unwrap_or(y);
                x = e;
                y = f;
                line_x = e;
            }
            "T*" => {
                let l = leading.unwrap_or(font_size * DEFAULT_LEADING_FACTOR);
                y -= l;
                x = line_x;
            }
            "Tj" => {
                if let Some(text) = show_string(op, cur_font.as_deref(), decode) {
                    push_cell(&mut cells, x, y, &text, font_size, &mut x);
                }
            }
            "TJ" => {
                if let Some(text) = show_array(op, cur_font.as_deref(), decode) {
                    push_cell(&mut cells, x, y, &text, font_size, &mut x);
                }
            }
            "'" => {
                let l = leading.unwrap_or(font_size * DEFAULT_LEADING_FACTOR);
                y -= l;
                x = line_x;
                if let Some(text) = show_string(op, cur_font.as_deref(), decode) {
                    push_cell(&mut cells, x, y, &text, font_size, &mut x);
                }
            }
            _ => {}
        }
    }

    cells.sort_by(|a, b| b.y.total_cmp(&a.y).then_with(|| a.x.total_cmp(&b.x)));
    let mut rows: Vec<Row> = Vec::new();
    for cell in cells {
        match rows.last_mut() {
            Some(last) if (last.baseline_y - cell.y).abs() <= Y_TOLERANCE => {
                last.cells.push(cell);
            }
            _ => {
                let baseline_y = cell.y;
                rows.push(Row {
                    baseline_y,
                    cells: vec![cell],
                });
            }
        }
    }
    for row in rows.iter_mut() {
        row.cells.sort_by(|a, b| a.x.total_cmp(&b.x));
    }
    rows
}

/// Interpret an operand as a number (`Integer` or `Real`).
fn as_f32(obj: &Object) -> Option<f32> {
    match obj {
        Object::Integer(i) => Some(*i as f32),
        Object::Real(r) => Some(*r),
        _ => None,
    }
}

/// Interpret an operand as a PDF name (`/F1` → `b"F1"`).
fn as_name(obj: &Object) -> Option<&[u8]> {
    match obj {
        Object::Name(name) => Some(name.as_slice()),
        _ => None,
    }
}

/// Decode a single string show (`Tj` / `'`) with the current font's decoder.
fn show_string<F>(op: &Operation, font: Option<&[u8]>, decode: &mut F) -> Option<String>
where
    F: FnMut(Option<&[u8]>, &[u8]) -> String,
{
    let bytes = op.operands.first()?.as_str().ok()?;
    let text = decode(font, bytes);
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Decode a `TJ` array show: strings plus inter-glyph kerning numbers. Per
/// lopdf's own convention a large negative number is treated as a space.
fn show_array<F>(op: &Operation, font: Option<&[u8]>, decode: &mut F) -> Option<String>
where
    F: FnMut(Option<&[u8]>, &[u8]) -> String,
{
    let arr = op.operands.first()?.as_array().ok()?;
    let mut out = String::new();
    for item in arr {
        match item {
            Object::String(bytes, _) => out.push_str(&decode(font, bytes)),
            Object::Integer(i) if *i < -100 => out.push(' '),
            Object::Real(r) if *r < -100.0 => out.push(' '),
            _ => {}
        }
    }
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Append a placed cell and advance the current x by an *estimated* glyph run
/// width so a following show-op on the same baseline is ordered correctly.
fn push_cell(cells: &mut Vec<Cell>, x: f32, y: f32, text: &str, font_size: f32, cur_x: &mut f32) {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return;
    }
    // ~0.5 em average advance per glyph (widths are not available).
    *cur_x += font_size * 0.5 * trimmed.chars().count() as f32;
    cells.push(Cell {
        x,
        y,
        text: trimmed,
    });
}

/// ASCII fallback decoder: printable ASCII kept, other whitespace → space,
/// everything else (CJK UTF-8 bytes, unmapped glyph codes) → U+FFFD. Used when
/// no font context is available so the geometry still works.
pub fn ascii_text(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len());
    for &b in bytes {
        if (0x20..=0x7e).contains(&b) {
            s.push(char::from(b));
        } else if b.is_ascii_whitespace() {
            s.push(' ');
        } else {
            s.push('\u{fffd}');
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::Operation;
    use lopdf::Object;

    fn num(n: i64) -> Object {
        Object::Integer(n)
    }
    fn str_op(s: &str) -> Object {
        Object::string_literal(s)
    }
    fn bytes_op(b: &[u8]) -> Object {
        Object::String(b.to_vec(), lopdf::StringFormat::Literal)
    }
    fn op(operator: &str, operands: Vec<Object>) -> Operation {
        Operation::new(operator, operands)
    }

    #[test]
    fn orders_two_rows_top_to_bottom() {
        let ops = vec![
            op("BT", vec![]),
            op("Tf", vec![Object::Name(b"F1".to_vec()), num(12)]),
            op(
                "Tm",
                vec![num(1), num(0), num(0), num(1), num(50), num(700)],
            ),
            op("Tj", vec![str_op("AAA")]),
            op(
                "Tm",
                vec![num(1), num(0), num(0), num(1), num(300), num(700)],
            ),
            op("Tj", vec![str_op("BBB")]),
            op(
                "Tm",
                vec![num(1), num(0), num(0), num(1), num(50), num(680)],
            ),
            op("Tj", vec![str_op("CCC")]),
            op("ET", vec![]),
        ];
        let rows = rows_from_ops(&ops);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].baseline_y, 700.0);
        assert_eq!(rows[0].cells.len(), 2);
        assert_eq!(rows[0].cells[0].text, "AAA");
        assert_eq!(rows[0].cells[1].text, "BBB");
        assert_eq!(rows[1].cells[0].text, "CCC");
    }

    #[test]
    fn relative_td_builds_a_line() {
        let ops = vec![
            op("BT", vec![]),
            op("Tf", vec![Object::Name(b"F1".to_vec()), num(12)]),
            op("Td", vec![num(72), num(700)]),
            op("Tj", vec![str_op("left")]),
            op("Td", vec![num(120), num(0)]),
            op("Tj", vec![str_op("right")]),
            op("ET", vec![]),
        ];
        let rows = rows_from_ops(&ops);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].cells.len(), 2);
        assert_eq!(rows[0].cells[0].text, "left");
        assert_eq!(rows[0].cells[1].text, "right");
    }

    #[test]
    fn tj_array_inserts_spaces_for_big_kerning() {
        let tj = op(
            "TJ",
            vec![Object::Array(vec![str_op("ab"), num(-200), str_op("cd")])],
        );
        let ops = vec![
            op("BT", vec![]),
            op(
                "Tm",
                vec![num(1), num(0), num(0), num(1), num(100), num(700)],
            ),
            tj,
            op("ET", vec![]),
        ];
        let rows = rows_from_ops(&ops);
        assert_eq!(rows[0].cells[0].text, "ab cd");
    }

    #[test]
    fn empty_show_ops_are_dropped() {
        let ops = vec![
            op("BT", vec![]),
            op(
                "Tm",
                vec![num(1), num(0), num(0), num(1), num(100), num(700)],
            ),
            op("Tj", vec![str_op("   ")]),
            op("ET", vec![]),
        ];
        let rows = rows_from_ops(&ops);
        assert!(rows.is_empty());
    }

    #[test]
    fn ascii_fallback_maps_non_ascii_bytes_to_replacement_char() {
        let ops = vec![
            op("BT", vec![]),
            op(
                "Tm",
                vec![num(1), num(0), num(0), num(1), num(100), num(700)],
            ),
            op("Tj", vec![bytes_op("你好".as_bytes())]),
            op("ET", vec![]),
        ];
        let rows = rows_from_ops(&ops); // default ASCII decoder
        assert_eq!(rows[0].cells[0].text.chars().count(), "你好".len());
        assert!(rows[0].cells[0].text.chars().all(|c| c == '\u{fffd}'));
    }

    #[test]
    fn decoded_rows_carry_real_unicode_when_decoder_supplies_it() {
        // A font-aware decoder decodes UTF-8 CJK bytes to real characters.
        let ops = vec![
            op("BT", vec![]),
            op("Tf", vec![Object::Name(b"F1".to_vec()), num(12)]),
            op(
                "Tm",
                vec![num(1), num(0), num(0), num(1), num(72), num(700)],
            ),
            op("Tj", vec![bytes_op("你好".as_bytes())]),
            op(
                "Tm",
                vec![num(1), num(0), num(0), num(1), num(200), num(680)],
            ),
            op("Tj", vec![bytes_op("世界".as_bytes())]),
            op("ET", vec![]),
        ];
        let mut decode =
            |_: Option<&[u8]>, bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
        let rows = rows_from_ops_decoded(&ops, &mut decode);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].cells[0].text, "你好");
        assert_eq!(rows[1].cells[0].text, "世界");
        // And it honours which font the show was under.
    }

    #[test]
    fn decoder_receives_the_current_font_name() {
        let ops = vec![
            op("BT", vec![]),
            op("Tf", vec![Object::Name(b"F2".to_vec()), num(12)]),
            op(
                "Tm",
                vec![num(1), num(0), num(0), num(1), num(72), num(700)],
            ),
            op("Tj", vec![str_op("x")]),
            op("ET", vec![]),
        ];
        let mut seen: Vec<Option<Vec<u8>>> = Vec::new();
        {
            let mut decode = |font: Option<&[u8]>, b: &[u8]| {
                seen.push(font.map(|f| f.to_vec()));
                ascii_text(b)
            };
            let _ = rows_from_ops_decoded(&ops, &mut decode);
        }
        assert_eq!(seen, vec![Some(b"F2".to_vec())]);
    }

    #[test]
    fn pathological_operators_do_not_panic_and_are_deterministic() {
        // Unknown ops, missing operands, huge numbers, empty arrays and wrong
        // operand types must never panic and must produce identical results.
        let ops = vec![
            op("Bogus", vec![num(1)]),
            op("Tf", vec![Object::Name(b"F1".to_vec())]), // missing size
            op("Td", vec![num(i64::MAX)]),                // single huge operand
            op("Tm", vec![]),                             // no operands
            op("TJ", vec![str_op("not-an-array")]),       // wrong operand type
            op("Tj", vec![num(1)]),                       // Tj with a number, not a string
            op("ET", vec![]),
        ];
        let a = rows_from_ops(&ops);
        let b = rows_from_ops(&ops);
        assert_eq!(a, b, "pure path must be deterministic");

        let mut decode = |_: Option<&[u8]>, bytes: &[u8]| ascii_text(bytes);
        let c = rows_from_ops_decoded(&ops, &mut decode);
        assert_eq!(a, c, "decoded path must agree with the pure path here");
    }
}

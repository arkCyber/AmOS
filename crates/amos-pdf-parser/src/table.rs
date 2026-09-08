//! Heuristic table detector over [`layout::Row`]s.
//!
//! Looks for **maximal runs** of consecutive rows whose cells line up on the
//! same column x-positions. When a run has a header row plus at least one body
//! row and two or more columns it is emitted as a [`crate::model::Table`] (the
//! first row is marked as its header).
//!
//! This only ever fires on *geometrically aligned* cells, so body paragraphs
//! (single wide cell per row) never become tables, and a wrapped multi-line
//! paragraph inside one table cell will simply stop the run where alignment
//! breaks — honest, no fabricated cells.

use crate::layout::{Cell, Row};
use crate::model::Table;

/// Allowed drift (points) of a cell origin from the run's column anchor.
const COL_TOLERANCE: f32 = 6.0;
/// A table must have a header + at least one body row.
const MIN_ROWS: usize = 2;
/// A cell narrower than this (points) is not a useful table column by itself.
const MIN_COL_SPACING: f32 = 10.0;

/// Detect tables across a page's rows.
pub fn detect_tables(page_number: usize, rows: &[Row]) -> Vec<Table> {
    let mut tables = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        // A potential table must start on a row that already has ≥ 2 real
        // columns wide enough apart to matter.
        if rows[i].cells.len() < 2 || !wide_spacing(&rows[i].cells) {
            i += 1;
            continue;
        }
        let anchors: Vec<f32> = rows[i].cells.iter().map(|c| c.x).collect();
        let ncols = anchors.len();

        // Extend the run while each later row aligns to the same columns.
        let mut j = i + 1;
        while j < rows.len() && row_fits(&anchors, ncols, &rows[j]) {
            j += 1;
        }

        let total_rows = j - i;
        if total_rows >= MIN_ROWS {
            let mut table_rows: Vec<Vec<String>> = Vec::with_capacity(total_rows);
            for r in rows.iter().take(j).skip(i) {
                let mut cells = vec![String::new(); ncols];
                for cell in &r.cells {
                    if let Some(idx) = nearest_column(&anchors, cell.x) {
                        cells[idx] = cell.text.clone();
                    }
                }
                table_rows.push(cells);
            }
            tables.push(Table {
                page_number,
                header: true,
                rows: table_rows,
            });
            i = j;
        } else {
            i += 1;
        }
    }
    tables
}

/// Whether the given row lines up with the column anchors (same count, each
/// cell origin within tolerance of its anchor, in left-to-right order).
fn row_fits(anchors: &[f32], ncols: usize, row: &Row) -> bool {
    if row.cells.len() != ncols {
        return false;
    }
    for (k, cell) in row.cells.iter().enumerate() {
        let anchor = anchors[k];
        if (cell.x - anchor).abs() > COL_TOLERANCE {
            return false;
        }
        // Two cells must not land in the same column.
        if k > 0 && (cell.x - anchors[k - 1]).abs() < COL_TOLERANCE {
            return false;
        }
    }
    true
}

/// Index of the column anchor nearest to `x`, or `None` if it is far from all.
fn nearest_column(anchors: &[f32], x: f32) -> Option<usize> {
    let mut best: Option<(usize, f32)> = None;
    for (idx, &a) in anchors.iter().enumerate() {
        let d = (a - x).abs();
        if best.map_or(true, |(_, bd)| d < bd) {
            best = Some((idx, d));
        }
    }
    let (idx, d) = best?;
    if d <= COL_TOLERANCE {
        Some(idx)
    } else {
        None
    }
}

/// A row only starts a table when its two leftmost columns are meaningfully
/// separated (avoids splitting ordinary text with tiny intra-word gaps).
fn wide_spacing(cells: &[Cell]) -> bool {
    if cells.len() < 2 {
        return false;
    }
    let mut xs: Vec<f32> = cells.iter().map(|c| c.x).collect();
    xs.sort_by(|a, b| a.total_cmp(b));
    // Max gap between consecutive cell origins.
    xs.windows(2).map(|w| w[1] - w[0]).fold(0.0f32, f32::max) >= MIN_COL_SPACING
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(x: f32, y: f32, text: &str) -> Cell {
        Cell {
            x,
            y,
            text: text.to_string(),
        }
    }
    fn row(y: f32, cells: Vec<Cell>) -> Row {
        Row {
            baseline_y: y,
            cells,
        }
    }

    fn table_ops() -> Vec<Row> {
        vec![
            row(
                700.0,
                vec![cell(50.0, 700.0, "Name"), cell(250.0, 700.0, "Score")],
            ),
            row(
                680.0,
                vec![cell(50.0, 680.0, "alice"), cell(250.0, 680.0, "95")],
            ),
            row(
                660.0,
                vec![cell(50.0, 660.0, "bob"), cell(250.0, 660.0, "88")],
            ),
        ]
    }

    #[test]
    fn detects_a_clean_table() {
        let tables = detect_tables(1, &table_ops());
        assert_eq!(tables.len(), 1);
        let t = &tables[0];
        assert!(t.header);
        assert_eq!(t.rows.len(), 3);
        assert_eq!(t.rows[0], vec!["Name".to_string(), "Score".to_string()]);
        assert_eq!(t.rows[2], vec!["bob".to_string(), "88".to_string()]);
    }

    #[test]
    fn prose_is_not_a_table() {
        let rows = vec![
            row(
                700.0,
                vec![cell(50.0, 700.0, "This is just one long sentence")],
            ),
            row(
                680.0,
                vec![cell(50.0, 680.0, "continuing on the next line")],
            ),
        ];
        let tables = detect_tables(1, &rows);
        assert!(tables.is_empty());
    }

    #[test]
    fn single_body_row_under_minimum_is_rejected() {
        // header + only one candidate body row that fails alignment
        let rows = vec![
            row(700.0, vec![cell(50.0, 700.0, "A"), cell(250.0, 700.0, "B")]),
            row(680.0, vec![cell(52.0, 680.0, "x"), cell(900.0, 680.0, "y")]), // col2 misaligned
        ];
        let tables = detect_tables(1, &rows);
        assert!(tables.is_empty());
    }

    #[test]
    fn detection_is_deterministic() {
        let rows = table_ops();
        let a = detect_tables(1, &rows);
        let b = detect_tables(1, &rows);
        assert_eq!(a, b, "table detection must be order-stable and repeatable");
    }
}

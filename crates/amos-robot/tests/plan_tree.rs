//! The plan's module tree versus the files on disk.
//!
//! `AEROSPACE_PLAN.md` opens with a rendered `crates/amos-robot/src/` tree, and that tree is
//! the first thing an auditor reads: it is the map of what this crate *is*. Nothing read it.
//! The tree named `driver/traits.rs` — a file that has never existed — and described several
//! modules as algorithms they do not implement (`pose-graph relocalisation`, a `fixed 4-D
//! state`; it also named JCBB, which has since been implemented — see `docs/robot-autonomy.md`
//! §71). A doc that names a module the crate does not have is the file-system form of
//! F-DEV-031: a record that disagrees with reality, and nothing fails.
//!
//! This test is the smallest thing that closes the *mechanical* half of that gap: **every
//! `.rs` filename in the plan's module tree must exist under `src/`**. It does not (and
//! cannot) check whether the prose next to a filename describes that file correctly — that
//! is what the audit re-read is for, and the plan's wording is now pinned by hand.
//!
//! Scope is **the first fenced block**, the tree itself, not the whole document: prose is
//! allowed to name a file on purpose to say it is gone ("an earlier revision listed a
//! `traits.rs` that never existed"), and a whole-document scan would flag exactly the
//! sentence that records the fix.
//!
//! Deliberately out of scope: the *placement* of a name (`can.rs` under `driver/`, not
//! `slam/`). Only existence is asserted; a name that exists anywhere under `src/` passes.
//!
//! # The direction this test was missing
//!
//! The assertion above asks *"does every name in the map exist on disk?"* — it never asks
//! *"is every file on disk named in the map?"*. Those are not the same question, and only
//! the second one catches an **omission**: a module the crate *has* and the map *does not*
//! name. The map is billed as "the map of what this crate *is*", so a module missing from
//! it is the same defect the header describes — "a record that disagrees with reality, and
//! nothing fails" — just in the direction the original check could not see.
//!
//! It was not hypothetical. `src/watchdog.rs` (the **external** watchdog, REQ-A701 /
//! FMEA `F-SH-161` — a component `safety.rs`'s own docs point at as a separate module)
//! and `src/lib.rs` were both absent from the tree, and the one-directional check stayed
//! green: deleting `watchdog.rs` from the tree left the suite byte-unchanged because the
//! *file* was still there. [`every_module_in_src_is_named_by_the_plan_tree`] pins the
//! other half (REQ-A1027 / FMEA `F-SH-345`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Every `…rs` token in `src`, taken as the maximal run of `[A-Za-z0-9_/]` that ends in
/// `.rs`. A path-shaped token (`vision/five_point.rs`) keeps its slashes; a bare one
/// (`ekf.rs`) does not. Written by hand rather than with a regex so the test adds no
/// dependency.
fn rs_tokens(src: &str) -> Vec<String> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 <= chars.len() {
        let is_suffix = chars[i] == '.' && chars[i + 1] == 'r' && chars[i + 2] == 's';
        if !is_suffix {
            i += 1;
            continue;
        }
        let end = i + 3;
        let mut start = i;
        while start > 0 {
            let c = chars[start - 1];
            if c.is_ascii_alphanumeric() || c == '_' || c == '/' {
                start -= 1;
            } else {
                break;
            }
        }
        out.push(chars[start..end].iter().collect());
        i = end;
    }
    out
}

/// The text of the **first** ```` ``` ````-fenced block — the plan's rendered module tree,
/// which is the first fence in the file. Returns `None` if there is no closing fence.
fn first_fence(src: &str) -> Option<&str> {
    let open = src.find("```")?;
    let rest = &src[open + 3..];
    // Skip the rest of the opening line (an info string, if any).
    let after_newline = rest.find('\n')? + 1;
    let body = &rest[after_newline..];
    let close = body.find("```")?;
    Some(&body[..close])
}

/// Does a file named `name` exist anywhere under `dir`? Used for the bare tokens.
fn name_exists_under(dir: &Path, name: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if name_exists_under(&path, name) {
                return true;
            }
        } else if path.file_name().is_some_and(|n| n == name) {
            return true;
        }
    }
    false
}

fn resolve(src_dir: &Path, token: &str) -> bool {
    if token.contains('/') {
        src_dir.join(token).is_file()
    } else {
        name_exists_under(src_dir, token)
    }
}

#[test]
fn every_rust_file_the_plan_names_exists() {
    let plan = include_str!("../AEROSPACE_PLAN.md");
    let src_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");

    let tree = first_fence(plan).expect("AEROSPACE_PLAN.md must carry the tree in a fenced block");
    let tokens = rs_tokens(tree);
    // A parse regression must fail loudly rather than pass vacuously. The plan's tree lists
    // well over a dozen files; the floor is a sanity check on the extractor, not a spec.
    assert!(
        tokens.len() >= 15,
        "the extractor found only {} `.rs` token(s) — the parse is broken, not the plan: {tokens:?}",
        tokens.len()
    );

    let missing: Vec<&String> = tokens.iter().filter(|t| !resolve(&src_dir, t)).collect();
    assert!(
        missing.is_empty(),
        "AEROSPACE_PLAN.md names Rust files that do not exist under src/: {missing:?}\n\
         A plan tree that names a module the crate does not have is a record that disagrees \
         with reality — fix the tree, or add the file it promises."
    );
}

/// Every `.rs` file under `dir`, recursively, as its bare filename.
fn rs_files_under(dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rs_files_under(&path, out);
        } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.ends_with(".rs") {
                out.push(name.to_string());
            }
        }
    }
}

/// The **other** half: every module file the crate ships is named by the plan's tree.
///
/// The sibling test proves the tree names no file that does not exist; this one proves no
/// file exists that the tree does not name. Without it a whole module can sit outside the
/// map that is supposed to be the map — measured: `watchdog.rs` and `lib.rs` did, and
/// removing either line from the tree kept the suite green.
///
/// The exemption list is deliberately **empty**: a module that belongs on disk but not on
/// the crate's own map is not a thing this crate has an example of, and inventing one to
/// quiet this test would recreate the defect. If a real exception ever appears, it must be
/// named here with its reason — that is the point.
#[test]
fn every_module_in_src_is_named_by_the_plan_tree() {
    const EXEMPT: &[&str] = &[];

    let plan = include_str!("../AEROSPACE_PLAN.md");
    let src_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");

    let tree = first_fence(plan).expect("AEROSPACE_PLAN.md must carry the tree in a fenced block");
    // Compare by **basename**: the tree may write `driver/can.rs` or bare `can.rs`, and the
    // question here is a set question, not a placement one (placement is out of scope above).
    let tokens = rs_tokens(tree);
    let named: HashSet<&str> = tokens
        .iter()
        .map(|t| t.rsplit('/').next().unwrap_or(t.as_str()))
        .collect();

    let mut on_disk = Vec::new();
    rs_files_under(&src_dir, &mut on_disk);
    // A walk regression must fail loudly rather than pass vacuously.
    assert!(
        on_disk.len() >= 15,
        "the walk found only {} `.rs` file(s) under src/ — the walk is broken, not the plan: {on_disk:?}",
        on_disk.len()
    );

    let unnamed: Vec<&String> = on_disk
        .iter()
        .filter(|n| !EXEMPT.contains(&n.as_str()) && !named.contains(n.as_str()))
        .collect();
    assert!(
        unnamed.is_empty(),
        "src/ holds Rust files the plan's tree does not name: {unnamed:?}\n\
         The tree is presented as the crate's own map; a module it omits is invisible to \
         every auditor who reads the map instead of the directory — name it, or record it \
         in this test's EXEMPT list with a reason."
    );
}

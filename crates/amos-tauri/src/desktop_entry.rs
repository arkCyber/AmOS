//! `desktop_entry` — the freedesktop `.desktop` entry format as a **pure parser**.
//!
//! Two desktop surfaces read `.desktop` files: the Wine prefix scan
//! (`crates/amos-tauri/src/wine.rs`) and the XDG application list
//! (`crates/amos-tauri/src/linux_apps.rs`). Each used to carry its own parser —
//! two copies of the same rules with two different bugs (both recursed without a
//! bound, and the XDG copy's "deduplicate by id" step was a no-op). This module is
//! the single source: **parsing is pure** (`&str` in, values out, no I/O), so every
//! rule here is testable offline, and the I/O is two functions with documented
//! refusals (a byte bound per file, a depth + file bound per directory walk).
//!
//! Grammar honoured (`[Desktop Entry]` group only, per the spec):
//!   * `Key=value` lines inside the first group; the group ends at the next `[`.
//!   * `#` comments and blank lines are ignored.
//!   * `Name` / `Exec` are required for our purposes (an entry without them is not
//!     launchable, so it is refused rather than reported as a nameless app).
//!   * **Localized keys are ignored** (`Name[zh_CN]`): honouring one needs a locale
//!     argument this host does not have, and picking a translation at random would
//!     be a guess. The plain key is always present in a well-formed entry.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

/// Largest `.desktop` file this host will parse (bytes). Entries are a few hundred
/// bytes; past this bound a file is not an entry we can read faithfully, and
/// refusing beats parsing half of it and reporting a truncated name/command as
/// fact (the same rule `note_export` applies to note text).
pub const MAX_ENTRY_BYTES: u64 = 64 * 1024;

/// Most `.desktop` files one directory walk will collect. A directory with more is
/// not an application menu; the count is bounded so a hostile directory cannot make
/// the host allocate without limit (Power of 10 #2).
pub const MAX_SCAN_FILES: usize = 512;

/// Deepest directory level the walk descends. Start-menu trees are shallow; the
/// bound is what makes the explicit work list below a *bounded loop*.
pub const MAX_SCAN_DEPTH: usize = 4;

/// The fields this host consumes out of the `[Desktop Entry]` group.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DesktopEntry {
    /// `Name=` (the plain, non-localized key).
    pub name: String,
    /// Raw `Exec=` value — arguments and `%` field codes included. Use [`argv`] to
    /// turn it into a program + arguments.
    pub exec: String,
    /// `Icon=`, when present and non-empty.
    pub icon: Option<String>,
    /// First top-level `Categories=` token (`A;B;` → `A`).
    pub category: Option<String>,
    /// `Type=` as written (`Application`, `Link`, …).
    pub entry_type: Option<String>,
    /// `NoDisplay=true` — installed but deliberately not shown in a menu.
    pub no_display: bool,
    /// `Hidden=true` — logically deleted / overridden by another entry.
    pub hidden: bool,
}

impl DesktopEntry {
    /// Is this entry something a launcher may offer?
    ///
    /// `NoDisplay`/`Hidden` entries and non-`Application` types (a `Link` is a URL
    /// shortcut, a `Directory` is a folder) are real files but not apps we can run.
    /// An entry with no `Type` at all defaults to `Application` per the spec.
    pub fn is_launchable_app(&self) -> bool {
        if self.no_display || self.hidden {
            return false;
        }
        match self.entry_type.as_deref() {
            None => true,
            Some(t) => t.eq_ignore_ascii_case("application"),
        }
    }
}

/// Parse the `[Desktop Entry]` group of a `.desktop` file.
///
/// `None` when there is no such group, or when it carries no usable `Name`/`Exec`.
pub fn parse(text: &str) -> Option<DesktopEntry> {
    let mut in_group = false;
    let mut seen_group = false;
    let mut entry = DesktopEntry::default();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            if in_group {
                break; // the `[Desktop Entry]` group ended
            }
            if line == "[Desktop Entry]" {
                in_group = true;
                seen_group = true;
            }
            continue;
        }
        if !in_group {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue; // not a key=value line (a stray token: ignore, never guess)
        };
        let key = key.trim();
        let value = value.trim();
        // Localized keys (`Name[zh_CN]`) are deliberately not read — see module doc.
        if key.contains('[') {
            continue;
        }
        match key {
            "Name" if entry.name.is_empty() => entry.name = value.to_string(),
            "Exec" if entry.exec.is_empty() => entry.exec = value.to_string(),
            "Icon" if entry.icon.is_none() => {
                entry.icon = Some(value.to_string()).filter(|s| !s.is_empty());
            }
            "Categories" if entry.category.is_none() => {
                entry.category = value
                    .split(';')
                    .next()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
            }
            "Type" if entry.entry_type.is_none() => {
                entry.entry_type = Some(value.to_string()).filter(|s| !s.is_empty());
            }
            "NoDisplay" => entry.no_display = value.eq_ignore_ascii_case("true"),
            "Hidden" => entry.hidden = value.eq_ignore_ascii_case("true"),
            _ => {}
        }
    }

    if !seen_group || entry.name.is_empty() || entry.exec.is_empty() {
        return None;
    }
    Some(entry)
}

/// One launchable program + its arguments, derived from an `Exec=` value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Argv {
    /// The program to run. May be a bare name (`firefox`) — resolved through the
    /// host's `PATH` exactly like a desktop environment does — or an absolute path.
    pub program: String,
    /// Arguments, with `%` field codes removed.
    pub args: Vec<String>,
}

/// Split an `Exec=` value into a program and arguments.
///
/// Quotes group tokens (`"…"` / `'…'`), `\` escapes the next character, and `%x`
/// field codes (`%u`, `%f`, `%U`, `%F`, `%i`, `%c`, `%k`, …) are **dropped**: the
/// host has no file/URL to substitute, and passing a literal `%u` through as an
/// argument would hand the app a junk parameter. `%%` is the spec's escape for a
/// literal `%` and is kept as such.
///
/// `None` when nothing usable is left (empty value, or only field codes): there is
/// no program to run.
pub fn argv(exec: &str) -> Option<Argv> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut chars = exec.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' | '\'' => {
                // Quoted mode until the matching quote. The quote itself also ends
                // a pending token, so `a"b c"d` is the single token `ab cd`.
                let quote = c;
                started = true;
                while let Some(q) = chars.next() {
                    if q == quote {
                        break;
                    }
                    if q == '\\' && matches!(chars.peek(), Some('\\')) {
                        chars.next();
                        current.push('\\');
                        continue;
                    }
                    current.push(q);
                }
            }
            '\\' => {
                started = true;
                // Only `\\` is an escape sequence (the spec defines no other
                // backslash escape in `Exec`). A lone backslash is **kept**: a Wine
                // entry's `C:\Program Files\…` must survive being read, and
                // swallowing the separator is how the first version of this parser
                // turned a real path into `C:Program FilesApp`.
                if matches!(chars.peek(), Some('\\')) {
                    chars.next();
                }
                current.push('\\');
            }
            '%' => {
                started = true;
                match chars.peek() {
                    Some('%') => {
                        chars.next();
                        current.push('%');
                    }
                    // A field code: consume the directive character and drop both.
                    Some(_) => {
                        chars.next();
                    }
                    None => {}
                }
            }
            c if c.is_whitespace() => {
                if started {
                    tokens.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                started = true;
                current.push(c);
            }
        }
    }
    if started {
        tokens.push(current);
    }

    let mut iter = tokens.into_iter().filter(|t| !t.is_empty());
    let program = iter.next()?;
    Some(Argv {
        program,
        args: iter.collect(),
    })
}

/// `env VAR=value … program args…` → the program and the `VAR=value` pairs.
///
/// Wine's own `.desktop` files are written this way
/// (`Exec=env WINEPREFIX="/home/me/.wine" wine start …`), and a Wine prefix is not
/// a GUI preference the shell may carry: it belongs to the entry, so it travels
/// with it. Returning the pairs separately (instead of letting each caller parse
/// them out of the token list) keeps the rule in one place.
///
/// `env`'s own options (`-i`, `-u NAME`, …) are **not** modelled: an entry using
/// them keeps its raw tokens, so the launch fails and is reported — never silently
/// half-applied.
pub fn env_prefix(argv: &Argv) -> (Vec<(String, String)>, Argv) {
    if argv.program != "env" {
        return (Vec::new(), argv.clone());
    }
    let mut vars = Vec::new();
    let mut program: Option<String> = None;
    let mut args: Vec<String> = Vec::new();
    for token in &argv.args {
        if program.is_none() {
            if let Some((k, v)) = token.split_once('=') {
                if !k.is_empty() && !k.starts_with('-') {
                    vars.push((k.to_string(), v.to_string()));
                    continue;
                }
            }
            program = Some(token.clone());
        } else {
            args.push(token.clone());
        }
    }
    let argv = match program {
        Some(program) => Argv { program, args },
        // No program was promoted (only assignments): return the input untouched
        // rather than inventing a program out of a `VAR=value` token.
        None => argv.clone(),
    };
    (vars, argv)
}

/// Read one `.desktop` file, bounded by [`MAX_ENTRY_BYTES`].
///
/// `Err` carries the reason so the caller can report it: a `.desktop` file the host
/// cannot read must never look like "an app with no name".
pub fn read_bounded(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }
    if meta.len() > MAX_ENTRY_BYTES {
        return Err(format!(
            "{} bytes exceeds the {MAX_ENTRY_BYTES} byte bound",
            meta.len()
        ));
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

/// The result of walking directories for `.desktop` files — findings **and** what
/// was left out, because a truncated list that looks complete is how a menu
/// silently loses an app.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DesktopFileScan {
    pub files: Vec<PathBuf>,
    /// Directories not descended into because [`MAX_SCAN_DEPTH`] was reached.
    pub skipped_depth: usize,
    /// Files not collected because [`MAX_SCAN_FILES`] was reached.
    pub skipped_cap: usize,
    /// Directories whose listing failed (permissions, races) — counted, not hidden.
    pub unreadable_dirs: usize,
}

/// Collect `*.desktop` files under `roots`.
///
/// An **explicit work list**, not recursion: NASA Power of 10 rule 1 forbids
/// recursion, and the earlier per-module copies of this walk were exactly the two
/// new recursion findings `scripts/rust-recursion-scan.mjs` reported. Depth and
/// file counts are bounded ([`MAX_SCAN_DEPTH`] / [`MAX_SCAN_FILES`]); the walk is
/// breadth-first so the cap spends its budget on the shallow, menu-like levels
/// instead of on one deep subtree.
pub fn scan_desktop_files(roots: &[PathBuf]) -> DesktopFileScan {
    let mut scan = DesktopFileScan::default();
    let mut queue: VecDeque<(PathBuf, usize)> = roots
        .iter()
        .filter(|r| r.is_dir())
        .map(|r| (r.clone(), 0))
        .collect();

    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            scan.unreadable_dirs += 1;
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth + 1 > MAX_SCAN_DEPTH {
                    scan.skipped_depth += 1;
                } else {
                    queue.push_back((path, depth + 1));
                }
                continue;
            }
            let is_entry = path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("desktop"));
            if !is_entry {
                continue;
            }
            if scan.files.len() >= MAX_SCAN_FILES {
                scan.skipped_cap += 1;
                continue;
            }
            scan.files.push(path);
        }
    }
    scan
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY: &str = "\
# a comment
[Desktop Entry]
Type=Application
Name=Files
Name[zh_CN]=文件
Exec=nautilus %U
Icon=system-file-manager
Categories=System;Utility;
";

    #[test]
    fn parses_the_plain_keys_and_ignores_localized_ones() {
        let e = parse(ENTRY).expect("a well-formed entry parses");
        assert_eq!(e.name, "Files", "the localized Name must not win");
        assert_eq!(e.exec, "nautilus %U");
        assert_eq!(e.icon.as_deref(), Some("system-file-manager"));
        assert_eq!(e.category.as_deref(), Some("System"), "first category only");
        assert_eq!(e.entry_type.as_deref(), Some("Application"));
        assert!(e.is_launchable_app());
    }

    #[test]
    fn refuses_entries_that_are_not_launchable() {
        assert!(
            parse("Name=x\nExec=y\n").is_none(),
            "no [Desktop Entry] group"
        );
        assert!(parse("[Desktop Entry]\nExec=y\n").is_none(), "no Name");
        assert!(parse("[Desktop Entry]\nName=x\n").is_none(), "no Exec");

        // A `Link` is a URL shortcut, `Directory` a folder: not apps we can run.
        let link = parse("[Desktop Entry]\nType=Link\nName=Site\nExec=x\n").expect("parses");
        assert!(!link.is_launchable_app());
        // Hidden / NoDisplay are real files that must not be offered.
        let hidden = parse("[Desktop Entry]\nName=Gone\nExec=x\nNoDisplay=true\n").expect("parses");
        assert!(!hidden.is_launchable_app());
        let deleted = parse("[Desktop Entry]\nName=Gone\nExec=x\nHidden=TRUE\n").expect("parses");
        assert!(!deleted.is_launchable_app());
        // …and only `true` (case-insensitively) means true.
        let shown = parse("[Desktop Entry]\nName=Here\nExec=x\nNoDisplay=false\n").expect("parses");
        assert!(shown.is_launchable_app());
    }

    #[test]
    fn stops_at_the_group_boundary() {
        // A later group's `Name=`/`Exec=` must never leak into the entry.
        let text =
            "[Desktop Entry]\nName=Real\nExec=real\n\n[Desktop Action new]\nName=Fake\nExec=fake\n";
        let e = parse(text).expect("parses");
        assert_eq!(e.name, "Real");
        assert_eq!(e.exec, "real");
    }

    #[test]
    fn argv_drops_field_codes_keeps_quoted_tokens_and_unescapes() {
        let a = argv("nautilus %U").expect("program");
        assert_eq!(a.program, "nautilus");
        assert_eq!(
            a.args,
            Vec::<String>::new(),
            "%U must not be passed through"
        );

        let b =
            argv("/usr/bin/foo --open \"My File.txt\" 'x y' %f --literal=100%%").expect("program");
        assert_eq!(b.program, "/usr/bin/foo");
        assert_eq!(
            b.args,
            vec!["--open", "My File.txt", "x y", "--literal=100%"],
            "quotes group, %% is a literal %, %f is dropped"
        );

        // A Windows path keeps its separators: `\\` is the only backslash escape
        // the spec defines, so a lone `\` is data, not an escape. (Quoted here,
        // because an unquoted path with spaces is three tokens by definition.)
        let win = argv("wine \"C:\\Program Files\\App\\app.exe\"").expect("program");
        assert_eq!(win.program, "wine");
        assert_eq!(win.args, vec!["C:\\Program Files\\App\\app.exe"]);
        let escaped = argv("wine C:\\\\App\\\\app.exe").expect("program");
        assert_eq!(
            escaped.args,
            vec!["C:\\App\\app.exe"],
            "`\\\\` really is one backslash"
        );

        assert!(argv("   ").is_none(), "nothing to run");
        assert!(argv("%U").is_none(), "only a field code is nothing to run");
    }

    #[test]
    fn env_prefix_splits_the_variables_wine_entries_carry() {
        let raw = argv(
            "env WINEPREFIX=\"/home/me/.wine\" WINEDEBUG=-all wine start /unix /home/me/a.exe",
        )
        .expect("program");
        let (vars, rest) = env_prefix(&raw);
        assert_eq!(
            vars,
            vec![
                ("WINEPREFIX".to_string(), "/home/me/.wine".to_string()),
                ("WINEDEBUG".to_string(), "-all".to_string())
            ],
            "the quoted prefix survives as one value"
        );
        assert_eq!(rest.program, "wine");
        assert_eq!(rest.args, vec!["start", "/unix", "/home/me/a.exe"]);

        // Not `env`: returned untouched (no variables invented).
        let plain = argv("firefox").expect("program");
        let (vars, rest) = env_prefix(&plain);
        assert!(vars.is_empty());
        assert_eq!(rest, plain);

        // Only assignments: no program to promote → unchanged, never invented.
        let only_vars = argv("env FOO=bar").expect("program");
        let (vars, rest) = env_prefix(&only_vars);
        assert_eq!(vars, vec![("FOO".to_string(), "bar".to_string())]);
        assert_eq!(rest.program, "env");
    }

    #[test]
    fn read_bounded_refuses_an_oversized_file() {
        let dir = std::env::temp_dir().join(format!("amos-de-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let big = dir.join("big.desktop");
        std::fs::write(&big, "x".repeat(MAX_ENTRY_BYTES as usize + 1)).expect("write");

        let err = read_bounded(&big).expect_err("oversized file refused");
        assert!(err.contains("exceeds"), "reason names the bound: {err}");
        assert!(read_bounded(&dir).is_err(), "a directory is not an entry");

        let ok = dir.join("ok.desktop");
        std::fs::write(&ok, ENTRY).expect("write");
        assert!(read_bounded(&ok)
            .expect("small file")
            .contains("Name=Files"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_walk_is_bounded_by_depth_and_reports_what_it_left_out() {
        let root =
            std::env::temp_dir().join(format!("amos-walk-{}-{}", std::process::id(), line!()));
        let deep = root.join("a/b/c/d/e/f");
        std::fs::create_dir_all(&deep).expect("temp tree");
        for level in ["a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e"] {
            std::fs::write(root.join(level).join("x.desktop"), ENTRY).expect("write");
        }
        std::fs::write(deep.join("too-deep.desktop"), ENTRY).expect("write");

        let scan = scan_desktop_files(std::slice::from_ref(&root));
        assert_eq!(scan.files.len(), 4, "four entries within depth 1..=4");
        assert_eq!(
            scan.skipped_depth, 1,
            "the depth-5 directory is reported, not hidden"
        );
        assert!(!scan.files.iter().any(|f| f.ends_with("too-deep.desktop")));

        // A missing root is not an error, it is simply nothing to scan.
        let empty = scan_desktop_files(&[root.join("nope")]);
        assert!(empty.files.is_empty() && empty.unreadable_dirs == 0);

        let _ = std::fs::remove_dir_all(&root);
    }
}

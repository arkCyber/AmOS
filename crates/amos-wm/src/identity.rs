//! `identity` — an app window's **identity**: which application it shows, and which
//! *instance* of that application it is (REQ-A473).
//!
//! ## The defect this module exists to remove
//!
//! Before this, `crates/amos-tauri/src/wm.rs` used **one string** (the Tauri window
//! label) for two different things: *the platform window* and *the application*. The
//! consequence was structural rather than cosmetic — one window per app, forever:
//!
//! * `WmState::open()` looks the label up in `by_label` and **focuses** it when it is
//!   there, so a second `wm_open("files")` can only ever mean "bring Files forward";
//! * `app_window_title()` is keyed by that same string, so any label that is not a bare
//!   app id falls through to the generic fallback;
//! * the shell's `#window=<label>` route treats the label as an app id, so an instance
//!   label would open an "unknown app" screen;
//! * and the product told the user so: the File menu item had to be renamed to
//!   **"New Files Window"** (`crates/amos-tauri/src/menu.rs`, REQ-A434) because a per-app
//!   "New Window" needs an identity *besides* the label ⇄ app mapping.
//!
//! Everything downstream of the conflation was therefore also impossible: ⌘` (cycle the
//! current app's windows), App Exposé (tile one app's windows), a per-app "New Window",
//! and per-app window lifecycle (G7). The fix is not a new convention sprinkled over the
//! host; it is one **named concept** with one implementation, here, where it is pure,
//! allocation-bounded and testable without a window:
//!
//! ```text
//! instance 1 : label = "<app>"        e.g. "files"
//! instance n : label = "<app>_<n>"    e.g. "files_2", "store:org.amos.demo_3"
//! ```
//!
//! ## Rules (each one exists to make exactly one spelling possible)
//!
//! * **The app id never contains the separator.** That is what makes the label
//!   unambiguous — the host refuses an app id with a `_` in it ([`validate_app_id`])
//!   instead of guessing which half is the app.
//! * **Ordinals are 1-based and instance 1 has no suffix.** `files_1` is *refused*
//!   ([`IdentityRefusal::OrdinalOutOfRange`]), not accepted as a twin spelling of
//!   `files`: two spellings for one window is how a ledger starts drifting.
//! * **Bounded** (Power of 10 rule 2): app ids are capped in **characters** (a CJK name
//!   is not 64 bytes) and a single app may not mint windows without end
//!   ([`MAX_WINDOWS_PER_APP`]); the refusal is named, so a caller can say *which* bound
//!   it hit.
//! * **Allocation is deterministic** ([`next_window_label`], REQ-A1760): the lowest free
//!   ordinal — **including 1**, so a closed first window is reused rather than lost — so a
//!   closed `_2` is reused rather than the numbers running away, and two identical trees
//!   get identical labels.
//! * **Cycling is deterministic** ([`cycle_target`]): the peers are ordered by ordinal
//!   (ties by spelling) and the step wraps — no reliance on a caller's iteration order.
//!
//! ## Honest boundaries
//!
//! * This module knows nothing about Tauri, the OS or the store: it maps **strings to
//!   strings**. Whether a window with that label exists is the host's question.
//! * The separator is **`_`, and that is a measurement, not a preference**. The first
//!   choice was `#` and it is *rejected by Tauri itself*: creating `files#2` fails with
//!   `Window labels must only include alphanumeric characters, -, /, : and _` (measured
//!   2026-09-19 by the host tests below — the defect appeared only when a window was really
//!   built, which is why those tests build one). Of the three remaining candidates, `-` is
//!   the most likely to occur inside a real third-party id (`store:org.amos.demo-v2` would
//!   then parse as *instance 2* of a different app instead of being refused), and `/`
//!   carries path semantics wherever a label travels; `_` is ambiguous with neither, and it
//!   is already the tree's own instance idiom (`legacy:waydroid_0`).
//! * Instance numbers are **not** stable identities across launches (a window closed and
//!   reopened may take a freed ordinal). Persisting them would be a *second* ledger, and
//!   the host deliberately reads the platform instead (see `WmState::reclamp_windows`'
//!   reasoning).

use std::fmt;

/// The one character that separates an app id from an instance ordinal — `_`, measured.
///
/// The first choice was `#` and Tauri itself rejects it in a window label
/// (`Window labels must only include alphanumeric characters, -, /, : and _`, measured
/// 2026-09-19); see the module docs for why `-` and `/` were the worse of the three
/// remaining candidates.
pub const INSTANCE_SEPARATOR: char = '_';

/// Longest app id, in **characters** (not bytes).
///
/// An app id is a key, so this is deliberately tighter than a display limit: it bounds
/// what the ledger, the window-state file name and every `wm_windows` broadcast carry.
pub const MAX_APP_ID_CHARS: usize = 64;

/// Most windows one application may have open at once.
///
/// A resource bound, not a taste: without it [`next_window_label`] could mint labels
/// forever. 16 is far above any plausible desktop use and small enough that the ledger
/// and the cycle ring stay trivial.
pub const MAX_WINDOWS_PER_APP: u32 = 16;

/// Why an app id or a window label was refused.
///
/// Every variant names the offending *value shape*, so a caller can put the reason on
/// screen instead of reporting a generic failure (the host's `String` errors carry the
/// `Display` of this type).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityRefusal {
    /// The app id was empty (or only whitespace).
    EmptyAppId,
    /// The app id contains a character that may not appear in one.
    ///
    /// Covers control characters **and** whitespace: an id is a key, and a key with a
    /// space in it is a bug that shows up much later (as a label that cannot be typed, a
    /// file name that needs quoting, or a fragment that needs escaping).
    AppIdChar { ch: char },
    /// The app id contains the instance separator.
    ///
    /// Refused rather than split, because splitting is exactly the guess this module
    /// exists to remove: it would make `a_b_2` ambiguous between app `a_b` instance 2 and
    /// app `a` instance `b_2`.
    AppIdHasSeparator,
    /// The app id is longer than [`MAX_APP_ID_CHARS`].
    AppIdTooLong { chars: usize, max: usize },
    /// The part after the separator is not a number.
    OrdinalNotNumeric { raw: String },
    /// The ordinal is outside `1..=MAX_WINDOWS_PER_APP`, or is the redundant `#1`.
    OrdinalOutOfRange { ordinal: u32, max: u32 },
    /// This application already has [`MAX_WINDOWS_PER_APP`] windows.
    TooManyWindows { max: u32 },
}

impl fmt::Display for IdentityRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IdentityRefusal::EmptyAppId => write!(f, "an app id may not be empty"),
            IdentityRefusal::AppIdChar { ch } => write!(
                f,
                "an app id may not contain {ch:?} (U+{:04X}): it is a key, and whitespace or a control character in a key is not addressable",
                *ch as u32
            ),
            IdentityRefusal::AppIdHasSeparator => write!(
                f,
                "an app id may not contain '{INSTANCE_SEPARATOR}': that character separates an app from its window instance"
            ),
            IdentityRefusal::AppIdTooLong { chars, max } => {
                write!(f, "an app id may be at most {max} characters, got {chars}")
            }
            IdentityRefusal::OrdinalNotNumeric { raw } => write!(
                f,
                "'{raw}' is not a window instance number: the part after '{INSTANCE_SEPARATOR}' must be a number"
            ),
            IdentityRefusal::OrdinalOutOfRange { ordinal, max } => write!(
                f,
                "window instance {ordinal} is out of range 1..={max}: instance 1 is spelled without a suffix ('{INSTANCE_SEPARATOR}1' is not a second spelling of it)"
            ),
            IdentityRefusal::TooManyWindows { max } => {
                write!(f, "one application may have at most {max} windows open")
            }
        }
    }
}

impl std::error::Error for IdentityRefusal {}

/// Which application a window shows, and which instance of it the window is.
///
/// `instance` is 1-based by construction: a [`WindowIdentity`] can only be produced by
/// the functions below, and they refuse anything outside `1..=MAX_WINDOWS_PER_APP`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowIdentity {
    /// The app id — exactly the spelling the shell's registry and store use.
    pub app: String,
    /// 1 for the app's first window, 2.. for the ones after it.
    pub instance: u32,
}

impl WindowIdentity {
    /// The canonical label for this identity (the only accepted spelling).
    ///
    /// Cannot fail: the identity was validated when it was built, so the canonical
    /// spelling is what [`label_for`] returns for values it already accepted.
    pub fn label(&self) -> String {
        if self.instance <= 1 {
            self.app.clone()
        } else {
            format!("{}{}{}", self.app, INSTANCE_SEPARATOR, self.instance)
        }
    }

    /// Is this the application's **first** window?
    pub fn is_first(&self) -> bool {
        self.instance <= 1
    }
}

impl fmt::Display for WindowIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.label())
    }
}

/// May `app` be used as an app id? Pure; the refusals are named and bounded.
///
/// The rule set is deliberately small and total (every string either passes or gets one
/// named refusal): non-empty, no whitespace or control characters, no separator, and at
/// most [`MAX_APP_ID_CHARS`] characters.
pub fn validate_app_id(app: &str) -> Result<(), IdentityRefusal> {
    if app.trim().is_empty() {
        return Err(IdentityRefusal::EmptyAppId);
    }
    let chars = app.chars().count();
    if chars > MAX_APP_ID_CHARS {
        return Err(IdentityRefusal::AppIdTooLong {
            chars,
            max: MAX_APP_ID_CHARS,
        });
    }
    for ch in app.chars() {
        if ch == INSTANCE_SEPARATOR {
            return Err(IdentityRefusal::AppIdHasSeparator);
        }
        if ch.is_control() || ch.is_whitespace() {
            return Err(IdentityRefusal::AppIdChar { ch });
        }
    }
    Ok(())
}

/// The canonical label for instance `instance` of `app`.
///
/// Refuses an invalid app id and an ordinal outside `1..=MAX_WINDOWS_PER_APP`.
pub fn label_for(app: &str, instance: u32) -> Result<String, IdentityRefusal> {
    validate_app_id(app)?;
    if instance == 0 || instance > MAX_WINDOWS_PER_APP {
        return Err(IdentityRefusal::OrdinalOutOfRange {
            ordinal: instance,
            max: MAX_WINDOWS_PER_APP,
        });
    }
    if instance == 1 {
        return Ok(app.to_string());
    }
    Ok(format!("{app}{INSTANCE_SEPARATOR}{instance}"))
}

/// Parse a label back into the identity it names.
///
/// Exactly one spelling maps to each identity (see the module docs): a bare app id is
/// instance 1, and a suffixed one must carry an ordinal in `2..=MAX_WINDOWS_PER_APP`.
/// Anything else is a named refusal, never a guess.
pub fn identity_of_label(label: &str) -> Result<WindowIdentity, IdentityRefusal> {
    match label.split_once(INSTANCE_SEPARATOR) {
        None => {
            validate_app_id(label)?;
            Ok(WindowIdentity {
                app: label.to_string(),
                instance: 1,
            })
        }
        Some((app, rest)) => {
            validate_app_id(app)?;
            let ordinal: u32 = rest
                .parse()
                .map_err(|_| IdentityRefusal::OrdinalNotNumeric {
                    raw: rest.to_string(),
                })?;
            // `!(2..=MAX).contains(..)` rather than two comparisons: one bound, read once
            // (clippy's `manual_range_contains`, and the range is the statement of the rule).
            if !(2..=MAX_WINDOWS_PER_APP).contains(&ordinal) {
                return Err(IdentityRefusal::OrdinalOutOfRange {
                    ordinal,
                    max: MAX_WINDOWS_PER_APP,
                });
            }
            Ok(WindowIdentity {
                app: app.to_string(),
                instance: ordinal,
            })
        }
    }
}

/// The label a **new** window of `app` should get, given the labels that already exist.
///
/// `existing` may contain anything (labels of other apps, unparseable strings): only the
/// ones that parse to `app` are counted, and unparseable entries are ignored rather than
/// propagated — this function allocates a name, it does not validate the ledger.
///
/// Deterministic by construction: the **lowest free ordinal** is chosen, so the answer
/// depends only on the *set* of labels and not on their order (the same tree always
/// produces the same label), and a closed `_2` is reused instead of the numbers running
/// away. Ordinal 1 is counted with the rest — with no window of `app` it *is* the free
/// slot (the bare app id, which is what ⌘N on a not-running app allocates), and an app
/// whose first window was closed takes that slot back rather than being refused one
/// window early. When every one of the [`MAX_WINDOWS_PER_APP`] slots is taken, the
/// refusal is [`IdentityRefusal::TooManyWindows`].
pub fn next_window_label(app: &str, existing: &[String]) -> Result<String, IdentityRefusal> {
    validate_app_id(app)?;
    let mut used = [false; MAX_WINDOWS_PER_APP as usize + 1];
    for label in existing {
        if let Ok(identity) = identity_of_label(label) {
            if identity.app == app {
                let slot = identity.instance as usize;
                if slot < used.len() {
                    used[slot] = true;
                }
            }
        }
    }
    // Ordinal 1 is a slot like any other: [`label_for`] spells it `app` itself, so with
    // no window of this app it is the answer (`!any` is not a special case — it is "slot
    // 1 is free"), and with the first window closed it is **reused** like a freed `_2`.
    // Bounded: at most MAX_WINDOWS_PER_APP iterations (Power of 10 rule 2).
    for ordinal in 1..=MAX_WINDOWS_PER_APP {
        if !used[ordinal as usize] {
            return label_for(app, ordinal);
        }
    }
    Err(IdentityRefusal::TooManyWindows {
        max: MAX_WINDOWS_PER_APP,
    })
}

/// Which of `peers` a cycle step should land on — the decision behind ⌘`.
///
/// `peers` are the labels of **one application's** windows (the caller owns that scope:
/// ⌘` cycles within the current app, while ⌘Tab is the shell's separate window switcher).
/// `current` is the focused window's label, or `None` when focus is somewhere else.
///
/// Deterministic and total: the peers are ordered by ordinal (ties broken by spelling, so
/// the order never depends on a caller's map iteration) and the step wraps. With an empty
/// ring there is nothing to cycle to (`None`); with a single window the answer is that
/// window — cycling inside a ring of one is a no-op rather than an error, and the
/// **caller** decides whether to report it.
pub fn cycle_target<'a>(
    current: Option<&str>,
    peers: &'a [String],
    forward: bool,
) -> Option<&'a str> {
    if peers.is_empty() {
        return None;
    }
    let mut ordered: Vec<&'a String> = peers.iter().collect();
    ordered.sort_by(|a, b| {
        let ia = identity_of_label(a).map(|i| i.instance).unwrap_or(1);
        let ib = identity_of_label(b).map(|i| i.instance).unwrap_or(1);
        ia.cmp(&ib).then_with(|| a.cmp(b))
    });
    let edge = |forward: bool| -> &'a String {
        if forward {
            ordered[0]
        } else {
            ordered[ordered.len() - 1]
        }
    };
    let Some(current) = current else {
        return Some(edge(forward));
    };
    let Some(pos) = ordered.iter().position(|p| p.as_str() == current) else {
        return Some(edge(forward));
    };
    let len = ordered.len();
    let next = if forward {
        (pos + 1) % len
    } else {
        (pos + len - 1) % len
    };
    Some(ordered[next])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // ---- app ids ----------------------------------------------------------------

    #[test]
    fn an_app_id_is_a_key_not_a_sentence() {
        assert!(validate_app_id("files").is_ok());
        assert!(validate_app_id("store:org.amos.pomodoro").is_ok());
        assert!(validate_app_id("设置").is_ok(), "a CJK id is an id");
        assert_eq!(validate_app_id(""), Err(IdentityRefusal::EmptyAppId));
        assert_eq!(validate_app_id("   "), Err(IdentityRefusal::EmptyAppId));
        assert_eq!(
            validate_app_id("my files"),
            Err(IdentityRefusal::AppIdChar { ch: ' ' })
        );
        assert_eq!(
            validate_app_id("line\nbreak"),
            Err(IdentityRefusal::AppIdChar { ch: '\n' })
        );
        assert_eq!(
            validate_app_id("files_2"),
            Err(IdentityRefusal::AppIdHasSeparator),
            "the separator belongs to the label scheme, never to an app id"
        );
    }

    #[test]
    fn an_app_id_is_bounded_in_characters_not_bytes() {
        let cjk = "汉".repeat(MAX_APP_ID_CHARS);
        assert!(
            validate_app_id(&cjk).is_ok(),
            "{MAX_APP_ID_CHARS} CJK chars is {MAX_APP_ID_CHARS} chars, not a 3x byte overrun"
        );
        let too_long = "汉".repeat(MAX_APP_ID_CHARS + 1);
        assert_eq!(
            validate_app_id(&too_long),
            Err(IdentityRefusal::AppIdTooLong {
                chars: MAX_APP_ID_CHARS + 1,
                max: MAX_APP_ID_CHARS,
            })
        );
    }

    // ---- the one-spelling rule --------------------------------------------------

    #[test]
    fn instance_one_is_spelled_without_a_suffix() {
        assert_eq!(label_for("files", 1).as_deref(), Ok("files"));
        assert_eq!(label_for("files", 2).as_deref(), Ok("files_2"));
        assert_eq!(label_for("files", 3).as_deref(), Ok("files_3"));
    }

    #[test]
    fn a_redundant_suffix_is_refused_not_accepted_as_a_twin() {
        // Two spellings for one window is how a ledger starts drifting (the host's
        // `by_label` would hold both, and they could disagree).
        assert_eq!(
            identity_of_label("files_1"),
            Err(IdentityRefusal::OrdinalOutOfRange {
                ordinal: 1,
                max: MAX_WINDOWS_PER_APP
            })
        );
        assert_eq!(
            identity_of_label("files_0"),
            Err(IdentityRefusal::OrdinalOutOfRange {
                ordinal: 0,
                max: MAX_WINDOWS_PER_APP
            })
        );
    }

    #[test]
    fn the_ordinal_is_bounded_and_must_be_a_number() {
        assert_eq!(
            identity_of_label("files_9999"),
            Err(IdentityRefusal::OrdinalOutOfRange {
                ordinal: 9999,
                max: MAX_WINDOWS_PER_APP
            })
        );
        assert_eq!(
            identity_of_label("files_two"),
            Err(IdentityRefusal::OrdinalNotNumeric { raw: "two".into() })
        );
        assert_eq!(
            identity_of_label("files_"),
            Err(IdentityRefusal::OrdinalNotNumeric { raw: String::new() })
        );
        assert_eq!(
            identity_of_label("files_2_3"),
            Err(IdentityRefusal::OrdinalNotNumeric { raw: "2_3".into() }),
            "the app half is split at the FIRST separator, so a second one is data and must not parse"
        );
    }

    #[test]
    fn a_label_round_trips_through_the_identity() {
        for (label, instance) in [("files", 1), ("files_2", 2), ("files_16", 16)] {
            let id = identity_of_label(label).expect("canonical labels parse");
            assert_eq!(id.app, "files");
            assert_eq!(id.instance, instance);
            assert_eq!(
                id.label(),
                label,
                "the canonical spelling is what was parsed"
            );
            assert_eq!(id.is_first(), instance == 1);
        }
        assert_eq!(
            identity_of_label("store:org.amos.demo_3")
                .expect("a store tile has an identity too")
                .app,
            "store:org.amos.demo"
        );
    }

    #[test]
    fn an_empty_or_whitespace_label_is_refused() {
        assert_eq!(identity_of_label(""), Err(IdentityRefusal::EmptyAppId));
        assert_eq!(
            identity_of_label(" files"),
            Err(IdentityRefusal::AppIdChar { ch: ' ' })
        );
    }

    #[test]
    fn a_refusal_explains_itself() {
        // The host puts this on screen, so it must name the offending value and the rule.
        let msg = IdentityRefusal::AppIdHasSeparator.to_string();
        assert!(msg.contains('_'), "the message names the character: {msg}");
        let msg = IdentityRefusal::OrdinalOutOfRange {
            ordinal: 1,
            max: MAX_WINDOWS_PER_APP,
        }
        .to_string();
        assert!(msg.contains("1..=16"), "the message names the bound: {msg}");
        assert!(
            IdentityRefusal::TooManyWindows {
                max: MAX_WINDOWS_PER_APP
            }
            .to_string()
            .contains("at most 16"),
            "the message names the cap"
        );
    }

    // ---- allocation ------------------------------------------------------------

    #[test]
    fn the_first_window_of_an_app_takes_the_bare_label() {
        assert_eq!(next_window_label("files", &[]).as_deref(), Ok("files"));
        assert_eq!(
            next_window_label("files", &labels(&["notes", "settings"])).as_deref(),
            Ok("files"),
            "other apps' labels do not consume this app's slots"
        );
    }

    #[test]
    fn allocation_takes_the_lowest_free_ordinal_and_reuses_gaps() {
        let existing = labels(&["files", "files_3"]);
        assert_eq!(
            next_window_label("files", &existing).as_deref(),
            Ok("files_2"),
            "2 is free, so 2 is taken — the numbers do not run away"
        );
        let existing = labels(&["files", "files_2", "files_3"]);
        assert_eq!(
            next_window_label("files", &existing).as_deref(),
            Ok("files_4")
        );
    }

    #[test]
    fn allocation_is_order_independent() {
        let a = labels(&["files", "files_3", "notes"]);
        let mut b = labels(&["notes", "files_3", "files"]);
        assert_eq!(
            next_window_label("files", &a).as_deref(),
            next_window_label("files", &b).as_deref(),
            "the same set of labels yields the same name, whatever the order"
        );
        b.reverse();
        assert_eq!(
            next_window_label("files", &a).as_deref(),
            next_window_label("files", &b).as_deref()
        );
    }

    #[test]
    fn unparseable_ledger_entries_are_ignored_not_propagated() {
        // A label of another scheme (`app-3`, a container surface) must not make
        // allocation fail — it allocates names, it does not validate the ledger.
        let existing = labels(&["app-3", "legacy:waydroid_0", "files_junk", "files"]);
        assert_eq!(
            next_window_label("files", &existing).as_deref(),
            Ok("files_2")
        );
    }

    #[test]
    fn an_app_at_its_cap_is_refused_by_name() {
        let mut existing = labels(&["files"]);
        for n in 2..=MAX_WINDOWS_PER_APP {
            existing.push(format!("files_{n}"));
        }
        assert_eq!(
            next_window_label("files", &existing),
            Err(IdentityRefusal::TooManyWindows {
                max: MAX_WINDOWS_PER_APP
            })
        );
        // …and with one slot fewer it is still allocatable.
        existing.pop();
        assert_eq!(
            next_window_label("files", &existing).as_deref(),
            Ok("files_16")
        );
    }

    /// The cap counts **windows**, not "slots below 2": an app whose instance-1 window
    /// was closed still has that slot free, and [`WmState::open`] would happily put a
    /// window there — so allocating a name must not report a full app while 15 of the
    /// 16 slots are in use. ([`WmState::open`]: the host's *other* answer to "may this
    /// app host one more window right now".)
    #[test]
    fn a_free_first_slot_is_allocated_not_reported_as_a_full_app() {
        // Every slot except instance 1 is taken: 15 windows, one short of the cap.
        let mut existing: Vec<String> = (2..=MAX_WINDOWS_PER_APP)
            .map(|n| format!("files_{n}"))
            .collect();
        assert_eq!(existing.len(), MAX_WINDOWS_PER_APP as usize - 1);
        assert_eq!(
            next_window_label("files", &existing).as_deref(),
            Ok("files"),
            "instance 1 is free, so it is the lowest free ordinal — refusing here would \
             report a full app one window early"
        );

        // Positive control: only when *every* slot is taken is the refusal earned.
        existing.push("files".to_string());
        assert_eq!(
            next_window_label("files", &existing),
            Err(IdentityRefusal::TooManyWindows {
                max: MAX_WINDOWS_PER_APP
            })
        );
    }

    #[test]
    fn allocation_refuses_an_app_id_that_is_not_one() {
        assert_eq!(
            next_window_label("files_2", &[]),
            Err(IdentityRefusal::AppIdHasSeparator),
            "an instance label is not an app id — a caller must not be able to allocate a window for a window"
        );
        assert_eq!(next_window_label("", &[]), Err(IdentityRefusal::EmptyAppId));
    }

    // ---- cycling (⌘`) -----------------------------------------------------------

    #[test]
    fn cycling_walks_the_ring_in_order_and_wraps() {
        let peers = labels(&["files_3", "files", "files_2"]); // deliberately unsorted
        assert_eq!(cycle_target(Some("files"), &peers, true), Some("files_2"));
        assert_eq!(cycle_target(Some("files_2"), &peers, true), Some("files_3"));
        assert_eq!(
            cycle_target(Some("files_3"), &peers, true),
            Some("files"),
            "forward from the last wraps to the first"
        );
        assert_eq!(
            cycle_target(Some("files"), &peers, false),
            Some("files_3"),
            "backward from the first wraps to the last"
        );
        assert_eq!(cycle_target(Some("files_2"), &peers, false), Some("files"));
    }

    #[test]
    fn cycling_with_no_current_focus_starts_at_an_end() {
        let peers = labels(&["files", "files_2"]);
        assert_eq!(cycle_target(None, &peers, true), Some("files"));
        assert_eq!(cycle_target(None, &peers, false), Some("files_2"));
        assert_eq!(
            cycle_target(Some("notes"), &peers, true),
            Some("files"),
            "a pointer outside the ring is treated like no pointer — never a panic"
        );
    }

    #[test]
    fn cycling_an_empty_ring_is_none_and_a_ring_of_one_is_itself() {
        assert_eq!(cycle_target(Some("files"), &[], true), None);
        assert_eq!(cycle_target(None, &[], false), None);
        let one = labels(&["files"]);
        assert_eq!(cycle_target(Some("files"), &one, true), Some("files"));
        assert_eq!(cycle_target(Some("files"), &one, false), Some("files"));
    }

    #[test]
    fn cycling_is_deterministic_under_input_permutation() {
        let a = labels(&["files", "files_2", "files_3"]);
        let b = labels(&["files_3", "files", "files_2"]);
        for current in ["files", "files_2", "files_3"] {
            assert_eq!(
                cycle_target(Some(current), &a, true),
                cycle_target(Some(current), &b, true),
                "the ring order comes from the ordinals, not from the caller's order"
            );
        }
    }
}

//! AmOS input-method (IME) domain core — the engine behind the System UI's
//! on-screen pinyin keyboard. Design & honest boundaries: `docs/input-method.md`.
//!
//! Layering (same shape as the other AmOS domain cores):
//!
//! * [`fuzzy`] — [`FuzzyPrefs`]: the nine toggleable fuzzy pairs (`z↔zh`, `n↔l`,
//!   `in↔ing`, …) as a serde-stable preference struct, plus [`FuzzyPair`] as the
//!   addressable handle the UI toggles one at a time.
//! * [`engine`] — [`PinyinInput`]: the typing session. Wraps `inputx-pinyin`'s
//!   immutable [`inputx_pinyin::PinyinEngine`] and composes the two candidate
//!   sources the keyboard shows:
//!   1. **exact-code words** (`Session::candidates` — `zhongguo` → 中国), ranked
//!      by the engine's frequency table with the per-user L0 layer on top;
//!   2. **a sentence composition** (`PinyinDict::best_composition`) for a
//!      continuous multi-syllable buffer (`zhongguorenmin` → 中国人民), which is
//!      the only thing that makes long buffers useful — an exact-code lookup has
//!      no match for them at all.
//! * [`profile`] — [`ImeProfile`]: the persistable profile (schema version +
//!   fuzzy prefs + exported L0 learning: pins and pending pick counts). Pure
//!   serde + string (de)serialization; **no file I/O** (the host bridge owns the
//!   path, exactly like `amos-blocklist`'s rule store).
//!
//! Honest boundaries (also documented in `docs/input-method.md`):
//!
//! * The engine only ever sees ASCII letters; digits, punctuation and
//!   non-Chinese text are the keyboard's business, not the engine's. A candidate
//!   list is a *suggestion*: committing a sentence candidate is recorded as the
//!   last committed word but is **not** fed to the L0 learner (that layer only
//!   accepts real dictionary words, and claiming otherwise would silently teach
//!   the dictionary a word it does not contain).
//! * Next-word prediction (联想) is wired via bigram boosting (REQ-A259): the
//!   ~20 MB bigram/trigram tables improve multi-character word ranking based on
//!   context. Binary size impact measured: 20 MB → 26 MB (+6 MB in practice,
//!   +13.5 MB nominal). Desktop form factor tolerates this; mobile builds may
//!   want to disable the `bigrams` feature to save space.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

mod engine;
mod fuzzy;
mod profile;

pub use engine::{Candidate, CandidateKind, PinyinCore, PinyinInput, MAX_CANDIDATES};
pub use fuzzy::{FuzzyPair, FuzzyPrefs, FUZZY_PAIRS};
pub use profile::{ImeProfile, L0Data, MAX_CODE_LEN, MAX_PICK_COUNTS, MAX_PINS};

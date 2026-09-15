//! Size probe for the 联想 / prediction data (REQ-A260).
//!
//! Build it twice — with and without the `predict` feature — and compare the two
//! binaries. That is where the honest number in `docs/input-method.md` comes from;
//! a claim about megabytes belongs in a reproducible command, not in prose.
//!
//! ```text
//! cargo build --release -p amos-ime --example size_probe      # with the FSTs
//! cargo build --release -p amos-ime --no-default-features \
//!       --example size_probe                                  # without them
//! ls -l target/release/examples/size_probe
//! ```
//!
//! It also answers the second question a size decision needs: does the engine still
//! work when the data is *not* linked in? (Yes — it reports what it has and returns
//! no suggestions instead of pretending.)

use amos_ime::{FuzzyPrefs, PinyinInput, MAX_CANDIDATES};

fn main() {
    let mut ime = PinyinInput::new(FuzzyPrefs::strict());
    ime.type_str("zhongguo");
    let first = ime
        .candidates(MAX_CANDIDATES)
        .first()
        .map(|c| c.text.clone())
        .unwrap_or_default();
    ime.commit(0);
    ime.type_str("de");
    ime.commit(0);
    let mut ime2 = PinyinInput::new(FuzzyPrefs::strict());
    ime2.type_str("women");
    ime2.commit(0);
    ime2.type_str("de");
    ime2.commit(0);
    println!(
        "dict_entries={} first_zhongguo={first} suggestions_women_de={:?}",
        ime.dict_entries(),
        ime2.predictions(MAX_CANDIDATES)
    );
}

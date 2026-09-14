//! `typing_session` — code in, candidates out, and what learning changes.
//!
//! A pinyin engine you can test: type `nihao`, see the ranked candidates and their kind; turn
//! on one fuzzy pair (zh↔z) and watch the order change for a code that needs it; commit a
//! candidate and see the profile learn, so the next pass ranks it differently. No window, no
//! platform input API — the engine is driven directly.
//!
//! Usage:
//! ```text
//! cargo run -p amos-ime --example typing_session
//! ```

use amos_ime::{FuzzyPair, FuzzyPrefs, ImeProfile, PinyinInput};
/// Print the first few candidates of the current input, with their kind.
fn show(input: &PinyinInput, label: &str) {
    let candidates = input.candidates(4);
    let rendered: Vec<String> = candidates
        .iter()
        .map(|c| format!("{} ({:?})", c.text, c.kind))
        .collect();
    println!(
        "{label:<26} input={:<8} composing={:<5} candidates=[{}]",
        input.input(),
        input.is_composing(),
        rendered.join(", ")
    );
}

fn main() {
    let mut input = PinyinInput::new(FuzzyPrefs::strict());
    println!("strict prefs? {}", input.is_strict());

    // Type a code letter by letter; each keystroke updates the composing text.
    let typed = input.type_str("nihao");
    show(&input, &format!("typed {typed} char(s)"));

    // A candidate the user picks is committed to the surface (and remembered).
    match input.commit(0) {
        Some(picked) => println!("commit(0) -> {picked:?}"),
        None => println!("commit(0) -> nothing to commit"),
    }
    println!(
        "learned: pins={} pending={} dict_entries={}",
        input.learned_pins(),
        input.learned_pending(),
        input.dict_entries()
    );

    // A code that needs the zh/z confusion, before and after switching that pair on.
    input.clear();
    input.type_str("zhongguo");
    show(&input, "strict (zh/z separate)");
    input.toggle_fuzzy(FuzzyPair::ZZh);
    println!(
        "toggled {:?}: strict now {}",
        FuzzyPair::ZZh,
        input.prefs().is_strict()
    );
    // Changing preferences is a new composition (the old one is abandoned), so re-type.
    input.type_str("zhongguo");
    show(&input, "fuzzy zh↔z on");

    // Backspace and clear behave the way a keyboard expects.
    println!("backspace -> {}", input.backspace());
    show(&input, "after one backspace");
    input.clear();
    println!(
        "after clear: input={:?} composing={}",
        input.input(),
        input.is_composing()
    );

    // The profile is the persisted half: preferences + learned L0 data, as JSON.
    let l0 = input.export_l0();
    let profile = ImeProfile::new(FuzzyPrefs::strict(), l0);
    let json = profile.to_json().expect("the profile serialises");
    let reloaded = ImeProfile::from_json(&json).expect("and parses back");
    let l0 = reloaded.l0();
    println!(
        "profile round trip: strict={} pins={} pick_counts={} json_bytes={}",
        reloaded.fuzzy().is_strict(),
        l0.pins.len(),
        l0.pick_counts.len(),
        json.len()
    );
    let imported = input.import_l0(&l0);
    println!("imported {imported} entry/entries into the engine");

    // Preferences are just data: a permissive preset flips every pair on at once.
    let mut permissive = FuzzyPrefs::permissive();
    println!("permissive preset strict? {}", permissive.is_strict());
    FuzzyPair::ZZh.set(&mut permissive, false);
    println!(
        "after switching {:?} off: strict={}",
        FuzzyPair::ZZh,
        permissive.is_strict()
    );
    println!("the catalogue has {} pair(s)", amos_ime::FUZZY_PAIRS.len());
}

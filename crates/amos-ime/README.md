# amos-ime — Mandarin pinyin input-method engine

A headless input method you can test: a pinyin engine (`inputx-pinyin`) turning typed codes
into candidates, fuzzy-pair preferences (zh/z, n/l …), per-user learning that is persisted,
and a typing session the UI drives. Part of **[Amos](../../README.md)**. Design record:
[`docs/input-method.md`](../../docs/input-method.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `PinyinInput` is the engine: feed it codes (`ni`), get ranked `Candidate`s with a
  `CandidateKind` (exact / fuzzy / prefix …) — bounded by `MAX_CANDIDATES`.
- **`FuzzyPrefs`** select which confusion pairs apply (`FUZZY_PAIRS` is the catalogue), so a
  user who never confuses `zh`/`z` is not shown that noise.
- **`ImeProfile`** is the per-user state (pick counts, pins, L0 data) with explicit caps
  (`MAX_PICK_COUNTS`, `MAX_PINS`, `MAX_CODE_LEN`), so learning cannot grow without bound.
- The session is **headless and synchronous**: a UI feeds keys and receives candidates; no
  windowing, no platform input API, no IME service registration.

It is **not** a full IME service: it does not implement Android's `InputMethodService`, does
not draw a candidate bar, and handles Mandarin pinyin only.

## Layout

| file | what |
|---|---|
| `src/engine.rs` | `PinyinCore` (the process-wide dictionary + learner + fuzzy prefs), `PinyinInput` (one typing session over it), `Candidate`, `CandidateKind`, `MAX_CANDIDATES` |
| `src/fuzzy.rs` | `FuzzyPair`, `FuzzyPrefs`, `FUZZY_PAIRS` |
| `src/profile.rs` | `ImeProfile` (learning + pins) and its caps |

## Features

| feature | default | what it buys |
|---|---|---|
| `predict` | **on** | 联想 / next-word suggestions: the word-trigram + word-bigram FSTs behind `PinyinInput::predictions()` (context path) and the `bigram_boost` the composition Viterbi uses. Costs **+19.6 MB** of binary (measured) — `--no-default-features` builds without it, and the engine then answers "no suggestions" instead of pretending. |

## Build & test

```bash
cargo test -p amos-ime
cargo clippy -p amos-ime --all-targets -- -D warnings
cargo fmt -p amos-ime -- --check
# the feature explicitly (CI does this too, so it cannot rot silently):
cargo clippy -p amos-ime --all-targets --features predict -- -D warnings
```

## Examples

```bash
# Type "nihao": candidates, a fuzzy variant, a picked-and-learned re-ranking.
cargo run -p amos-ime --example typing_session

# What the 联想 FSTs cost in binary size (build it twice, with and without them).
cargo build --release -p amos-ime --example size_probe
cargo build --release -p amos-ime --no-default-features --example size_probe
```

| example | shows |
|---|---|
| `typing_session` | a few codes typed through `PinyinInput`, the candidates (with kind), a fuzzy pair flipping on and changing the order, and the profile learning a pick so the next type ranks it differently |
| `size_probe` | the honest cost of the `predict` feature: build it with and without, compare the two binaries; it also prints what the engine composes and which suggestions it returns (empty without the data) |

## Honest boundaries

- **Dictionary quality is what ships**: the engine ranks the table it is given; a wrong
  candidate is a data problem, not a silent heuristic.
- **Learning is local and bounded**: `ImeProfile` caps are enforced at insert time.
- **No cloud prediction** and no user-text upload — the input method is offline by design.
- **联想 needs context**: `predictions()` returns nothing until two words have been committed
  in that session (the upstream engine's context path is trigram-based on purpose — the
  bigram-only path produced "在年月日年月日…" chain noise), and nothing while a code is being
  composed. A picked suggestion is inserted but **not** taught to the learner.
- **No platform IME glue here**: registering with Android's input framework is the host's
  job (and is a device verification item).

## Related

- [`docs/input-method.md`](../../docs/input-method.md) — the engine contract, fuzzy pairs and
  the learning profile.

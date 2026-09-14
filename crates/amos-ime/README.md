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
| `src/engine.rs` | `PinyinInput`, `Candidate`, `CandidateKind`, `MAX_CANDIDATES` |
| `src/fuzzy.rs` | `FuzzyPair`, `FuzzyPrefs`, `FUZZY_PAIRS` |
| `src/profile.rs` | `ImeProfile` (learning + pins) and its caps |

## Build & test

```bash
cargo test -p amos-ime
cargo clippy -p amos-ime --all-targets -- -D warnings
cargo fmt -p amos-ime -- --check
```

## Examples

```bash
# Type "nihao": candidates, a fuzzy variant, a picked-and-learned re-ranking.
cargo run -p amos-ime --example typing_session
```

| example | shows |
|---|---|
| `typing_session` | a few codes typed through `PinyinInput`, the candidates (with kind), a fuzzy pair flipping on and changing the order, and the profile learning a pick so the next type ranks it differently |

## Honest boundaries

- **Dictionary quality is what ships**: the engine ranks the table it is given; a wrong
  candidate is a data problem, not a silent heuristic.
- **Learning is local and bounded**: `ImeProfile` caps are enforced at insert time.
- **No cloud prediction** and no user-text upload — the input method is offline by design.
- **No platform IME glue here**: registering with Android's input framework is the host's
  job (and is a device verification item).

## Related

- [`docs/input-method.md`](../../docs/input-method.md) — the engine contract, fuzzy pairs and
  the learning profile.

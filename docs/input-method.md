# Input method (输入法) — the on-screen pinyin keyboard

Amos ships a **pinyin input method** for its own System UI: focus a text field and
a docked keyboard appears; typing letters composes pinyin, and picking a candidate
writes the Chinese word into that field.

The engine is [`inputx-pinyin`](https://crates.io/crates/inputx-pinyin) (an
embedded ~165k-code FST dictionary with a per-user learning layer), wrapped by the
AmOS domain core so the ranking stays in one place and the UI only renders it.

## Layers

| Layer | Where | Responsibility |
| --- | --- | --- |
| Engine | `crates/amos-ime` | Pinyin buffer, candidate composition, fuzzy-pair preferences, per-user learner (pins + pick counts), profile (de)serialization. **No I/O, no Tauri.** |
| Bridge | `crates/amos-tauri/src/ime.rs` | The nine `ime_*` Tauri commands, the session (`Mutex<ImeInner>`) and the `amos-ime.json` profile file (atomic temp+rename write, next to the blocklist/SMS stores). |
| Client | `crates/amos-tauri/frontend-ts/src/lib/ime.ts` | One `invoke` wrapper per command + the pure helpers (`isTextEntry`, `insertTextAtCursor`, `deleteBeforeCaret`, key layouts, candidate pager). |
| UI | `.../src/svelte/ImeKeyboard.svelte`, `.../ImeOverlay.svelte` | `ImeKeyboard` is presentation only; `ImeOverlay` owns focus tracking, the zh/en mode, insertion into the focused field, and the fuzzy-settings panel. Mounted by `Shell.svelte`, so every app gets it. |

## Candidates

Two sources, composed in `amos_ime::PinyinInput::candidates`:

1. **Exact-code words** — `Session::candidates`, i.e. the dictionary entries for the
   whole typed code (`zhongguo` → 中国), ranked by the corpus frequency table with
   the user's L0 layer on top.
2. **A sentence composition** — `PinyinDict::best_composition`, a Viterbi
   segmentation of a *continuous* multi-syllable buffer
   (`zhongguorenmin` → 中国人民). This is what makes long buffers useful at all:
   an exact-code lookup has no entry for them, so without it the keyboard would
   show an empty candidate list.

Ordering is deliberate: exact words lead, and the sentence candidate is appended
(deduplicated) — except when there are no exact words, where it leads. The
keyboard marks the sentence candidate with 整句/sentence so the user can tell a
whole-buffer guess from a dictionary word.

## Key behaviours

Rules the keyboard follows, each pinned by a test:

* **Letters compose, everything else is literal.** A letter key goes to the engine
  (`ime_key` — the engine only ever sees ASCII letters). A **digit or punctuation**
  key is not fed to the engine; if something is composing it is **committed first**
  and the symbol is then typed, which is the ordinary IME behaviour. (Feeding a
  symbol to the engine would silently swallow it: `type_char` rejects non-letters.)
  Committing first is not decoration: a symbol that reached the field on its own
  would land *in front of* the Chinese the user typed before it, and the code would
  stay composing behind it. **Both keyboards call the same function for this**
  (`typeNonLetter`), so the rule cannot depend on which key produced the keystroke.
* **Space/Enter commit the highlighted candidate** while composing; with an empty
  buffer they mean a space, and only a `<textarea>` gets the newline — an `<input>`
  has none to give, so claiming one would be a lie. A buffer the dictionary has **no
  candidate for** is not an exception: the key still means a space rather than
  vanishing because there was nothing to commit.
* **Backspace edits the pinyin first, then the field** (one key, two meanings in
  the order a user expects). In a field with no caret at all (`email`/`number`
  report `null` for `selectionStart`) it deletes the last character instead of
  silently doing nothing, and a deletion that cannot change the value is never
  claimed as one.
* **A new letter resets the candidate list to page one.**
* **The pager agrees with itself.** The page the keyboard renders is clamped to the
  candidate list, so the slice shown, the "第 n / m 页" label and the index a
  candidate reports are always the *same* page — an over-range page used to show
  page m while reporting indices from a page that does not exist, so tapping a
  visible candidate committed nothing. The arrows are disabled at either end.
* **Shift** is one-shot and applies only in English mode — pinyin is
  case-insensitive, so a shifted pinyin key would claim a difference that does not
  exist. It is therefore **not offered in Chinese mode** (disabled, like the other
  engine-dependent controls when the engine is gone) and the arm is **dropped when
  the mode changes**, so a stale ⇧ can never uppercase the first letter after the
  user switches back.
* **Losing the field abandons the code** (`ime_clear`): a half-typed buffer can
  never land in the next field, and nothing is inserted on blur.
* **A field that left the document is not written to.** Removing the focused node
  from the DOM moves focus to `<body>` and fires **no** `focusout`, so the overlay
  can hold a reference to an element the user no longer sees; a programmatic
  `.value` write into it "succeeds" while nothing appears on screen. The next write
  path notices (`isConnected`), ends the session exactly like losing focus does, and
  the *text is not claimed as inserted* — the same rule the read-only refusal
  follows. Honest limit: the check runs at the next interaction, not at the moment
  of removal (the WebView fires no event for it).
* **Escape cancels the composition**, and only when there is something to cancel —
  the shell's global Escape (close overlays) is left alone otherwise.
* **An insertion is refused rather than forced.** A field can become read-only
  *while* it is focused, and a programmatic `.value` write sails straight past
  `readOnly`; the overlay re-checks and reports the refusal through the diagnostics
  ledger (`amosWarn("ime", …)`) instead of writing anyway or losing the text
  silently. The **host's declared limit counts too**: `maxlength` constrains *user*
  input but not a programmatic write, so an insertion is clamped to it — and a field
  already at its limit is **refused** rather than claimed (no phantom insert, not
  even an `input` event).
* **The commit hint is real — and it ends with the word.** After a commit the bar
  shows what was inserted; when the pick was a **dictionary** word it also offers
  *forget*, which drops that code's learned pin (`ime_forget_last`). A sentence
  composition offers no undo — it never taught the learner anything, so the button
  would do nothing. The next accepted letter starts a new word and retires the
  hint, so a stale chip cannot pop back after the new composition is cleared.
* **The dock scrolls the field back into view** when it opens, since it covers the
  bottom of the screen.
* **The settings panel states real facts**: the embedded dictionary size
  (`dict_entries`) and whether the fuzzy mode is *Strict* or *Custom* (`strict`),
  not just the toggles.
* **Forgetting every learned word asks once.** It cannot be undone, so the button
  turns into a confirmation ("确认清除？" / "Confirm?") and drops the question when
  the settings panel closes.

## Physical keyboard

The same engine is driven from a **physical** keyboard — the input method is not a
touch-only keyboard:

* **a–z composes** (no letter reaches the field while the keyboard is up),
* **1–9 pick the candidate on the page that is showing**; a digit the page has no
  candidate for is still typed **literally** rather than swallowed — but only after
  the code the user typed *before* it is committed, so the field reads `中国7`
  rather than `7中国`,
* **Space / Enter** commit the highlighted candidate; with nothing to commit they
  mean what they say (a space — a newline only in a `<textarea>`), exactly as the
  on-screen keys do,
* **punctuation and other printable keys** go through the *same* `press` rule the
  on-screen keys use: commit the composition first, then insert the character,
* **Backspace** edits the pinyin before the field,
* **Escape** cancels the composition (and is left to the shell when there is
  nothing to cancel),
* **modifier combinations**, **English mode** and a **collapsed keyboard** (⌄) all
  hand the keys straight back to the field, and so does every key the input method
  itself does not act on (**Tab**, arrows, PageUp/Down) — those are never consumed.

The rule is deliberately *one* rule: a physical key and its on-screen twin call the
same overlay functions, so a behaviour cannot exist on one keyboard and not the
other. (Before this, a physical `,` slipped past the engine entirely: the field got
the comma in front of the Chinese and the pinyin code stayed in flight.)

This is also a correctness fix: the shell maps physical **H / V / A** to
Home / Voice / AI (`osInputBridge`, a `window` listener), so typing `hao`, `shi` or
`da` used to compose *and* jump to the Home screen. The IME now listens on the
**capture** path and consumes the keystroke it acts on — it never reaches the field
or the shell's shortcuts. A native composition (`event.isComposing`) is never
intercepted.

## Learning and persistence

`inputx-pinyin`'s L0 layer auto-pins a `(code, word)` pair after three picks.
`amos-ime` mirrors that state into `L0Data` (serde), the bridge persists it to
`amos-ime.json` (`version`, `fuzzy`, `l0`), and imports are **validated**: codes
must be lowercase ASCII, words non-empty and control-char-free, and both lists are
capped (`MAX_PINS`/`MAX_PICK_COUNTS`). A file from a *newer* schema version is
refused rather than half-read, and a corrupt file is logged with the defaults kept
— it never crashes the keyboard and never silently invents preferences.

Committing a **sentence** candidate does *not* teach the learner: it is not a
dictionary word, so claiming the dictionary learned it would be false.

## Fuzzy pinyin

Nine toggleable pairs (`z↔zh`, `c↔ch`, `s↔sh`, `n↔l`, `f↔h`, `r↔l`, `in↔ing`,
`en↔eng`, `an↔ang`) in the keyboard's settings panel, plus the `严格` / `全部模糊`
presets. Defaults are strict. Changing a pair rebuilds the engine and clears the
in-flight buffer, because the old candidate list was ranked under the old rules.

## Settings integration

Settings → **输入法 / Input Method** (`svelte/settings/ImePage.svelte`) is the
discoverable half of the feature — without it the keyboard only exists for someone
who already focused a text field:

* the **on-screen keyboard switch** (the same `amos-ui.ime` preference the keyboard
  reads; **both** surfaces listen for the store change, so flipping it on either one
  raises/closes the keyboard there and updates the switch here),
* the nine **fuzzy pairs** + the `Strict` / `All fuzzy` presets,
* a real readout — the embedded **dictionary size** and the **learned-word count**,
* **forget every learned word** (with the same one-tap confirmation as the
  keyboard's panel).

Both surfaces drive the *same* `ime_*` commands through `lib/ime`, so they cannot
drift. With no engine the page keeps only the switch (a local preference) and one
line explaining that the engine is not connected — it never draws a control that
would silently do nothing.

## Persistence

The profile is written atomically: a staging file in the **same directory** (that
is what makes `rename` atomic) with a **unique name per call**
(`.<file>.tmp.<pid>.<seq>`), then a rename over the destination. The unique name is
not decoration — two concurrent `ime_*` commands do their IO *outside* the session
lock, and a shared staging file would let them interleave into one inode and publish
a **torn** profile; the next boot would then log "unreadable — keeping defaults" and
the user's pinned words would be silently gone (the same defect
`amos-appstore::atomic` fixed with its own `STAGING_SEQ`). A staging file left
behind by a failed rename is reported, not inherited by the next writer.

Honest limit: this guarantees the replace is **atomic**, not **durable** — the last
write is not `fsync`ed, so an abrupt power loss can still lose the newest state
(never leave a half file).

## Honest boundaries

* **Next-word prediction (联想) is not wired.** It needs `inputx-pinyin`'s word
  bigram + trigram FSTs (~20 MB of embedded data) which this crate deliberately
  leaves off (`default-features = false`); nothing in the UI consumes them yet, so
  turning them on would only grow the binary. The candidate path used here
  (`Session::candidates` + `best_composition`) does not change if they are enabled.
* **The keyboard is a letters/digits/punctuation keyboard.** There is no emoji or
  full symbol plane, no long-press accents, no swipe typing, and shift is a
  one-shot key that only affects English mode (it is **disabled** in Chinese mode;
  no caps-lock, no auto-capitalisation at the start of a sentence).
* **`contenteditable` hosts are not targeted** — only real `<input>` (text-like
  types) and `<textarea>` elements. `isTextEntry` says so explicitly.
* **This is an in-app input method**, not an Android system IME that other apps
  can select: the System UI types into its own WebView (`insertTextAtCursor`
  dispatches a real `input` event, so the host component's `bind:value` updates).
  A system-wide IME would be a separate APK with
  `android.inputmethodservice.InputMethodService` — see `docs/android-compat.md`
  for the container/keyboard-sharing design.
* **Off by default on a fine-pointer device** (`(pointer: coarse)` decides), since
  a desktop already has a physical keyboard; the ⌨ button enables it and the
  preference is persisted (`amos-ui.ime`).
* **The Settings page and the keyboard share the switch, not every control's
  state.** Turning the IME on/off is synced live in **both** directions (each side
  listens for the `amos-ui.ime` store change the other dispatches); the fuzzy
  preferences are read by each surface when it loads (they are only changed in one
  place at a time, and both write through the same commands).
* **No engine ⇒ literal typing.** When the bridge does not answer at all, the
  keyboard drops to English and disables the two engine-dependent controls instead
  of offering a Chinese keyboard that would swallow every letter.

## Tests

* `crates/amos-ime` — 32 unit tests: candidate composition, commit/L0 learning,
  fuzzy toggles, profile JSON validation and caps, the transient commit hint.
* `crates/amos-tauri/src/ime.rs` — 21 tests: the command surface, persistence
  round-trip across a simulated restart, corrupt/newer profile handling, the
  per-word undo (only a dictionary pick is undoable, and the next word retires it),
  and the write path: unique staging names + concurrent persists never publishing a
  torn profile.
* `frontend-ts/src/__tests__/ime.test.ts` — 15 tests: the wire contract (command
  names + camelCase args), field detection, caret insertion/deletion (including a
  field with no caret, a field **at its `maxlength`** and a clamp that never splits
  a surrogate pair), paging.
* `frontend-ts/svelte-tests/ime-keyboard.svelte.test.ts` (27) and
  `ime-overlay.svelte.test.ts` (39) — the key grid, candidate bar, pager (clamped,
  ends disabled), settings panel with the dictionary/mode readout, commit hint,
  the bridge-failure notice, and the behavior contract (compose → commit at the
  caret, backspace order, symbols while composing, page reset, English mode +
  shift, read-only refusal, Escape cancelling the composition, the no-engine
  degradation, live store sync with the Settings switch, the **physical keyboard**
  driving the same engine without leaking keys to the field or the shell's
  shortcuts — including the *shared* rule for symbols, an out-of-range digit and
  Space with nothing to commit, and Tab/arrows being left to the field —
  confirmation before forgetting everything, abandoning the code when
  the field goes away, and a field that was **removed from the document** never
  being written to).
* `frontend-ts/svelte-tests/settings-ime.svelte.test.ts` (5) — the Settings page:
  the switch writes the keyboard's preference **and follows the keyboard's own
  change**, the fuzzy controls call the same
  commands, the destructive reset asks first, and no engine ⇒ no inert controls.

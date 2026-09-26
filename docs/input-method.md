# Input method (输入法) — the on-screen pinyin keyboard

Amos ships a **pinyin input method** with two surfaces. In its own System UI, focus a
text field and a docked keyboard appears; typing letters composes pinyin, and picking a
candidate writes the Chinese word into that field. The same engine is also exposed as an
Android **system IME** (`AmosImeService`), so any other app on the device can select it
and type Chinese — see §System IME.

The engine is [`inputx-pinyin`](https://crates.io/crates/inputx-pinyin) (an
embedded ~165k-code FST dictionary with a per-user learning layer), wrapped by the
AmOS domain core so the ranking stays in one place and the UI only renders it.

## Layers

| Layer | Where | Responsibility |
| --- | --- | --- |
| Engine | `crates/amos-ime` | `PinyinCore` (the **process-wide** dictionary + L0 learner + fuzzy preferences) and `PinyinInput` (**one window's** buffer over a core); candidate composition; profile (de)serialization. **No I/O, no Tauri.** |
| Bridge | `crates/amos-tauri/src/ime.rs` | The nine `ime_*` Tauri commands, the per-window session map (`Mutex<ImeInner { core, windows: HashMap<label, _> }>`) and the `amos-ime.json` profile file (atomic temp+rename write, next to the blocklist/SMS stores). |
| Client | `crates/amos-tauri/frontend-ts/src/lib/ime.ts` | One `invoke` wrapper per command + the pure helpers (`isTextEntry`, `insertTextAtCursor`, `deleteBeforeCaret`, key layouts, candidate pager). |
| UI | `.../src/svelte/ImeKeyboard.svelte`, `.../ImeOverlay.svelte` | `ImeKeyboard` is presentation only; `ImeOverlay` owns focus tracking, the zh/en mode, insertion into the focused field, and the fuzzy-settings panel. Mounted by `Shell.svelte`, so every app gets it. |
| System IME | `android-glue/.../AmosImeService.kt` + `crates/amos-tauri/src/android_ime.rs` | The Android `InputMethodService` other apps select, driving the **same** bridge under the `"android-ime"` pseudo-window; see §System IME. |

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

## Chinese punctuation (中文标点)

In Chinese mode a punctuation key is the **Chinese** glyph, not its half-width
twin — the ordinary pinyin-IME behaviour, applied on both keyboards:

* the **`?123` page is mode-dependent**: in Chinese mode it shows Chinese
  punctuation (`，。？！、：；“”…` and `（）《》【】「」‘’`), in English mode the
  ASCII page (`. , ? ! …`). The user therefore always sees the glyph they get.
* a **physical** `,` in Chinese mode is committed as `，` — with or without a code
  in flight. This is a Chinese-IME behaviour, not only a composing one: with an
  empty buffer the browser would otherwise insert a half-width `,`. Only the keys
  that *have* a Chinese form are taken over; a twinless symbol (`@`, `#`, `$`)
  and Space/Enter are still left to the field, so an email address typed in
  Chinese mode survives intact.
* **digits stay half-width in both modes.** `１２３` is never what a phone-number
  field wants, so the Chinese page keeps the same ASCII digit row.
* the mapping is a fixed **one-to-one** table (`lib/ime.ts` `toChinesePunctuation`).
  A straight `"`/`'` has no single Chinese form — a Chinese quotation is a *pair*
  (`“…”` / `‘…’`) — so it maps to the **opening** glyph and the closing glyph is a
  key on the Chinese symbol page; the IME does **not** guess an open/close
  alternation from invisible state.

An already-Chinese glyph passes through unchanged (so a symbol-page tap is not
double-translated), and everything the table does not name passes through too.

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

The per-window split (REQ-A258) does not multiply the file: the dictionary and
learner live in **one** shared core, and every `persist()` snapshots that core
(preferences + L0) under its lock — so two windows committing at the same moment
cannot write two diverging learners, the last atomic replace simply carries the
newest shared state. Before the split each window would have owned a learner, and
"last writer wins" would have silently dropped the other window's pinned words.

Honest limit: this guarantees the replace is **atomic**, not **durable** — the last
write is not `fsync`ed, so an abrupt power loss can still lose the newest state
(never leave a half file).

## Next-word suggestions (联想)

After a commit the buffer is empty — and that is exactly when the engine can offer
the **next word**. The keyboard shows the suggestions in the same candidate bar,
tagged 联想 (`ime.predict`).

| Layer | What it does |
| --- | --- |
| Engine (`crates/amos-ime`) | `PinyinInput::predictions(limit)` — the crate's **context** path (`PinyinDict::predict_next_words_context`, a word-trigram hit) over the last **two** committed words of *this window*. Empty while a code is composing, and empty with nothing/one word of context. |
| Bridge (`crates/amos-tauri/src/ime.rs`) | With an empty buffer the state's `candidates` **are** the suggestions, each with `kind: "predict"`; `ime_commit(index)` on that list inserts the suggestion (`commit_prediction`) **without** teaching the learner and records it as the newest commit, so the chain can continue. |
| UI (`ImeKeyboard.svelte`) | Renders the bar when `composing \|\| suggesting`; the pinyin chip and the clear button only exist while composing (there is no code to clear when a suggestion is showing). |

Three decisions worth their reasons:

* **The context path, not the bigram one.** `inputx-pinyin` ships two prediction
  APIs; upstream documents the bigram-only `predict_next_words` as too noisy to ship
  (it produced "在年月日年月日…" chains on a real device) and added
  `predict_next_words_context` — trigram-only, `count ≥ 15` — precisely to replace it.
  We call the context one, so a **cold start offers nothing**: one word is not
  context, and "no suggestion" is a better answer than a guess. (The bigram FSAs are
  still linked: they are what `bigram_boost` feeds into the composition Viterbi, i.e.
  they improve the *sentence* candidate — not the exact-code list, which is
  frequency + L0 only.)
* **One index space.** A suggestion is a candidate (`kind: "predict"`), so the
  keyboard's pager and `ime_commit(index)` keep exactly one meaning. The kind is
  explicit rather than inferred from "the buffer happens to be empty" — it decides
  which operation a pick is.
* **A pick is not typing.** Committing a suggestion inserts the text but **never**
  records it in the L0 learner, and leaves no "undo this word" hint: the dictionary
  only learns words the user actually composed, and a suggestion has no pinyin code
  to forget.

Cost, **measured** (not estimated), on this machine:

```text
# 1) isolated engine probe (crates/amos-ime/examples/size_probe.rs)
cargo build --release -p amos-ime --example size_probe            # with the FSTs
cargo build --release -p amos-ime --no-default-features --example size_probe
  without:  4,833,200 B   (prints suggestions = [])
  with:    24,449,456 B   (prints ["国家", "生活", "工作", "社会"])
  delta:  +19,616,256 B

# 2) the whole System UI binary, same tree, only the feature differs
cargo clean -p amos-tauri && cargo build --release -p amos-tauri  # twice
  without: 21,012,144 B   (byte probes for both FSTs: 0/2 found)
  with:    40,628,464 B   (byte probes: 2/2 found)
  delta:  +19,616,320 B   ≈ +19.6 MB (18.7 MiB)

# the two FST files themselves: 13,517,480 B (trigrams) + 4,462,261 B (bigrams) = 18.0 MB
```

Both measurements agree, and the byte probes (`python3`-style: take two windows out of each
FST file and look for them in the binary) prove the data really is linked in — the number is
not an estimate of what "should" happen.

Honest provenance: the **first** attempt at the app-level A/B compared a stale binary (the
"without" build had not been relinked, so both sides read ~40.6 MB and the probes found the
data on both); it was discarded and redone with `cargo clean -p amos-tauri`, which is what
produced the 21.0 MB figure above. A size claim that cannot survive a rebuild is not a
measurement.

`amos-ime`'s `predict` feature (default **on**) is the single switch. A
size-constrained build passes `--no-default-features`; every call site in *our* code
is unconditional (no `cfg`), and the engine answers "no suggestions" instead of
pretending.

## System IME (系统输入法)

The keyboard above types into AmOS's own WebView. The **system IME** is the other
half: a real Android `InputMethodService` that any app on the device — an app in the
Waydroid container, or any app on the no-UI Android base (`docs/no-ui-android.md`) —
can select in `Settings → 语言与输入法 → 键盘` and type Chinese into.

It lives **inside the System UI APK** (`com.amos.ai`), not a separate APK: in the
product form every app and the System UI run in the same Android instance, so the
service can JNI straight into the same `libamos_tauri_lib.so` and reach the **same
engine**. The Kotlin class is `com.amos.ai.glue.AmosImeService`
(`crates/amos-tauri/android-glue/com/amos/ai/glue/AmosImeService.kt`), declared in
`AndroidManifest.components.xml` with the action `android.view.InputMethod` — the
value of `android.view.inputmethod.InputMethod.SERVICE_INTERFACE`, and the one
string here a reader gets wrong: the package-shaped
`android.view.inputmethod.InputMethod` looks right by analogy with the class name
and matches nothing, so the IME installs, resolves in `dumpsys package`, and is
absent from the keyboard list (`scripts/ime-action-scan.mjs` compares the literal
to the SDK's constant) — and the **caller's** permission
`android.permission.BIND_INPUT_METHOD` (a `signature|privileged` grant the platform
holds, not us — so there is deliberately no `<uses-permission>` for it; see
`scripts/android-permission-scan.mjs`'s `ime` family). The subtype list the platform
enumerates is the tracked resource `android-glue/res/xml/method.xml`, pointed at by
the service's `<meta-data android:name="android.view.im">`.

**One engine, one learner, two surfaces.** The service does *not* carry a second
engine. It drives the process-wide `ImeBridge` (`crates/amos-tauri/src/ime.rs`) under
the fixed pseudo-window `ime::ANDROID_WINDOW` (`"android-ime"`), which is the same
bridge `Shell.svelte`'s keyboard uses — a bridge is one `PinyinCore` (dictionary + L0
learner + fuzzy preferences) plus **one buffer per window label**. So a word learned
in a third-party app and a word learned in the WebView land in the same learner and the
same `amos-ime.json`; there is no second profile to diverge.

| Layer | File | Responsibility |
| --- | --- | --- |
| Service | `android-glue/.../AmosImeService.kt` | `: InputMethodService`; builds the keyboard view programmatically (no dependency on git-ignored `res/layout`), `onStartInput`/`onFinishInput` reset the per-session buffer, each keystroke routes through `ImeRouting` and commits through `InputConnection`. |
| Wire | `android-glue/.../ImeWire.kt` | Decodes the line/tab wire the Rust bridge answers. Not JSON, so the parser is host-JVM testable (`ImeWireTest.kt`). |
| Layout | `android-glue/.../ImeLayout.kt` | The key rows, the ASCII→Chinese punctuation table and the 8-per-page pager, mirrored from `frontend-ts/src/lib/ime.ts`. |
| Routing | `android-glue/.../ImeRouting.kt` | §Key behaviours as a pure function — the one place "a non-letter commits the code first" lives. |
| JNI | `crates/amos-tauri/src/android_ime.rs` | The eight `Java_com_amos_ai_glue_AmosImeService_native*` trampolines into `ime::ImeBridge::shared_or_boot()`. |

The wire format is `\n`-separated records, `\t`-separated fields, with `\\`/`\t`/`\n`
escaped:

```
input\t<code>
composing\t<0|1>
strict\t<0|1>
commit\t<text>            (empty = nothing was inserted)
undo\t<code>              (the undoable dictionary pick's code; empty = nothing to forget)
cand\t<kind>\t<text>      (0..n; kind is dict | sentence | predict)
```

**Duplicate key rules are a real cost, and named here.** The engine is the single
source of truth for *candidates*, but *which keys exist* and *what a punctuation key
means in Chinese mode* are platform facts Kotlin cannot import from TypeScript, so
`ImeLayout`/`ImeRouting` are a second copy of `frontend-ts/src/lib/ime.ts` +
`ImeOverlay.svelte`. `ImeLayoutTest`/`ImeRoutingTest` pin every value against the TS
literals so the two cannot drift unnoticed.

## Honest boundaries

* **The system IME is device-verified end to end, including the profile path; the
  cross-surface *ranking* is still host-only.** On a real device (K-Touch S5,
  Android 14, `com.amos.ai`, the arm64 debug APK that carries the corrected action)
  the service is enumerated, enabled, bound and drawn, and a Chinese word goes all
  the way through: `ime list -a -s` lists `com.amos.ai/.glue.AmosImeService`;
  `dumpsys input_method` shows `mId=com.amos.ai/.glue.AmosImeService`,
  `mShowInInputMethodPicker=true`, the subtype `中文（中国）`, and
  `mCurIntent=… act=android.view.InputMethod`, `mHaveConnection=true
  mBoundToMethod=true`; in **third-party apps** the keyboard renders (Google
  Messages' compose field, Chrome's omnibox) and real engine candidates come back —
  `n` raises `嗯`, `nihao` raises `你好` first — and tapping a candidate commits it
  into the host app (`你好` landed in Chrome's omnibox). The **profile path is
  confirmed**: `/data/user/0/com.amos.ai/files/amos-ime.json` is the app's
  `filesDir`, i.e. exactly what the service hands `nativeAttach` and what Tauri joins
  as `app_data_dir()/files`, and after the commit it held
  `"l0": { "pins": [], "pick_counts": [["nihao","你好",1]] }` — one file, written by
  the system IME, no second profile. What is **not** device-exercised is the
  *behavioural* half of sharing: that a word learned through the system IME visibly
  re-ranks in the WebView keyboard (they are one `ImeBridge` in one process by
  construction — `ime::install_shared` + `shared_or_boot` — but no device read
  traversed both surfaces). The Latin direct-insert path, the punctuation page's
  Chinese-glyph commit and the pager are pinned by the host JUnit suite
  (`ImeRoutingTest`/`ImeLayoutTest`) and exercised by tap on device, but the
  host-JVM suite remains their authority.
* **The IME lives in the app's process, so the app's lifecycle is the keyboard's.**
  The service is declared in `com.amos.ai` with no `android:process`, so it is
  hosted by the same process as the Tauri Activity — the price of reaching the same
  `ImeBridge` without cross-process plumbing. Device-observed consequence: a
  `force-stop com.amos.ai` (or a reinstall) makes the platform disable the IME and
  **fall back to the previously-selected keyboard**, logging `Input method
  uninstalled, disabling: ComponentInfo{com.amos.ai/…AmosImeService}` and
  `Current input method removed`. It comes back on `ime enable` + `ime set` (or the
  user re-picking it in Settings) once the app is launched again. The same is true,
  more slowly, of any low-memory kill of the UI process. A dedicated
  `android:process=":ime"` would decouple this, at the cost of a second process
  holding the engine.
* **联想 is a *context* feature, and it says so.** Suggestions need two committed
  words of context and a trigram hit in the embedded corpus, so there is nothing
  after the first word, nothing for rare word pairs, and nothing while a code is
  being composed. It suggests, it does not decide: the user picks every word. Chains
  are user-driven for the same reason — each picked suggestion is a keystroke.
* **The FST data costs ~19.6 MB of binary** (measured; breakdown and the reproducible
  probe in §Next-word suggestions). It is only spent if the build enables `predict`
  (the default), and a build without it offers no suggestions rather than pretending.
* **The keyboard is a letters/digits/punctuation keyboard.** There is no emoji or
  full symbol plane, no long-press accents, no swipe typing, and shift is a
  one-shot key that only affects English mode (it is **disabled** in Chinese mode;
  no caps-lock, no auto-capitalisation at the start of a sentence). Chinese
  punctuation is one mode-aware page + a fixed one-to-one ASCII→Chinese table
  (§Chinese punctuation) — not a smart-quote engine, so a quotation's opening and
  closing glyphs are chosen by the user, not alternated automatically.
* **`contenteditable` hosts are not targeted** — only real `<input>` (text-like
  types) and `<textarea>` elements. `isTextEntry` says so explicitly.
* **The WebView keyboard is in-app; the system IME is the other half.** The keyboard
  described above types into AmOS's own WebView (`insertTextAtCursor` dispatches a real
  `input` event, so the host component's `bind:value` updates). Other apps on the device
  type into `AmosImeService` instead (see §System IME), which shares the same engine and
  profile. Note this is *not* the same thing as the Android container's host-side
  `input text` forwarding (`docs/android-compat.md` option 1) — that injects text into
  the container from outside and never involves this engine.
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
* **A fuzzy-preference change keeps what you taught it.** `FuzzyConfig` is baked
  into the engine at construction, so `PinyinInput::set_prefs` **rebuilds** the
  engine — and the L0 learner lives *inside* that engine's dictionary. It did not
  carry the learner across, so flipping one fuzzy pair dropped every pinned word
  **and** (because the bridge persists right after a toggle) wrote the emptied
  learner over the good `amos-ime.json`. Found in REQ-A254 by the regression test
  `changing_fuzzy_preferences_keeps_the_learned_words` (it failed with
  `learned_pins: 0` before the fix). The in-flight **buffer** is still cleared: the
  ranking rules for it really did change.
* **One engine, one buffer per window (the G1 gap, closed in REQ-A258).** The bridge
  used to own a single `Mutex<ImeInner>` — one dictionary, one learner **and one
  pinyin buffer** for the whole process — and the `ime_*` commands carried no window
  label. That was exactly right when AmOS had one WebView. Once the desktop shell
  opened one real `WebviewWindow` per app (`docs/multi-window.md` §6) *and*
  `Shell.svelte` mounted the keyboard overlay in every window, two windows composed
  into the **same** buffer: window A's candidate bar showed what was typed in window
  B, and a commit in B consumed A's code (`docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md` G1).
  The two scopes are now split the way they should have been:
  * the **dictionary + L0 learner + fuzzy preferences are process-wide**
    (`Arc<PinyinCore>`); a word taught in one window therefore ranks first in the
    other, the learner is counted once, and the profile has a single source —
    `PinyinInput::new` still gives a self-contained session, `with_core` gives the
    per-window one;
  * the **in-flight buffer, its "just committed" hint and its undo code belong to the
    window** that typed them. Every command takes the caller as
    `window: tauri::WebviewWindow` (the host injects it — the JS side passes nothing,
    the `clipboard.rs` precedent) and files its buffer under `window.label()`.
  Device-wide actions stay device-wide **and say so**: a fuzzy-preference change swaps
  the engine for every window at once and abandons every window's in-flight buffer
  (the ranking rules really did change) — logged with the count, never silent. The
  per-window map is **bounded** (`MAX_IME_SESSIONS = 64`): at the cap, windows holding
  nothing a user could miss (empty buffer, no undo code, no commit hint) are dropped
  first; only when every window is mid-composition is the least-recently-used one
  evicted, and that one is `warn!`ed because a half-typed code really can be lost.
  The shared engine also means one dictionary and one learner in memory instead of one
  per window.
* **The buffer is per *window*, not per app.** Two windows of the same app do not share
  a composition — in this shell each window *is* an app (`#window=<label>`). A
  "resume the composition in another window" feature would be a new product decision,
  not a side effect.

## Tests

* `crates/amos-ime` — **42** unit tests: candidate composition, commit/L0 learning,
  fuzzy toggles, profile JSON validation and caps, the transient commit hint, **a fuzzy
  change never wiping the learner** (REQ-A254), the shared-core contract
  (REQ-A258): two sessions over one `PinyinCore` keep their own buffers, a commit in
  one does not eat the other's code, a word learned in one ranks first in the other, a
  preference change reaches every session and keeps the learner, and four threads can
  compose over one core (the host keeps it in managed state, which is `Send + Sync`);
  and the 联想 contract (REQ-A260): two words of context are required, suggestions are
  silent while composing, a picked suggestion continues the chain **without** teaching
  the learner, an out-of-range pick is a no-op, and the context is per session.
* `crates/amos-tauri/src/ime.rs` — **35** tests: the command surface, persistence
  round-trip across a simulated restart, corrupt/newer profile handling, the per-word
  undo (only a dictionary pick is undoable, and the next word retires it), **a fuzzy
  toggle not erasing the learner on disk** (REQ-A254), the write path (unique staging
  names + concurrent persists never publishing a torn profile), the per-window split
  (REQ-A258): two windows do not share a composition buffer, a commit in one
  leaves the other's code and undo hint alone, the learner/ranking is shared, an undo
  belongs to the window that committed, a preference change applies to every window and
  abandons their buffers, the window map is bounded and prunes what holds nothing, and
  two windows answer from one profile; and the 联想 surface (REQ-A260): an empty buffer
  offers `kind: "predict"` suggestions for what *this* window committed, picking one
  inserts it and teaches nothing (no undo was invented), and suggestions are per window;
  and the **shared instance** the system IME rides (REQ-A1893): a `Clone` is the same
  `ImeInner` (a word taught through `"android-ime"` reaches the WebView's learner), and
  the pseudo-window keeps its own buffer (a half-typed code there is invisible to `MAIN`).
* `crates/amos-ime/examples/size_probe.rs` — the reproducible size measurement quoted
  in §Next-word suggestions: build it with and without `--no-default-features` and
  compare; it also prints whether the engine still composes and what it suggests.
* `frontend-ts/src/__tests__/ime.test.ts` — 18 tests: the wire contract (command
  names + camelCase args), field detection, caret insertion/deletion (including a
  field with no caret, a field **at its `maxlength`** and a clamp that never splits
  a surrogate pair), paging, and the Chinese punctuation table (the mapped glyphs,
  the pass-through for letters/digits/twinless symbols, and the Chinese page's
  contents).
* `frontend-ts/svelte-tests/ime-keyboard.svelte.test.ts` (31) and
  `ime-overlay.svelte.test.ts` (42) — the key grid, candidate bar, pager (clamped,
  ends disabled), settings panel with the dictionary/mode readout, commit hint,
  the bridge-failure notice, the 联想 bar (tagged suggestions render with an empty
  buffer and no pinyin chip, picking one reports its absolute index, and typing takes
  the bar back), and the behavior contract (compose → commit at the
  caret, backspace order, symbols while composing, page reset, English mode +
  shift, read-only refusal, Escape cancelling the composition, the no-engine
  degradation, live store sync with the Settings switch, the **physical keyboard**
  driving the same engine without leaking keys to the field or the shell's
  shortcuts — including the *shared* rule for symbols, an out-of-range digit and
  Space with nothing to commit, and Tab/arrows being left to the field —
  confirmation before forgetting everything, abandoning the code when
  the field goes away, and a field that was **removed from the document** never
  being written to). The Chinese punctuation contract is here too: the
  Chinese-mode page types `，。？` (and keeps digits ASCII), the English page keeps
  `.`, a physical `,` commits first and reads as `，` with *and* without a
  composition, and a twinless `@` is left to the field.
* `frontend-ts/svelte-tests/settings-ime.svelte.test.ts` (5) — the Settings page:
  the switch writes the keyboard's preference **and follows the keyboard's own
  change**, the fuzzy controls call the same
  commands, the destructive reset asks first, and no engine ⇒ no inert controls.
* `crates/amos-tauri/src/android_ime.rs` — **7** host tests: the wire encoder's exact
  bytes for a composing session, the `commit`/`undo` records, the honest empty buffer,
  a candidate containing a newline staying one record, and a key through the service
  window encoding real candidates.
* `android-glue/tests/.../ImeWireTest.kt` (9), `ImeLayoutTest.kt` (10),
  `ImeRoutingTest.kt` (14) — the system IME's host-JVM half: the wire decoder
  (every record, the escaping round trip, an unknown record tolerated, a null/empty
  answer meaning *unavailable*), the layout/punctuation/pager tables pinned against
  the `frontend-ts/src/lib/ime.ts` literals, and every arm of §Key behaviours
  (space/enter commit-or-literal, backspace order, the `1–9` shortcut and its
  off-page/digit-zero fallbacks, punctuation becoming Chinese after the commit).
  Run by `make android-glue-check` (`scripts/android-glue-nv21-check.sh`).

package com.amos.ai.glue

/**
 * ImeRouting — the **key behaviour table** of `docs/input-method.md` §Key behaviours,
 * expressed as a pure function so it can be pinned on a host JVM instead of only on a
 * device (REQ-A1893, the system IME).
 *
 * The engine (`amos-ime`) only ever sees ASCII letters: a key that is not a letter must
 * *commit the composition first* and then be inserted literally, or the symbol would
 * land **in front of** the Chinese the user typed while the code stayed composing
 * behind it. That ordering rule, the space/enter rule, the backspace order and the
 * `1–9` candidate shortcut are exactly what [decide] encodes — one function, so the
 * rule cannot depend on which key produced the keystroke (the same "both keyboards call
 * the same function" argument the WebView keyboard makes).
 *
 * This is a **platform-side copy** of the TS rule (`ImeOverlay.svelte`'s `press` /
 * `typeNonLetter`); `ImeRoutingTest.kt` pins every arm so the two cannot drift
 * silently. The engine remains the single source of truth for ranking — this object
 * only decides *where a key goes*.
 */
object ImeRouting {

    /** What kind of key was pressed. */
    enum class KeyKind { LETTER, DIGIT, PUNCTUATION, SPACE, ENTER, BACKSPACE }

    /** One key: its [kind] and its (single-character) [ch] glyph. */
    data class Key(val kind: KeyKind, val ch: String)

    /** The decision for one key. */
    sealed interface Action {
        /** Feed [ch] to the engine's pinyin buffer (`nativeKey`). */
        data class Compose(val ch: String) : Action

        /** Commit the candidate at this **page-relative** index (the page shows it). */
        data class Commit(val pageIndex: Int) : Action

        /** Commit the in-flight composition, then insert [text] literally. */
        data class CommitThenInsert(val text: String) : Action

        /** Delete one buffered pinyin letter (the buffer is not empty). */
        object Backspace : Action

        /** Delete one character in the target field (nothing is composing). */
        object DeleteInField : Action

        /** Insert [text] literally, with nothing to commit first. */
        data class Insert(val text: String) : Action

        /**
         * Enter with nothing to commit: the target field's own newline / editor action.
         * The service decides *how* (a multiline field gets `"\n"`, a single-line one its
         * `imeOptions` action) — there is no candidate involved here.
         */
        object Enter : Action
    }

    /**
     * Decide where [key] goes.
     *
     * @param composing whether a pinyin code is in flight (the engine's `composing`).
     * @param candidatesOnPage how many candidates the current page shows — space/enter
     *   only commit through it, because a buffer the dictionary has no candidate for
     *   still means a space rather than vanishing.
     * @param highlighted the page-relative index of the highlighted candidate.
     * @param chineseMode whether the Chinese glyph of a punctuation key applies.
     */
    fun decide(
        key: Key,
        composing: Boolean,
        candidatesOnPage: Int,
        highlighted: Int,
        chineseMode: Boolean,
    ): Action = when (key.kind) {
        // Letters compose in Chinese mode; in English mode they are typed literally
        // (the engine never sees them, so nothing is buffered behind the field).
        KeyKind.LETTER ->
            if (chineseMode || composing) Action.Compose(key.ch) else Action.Insert(key.ch)

        // Space / Enter commit the highlighted candidate while composing; with nothing
        // to commit they mean what they say.
        KeyKind.SPACE ->
            if (composing && candidatesOnPage > 0) Action.Commit(highlighted) else Action.Insert(" ")

        KeyKind.ENTER ->
            if (composing && candidatesOnPage > 0) Action.Commit(highlighted) else Action.Enter

        // One key, two meanings, in the order a user expects: edit the pinyin first.
        KeyKind.BACKSPACE -> if (composing) Action.Backspace else Action.DeleteInField

        // A digit picks the candidate on the showing page; a digit the page has no
        // candidate for is still typed literally — but only after the code the user
        // typed before it is committed, so the field reads `中国7` rather than `7中国`.
        //
        // The `composing && …` guard is the WebView's `composing && candidates.length
        // > 0`, not bare `composing`: with nothing to commit there is no "first", and
        // committing nothing would only re-read the state (the engine's `commit` is a
        // no-op past the candidate list, so the field text is the same either way).
        KeyKind.DIGIT -> {
            val n = key.ch.firstOrNull()?.minus('0') ?: 0
            val hasCandidates = composing && candidatesOnPage > 0
            when {
                hasCandidates && n in 1..candidatesOnPage -> Action.Commit(n - 1)
                hasCandidates -> Action.CommitThenInsert(key.ch)
                else -> Action.Insert(key.ch)
            }
        }

        // Punctuation: the Chinese glyph in Chinese mode, and never fed to the engine.
        KeyKind.PUNCTUATION -> {
            val ch = if (chineseMode) ImeLayout.toChinesePunctuation(key.ch) else key.ch
            if (composing && candidatesOnPage > 0) Action.CommitThenInsert(ch) else Action.Insert(ch)
        }
    }
}

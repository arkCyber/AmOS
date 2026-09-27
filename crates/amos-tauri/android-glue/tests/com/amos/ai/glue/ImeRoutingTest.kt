package com.amos.ai.glue

import com.amos.ai.glue.ImeRouting.Action
import com.amos.ai.glue.ImeRouting.Key
import com.amos.ai.glue.ImeRouting.KeyKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Host-JVM tests for the IME **key behaviour table** (REQ-A1893, F-DEV-161).
 *
 * [ImeRouting.decide] encodes `docs/input-method.md` §Key behaviours, which
 * `ImeOverlay.svelte` implements for the WebView keyboard (`press` / `typeNonLetter` /
 * `onBackspace`). Every arm is pinned here against that authoritative behaviour, so the
 * platform-side copy cannot drift silently. The one rule with teeth: a non-letter key
 * must **commit the in-flight code first**, or the symbol lands in front of the Chinese
 * the user typed while the code stays composing behind it.
 *
 * Run: `scripts/android-glue-nv21-check.sh`.
 */
class ImeRoutingTest {

    private fun letter(ch: String) = Key(KeyKind.LETTER, ch)
    private fun digit(ch: String) = Key(KeyKind.DIGIT, ch)
    private fun punct(ch: String) = Key(KeyKind.PUNCTUATION, ch)
    private val space = Key(KeyKind.SPACE, " ")
    private val enter = Key(KeyKind.ENTER, "\n")
    private val backspace = Key(KeyKind.BACKSPACE, "\b")

    private fun decide(
        key: Key,
        composing: Boolean = false,
        candidatesOnPage: Int = 0,
        highlighted: Int = 0,
        chineseMode: Boolean = true,
    ) = ImeRouting.decide(key, composing, candidatesOnPage, highlighted, chineseMode)

    // --- letters -------------------------------------------------------------

    @Test
    fun aLetterComposesInChineseMode() {
        assertEquals(Action.Compose("n"), decide(letter("n")))
    }

    @Test
    fun aLetterIsLiteralInEnglishMode() {
        assertEquals(Action.Insert("n"), decide(letter("n"), chineseMode = false))
    }

    // --- space / enter -------------------------------------------------------

    @Test
    fun spaceCommitsTheHighlightedCandidateWhileComposing() {
        assertEquals(Action.Commit(2), decide(space, composing = true, candidatesOnPage = 5, highlighted = 2))
    }

    @Test
    fun spaceIsALiteralSpaceWithNothingToCommit() {
        assertEquals(Action.Insert(" "), decide(space, composing = false, candidatesOnPage = 5))
        // A code the dictionary has no candidate for is not an exception: the key must
        // never vanish into nothing.
        assertEquals(Action.Insert(" "), decide(space, composing = true, candidatesOnPage = 0))
    }

    @Test
    fun enterCommitsWhileComposingAndIsTheEditorActionOtherwise() {
        assertEquals(Action.Commit(1), decide(enter, composing = true, candidatesOnPage = 3, highlighted = 1))
        assertEquals(Action.Enter, decide(enter, composing = false, candidatesOnPage = 3))
        assertEquals(Action.Enter, decide(enter, composing = true, candidatesOnPage = 0))
    }

    // --- backspace -----------------------------------------------------------

    @Test
    fun backspaceEditsThePinyinFirst() {
        assertEquals(Action.Backspace, decide(backspace, composing = true))
        assertEquals(Action.DeleteInField, decide(backspace, composing = false))
    }

    // --- digits --------------------------------------------------------------
    //
    // A digit key on the service's own grid is an **on-screen** key, so it follows the
    // on-screen rule (`press` → `typeNonLetter`): commit the in-flight code first, then
    // type the digit half-width. It is NOT the physical `1–9` candidate shortcut — that
    // lives in `ImeOverlay.svelte`'s `onKeyDown` (`/^[1-9]$/`), and the service has no
    // physical-key path at all (a key it does not act on is handed to the field), so the
    // shortcut has no counterpart here.

    @Test
    fun anOnScreenDigitCommitsTheCodeFirstAndThenTypesHalfWidth() {
        assertEquals(Action.CommitThenInsert("3"), decide(digit("3"), composing = true, candidatesOnPage = 5))
        assertEquals(Action.CommitThenInsert("1"), decide(digit("1"), composing = true, candidatesOnPage = 5))
        assertEquals(Action.CommitThenInsert("0"), decide(digit("0"), composing = true, candidatesOnPage = 5))
    }

    /** The digit is typed, never *picked*: `1` must not become the first candidate. */
    @Test
    fun aDigitNeverPicksACandidate() {
        assertNotEquals(Action.Commit(0), decide(digit("1"), composing = true, candidatesOnPage = 5))
        assertNotEquals(Action.Commit(2), decide(digit("3"), composing = true, candidatesOnPage = 5))
    }

    /** One non-letter rule: a digit and a punctuation key agree whenever the glyph is ASCII. */
    @Test
    fun aDigitAndAnUnmappedPunctuationKeyRouteIdentically() {
        assertEquals(
            decide(punct("3"), composing = true, candidatesOnPage = 5),
            decide(digit("3"), composing = true, candidatesOnPage = 5),
        )
    }

    @Test
    fun aDigitIsLiteralWhenNothingIsComposing() {
        assertEquals(Action.Insert("3"), decide(digit("3"), composing = false, candidatesOnPage = 5))
    }

    /** Composing with no candidates: there is nothing to commit, so it is a bare insert. */
    @Test
    fun aDigitWithNoCandidatesIsJustInserted() {
        assertEquals(Action.Insert("3"), decide(digit("3"), composing = true, candidatesOnPage = 0))
    }

    // --- punctuation ---------------------------------------------------------

    @Test
    fun punctuationBecomesChineseInChineseModeAfterTheCommit() {
        assertPunctBecomes(",", "，", chineseMode = true)
        assertPunctBecomes(".", "。", chineseMode = true)
        assertPunctBecomes("?", "？", chineseMode = true)
        assertPunctBecomes("\"", "“", chineseMode = true)
    }

    @Test
    fun punctuationStaysTheKeyboardGlyphInEnglishMode() {
        assertPunctBecomes(",", ",", chineseMode = false)
        assertPunctBecomes(".", ".", chineseMode = false)
    }

    /** Chinese mode with an empty buffer still means the Chinese glyph (`，`, never `,`). */
    @Test
    fun chinesePunctuationAppliesWithNothingComposing() {
        assertEquals(Action.Insert("，"), decide(punct(","), composing = false, chineseMode = true))
    }

    private fun assertPunctBecomes(ascii: String, expected: String, chineseMode: Boolean) {
        assertEquals(
            Action.CommitThenInsert(expected),
            decide(punct(ascii), composing = true, candidatesOnPage = 4, chineseMode = chineseMode),
        )
    }
}

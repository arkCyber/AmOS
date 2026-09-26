package com.amos.ai.glue

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-JVM tests for the IME key layout and pager (REQ-A1893, F-DEV-161).
 *
 * [ImeLayout] is a **deliberate duplication** of `frontend-ts/src/lib/ime.ts` — the
 * WebView keyboard is the source of truth for *which keys exist* and *what a
 * punctuation key means in Chinese mode*. These assertions spell the TS literals out
 * as the authority rather than referencing the Kotlin tables, so a drift on either side
 * is a red test rather than two implementations quietly disagreeing. `PAGE_SIZE` is the
 * one place the WebView side is also pinned (`IME_CANDIDATE_PAGE_SIZE`).
 *
 * Run: `scripts/android-glue-nv21-check.sh`.
 */
class ImeLayoutTest {

    /** `IME_LETTER_ROWS` — `frontend-ts/src/lib/ime.ts`. */
    private val tsLetterRows = listOf(
        listOf("q", "w", "e", "r", "t", "y", "u", "i", "o", "p"),
        listOf("a", "s", "d", "f", "g", "h", "j", "k", "l"),
        listOf("z", "x", "c", "v", "b", "n", "m"),
    )

    /** `IME_SYMBOL_ROWS`. */
    private val tsSymbolRows = listOf(
        listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "0"),
        listOf("-", "/", ":", ";", "(", ")", "\$", "&", "@", "\""),
        listOf(".", ",", "?", "!", "'", "*", "#", "%", "+", "="),
    )

    /** `IME_ZH_SYMBOL_ROWS`. */
    private val tsZhSymbolRows = listOf(
        listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "0"),
        listOf("，", "。", "？", "！", "、", "：", "；", "“", "”", "…"),
        listOf("（", "）", "《", "》", "【", "】", "「", "」", "‘", "’"),
    )

    /** `ZH_PUNCTUATION` — every mapped ASCII char and its Chinese form. */
    private val tsZhPunctuation = mapOf(
        "," to "，", "." to "。", "?" to "？", "!" to "！", ":" to "：", ";" to "；",
        "(" to "（", ")" to "）", "<" to "《", ">" to "》", "[" to "【", "]" to "】",
        "{" to "「", "}" to "」", "\\" to "、", "'" to "‘", "\"" to "“",
    )

    @Test
    fun letterRowsMatchTheWebViewKeyboard() {
        assertEquals(tsLetterRows, ImeLayout.LETTER_ROWS)
    }

    @Test
    fun symbolRowsMatchTheWebViewKeyboard() {
        assertEquals(tsSymbolRows, ImeLayout.SYMBOL_ROWS)
        assertEquals(tsZhSymbolRows, ImeLayout.ZH_SYMBOL_ROWS)
    }

    @Test
    fun thePageSizeMatchesTheWebViewPager() {
        assertEquals(8, ImeLayout.PAGE_SIZE)
    }

    /** The Chinese symbol page keeps half-width digits (a phone field wants `12`, not `１２`). */
    @Test
    fun chineseSymbolPageKeepsHalfWidthDigits() {
        assertEquals(tsSymbolRows[0], ImeLayout.ZH_SYMBOL_ROWS[0])
    }

    @Test
    fun everyWebViewPunctuationMappingIsMirrored() {
        for ((ascii, zh) in tsZhPunctuation) {
            assertEquals("Chinese form of '$ascii'", zh, ImeLayout.toChinesePunctuation(ascii))
        }
    }

    /** An unmapped key has no Chinese twin (`@`, `#`, digits, letters) and passes through. */
    @Test
    fun aKeyWithNoChineseTwinPassesThrough() {
        for (ch in listOf("@", "#", "%", "+", "=", "*", "a", "7", "￥")) {
            assertEquals(ch, ImeLayout.toChinesePunctuation(ch))
        }
    }

    @Test
    fun theSymbolPageIsModeDependentButTheLetterPageIsNot() {
        assertEquals(tsSymbolRows, ImeLayout.rows(letters = false, chineseMode = false))
        assertEquals(tsZhSymbolRows, ImeLayout.rows(letters = false, chineseMode = true))
        assertEquals(tsLetterRows, ImeLayout.rows(letters = true, chineseMode = false))
        assertEquals(tsLetterRows, ImeLayout.rows(letters = true, chineseMode = true))
    }

    /** Shift is one-shot and case-insensitive pinyin makes it meaningless in Chinese mode. */
    @Test
    fun shiftIsOfferedOnlyInEnglishMode() {
        assertFalse(ImeLayout.shiftAllowed(chineseMode = true))
        assertTrue(ImeLayout.shiftAllowed(chineseMode = false))
    }

    @Test
    fun thePagerAlwaysOffersAtLeastOnePage() {
        assertEquals(1, ImeLayout.pageCount(0))
        assertEquals(1, ImeLayout.pageCount(1))
        assertEquals(1, ImeLayout.pageCount(8))
        assertEquals(2, ImeLayout.pageCount(9))
        assertEquals(2, ImeLayout.pageCount(16))
        assertEquals(3, ImeLayout.pageCount(17))
    }

    @Test
    fun thePageSlicesByPageSizeAndClamps() {
        val items = (1..20).toList()
        assertEquals(items.subList(0, 8), ImeLayout.page(items, 0))
        assertEquals(items.subList(8, 16), ImeLayout.page(items, 1))
        assertEquals(items.subList(16, 20), ImeLayout.page(items, 2))
        // A page past the end clamps to the last page rather than returning nothing.
        assertEquals(items.subList(16, 20), ImeLayout.page(items, 9))
        // A negative page clamps to the first.
        assertEquals(items.subList(0, 8), ImeLayout.page(items, -3))
        assertTrue(ImeLayout.page(emptyList<String>(), 0).isEmpty())
    }
}

package com.amos.ai.glue

/**
 * ImeLayout — the key grid, the Chinese-punctuation table and the candidate pager,
 * mirrored from the WebView keyboard's `frontend-ts/src/lib/ime.ts` (REQ-A1893, the
 * system IME).
 *
 * This is a **deliberate duplication** and the honest boundary of the system IME: the
 * engine (`amos-ime`) is the single source of truth for *candidates*, but *which keys
 * exist* and *what a punctuation key means in Chinese mode* are platform facts the
 * Kotlin service cannot import from TypeScript. `ImeLayoutTest.kt` pins each table
 * against the TS literals so the two cannot drift unnoticed — and the 8-per-page pager
 * mirrors `IME_CANDIDATE_PAGE_SIZE`.
 */
object ImeLayout {

    /** Candidates shown per page before the pager kicks in (`IME_CANDIDATE_PAGE_SIZE`). */
    const val PAGE_SIZE = 8

    /** QWERTY letter page. */
    val LETTER_ROWS: List<List<String>> = listOf(
        listOf("q", "w", "e", "r", "t", "y", "u", "i", "o", "p"),
        listOf("a", "s", "d", "f", "g", "h", "j", "k", "l"),
        listOf("z", "x", "c", "v", "b", "n", "m"),
    )

    /** Digits + ASCII punctuation page (the `?123` key in **English** mode). */
    val SYMBOL_ROWS: List<List<String>> = listOf(
        listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "0"),
        listOf("-", "/", ":", ";", "(", ")", "\$", "&", "@", "\""),
        listOf(".", ",", "?", "!", "'", "*", "#", "%", "+", "="),
    )

    /**
     * Digits + **Chinese** punctuation page — what `?123` shows in Chinese mode.
     * Digits stay half-width on purpose: `１２３` is never what a phone-number field
     * wants (the same rule the WebView page follows).
     */
    val ZH_SYMBOL_ROWS: List<List<String>> = listOf(
        listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "0"),
        listOf("，", "。", "？", "！", "、", "：", "；", "“", "”", "…"),
        listOf("（", "）", "《", "》", "【", "】", "「", "」", "‘", "’"),
    )

    /**
     * The ASCII→Chinese (full-width) punctuation a key becomes in Chinese mode. Only
     * punctuation with an unambiguous Chinese form is mapped; a straight quote has no
     * single Chinese form (a Chinese quotation is a *pair*), so it maps to the
     * **opening** glyph rather than guessing an alternation from invisible state.
     */
    private val ZH_PUNCTUATION: Map<String, String> = mapOf(
        "," to "，",
        "." to "。",
        "?" to "？",
        "!" to "！",
        ":" to "：",
        ";" to "；",
        "(" to "（",
        ")" to "）",
        "<" to "《",
        ">" to "》",
        "[" to "【",
        "]" to "】",
        "{" to "「",
        "}" to "」",
        "\\" to "、",
        "'" to "‘",
        "\"" to "“",
    )

    /** The Chinese form of an ASCII punctuation key, or the key itself when it has none. */
    fun toChinesePunctuation(ch: String): String = ZH_PUNCTUATION[ch] ?: ch

    /** The rows for a mode: the letter page, or the mode-dependent symbol page. */
    fun rows(letters: Boolean, chineseMode: Boolean): List<List<String>> = when {
        letters -> LETTER_ROWS
        chineseMode -> ZH_SYMBOL_ROWS
        else -> SYMBOL_ROWS
    }

    /**
     * Shift is one-shot and only means anything in English mode — pinyin is
     * case-insensitive, so the key is **not offered** in Chinese mode (and the arm is
     * dropped when the mode changes). Mirrors the WebView rule.
     */
    fun shiftAllowed(chineseMode: Boolean): Boolean = !chineseMode

    /**
     * The glyph a letter key types with the one-shot shift armed — the WebView's `tap`
     * (`upper ? glyph.toUpperCase() : glyph`). Applied to the label the key **shows** and
     * the glyph it **routes** alike, so the two cannot disagree, and a no-op for the
     * digits/punctuation keys, which have no case.
     */
    fun shifted(ch: String, upper: Boolean): String = if (upper) ch.uppercase() else ch

    /** Number of candidate pages for [total] candidates (always at least 1). */
    fun pageCount(total: Int): Int = maxOf(1, ceilDiv(maxOf(0, total), PAGE_SIZE))

    /** The slice of [items] on [page] (0-based), clamped to the available data. */
    fun <T> page(items: List<T>, page: Int): List<T> {
        val pages = pageCount(items.size)
        val clamped = minOf(maxOf(0, page), pages - 1)
        val start = clamped * PAGE_SIZE
        return items.subList(start, minOf(start + PAGE_SIZE, items.size))
    }

    /** Round-up integer division, `Int`-only so the pager never touches floating point. */
    private fun ceilDiv(a: Int, b: Int): Int = (a + b - 1) / b
}

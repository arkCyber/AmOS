package com.amos.ai.glue

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-JVM tests for the IME wire decoder (REQ-A1893, F-DEV-161).
 *
 * The Rust half (`crates/amos-tauri/src/android_ime.rs::encode_state`) writes a
 * line/tab wire; this is the reader. Both halves are pure, so the contract is pinned
 * on both sides rather than only on a device — the point of the escape scheme is that
 * a candidate containing a tab or a newline (a paste, an emoji-variant glyph) must not
 * split into a second column or a second record and silently corrupt the session.
 *
 * Run: `scripts/android-glue-nv21-check.sh` (mirrors the glue and runs this source set
 * on the host JVM), like `AlarmIdentityTest`.
 */
class ImeWireTest {

    /** The exact bytes `android_ime.rs`'s `encode_state` writes for `zhongguo` → 中国. */
    private val rustAnswer =
        "input\tzhongguo\n" +
            "composing\t1\n" +
            "strict\t1\n" +
            "commit\t\n" +
            "undo\tzhongguo\n" +
            "cand\tdict\t中国\n" +
            "cand\tsentence\t中过\n"

    @Test
    fun parsesEveryRecordTheRustWriterEmits() {
        val s = ImeWire.parse(rustAnswer)!!
        assertEquals("zhongguo", s.input)
        assertTrue(s.composing)
        assertTrue(s.strict)
        assertEquals("", s.committed)
        assertEquals("zhongguo", s.undoCode)
        assertEquals(
            listOf(ImeWire.Candidate("dict", "中国"), ImeWire.Candidate("sentence", "中过")),
            s.candidates,
        )
    }

    @Test
    fun aCommitCarriesTheInsertedText() {
        val s = ImeWire.parse("composing\t0\ncommit\t中国\nundo\t\n")!!
        assertFalse(s.composing)
        assertEquals("中国", s.committed)
        assertEquals("", s.undoCode)
        assertTrue(s.candidates.isEmpty())
    }

    /** A null answer is the engine being unavailable, not an empty session. */
    @Test
    fun aNullAnswerIsUnavailable() {
        assertNull(ImeWire.parse(null))
    }

    /**
     * An empty string is also unavailable: Rust always writes the fixed records, so a
     * bridge that answered nothing at all is not a session the service may draw.
     */
    @Test
    fun aRecordlessAnswerIsUnavailable() {
        assertNull(ImeWire.parse(""))
        assertNull(ImeWire.parse("\n\n"))
    }

    /**
     * A newer Rust writer must not make an older service refuse the session: an unknown
     * record is skipped, and the records it does know are still read.
     */
    @Test
    fun anUnknownRecordIsIgnoredNotFatal() {
        val s = ImeWire.parse("composing\t1\nfuture-thing\ta\tb\tc\ncand\tdict\t好\n")!!
        assertEquals("好", s.candidates.single().text)
        assertTrue(s.composing)
    }

    /** A record with no payload (a truncated line) folds to the empty default, not a crash. */
    @Test
    fun aRecordWithNoPayloadFoldsToEmpty() {
        val s = ImeWire.parse("input\ncommit\nundo\ncand\tdict\n")!!
        assertEquals("", s.input)
        assertEquals("", s.committed)
        assertEquals("", s.undoCode)
        assertEquals(ImeWire.Candidate("dict", ""), s.candidates.single())
    }

    @Test
    fun escapeAndUnescapeRoundTripTheDelimiters() {
        for (raw in listOf("中国", "a\tb", "a\nb", "a\\b", "\\", "a\\", "a\t\n\\b", "")) {
            assertEquals("round trip failed for ${raw.encodeToByteArray().size} byte(s)", raw, ImeWire.unescape(ImeWire.escape(raw)))
        }
    }

    /**
     * The premise the escape scheme exists for: without escaping, a candidate carrying a
     * tab would arrive as an extra column and one carrying a newline as an extra record.
     * Measured here rather than asserted in prose.
     */
    @Test
    fun anUnescapedDelimiterWouldCorruptTheRecord() {
        val hostile = "中国\tX"
        val raw = "cand\tdict\t" + hostile
        val fields = raw.split('\t', '\n')
        assertTrue("the unescaped payload must split into more columns", fields.size > 3)

        val escaped = ImeWire.escape(hostile)
        val ok = raw.replace(hostile, escaped).split('\n')
        assertEquals(1, ok.size)
        val parsed = ImeWire.parse("cand\tdict\t$escaped\n")!!
        assertEquals(hostile, parsed.candidates.single().text)
    }

    @Test
    fun aTrailingLoneBackslashIsKeptVerbatim() {
        assertEquals("a\\", ImeWire.unescape("a\\"))
        assertEquals("\\x", ImeWire.unescape("\\x"))
    }
}

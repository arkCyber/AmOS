package com.amos.ai.glue

/**
 * ImeWire — the decoder for the line/tab wire the Rust bridge answers
 * (`crates/amos-tauri/src/android_ime.rs::encode_state`; REQ-A1893, the system IME).
 *
 * Why not JSON: Android ships `org.json`, but this object must stay **host-JVM
 * testable** (there is no `org.json` on a plain JVM), so the Rust side writes
 * newline-separated, tab-separated records with `\\`/`\t`/`\n` escaped instead —
 * `escape_field` in Rust is the writer, [unescape] here is the reader, and each half
 * is pinned by its own test (`ImeWireTest.kt` / `android_ime.rs`'s `#[cfg(test)]`).
 *
 * The shape, one record per line:
 *
 * ```
 * input\t<code>
 * composing\t<0|1>
 * strict\t<0|1>
 * commit\t<text>            (always written; empty = nothing was inserted)
 * undo\t<code>              (the undoable dictionary pick's code; empty = nothing to forget)
 * cand\t<kind>\t<text>      (0..n, kind is dict | sentence | predict)
 * ```
 *
 * A null (or unparseable) answer is the engine being unavailable, not an empty
 * session: the caller reads `null` and degrades to literal typing rather than drawing
 * a Chinese keyboard that would swallow every letter — the same rule the WebView
 * overlay follows when the bridge does not answer.
 */
object ImeWire {

    /** One `cand` record: [kind] is `dict` / `sentence` / `predict`, [text] the glyphs. */
    data class Candidate(val kind: String, val text: String)

    /**
     * A decoded session state. [undoCode] is the last **dictionary** commit's pinyin code,
     * non-empty only while forgetting it would do something — a sentence/suggestion pick
     * carries nothing, so the service never draws a forget button that is a no-op.
     */
    data class Snapshot(
        val input: String,
        val composing: Boolean,
        val strict: Boolean,
        val committed: String,
        val undoCode: String,
        val candidates: List<Candidate>,
    )

    private const val FIELD = '\t'
    private const val RECORD = '\n'
    private const val ESCAPE = '\\'

    /**
     * Decode one answer; `null` when the raw string is null (the engine is unavailable)
     * or carries no record at all. Rust always writes the four fixed records, so an
     * empty string is not a legitimate session — treating it as unavailable is honest.
     */
    fun parse(raw: String?): Snapshot? {
        if (raw == null) return null
        var input = ""
        var composing = false
        var strict = false
        var committed = ""
        var undoCode = ""
        val candidates = mutableListOf<Candidate>()
        var sawRecord = false
        for (line in raw.split(RECORD)) {
            if (line.isEmpty()) continue
            val fields = line.split(FIELD).map { unescape(it) }
            sawRecord = true
            when (fields[0]) {
                "input" -> input = fields.getOrElse(1) { "" }
                "composing" -> composing = fields.getOrElse(1) { "0" } == "1"
                "strict" -> strict = fields.getOrElse(1) { "0" } == "1"
                "commit" -> committed = fields.getOrElse(1) { "" }
                "undo" -> undoCode = fields.getOrElse(1) { "" }
                "cand" -> candidates.add(
                    Candidate(fields.getOrElse(1) { "" }, fields.getOrElse(2) { "" }),
                )
                // An unknown record is ignored rather than fatal: a newer Rust writer that
                // adds a field must not make an older service refuse the whole session.
                else -> Unit
            }
        }
        return if (sawRecord) {
            Snapshot(input, composing, strict, committed, undoCode, candidates)
        } else {
            null
        }
    }

    /** Escape one field so it cannot split into a second column or record. Mirrors Rust `escape_field`. */
    fun escape(field: String): String {
        val out = StringBuilder(field.length)
        for (c in field) {
            when (c) {
                ESCAPE -> out.append("\\\\")
                FIELD -> out.append("\\t")
                RECORD -> out.append("\\n")
                else -> out.append(c)
            }
        }
        return out.toString()
    }

    /** Undo [escape]. A trailing lone backslash is kept verbatim (nothing to unescape it into). */
    fun unescape(field: String): String {
        if (!field.contains(ESCAPE)) return field
        val out = StringBuilder(field.length)
        var i = 0
        while (i < field.length) {
            val c = field[i]
            if (c == ESCAPE && i + 1 < field.length) {
                when (field[i + 1]) {
                    ESCAPE -> { out.append(ESCAPE); i += 2 }
                    't' -> { out.append(FIELD); i += 2 }
                    'n' -> { out.append(RECORD); i += 2 }
                    else -> { out.append(c); i += 1 }
                }
            } else {
                out.append(c)
                i += 1
            }
        }
        return out.toString()
    }
}

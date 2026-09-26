package com.amos.ai.glue

/**
 * AmOS 输入法 — the **pure** half of the system-IME entry point (REQ-A1904).
 *
 * Why a separate file: the Android-dependent half ([ImeSettingsGlue]) reads
 * `InputMethodManager`, which a host JVM does not have — so the *wire* it writes is kept
 * here, on a plain object with no Android imports, and pinned by `ImeSettingsTest.kt`.
 * The Rust reader is `crates/amos-tauri/src/ime.rs`'s `parse_platform_ime_facts`, which
 * owns the other side of the same contract.
 *
 * **A failed read writes no fact lines.** That is the whole point of `unavailable`: the
 * caller asked "is AmOS's keyboard enabled and in force?" and the platform did not
 * answer, so `current` / `ours_enabled` / `ours_selected` are *absent* — not `""`, not
 * `false`. A reader that defaulted `ours_enabled` to `false` would be putting the
 * platform's own sentence ("not enabled") in the mouth of a question that was never
 * answered — the family `nfc_status` paid for (REQ-A775 / F-AND-007), where five
 * different failures all arrived at the screen as "this device has no NFC hardware".
 *
 * The format is the same line/tab one `ImeWire` uses, and for the same reason: no
 * `org.json` on a plain JVM, so a JSON wire would make the pure half untestable.
 * Record = `<name>\t<value>\n`; a value never contains a tab or a newline (see
 * [sanitize]).
 */
internal object ImeSettings {

    /** The platform answered: every fact line below is present. */
    const val STATE_OK = "ok"

    /** The platform could not be asked; `why` carries its own words. **No fact lines.** */
    const val STATE_UNAVAILABLE = "unavailable"

    private const val FIELD = '\t'
    private const val RECORD = '\n'

    /**
     * A read that reached the platform.
     *
     * `currentId` may legitimately be **empty** — that is the platform saying "no
     * keyboard is currently selected", which is a measurement, not a missing answer.
     * It is written even when empty for exactly that reason.
     */
    fun ok(currentId: String, oursEnabled: Boolean, oursSelected: Boolean): String =
        buildString {
            record("state", STATE_OK)
            record("current", sanitize(currentId))
            record("ours_enabled", flag(oursEnabled))
            record("ours_selected", flag(oursSelected))
        }

    /**
     * A read that did not reach the platform — no `InputMethodManager`, or a
     * `Throwable` on the way. `why` is the exception's class + message, so the user
     * sees the platform's own complaint instead of a generic sentence.
     */
    fun unavailable(why: String): String =
        buildString {
            record("state", STATE_UNAVAILABLE)
            record("why", sanitize(why))
        }

    private fun flag(value: Boolean) = if (value) "1" else "0"

    /**
     * Flatten a value onto one line. A record is `<name>\t<value>` up to the next
     * newline, so a tab or a newline inside a value would end the record early and
     * the remaining text would decode as a *fact* the platform never stated.
     */
    private fun sanitize(value: String) =
        value.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ')

    private fun StringBuilder.record(name: String, value: String) {
        append(name)
        append(FIELD)
        append(value)
        append(RECORD)
    }
}

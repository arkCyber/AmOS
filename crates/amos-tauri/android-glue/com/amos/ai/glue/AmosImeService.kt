package com.amos.ai.glue

import android.annotation.SuppressLint
import android.graphics.Typeface
import android.inputmethodservice.InputMethodService
import android.text.InputType
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * AmOS System UI — the **Android system input method** (`docs/input-method.md`
 * §System IME).
 *
 * Why this class exists: until it did, `amos-ime` had exactly **one** exit — the System
 * UI's own WebView (`ImeOverlay.svelte` + the `ime_*` commands). The platform had no
 * `InputMethodService` anywhere, so no other app on the device (a legacy app in the
 * container, or any app on the no-UI Android base) could select the pinyin keyboard.
 * This is the missing half: the platform binding that makes the same engine reachable
 * from **any** app.
 *
 * **One engine, one learner, two surfaces.** The service does not own an engine: the
 * Rust trampolines in `crates/amos-tauri/src/android_ime.rs` drive the *same*
 * process-wide `ImeBridge` the WebView keyboard drives, under the fixed pseudo-window
 * `"android-ime"`. So a word taught in WeChat ranks first in AmOS's Notes app and vice
 * versa, there is one `amos-ime.json`, and the per-window buffer rule (REQ-A258) keeps
 * this service's half-typed code from leaking into a WebView window. `nativeAttach`
 * hands Rust the profile directory (the app's `filesDir`, i.e. the same
 * `app_data_dir()/files` the WebView bridge uses); if the platform binds the service
 * before the Activity ever booted, Rust boots a bridge from that path instead — an
 * honest fallback, logged, never a panic.
 *
 * The pure halves live beside this class and are pinned on a host JVM: [ImeWire] (the
 * Rust wire), [ImeLayout] (the key grid / Chinese punctuation / pager) and [ImeRouting]
 * (the `docs/input-method.md` §Key behaviours table). What is left here is presentation
 * plus the `InputConnection` plumbing, which needs a live editor.
 *
 * Honest boundary: everything here is compile- and lint-verified on the host
 * (`make android-glue-check`) but the end-to-end "select AmOS 输入法 in Android Settings
 * and type in a third-party app" is a **device verification item** (`docs/input-method.md`
 * §System IME).
 */
class AmosImeService : InputMethodService() {

    /** Which key page is showing; the `?123` page itself is mode-dependent ([ImeLayout]). */
    private enum class Layer { LETTERS, SYMBOLS }

    /** The user's zh/en preference. [zhActive] folds in whether the engine can serve it. */
    private var chineseMode = true
    private var layer = Layer.LETTERS
    private var page = 0
    private var snapshot: ImeWire.Snapshot? = null

    /** `false` until the engine answers; the keyboard then degrades to literal typing. */
    private var engineUp = false

    /** One-shot shift: applies to the *next* letter, and only in English mode (see [upper]). */
    private var shift = false

    /** The mode actually in force: Chinese only while the engine can compose for it. */
    private val zhActive: Boolean get() = chineseMode && engineUp

    /**
     * Whether the letter keys should type their uppercase glyph. Mirrors the WebView's
     * `upper = mode === "en" && shift && !symbols`: the arm means nothing off the letter
     * page, and nothing while the keyboard is typing Chinese (pinyin is case-insensitive).
     */
    private val upper: Boolean get() = !zhActive && shift && layer == Layer.LETTERS

    private var candidateBar: LinearLayout? = null
    private var keysContainer: LinearLayout? = null
    private var pagerLabel: TextView? = null
    private var prevKey: Button? = null
    private var nextKey: Button? = null
    private var shiftKey: Button? = null
    private var modeKey: Button? = null
    private var layerKey: Button? = null
    private var fuzzyKey: Button? = null
    private var forgetKey: Button? = null

    override fun onCreate() {
        super.onCreate()
        // Bind to the shared pinyin engine. A failure is logged, never fatal: the keyboard
        // still types, it just types literally (the same honest degradation the WebView
        // overlay follows when the bridge does not answer).
        try {
            nativeAttach(filesDir.absolutePath)
        } catch (t: Throwable) {
            Log.w(TAG, "pinyin engine unavailable: ${t.javaClass.simpleName}: ${t.message}")
        }
        snapshot = refresh()
        engineUp = snapshot != null
    }

    override fun onCreateInputView(): View {
        snapshot = refresh()
        engineUp = snapshot != null

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(controlRow())
        root.addView(
            HorizontalScrollView(this).apply {
                addView(
                    LinearLayout(this@AmosImeService).apply {
                        orientation = LinearLayout.HORIZONTAL
                        candidateBar = this
                    },
                )
            },
        )
        keysContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(keysContainer)
        root.addView(bottomRow())

        renderKeys()
        render()
        return root
    }

    private fun controlRow(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(chip(FUZZY_STRICT) { toggleFuzzy() }.also { fuzzyKey = it })
        addView(chip("‹") { pageTo(page - 1) }.also { prevKey = it })
        addView(
            TextView(this@AmosImeService).apply {
                gravity = Gravity.CENTER
                pagerLabel = this
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        addView(chip("›") { pageTo(page + 1) }.also { nextKey = it })
        addView(chip(FORGET_LABEL) { forgetLast() }.also { forgetKey = it })
    }

    private fun bottomRow(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(chip(SHIFT_LABEL) { toggleShift() }.also { shiftKey = it })
        addView(chip(MODE_ZH) { toggleMode() }.also { modeKey = it })
        addView(chip(LAYER_SYMBOLS) { toggleLayer() }.also { layerKey = it })
        addKey(this, " ", 2f) { onKey(ImeRouting.Key(ImeRouting.KeyKind.SPACE, " ")) }
        addKey(this, "⏎") { onKey(ImeRouting.Key(ImeRouting.KeyKind.ENTER, "\n")) }
        addKey(this, "⌫") { onKey(ImeRouting.Key(ImeRouting.KeyKind.BACKSPACE, "")) }
    }

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        // A new field means a new session: page one, the letter page, and no stale
        // composition (the buffer is the service's own pseudo-window, shared across every
        // app that focuses here — see the class KDoc).
        page = 0
        layer = Layer.LETTERS
        clearComposition()
        renderKeys()
    }

    override fun onFinishInput() {
        // Losing the field abandons the code — a half-typed pinyin buffer must never land
        // in the next field (the same rule the WebView overlay follows on blur).
        clearComposition()
        super.onFinishInput()
    }

    // ---- keys ----------------------------------------------------------------

    /** Route one key through the shared behaviour table and act on the decision. */
    private fun onKey(key: ImeRouting.Key) {
        val decision = ImeRouting.decide(
            key = key,
            composing = snapshot?.composing == true,
            candidatesOnPage = ImeLayout.page(snapshot?.candidates ?: emptyList(), page).size,
            highlighted = 0,
            chineseMode = zhActive,
        )
        when (decision) {
            is ImeRouting.Action.Compose -> compose(decision.ch)
            is ImeRouting.Action.Commit -> commitAt(decision.pageIndex)
            is ImeRouting.Action.CommitThenInsert -> commitThenInsert(decision.text)
            is ImeRouting.Action.Insert -> insert(decision.text)
            is ImeRouting.Action.Backspace -> backspace()
            is ImeRouting.Action.DeleteInField -> deleteInField()
            is ImeRouting.Action.Enter -> performEnter()
        }
    }

    private fun compose(ch: String) {
        apply(nativeKey(ch))
        page = 0 // a new letter resets the candidate list to page one
        render()
    }

    private fun backspace() {
        apply(nativeBackspace())
        page = 0
        render()
    }

    private fun clearComposition() {
        apply(nativeClear())
        page = 0
        render()
    }

    /** Commit the page-relative candidate [pageIndex] and insert what the engine committed. */
    private fun commitAt(pageIndex: Int) {
        apply(nativeCommit(page * ImeLayout.PAGE_SIZE + pageIndex))
        val text = snapshot?.committed.orEmpty()
        if (text.isNotEmpty()) insert(text)
        page = 0
        render()
    }

    /**
     * Commit the in-flight composition (a symbol key is **not** fed to the engine — it
     * would be swallowed: `type_char` rejects non-letters), then insert [text]. The
     * commit's own text lands first, so the field reads `中国，` rather than `，中国`.
     */
    private fun commitThenInsert(text: String) {
        apply(nativeCommit(page * ImeLayout.PAGE_SIZE))
        val committed = snapshot?.committed.orEmpty()
        if (committed.isNotEmpty()) insert(committed)
        insert(text)
        page = 0
        render()
    }

    private fun forgetLast() {
        apply(nativeForgetLast())
        render()
    }

    /** Apply a fuzzy preset (`严格` / `全部模糊`); the engine rebuilds and clears the buffer. */
    private fun toggleFuzzy() {
        val next = if (snapshot?.strict == true) "permissive" else "strict"
        apply(nativeFuzzyPreset(next))
        page = 0
        render()
    }

    private fun pageTo(next: Int) {
        page = next
        render()
    }

    private fun insert(text: String) {
        currentInputConnection?.commitText(text, 1)
    }

    /**
     * Delete one character from the target field, counting a **non-BMP glyph as one**.
     *
     * `deleteSurroundingText(1, 0)` counts UTF-16 **code units**, so ⌫ over an emoji (or any
     * astral-plane character) removes only the low half of the surrogate pair and leaves a
     * lone high surrogate in the field — a broken string the host then stores (JSON
     * round-trips a lone surrogate). `deleteSurroundingTextInCodePoints` is the platform's
     * own code-point spelling of the same edit (API 24; this app's `minSdk` is 26), the
     * identical hazard the WebView keyboard's `deleteBeforeCaret` refuses at its own
     * boundary (REQ-A1931 ∕ F-SH-931). One ⌫ removes one *character*.
     */
    private fun deleteInField() {
        currentInputConnection?.deleteSurroundingTextInCodePoints(1, 0)
    }

    /**
     * Enter with nothing to commit: a multiline field gets a real newline, anything else
     * gets its own editor action — and a field with neither has none to give, so nothing
     * is inserted rather than a phantom newline.
     */
    private fun performEnter() {
        val info = currentInputEditorInfo
        val multiline = info != null &&
            (info.inputType and InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0
        if (multiline) {
            insert("\n")
            return
        }
        sendDefaultEditorAction(true)
    }

    private fun toggleMode() {
        chineseMode = !chineseMode
        page = 0
        layer = Layer.LETTERS
        // A one-shot modifier must not outlive the mode it belongs to (the WebView's
        // `$effect`): a stale ⇧ can never uppercase the first letter after the user
        // switches back.
        if (zhActive) shift = false
        // Leaving Chinese mode abandons the in-flight code rather than carrying it — the
        // rule the WebView overlay follows.
        if (!zhActive) clearComposition() else render()
        renderKeys()
    }

    /**
     * Arm / disarm the one-shot shift. It means nothing in Chinese mode, so the chip is
     * disabled there and this refuses rather than arming a modifier that could not apply
     * ([ImeLayout.shiftAllowed]).
     */
    private fun toggleShift() {
        if (!ImeLayout.shiftAllowed(zhActive)) return
        shift = !shift
        renderKeys()
    }

    private fun toggleLayer() {
        layer = if (layer == Layer.LETTERS) Layer.SYMBOLS else Layer.LETTERS
        renderKeys()
    }

    /** Decode one engine answer into [snapshot]; a missing answer keeps the last one. */
    private fun apply(wire: String?) {
        val next = ImeWire.parse(wire)
        if (next != null) snapshot = next
    }

    // ---- rendering -----------------------------------------------------------

    /** Reflect the engine's answer: candidate bar, pager, and the two state chips. */
    private fun render() {
        val candidates = snapshot?.candidates ?: emptyList()
        val pages = ImeLayout.pageCount(candidates.size)
        page = minOf(maxOf(0, page), pages - 1)
        renderCandidates(ImeLayout.page(candidates, page))
        renderPager(page, pages)
    }

    private fun renderCandidates(shown: List<ImeWire.Candidate>) {
        val bar = candidateBar ?: return
        bar.removeAllViews()
        // The in-flight pinyin, the way the WebView composer shows it
        // (`ImeKeyboard.svelte`'s `ime-input`). The engine's `input` record was decoded by
        // [ImeWire] but had **no consumer** in this service, so the system keyboard composed
        // blind: the user saw candidates but never the letters they had typed, and a
        // mistyped code was visible only through the wrong candidates. A wire field every
        // surface but one reads is a claim, not a feature (the F-AUD-002 family). The ✕ is
        // the WebView's clear affordance (`onclear` → `ime_clear`); the buffer is the
        // service's own pseudo-window, so this abandons it exactly like losing the field.
        if (snapshot?.composing == true) {
            bar.addView(chip("✕") { clearComposition() })
            bar.addView(
                TextView(this).apply {
                    text = snapshot?.input.orEmpty()
                    typeface = Typeface.MONOSPACE
                    setPadding(CHIP_PAD, CHIP_PAD, CHIP_PAD, CHIP_PAD)
                },
            )
        }
        shown.forEachIndexed { i, candidate ->
            bar.addView(
                TextView(this).apply {
                    text = candidate.text
                    setPadding(CHIP_PAD, CHIP_PAD, CHIP_PAD, CHIP_PAD)
                    isClickable = true
                    setOnClickListener { commitAt(i) }
                },
            )
        }
    }

    /**
     * The pager label and the two state chips.
     *
     * The label is a **numeral pair** (`2/3`), not prose, so it is suppressed rather than
     * translated. The forget chip exists only while `undoCode` is non-empty (a dictionary
     * pick that can still be undone), so it is never a button that does nothing — the
     * engine never offered an undo for a sentence or suggestion pick.
     *
     * The chip's visibility is decided by [forgetChipVisible] on `undoCode` **alone**: a
     * learned word is exactly the case that just emptied the 联想 list (`amos-ime`'s
     * `predictions` needs two commits to say anything), so folding in "are there
     * candidates" would hide the undo precisely when there is something to undo.
     * (REQ-A1896, F-DEV-162)
     */
    @SuppressLint("SetTextI18n") // the pager label is "n/m" — a numeral pair, not translatable prose
    private fun renderPager(current: Int, pages: Int) {
        pagerLabel?.text = "${current + 1}/$pages"
        val multi = pages > 1
        prevKey?.isEnabled = multi && current > 0
        nextKey?.isEnabled = multi && current < pages - 1
        forgetKey?.visibility =
            if (forgetChipVisible(snapshot?.undoCode)) View.VISIBLE else View.GONE
        fuzzyKey?.text = if (snapshot?.strict == true) FUZZY_STRICT else FUZZY_LOOSE
        // Without an engine the strict/fuzzy preference is not a fact anyone measured, so
        // the chip is hidden rather than drawn showing a mode it cannot know.
        fuzzyKey?.visibility = if (engineUp) View.VISIBLE else View.GONE
    }

    /** Rebuild the key grid and the mode/layer labels for the current mode + layer. */
    private fun renderKeys() {
        val container = keysContainer ?: return
        val letters = layer == Layer.LETTERS
        container.removeAllViews()
        for (row in ImeLayout.rows(letters, zhActive)) {
            container.addView(
                LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    for (label in row) {
                        val kind = when {
                            letters -> ImeRouting.KeyKind.LETTER
                            label.firstOrNull()?.isDigit() == true -> ImeRouting.KeyKind.DIGIT
                            else -> ImeRouting.KeyKind.PUNCTUATION
                        }
                        // One glyph for both the label and the routed key, so what the key
                        // shows can never disagree with what the field receives.
                        val typed =
                            if (kind == ImeRouting.KeyKind.LETTER) {
                                ImeLayout.shifted(label, upper)
                            } else {
                                label
                            }
                        addKey(this, typed) { onKey(ImeRouting.Key(kind, typed)) }
                    }
                },
            )
        }
        modeKey?.text = if (zhActive) MODE_ZH else MODE_EN
        // The mode key is disabled without an engine: a Chinese keyboard that swallows
        // every letter is worse than no toggle at all.
        modeKey?.isEnabled = engineUp
        layerKey?.text = if (letters) LAYER_SYMBOLS else LAYER_LETTERS
        // ⇧ is offered only where it can apply (English mode) — the WebView's
        // `disabled={mode !== "en"}` + `opacity-30`. Its armed state is read off the
        // letter keys' case; the chip itself is fully opaque while armed.
        shiftKey?.isEnabled = ImeLayout.shiftAllowed(zhActive)
        shiftKey?.isActivated = shift
        shiftKey?.alpha = when {
            !ImeLayout.shiftAllowed(zhActive) -> 0.3f
            shift -> 1f
            else -> 0.6f
        }
    }

    /** A chrome chip (pager arrows, mode / layer / fuzzy toggles, forget) with its handler. */
    private fun chip(label: String, onClick: () -> Unit): Button =
        Button(this).apply {
            text = label
            isAllCaps = false
            minWidth = 0
            minimumWidth = 0
            setPadding(CHIP_PAD, CHIP_PAD, CHIP_PAD, CHIP_PAD)
            setOnClickListener { onClick() }
        }

    private fun addKey(row: LinearLayout, label: String, weight: Float = 1f, onClick: () -> Unit) {
        val button = chip(label, onClick)
        button.layoutParams =
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, weight)
        row.addView(button)
    }

    /** Probe the engine and answer the decoded state (`null` while it is unavailable). */
    private fun refresh(): ImeWire.Snapshot? = runCatching {
        ImeWire.parse(nativeState())
    }.getOrNull()

    // ---- JNI downcalls into the shared pinyin engine (android_ime.rs) ---------

    /** Bind to the process-wide `ImeBridge`, reading/writing the same `amos-ime.json`. */
    private external fun nativeAttach(filesDir: String)

    private external fun nativeState(): String?

    private external fun nativeKey(ch: String): String?

    private external fun nativeBackspace(): String?

    private external fun nativeClear(): String?

    private external fun nativeCommit(index: Int): String?

    private external fun nativeFuzzyPreset(preset: String): String?

    private external fun nativeForgetLast(): String?

    init {
        // The System UI's Rust staticlib exposes the bridge. Best-effort: a host lint pass
        // has no .so, and the service then degrades to literal typing (logged, not fatal).
        try {
            System.loadLibrary("amos_tauri_lib")
        } catch (_: UnsatisfiedLinkError) {
            Log.w(TAG, "native library unavailable — the IME degrades to literal typing")
        }
    }

    private companion object {
        private const val TAG = "AmosImeService"
        private const val CHIP_PAD = 24
        private const val SHIFT_LABEL = "⇧"
        private const val MODE_ZH = "中"
        private const val MODE_EN = "EN"
        private const val LAYER_SYMBOLS = "?123"
        private const val LAYER_LETTERS = "ABC"
        private const val FUZZY_STRICT = "严格"
        private const val FUZZY_LOOSE = "模糊"
        private const val FORGET_LABEL = "忘记"
    }
}

/**
 * Whether the 「忘记「X」」 chip should be shown, given the wire's `undo` code.
 *
 * The engine sets `last_pick_code` (the wire's `undo` record) **only** for a learnable
 * dictionary pick, so a non-empty code *is* the whole criterion: there is something to
 * forget. This is deliberately **not** folded with "is there a candidate" — a fresh
 * window's first learned word commits with an empty 联想 list (`amos-ime`'s
 * `predictions` returns nothing until two words were committed), which is exactly when
 * the undo matters most. Extracted top-level so a host JVM can pin its truth table
 * (`AmosImeServiceTest`), the same shape `SensorGlue.wellnessRegistered` uses
 * (REQ-A1896, F-DEV-162).
 */
internal fun forgetChipVisible(undoCode: String?): Boolean = !undoCode.isNullOrEmpty()

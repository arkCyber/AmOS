package com.amos.ai.glue

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.SystemClock

/**
 * Amos clipboard glue — **System UI APK side** bridging the AmOS global clipboard
 * (Rust: `amos-tauri/src/clipboard.rs` + `clipboard_glue.rs`) to the device's
 * real [ClipboardManager].
 *
 * Two directions are wired through the JNI upcalls:
 *
 *   1. **Rust ─► Android**: the native `AndroidClipboardSink` mirrors every AmOS
 *      `clipboard_write` onto the real clipboard by calling this object's
 *      [pushTextClipboard] bridge method (so an app running alongside can paste
 *      AmOS-side copies). `attach` hands the native sink this object as the
 *      bridge.
 *
 *   2. **Android ─► Rust**: when the *device* clipboard changes (a copy made in
 *      the container), [onPrimaryClipChanged] forwards the text to native via
 *      `onContainerCopy`, where it is ingested into the shared AmOS clipboard.
 *
 * JNI contract (names must match `clipboard_glue.rs`):
 *
 *   external fun attach(bridge: Any)         // ─► Java_..._ClipboardGlue_attach
 *   external fun onContainerCopy(text: String) // ─► Java_..._ClipboardGlue_onContainerCopy
 *
 * Bring-up skeleton like `SensorGlue`/`CameraGlue`: verified at device time after
 * `tauri android init` once the System UI APK ships `libamos_tauri_lib.so`.
 */
object ClipboardGlue : ClipboardManager.OnPrimaryClipChangedListener {

    /** Copies we mirrored *out* (Rust push) are not re-ingested as inbound ones. */
    private const val SUPPRESS_WINDOW_MS = 500L

    private var clip: ClipboardManager? = null
    private var context: Context? = null

    // Suppress echo of our own Rust ─► Android pushes on the change listener.
    private var lastPushed: String? = null
    private var lastPushedAt = 0L

    /** Is the clipboard listener + native sink currently bound? */
    fun isBound() = clip != null

    /**
     * Bind the clipboard listener and hand the native sink this object as the
     * bridge so Rust `clipboard_write` mirrors here. Idempotent.
     */
    fun bind(context: Context) {
        if (clip != null) return
        val app = context.applicationContext
        this.context = app
        val cm = app.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        clip = cm
        cm.addPrimaryClipChangedListener(this)
        attach(this)
    }

    /** Unbind the listener + release the context. */
    fun detach() {
        clip?.removePrimaryClipChangedListener(this)
        clip = null
        context = null
    }

    /** Rust ─► Android: set the real clipboard from an AmOS `clipboard_write`. */
    fun pushTextClipboard(text: String, seq: Long) {
        lastPushed = text
        lastPushedAt = SystemClock.elapsedRealtime()
        clip?.setPrimaryClip(ClipData.newPlainText("amos-clipboard", text))
    }

    override fun onPrimaryClipChanged() {
        val text = currentText() ?: return
        // Ignore the echo of our own push above, then forward real copies to Rust.
        if (text == lastPushed && SystemClock.elapsedRealtime() - lastPushedAt <= SUPPRESS_WINDOW_MS) {
            lastPushed = null
            return
        }
        onContainerCopy(text)
    }

    /** Read the newest plain-text representation of the current clip, if any. */
    private fun currentText(): String? {
        val c = context ?: return null
        return clip?.primaryClip?.takeIf { it.itemCount > 0 }
            ?.getItemAt(0)?.coerceToText(c)?.toString()
    }

    /** JNI upcall: hand the native sink this bridge object (see clipboard_glue.rs). */
    private external fun attach(bridge: Any)

    /** JNI upcall: forward a container copy into the shared AmOS clipboard. */
    private external fun onContainerCopy(text: String)

    init {
        // The System UI's Rust staticlib exposes the upcalls. Best-effort: on a
        // freshly-generated Tauri project the .so is `libamos_tauri_lib.so`.
        try {
            System.loadLibrary("amos_tauri_lib")
        } catch (_: UnsatisfiedLinkError) {
            // Native lib not on the classpath yet (e.g. a host lint pass) — no-op;
            // the glue simply stays inert until the real APK ships it.
        }
    }
}

package com.amos.ai.glue

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context

/**
 * Amos clipboard glue — **guest side** of the host↔guest clipboard sync
 * (`crates/amos-clipboard` `src/android.rs`). This Kotlin object lives *inside* the
 * Android container (guest) and owns the `Context` + [ClipboardManager] that the
 * headless Rust guest-agent (`amos_clipboard::agent::GuestAgent`) cannot reach on
 * its own. It is handed to the native provider as the "bridge" object.
 *
 * JNI contract (names must match `crates/amos-clipboard/src/android.rs`):
 *
 *   external fun attach(bridge: Any)          // ─► Java_..._AndroidClipboardGlue_attach
 *   external fun onClipboardChanged(text: String) // ─► Java_..._AndroidClipboardGlue_onClipboardChanged
 *
 * The native side calls, on the bridge object it was given (`this`):
 *
 *   fun primaryText(): String?   // current primary clip text (native provider read)
 *   fun pushText(text: String)   // replace the primary clip (native provider write)
 *
 * Flow:
 *   * Host → guest: the native provider's `set_primary_text` calls [pushText] →
 *     `setPrimaryClip`. That triggers [onPrimaryClipChanged] here, which forwards
 *     the text back via `onClipboardChanged` — and the guest `GuestAgent`'s own
 *     [EchoGuard] recognizes it as its own push and does NOT echo it to the host
 *     (so this glue needs no separate echo-suppression window).
 *   * Guest → host: a *user* copy inside the container fires [onPrimaryClipChanged]
 *     → `onClipboardChanged` → the native change sink → the agent reports it as a
 *     genuine `ClipboardChanged`.
 *
 * Bring-up skeleton like the System UI's `ClipboardGlue.kt`: verified at device time
 * once the guest process ships `libamos_clipboard.so` and this object is bound.
 */
object AndroidClipboardGlue : ClipboardManager.OnPrimaryClipChangedListener {

    private var clip: ClipboardManager? = null
    private var context: Context? = null

    /** Is the clipboard listener currently bound? */
    fun isBound() = clip != null

    /**
     * Bind to the guest ClipboardManager, register the change listener, and hand
     * `this` to the native provider as its bridge. Idempotent.
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

    /** Native write: replace the primary clip with plain [text]. */
    fun pushText(text: String) {
        clip?.setPrimaryClip(ClipData.newPlainText("amos-guest-clipboard", text))
    }

    /** Native read: the current primary clip's plain text, if any. */
    fun primaryText(): String? {
        val c = context ?: return null
        return clip?.primaryClip?.takeIf { it.itemCount > 0 }
            ?.getItemAt(0)?.coerceToText(c)?.toString()
    }

    override fun onPrimaryClipChanged() {
        val text = primaryText() ?: return
        onClipboardChanged(text)
    }

    /** JNI upcall: hand the native provider this bridge object (see android.rs). */
    private external fun attach(bridge: Any)

    /** JNI upcall: forward a container clipboard change to the native change sink. */
    private external fun onClipboardChanged(text: String)

    init {
        // The guest's Rust staticlib exposes the upcalls. Best-effort: if the .so is
        // not on the classpath yet (e.g. a host lint pass) the glue stays inert until
        // the real guest package ships it.
        try {
            System.loadLibrary("amos_clipboard")
        } catch (_: UnsatisfiedLinkError) {
            // no-op; inert until the real guest package ships the native lib
        }
    }
}

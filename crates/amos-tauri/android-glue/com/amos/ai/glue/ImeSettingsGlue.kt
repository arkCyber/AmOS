package com.amos.ai.glue

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.util.Log
import android.view.inputmethod.InputMethodManager

/**
 * AmOS 输入法 — the **Android side** of the system-IME entry point (REQ-A1904).
 *
 * The service ([AmosImeService]) is the keyboard. This object is how the user *reaches*
 * it: `docs/input-method.md` §System IME shipped a real `InputMethodService` that any
 * app on the device can select, but the only way to select it was to leave AmOS, find
 * `Settings → 语言与输入法 → 键盘` and pick `AmOS 拼音` by hand. The AmOS Settings page
 * `svelte/settings/ImePage.svelte` is about the **WebView** keyboard and said nothing
 * about the system one, so the feature was unreachable from inside the product that
 * ships it.
 *
 * Three calls, all **read/launch** and all permission-free (nothing here is added to
 * `AndroidManifest.permissions.xml`):
 *
 *   * [status] — is AmOS's keyboard enabled, and is it the platform's current one?
 *   * [openPicker] — the platform's own keyboard switcher (`showInputMethodPicker`).
 *   * [openSettings] — `Settings.ACTION_INPUT_METHOD_SETTINGS`, the screen where a
 *     keyboard is **enabled**. This one is the load-bearing door: the picker only
 *     lists keyboards that are already enabled, so a user who has never enabled AmOS
 *     拼音 cannot reach it from the picker at all.
 *
 * Both launchers answer with a `STATUS_*` word rather than assuming success, so the host
 * can tell the user what happened — the [`RotationGlue`] precedent, whose words
 * `rotation_outcome_from_status` pins on the Rust side. The Rust mirror here is
 * `ime::ime_open_outcome_from_status`.
 *
 * **Which keyboard is "ours"** is asked of the platform by [ComponentName] equality, not
 * by comparing strings: `InputMethodInfo.getId()` and
 * `Settings.Secure.DEFAULT_INPUT_METHOD` are both `<package>/<class>` with the class in
 * *short* form when it shares the package prefix, and re-deriving that spelling here is
 * the mistake `state::extract_api_key` made (REQ-A1809 / F-MDM-011). The id is reported
 * as a **string** so the user can see which keyboard is in force; only the comparison
 * goes through `ComponentName`.
 */
object ImeSettingsGlue {

    private const val TAG = "ImeSettingsGlue"

    /** The call reached the platform. */
    const val STATUS_OK = "ok"

    /** No `InputMethodManager` on this `Context` — never observed on a real device. */
    const val STATUS_UNAVAILABLE = "unavailable"

    /** The platform refused the launch (or the call threw). */
    const val STATUS_DENIED = "denied"

    /**
     * Nothing is being typed into this window, so the platform has no IME window to hang its
     * switcher on — it returns from `showInputMethodPicker()` having drawn nothing.
     *
     * Measured on the S5 (`YY000286`, Android 14), twice at 19:40 and once at 19:41 on
     * 2026-09-26: with `dumpsys input_method`'s `mServedInputConnection=null` the call came
     * back without a window (`mInputMethodWindow` `mHasSurface=false isVisible=false`,
     * `mCurrentFocus` still AmOS's own activity), and with
     * `mServedInputConnection=RemoteInputConnectionImpl{… mServedView=com.amos.ai.RustWebView}`
     * the「选择输入法」dialog appeared (`mCurrentFocus=Window{… Select input method}`).
     * `isAcceptingText()` is precisely `mServedInputConnection != null`
     * (`InputMethodManager.java`), so it is the same field the measurement read — which is what
     * makes this an answer rather than a guess. Reporting [STATUS_OK] here instead told the
     * user a screen had come up that had not.
     */
    const val STATUS_NO_EDITOR = "no_editor"

    /**
     * `ImeSettingsGlue.status(context)` — the platform's answer about AmOS's keyboard.
     *
     * Read on the JNI worker thread: `InputMethodManager.enabledInputMethodList` and the
     * `Settings.Secure` read are both Binder calls that do not touch the View hierarchy.
     */
    @JvmStatic
    fun status(context: Context): String {
        return try {
            val imm =
                context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                    ?: return ImeSettings.unavailable("the Context has no InputMethodManager")
            val ours = ComponentName(context, AmosImeService::class.java)
            val enabled = imm.enabledInputMethodList.any { it.component == ours }
            val currentId =
                Settings.Secure.getString(
                    context.contentResolver,
                    Settings.Secure.DEFAULT_INPUT_METHOD,
                ).orEmpty()
            val selected = ComponentName.unflattenFromString(currentId) == ours
            ImeSettings.ok(currentId, enabled, selected)
        } catch (t: Throwable) {
            Log.w(TAG, "could not read the platform's input-method state: ${describe(t)}")
            ImeSettings.unavailable(describe(t))
        }
    }

    /**
     * `ImeSettingsGlue.openPicker(context)` — the platform's keyboard switcher.
     *
     * Lists the **enabled** keyboards only; a user who has never enabled AmOS 拼音 needs
     * [openSettings] first.
     *
     * Answered [STATUS_NO_EDITOR] when nothing in this window is accepting text: the platform's
     * picker is drawn from the serving IME's window, so with no input connection the call
     * returns without showing anything (see [STATUS_NO_EDITOR] for the measurement). Checking
     * first is what keeps this an answer about the platform rather than a claim to have opened
     * a screen nobody saw.
     */
    @JvmStatic
    fun openPicker(context: Context): String {
        val imm =
            context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                ?: return STATUS_UNAVAILABLE
        if (!imm.isAcceptingText()) {
            Log.i(TAG, "no input connection is being served; the picker would not be drawn")
            return STATUS_NO_EDITOR
        }
        return try {
            imm.showInputMethodPicker()
            Log.i(TAG, "showed the platform's input-method picker")
            STATUS_OK
        } catch (t: Throwable) {
            Log.w(TAG, "could not show the input-method picker: ${describe(t)}")
            STATUS_DENIED
        }
    }

    /**
     * `ImeSettingsGlue.openSettings(context)` — `Settings.ACTION_INPUT_METHOD_SETTINGS`,
     * where a keyboard is enabled or disabled.
     *
     * `FLAG_ACTIVITY_NEW_TASK` because the launch goes through an application `Context`:
     * without it the platform refuses a start from a non-Activity context. This is **not**
     * the background-activity-launch hazard the MediaProjection dialog hit — the user
     * taps a button in AmOS's own foreground window, so the launch is a foreground one.
     */
    @JvmStatic
    fun openSettings(context: Context): String {
        return try {
            val intent =
                Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.applicationContext.startActivity(intent)
            Log.i(TAG, "opened the platform's input-method settings")
            STATUS_OK
        } catch (t: Throwable) {
            Log.w(TAG, "could not open the input-method settings: ${describe(t)}")
            STATUS_DENIED
        }
    }

    private fun describe(t: Throwable) = "${t.javaClass.simpleName}: ${t.message}"
}

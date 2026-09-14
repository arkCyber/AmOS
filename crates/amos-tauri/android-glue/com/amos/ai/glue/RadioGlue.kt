package com.amos.ai.glue

import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log

/**
 * RadioGlue — hands the app's `JavaVM` + `Context` to Rust so the **real**
 * Android radio provider replaces the Mock (REQ-A185).
 *
 * Why it must exist: `crates/amos-radio` compiles `AndroidRadioProvider` under the
 * `android` feature, but Rust can only reach `WifiManager`/`BluetoothManager`
 * through the app's JNI environment — and Tauri builds its radio bridge during
 * `setup`, *before* any Activity callback hands that environment over. Nothing
 * called `RadioBridge::install_android` at all until this glue existed, so a real
 * phone ran the **Mock**: the quick-settings tiles (and the status-bar badges)
 * mirrored the persisted store, and a toggle could show "Wi-Fi off" while the
 * device's Wi-Fi was still on. That is the class of lie this repo refuses to ship.
 *
 * Wiring: [AmosGlue.onStart] → [attach] → `attachNative` upcall →
 * `Java_com_amos_ai_glue_RadioGlue_attachNative` (crates/amos-tauri/src/radio.rs),
 * which installs the provider into the same switchable provider the
 * `radio_status`/`radio_set` commands use. Idempotent, and a failure is **logged,
 * never fatal**: the radios simply keep answering from the Mock (honest offline
 * behaviour) instead of taking the app down.
 */
object RadioGlue {

    private const val TAG = "RadioGlue"

    /** Guards the one-shot attach (`AmosGlue.onStart` can run more than once). */
    @Volatile
    private var attached = false

    /**
     * Install the real radio provider. Safe to call repeatedly.
     */
    @JvmStatic
    fun attach(context: Context) {
        if (attached) return
        try {
            attachNative(context.applicationContext)
            attached = true
        } catch (t: Throwable) {
            // UnsatisfiedLinkError (symbol missing), an unavailable service, or a
            // bridge that was never built: report it and stay on the Mock.
            Log.w(TAG, "radio provider attach failed: ${t.javaClass.simpleName}: ${t.message}")
        }
    }

    /* ---- platform-managed switches (REQ-A202) ------------------------------- */

    /** An app may switch this radio; no system surface is involved. */
    private const val APP_CONTROLLED = "app_controlled"

    /**
     * Which system surface owns a radio switch this app may **not** flip, or
     * [APP_CONTROLLED] when it may — the answer Rust's `RadioProvider::control` needs.
     *
     * Shape: `"<reason>:<surface>"`, e.g. `"switch_removed:bluetooth_settings"`. Two
     * stable machine tokens (never copy), and an unknown/empty answer makes Rust fall
     * back to *attempting* the switch (the platform then reports its own refusal) rather
     * than to silently declaring a switch unwritable.
     *
     * The platform facts, verified on the S5 / Android 14 (API 34) — both APIs return
     * `false` unconditionally there:
     *   * `WifiManager#setWifiEnabled` is restricted to the system/device-owner caller
     *     from **API 29** (the last device round saw
     *     `the platform refused to switch Wi-Fi off (setWifiEnabled returned false)`).
     *   * `BluetoothAdapter#enable/disable` were **removed for apps targeting API 33+**
     *     (see the SDK note on those methods: for such apps they always fail).
     *   * The authoritative airplane switch is `Settings.Global.AIRPLANE_MODE_ON`, which
     *     needs `WRITE_SECURE_SETTINGS` (signature|privileged) on **every** version.
     *
     * Android 10/13 did not take these switches away from *everyone* — a device-owner or
     * system app still holds them — so this is a **capability** answer, not a "this
     * device cannot" claim: whatever the answer, AmOS still reads the real state.
     */
    @JvmStatic
    fun managedSurface(key: String): String = when (key) {
        "wifi" ->
            if (Build.VERSION.SDK_INT >= 29) "switch_removed:wifi_panel" else APP_CONTROLLED
        "bluetooth" ->
            if (Build.VERSION.SDK_INT >= 33) "switch_removed:bluetooth_settings" else APP_CONTROLLED
        "airplane" -> "privileged_only:airplane_settings"
        // The Wi-Fi AP is driven through `TetheringGlue`, whose call already answers
        // "accepted?" honestly (and reports `TETHER_PRIVILEGED`/unsupported as a
        // refusal), so there is no *extra* managed switch to surface here.
        "hotspot" -> APP_CONTROLLED
        else -> APP_CONTROLLED
    }

    /**
     * Open the system surface that owns a platform-managed switch, so the screen can
     * hand the user somewhere the switch still works. `true` = an Activity was started.
     *
     * Started from the **application context** with `FLAG_ACTIVITY_NEW_TASK`: unlike
     * `ACTION_REQUEST_ENABLE`/`ACTION_REQUEST_DISCOVERABLE` (which want an Activity to
     * return a result to), these are plain settings screens/panels — they need no
     * result, and the app is in the foreground when the user taps, so the background
     * activity-start restrictions do not apply.
     */
    @JvmStatic
    fun openSystemSurface(context: Context, surface: String): Boolean {
        val intent = try {
            when (surface) {
                // API 29+ panel (checked by the caller's control answer); fall back to
                // the Wi-Fi settings screen when the panel is missing on an OEM build.
                "wifi_panel" -> Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY)
                "bluetooth_settings" -> Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
                "airplane_settings" -> Intent(Settings.ACTION_AIRPLANE_MODE_SETTINGS)
                "wireless_settings" -> Intent(Settings.ACTION_WIRELESS_SETTINGS)
                else -> {
                    Log.w(TAG, "no system surface known for '$surface'")
                    return false
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "surface $surface unavailable: ${t.javaClass.simpleName}")
            return false
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            Log.d(TAG, "opened system surface $surface")
            true
        } catch (t: Throwable) {
            // An OEM build without the panel: retry once with the settings screen rather
            // than reporting a dead end (the user can still reach the switch there).
            if (surface == "wifi_panel") {
                return try {
                    context.startActivity(
                        Intent(Settings.ACTION_WIFI_SETTINGS)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                    Log.d(TAG, "opened Wi-Fi settings (panel unavailable)")
                    true
                } catch (t2: Throwable) {
                    Log.w(TAG, "Wi-Fi settings unavailable: ${t2.javaClass.simpleName}")
                    false
                }
            }
            Log.w(TAG, "no activity for $surface: ${t.javaClass.simpleName}")
            false
        }
    }

    /**
     * ─► `Java_com_amos_ai_glue_RadioGlue_attachNative` — builds
     * `AndroidRadioProvider` and installs it (crates/amos-tauri/src/radio.rs).
     */
    @JvmStatic
    private external fun attachNative(context: Context)
}

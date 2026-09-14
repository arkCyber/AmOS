// TetheringGlue.kt — Kotlin half of the AmOS personal hotspot (Wi-Fi AP).
//
// Android's tethering API is asynchronous and callback-based, so the call cannot
// live in Rust:
//   * `TetheringManager#startTethering(TetheringRequest, Executor, StartTetheringCallback)`
//   * `TetheringManager#stopTethering(TetheringRequest, Executor, StopTetheringCallback)`
//   * `TetheringManager#registerTetheringEventCallback(Executor, TetheringEventCallback)`
// Raw JNI cannot build the request/callback objects, which is exactly why this
// glue exists (same reason as `SmsGlue` / `FlashlightGlue`).
//
// Rust (`crates/amos-radio/src/android.rs`, under the `android` feature) calls
// these two statics:
//   * `setWifiTethering(context, enable)` → did the platform **accept** the request?
//   * `isWifiTethering(context)`          → is Wi-Fi tethering actually up?
//
// API reality — verified against the installed `android.jar` with `javap`, not
// assumed (the first draft of this file got it wrong and the
// `make android-glue-check` compile caught it):
//   * `android.net.TetheringManager` / `TetheringInterface` only became **public
//     SDK API in 36** (absent from the android-34/35 `android.jar`s), and
//     `ConnectivityManager`'s `startTethering`/`OnStartTetheringCallback` are
//     `@SystemApi` (absent from the public SDK entirely). So there is **no public
//     tethering API below 36**, and no `ConnectivityManager` fallback to write.
//   * `StartTetheringCallback` / `StopTetheringCallback` / `TetheringEventCallback`
//     are **interfaces** (their methods are `default`), so the Kotlin object
//     expressions must not use parentheses.
//
// Honest boundaries (device-time):
//   * Starting tethering needs `TETHER_PRIVILEGED` (signature|privileged), so a
//     normally-installed app gets a refusal. Every failure path here returns
//     `false` (or leaves [active] alone) and Rust turns that into a provider
//     error — the UI must never claim a hotspot the platform did not start.
//   * The AP's SSID/password/band are **not** pushed by this glue — and cannot be,
//     from a non-privileged install. Verified with `javap` against the android-36
//     `android.jar`: the public `android.net.wifi.SoftApConfiguration.Builder`
//     exposes only `setChannels(...)` — `setSsid`/`setPassphrase`/`setBand`/
//     `setSecurityType` are `@SystemApi`, so there is no way to build a configured
//     `SoftApConfiguration` (and thus no way to fill
//     `TetheringRequest.Builder#setSoftApConfiguration`) without platform
//     privileges. The settings screen's configuration is therefore the user's
//     *intent* (persisted in `amos.hotspot`), never a claim that the AP uses it.
//     Only a privileged/system-signed build could apply it.
//
// Structural delivery: the host has no Android VM, but the `android-glue-check`
// gate type-checks this file against the real SDK (`docs/android-glue.md`).

package com.amos.ai.glue

import android.content.Context
import android.net.TetheringInterface
import android.net.TetheringManager
import android.os.Build
import android.util.Log
import java.util.concurrent.Executor

object TetheringGlue {

    private const val TAG = "TetheringGlue"

    /** The public tethering API (`android.net.TetheringManager`) starts at API 36. */
    private const val TETHERING_API = 36

    /** Last Wi-Fi-tethering state the platform reported (event callback below). */
    @Volatile
    private var active = false

    /** Guards [callbackRegistered] so the event callback is wired exactly once. */
    private val callbackLock = Any()
    private var callbackRegistered = false

    /**
     * Ask the platform to start/stop Wi-Fi tethering.
     *
     * Returns `true` when the request was **accepted** — the async outcome then
     * arrives via the callback and updates [isWifiTethering]; `false` when the
     * platform refused it (unavailable below API 36, unsupported, or a missing
     * `TETHER_PRIVILEGED`). Nothing is faked: a `false` surfaces in Rust as a
     * provider error.
     */
    @JvmStatic
    fun setWifiTethering(context: Context, enable: Boolean): Boolean {
        if (Build.VERSION.SDK_INT < TETHERING_API) {
            Log.w(TAG, "no public tethering API below API $TETHERING_API")
            return false
        }
        val app = context.applicationContext
        return try {
            val tm = app.getSystemService(TetheringManager::class.java) ?: return false
            bindCallback(app, tm)
            val request =
                TetheringManager.TetheringRequest.Builder(TetheringManager.TETHERING_WIFI).build()
            if (enable) {
                tm.startTethering(
                    request,
                    mainExecutor(app),
                    object : TetheringManager.StartTetheringCallback {
                        override fun onTetheringStarted() {
                            active = true
                        }

                        override fun onTetheringFailed(errorCode: Int) {
                            Log.w(TAG, "startTethering failed: $errorCode")
                            active = false
                        }
                    },
                )
            } else {
                tm.stopTethering(
                    request,
                    mainExecutor(app),
                    object : TetheringManager.StopTetheringCallback {
                        override fun onStopTetheringSucceeded() {
                            active = false
                        }

                        override fun onStopTetheringFailed(errorCode: Int) {
                            Log.w(TAG, "stopTethering failed: $errorCode")
                        }
                    },
                )
            }
            true
        } catch (t: Throwable) {
            // A missing TETHER_PRIVILEGED, an unsupported device, or any other
            // platform refusal. Report it; never pretend the AP came up.
            Log.w(TAG, "setWifiTethering($enable) refused: ${t.javaClass.simpleName}")
            false
        }
    }

    /**
     * The platform's Wi-Fi-tethering state, kept live by the event callback
     * registered on the first call ([setWifiTethering] or this one).
     */
    @JvmStatic
    fun isWifiTethering(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= TETHERING_API) {
            try {
                val app = context.applicationContext
                app.getSystemService(TetheringManager::class.java)?.let { bindCallback(app, it) }
            } catch (t: Throwable) {
                Log.w(TAG, "tethering state unavailable: ${t.javaClass.simpleName}")
            }
        }
        return active
    }

    /**
     * Register [TetheringManager.TetheringEventCallback] once, so a hotspot
     * toggled outside AmOS is still reported truthfully.
     */
    private fun bindCallback(context: Context, tm: TetheringManager) {
        synchronized(callbackLock) {
            if (callbackRegistered) return
            callbackRegistered = true
            try {
                tm.registerTetheringEventCallback(
                    mainExecutor(context),
                    object : TetheringManager.TetheringEventCallback {
                        override fun onTetheredInterfacesChanged(
                            interfaces: MutableSet<TetheringInterface>,
                        ) {
                            active =
                                interfaces.any { it.type == TetheringManager.TETHERING_WIFI }
                        }
                    },
                )
            } catch (t: Throwable) {
                // Let a later call retry (e.g. the service was not up yet).
                callbackRegistered = false
                Log.w(TAG, "tethering callback not registered: ${t.javaClass.simpleName}")
            }
        }
    }

    /** `Context#getMainExecutor` (API 28+) — only reached on the API 36+ path. */
    private fun mainExecutor(context: Context): Executor = context.mainExecutor
}

package com.amos.ai.glue

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.nfc.tech.MifareClassic
import android.nfc.tech.MifareUltralight
import android.nfc.tech.Ndef
import android.nfc.tech.NdefFormatable
import android.nfc.tech.NfcA
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * NFC glue — **System UI APK side**.
 *
 * Wraps `NfcAdapter` for foreground dispatch, tag discovery, NDEF read/write.
 * All operations are driven from the WebView via JNI upcalls from
 * `crates/amos-tauri/src/ble.rs`. Async tag-discovery events are forwarded back
 * to Rust as JSON strings via the JNI callback `onNfcTagDiscovered(String)`.
 *
 * ## Thread safety
 * NFC callbacks fire on the main looper; all mutable state is guarded by `synchronized`.
 * Results are stored so the Rust command handler can read after the JNI call returns.
 *
 * ## Foreground dispatch
 * `startForegroundDispatch` must be called with the foreground `Activity` so Android
 * routes NFC intent filters to it. `stopForegroundDispatch` releases the adapter.
 */
object NfcGlue {

    /*
     * KOTLIN → RUST CONTRACT (why the members below carry `@JvmStatic`):
     *
     * `crates/amos-tauri/src/ble.rs` reaches them through `JNIEnv::call_static_method`, and a
     * Kotlin `object`'s member is an **instance** method on `INSTANCE` unless it is annotated.
     * Without `@JvmStatic` the JVM raises `java.lang.NoSuchMethodError: no static method …` at the
     * first call — which neither compiler can see. REQ-A376 found this the hard way in
     * `AlarmGlue.kt` (every alarm registration failed on device); REQ-A412 found the same defect
     * in **every** Rust-callable member of this file (`jni-contract-scan`, 17 call sites across
     * BLE-GATT/NFC/biometric). Keep `@JvmStatic` on anything Rust calls by name.
     */

    private const val TAG = "AmosGlue.NFC"

    @Volatile
    private var nfcAdapter: NfcAdapter? = null

    @Volatile
    private var isDispatchActive = false

    /** The most recently discovered tag, cleared after each read. */
    @Volatile
    private var lastTag: Tag? = null

    init {
        try {
            System.loadLibrary("amos_tauri_lib")
        } catch (_: UnsatisfiedLinkError) {
            Log.w(TAG, "amos_tauri_lib not loaded — JNI callbacks unavailable")
        }
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    /**
     * Initialize the NFC adapter from `Context`.
     * Idempotent.
     */
    @JvmStatic
    fun init(context: Context): Boolean {
        if (nfcAdapter != null) return true
        nfcAdapter = NfcAdapter.getDefaultAdapter(context)
        Log.i(TAG, "NFC adapter initialized: ${nfcAdapter != null}")
        return nfcAdapter != null
    }

    /**
     * Check whether NFC hardware is present and whether it is enabled.
     * Returns a JSON object: `{ "available": bool, "state": string }`.
     */
    @JvmStatic
    fun getStatus(): String {
        val adapter = nfcAdapter
        return if (adapter == null) {
            JSONObject()
                .put("available", false)
                .put("state", "no_hardware")
                .toString()
        } else if (!adapter.isEnabled) {
            JSONObject()
                .put("available", true)
                .put("state", "disabled")
                .toString()
        } else {
            JSONObject()
                .put("available", true)
                .put("state", "enabled")
                .toString()
        }
    }

    // ── Foreground dispatch ─────────────────────────────────────────────────────

    /**
     * Start NFC foreground dispatch so the System UI receives tag events.
     * Must be called with the foreground `Activity`.
     */
    @JvmStatic
    fun startForegroundDispatch(activity: Activity): Boolean {
        val adapter = nfcAdapter ?: return false
        if (isDispatchActive) return true

        try {
            val intent = Intent(activity, activity.javaClass).apply {
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }
            val pendingIntent = PendingIntent.getActivity(activity, 0, intent, flags)

            // Tech filters for common tag types.
            val techLists = arrayOf(
                arrayOf(Ndef::class.java.name),
                arrayOf(NfcA::class.java.name),
                arrayOf(IsoDep::class.java.name),
                arrayOf(MifareUltralight::class.java.name),
            )
            val intentFilters = arrayOf(
                IntentFilter(NfcAdapter.ACTION_NDEF_DISCOVERED).apply {
                    try {
                        addDataType("*/*")
                    } catch (e: IntentFilter.MalformedMimeTypeException) {
                        // ignore
                    }
                },
                IntentFilter(NfcAdapter.ACTION_TECH_DISCOVERED),
                IntentFilter(NfcAdapter.ACTION_TAG_DISCOVERED),
            )

            adapter.enableForegroundDispatch(activity, pendingIntent, intentFilters, techLists)
            isDispatchActive = true
            Log.i(TAG, "foreground dispatch started")
            return true
        } catch (e: Exception) {
            Log.e(TAG, "failed to start foreground dispatch", e)
            return false
        }
    }

    /**
     * Stop NFC foreground dispatch.
     */
    @JvmStatic
    fun stopForegroundDispatch(activity: Activity): Boolean {
        val adapter = nfcAdapter ?: return false
        if (!isDispatchActive) return true
        try {
            adapter.disableForegroundDispatch(activity)
            isDispatchActive = false
            Log.i(TAG, "foreground dispatch stopped")
            return true
        } catch (e: Exception) {
            Log.e(TAG, "failed to stop foreground dispatch", e)
            return false
        }
    }

    // ── Tag discovery ──────────────────────────────────────────────────────────

    /**
     * Called by the Kotlin activity when it receives an NFC intent.
     * Parses the tag and forwards discovery event to Rust via JNI.
     */
    fun onTagIntent(intent: Intent) {
        val tag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(NfcAdapter.EXTRA_TAG, Tag::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(NfcAdapter.EXTRA_TAG)
        } ?: return

        lastTag = tag
        val tagId = tag.id.joinToString("") { "%02x".format(it) }

        val tech = when {
            tag.techList.contains(Ndef::class.java.name) -> "ndef"
            tag.techList.contains(MifareClassic::class.java.name) -> "type2"
            tag.techList.contains(MifareUltralight::class.java.name) -> "type2"
            tag.techList.contains(IsoDep::class.java.name) -> "type4"
            tag.techList.contains(NfcA::class.java.name) -> "iso14443"
            else -> "unknown"
        }

        val ndef: Ndef? = try { Ndef.get(tag) } catch (_: Exception) { null }
        val ndefAvailable = ndef != null

        val records: JSONArray? = if (ndefAvailable && ndef != null) {
            try {
                ndef.connect()
                val msg = ndef.ndefMessage
                ndef.close()
                msg?.let { recordsToJson(it.records) }
            } catch (_: Exception) {
                null
            }
        } else null

        val payload = JSONObject()
            .put("id", tagId)
            .put("technology", tech)
            .put("ndef", ndefAvailable)
        if (records != null) {
            payload.put("records", records)
        }

        try {
            onNfcTagDiscovered(payload.toString())
        } catch (_: UnsatisfiedLinkError) {
            Log.w(TAG, "onNfcTagDiscovered JNI not available")
        }
    }

    private fun recordsToJson(records: Array<NdefRecord>): JSONArray {
        val arr = JSONArray()
        for (r in records) {
            arr.put(
                JSONObject()
                    .put("tnf", r.tnf.toInt())
                    .put("type", r.type.joinToString("") { "%02x".format(it) })
                    .put("payload", r.payload.joinToString("") { "%02x".format(it) })
                    .put("id", r.id.joinToString("") { "%02x".format(it) })
            )
        }
        return arr
    }

    // ── NDEF write ─────────────────────────────────────────────────────────────

    /**
     * Format a raw tag into NDEF.
     */
    @JvmStatic
    fun formatTag(): Boolean {
        val tag = lastTag ?: return false
        return try {
            val formatable = NdefFormatable.get(tag)
            if (formatable != null) {
                formatable.connect()
                // API 26+: format() requires an NdefMessage; passing null uses an
                // empty message which is fine for a blank-format operation.
                @Suppress("NULLABILITY_MISMATCH_BASED_ON_JAVA_ANNOTATIONS")
                formatable.format(null)
                formatable.close()
                true
            } else {
                // Try Ndef directly
                val ndef = Ndef.get(tag)
                if (ndef != null) {
                    ndef.connect()
                    // Already formatted if we can connect
                    ndef.close()
                    true
                } else {
                    false
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "formatTag failed", e)
            false
        }
    }

    /**
     * Write NDEF records to the current tag.
     * `recordsJson` is a JSON array string with entries: {tnf, type, payload, id}.
     */
    @JvmStatic
    fun writeNdefMessage(recordsJson: String): Boolean {
        val tag = lastTag ?: return false
        val ndef = try { Ndef.get(tag) } catch (_: Exception) { null } ?: return false

        return try {
            val arr = JSONArray(recordsJson)
            val ndefRecords = mutableListOf<NdefRecord>()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val tnf = (obj.optInt("tnf")).toShort()
                val type = parseHex(obj.optString("type", ""))
                val payload = parseHex(obj.optString("payload", ""))
                val id = parseHex(obj.optString("id", ""))
                try {
                    ndefRecords.add(NdefRecord(tnf, type, id, payload))
                } catch (_: Exception) {
                    // skip invalid record
                }
            }
            if (ndefRecords.isEmpty()) return false

            ndef.connect()
            if (ndef.maxSize < NdefMessage(ndefRecords.toTypedArray()).toByteArray().size) {
                Log.e(TAG, "NDEF message too large: ${ndef.maxSize}")
                ndef.close()
                return false
            }
            ndef.writeNdefMessage(NdefMessage(ndefRecords.toTypedArray()))
            ndef.close()
            true
        } catch (e: Exception) {
            Log.e(TAG, "writeNdefMessage failed", e)
            false
        }
    }

    /**
     * Read raw bytes from the last tag as hex string.
     */
    @JvmStatic
    fun readTagBytes(): String? {
        val tag = lastTag ?: return null
        return try {
            val ndef = Ndef.get(tag)
            if (ndef != null) {
                ndef.connect()
                val msg = ndef.ndefMessage
                ndef.close()
                msg?.toByteArray()?.joinToString("") { "%02x".format(it) }
            } else {
                tag.id.joinToString("") { "%02x".format(it) }
            }
        } catch (_: Exception) {
            null
        }
    }

    // ── Internal helpers ────────────────────────────────────────────────────────

    private fun parseHex(hex: String): ByteArray {
        if (hex.isEmpty()) return ByteArray(0)
        return ByteArray(hex.length / 2) {
            val idx = it * 2
            ((hex.substring(idx, idx + 2).toInt(16)) and 0xFF).toByte()
        }
    }

    // ── JNI upcall stubs (Rust → Kotlin) ──────────────────────────────────────

    external fun onNfcTagDiscovered(tagJson: String)

    /**
     * Clear the last discovered tag (call after Rust processes the event).
     */
    fun clearTag() {
        lastTag = null
    }
}

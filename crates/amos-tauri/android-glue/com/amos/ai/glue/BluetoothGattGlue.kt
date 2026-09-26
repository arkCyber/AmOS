package com.amos.ai.glue

import android.bluetooth.*
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.*
import org.json.JSONArray
import org.json.JSONObject

/**
 * BLE GATT client glue — **System UI APK side**.
 *
 * Wraps `BluetoothGatt` for connect/discover/read/write/subscribe.
 * All operations are driven from the WebView via JNI upcalls from
 * `crates/amos-tauri/src/ble.rs`. Async results are forwarded back to Rust
 * via JNI callbacks (`onConnectionStateChange`, `onCharacteristicReadResult`,
 * `onCharacteristicChanged`, etc.).
 *
 * ## Thread safety
 * Kotlin BLE callbacks fire on a Binder thread. All state is guarded by
 * `synchronized`, and result futures are stored so the Rust command handler
 * can read the resolved value after the JNI call returns.
 *
 * ## GATT UUIDs
 * Callers pass raw UUID strings. No UUID constants live here — they belong
 * in the device-specific consumer.
 */
object BluetoothGattGlue {

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

    private const val TAG = "AmosGlue.BLE"
    private val mainHandler = Handler(Looper.getMainLooper())

    /*
     * `setCharacteristicNotification` verdicts (mirrored by `notify_verdict` in
     * `crates/amos-tauri/src/ble.rs`; REQ-A1158 / F-SH-459). Only the numeric values cross JNI,
     * so the two lists must stay in step.
     */
    /** No request reached the stack (no glue / not connected / refused / no permission). */
    internal const val NOTIFY_NO_REQUEST = 0
    /** The CCC descriptor write was queued; the device's verdict arrives in `onDescriptorWrite`. */
    internal const val NOTIFY_DESCRIPTOR_QUEUED = 1
    /** The characteristic carries no CCC descriptor — the device cannot be told to notify. */
    internal const val NOTIFY_NO_DESCRIPTOR = 2

    @Volatile
    private var gatt: BluetoothGatt? = null

    @Volatile
    private var device: BluetoothDevice? = null

    private val discoveredServices = mutableListOf<BluetoothGattService>()

    init {
        try {
            System.loadLibrary("amos_tauri_lib")
        } catch (_: UnsatisfiedLinkError) {
            Log.w(TAG, "amos_tauri_lib not loaded — JNI callbacks unavailable")
        }
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    /**
     * Install the JavaVM binding so Kotlin can call back into Rust.
     * Must be called from `MainActivity.onStart` before any other operation.
     * Idempotent — safe to call multiple times.
     */
    @JvmStatic
    fun install(context: Context) {
        try {
            // The companion JNI function installs the JavaVM + Context into Rust.
            // All three glues (BLE, NFC, Biometric) share the same binding.
            nativeInstall(context)
            Log.i(TAG, "Rust JNI binding installed")
        } catch (t: Throwable) {
            Log.e(TAG, "nativeInstall failed: $t")
        }
    }

    /**
     * JNI upcall: hand the JavaVM and Context to the Rust glue layer.
     * This is called by Kotlin's install() to bootstrap the bidirectional JNI bridge.
     */
    private external fun nativeInstall(context: Context)

    /**
     * Connect to `address`. Returns `true` when a GATT **client object** was created and the
     * request was handed to the framework — **not** whether the device answered.
     *
     * The rendezvous verdict arrives asynchronously in `onConnectionStateChange(status,
     * newState)`; `ble_connect` waits for it rather than reading this return as "connected"
     * (REQ-A1158 / F-SH-459). A `false` here means "no request was made" (no adapter, bad MAC,
     * `BLUETOOTH_CONNECT` missing), which is a different fact from "the device refused".
     */
    @JvmStatic
    fun connect(context: Context, address: String): Boolean {
        teardownGatt()

        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            ?: return false
        val adapter = manager.adapter ?: return false

        // Parse MAC (with or without colons).
        val cleanMac = address.replace(":", "").uppercase()
        if (cleanMac.length != 12) return false

        val mac = listOf(
            cleanMac.substring(0, 2),
            cleanMac.substring(2, 4),
            cleanMac.substring(4, 6),
            cleanMac.substring(6, 8),
            cleanMac.substring(8, 10),
            cleanMac.substring(10, 12),
        ).joinToString(":")

        return try {
            device = adapter.getRemoteDevice(mac)
            gatt = device?.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            Log.i(TAG, "connecting to $mac")
            gatt != null
        } catch (e: SecurityException) {
            connectRefused("connect", e)
            false
        }
    }

    /**
     * Disconnect and release the GATT client.
     *
     * Returns `true` when there was a GATT client to release: the Rust command (`ble_disconnect`)
     * is typed `Result<bool, _>` and reads the JNI `Z` result, so a `Unit` return here was a
     * second, independent contract break — the JVM would have raised `NoSuchMethodError` on the
     * signature string alone, before any code ran (found by `jni-contract-scan`, REQ-A412).
     */
    @JvmStatic
    fun disconnect(): Boolean {
        val had = gatt != null
        try {
            gatt?.disconnect()
        } catch (e: SecurityException) {
            connectRefused("disconnect", e)
        }
        teardownGatt()
        return had
    }

    private fun teardownGatt() {
        val old = gatt
        gatt = null
        device = null
        discoveredServices.clear()
        try {
            old?.close()
        } catch (e: SecurityException) {
            connectRefused("close", e)
        }
    }

    // ── Service discovery ──────────────────────────────────────────────────────

    /**
     * Discover all services on the connected device.
     *
     * Answers whether the platform **accepted** the request (`1`) or refused it (`0`). The list
     * itself does not come back here — it arrives later in [onServicesDiscovered], which is why
     * this member has no getter to pair with: the Rust side's `ble_discover_services` waits for
     * that callback rather than draining a cache on the same tick (REQ-A1157 / F-SH-458).
     */
    @JvmStatic
    fun discoverServices(): Int {
        val g = gatt ?: return 0
        discoveredServices.clear()
        return try {
            if (g.discoverServices()) 1 else 0
        } catch (e: SecurityException) {
            connectRefused("discoverServices", e)
            0
        }
    }

    /**
     * The discovered services as the JSON array the Rust callback expects.
     *
     * Each service carries its **characteristics** — uuid and the raw
     * `BluetoothGattCharacteristic.getProperties()` bitmask — because the screen has to know
     * which actions a characteristic permits before it offers them. Without this the screen
     * could enumerate services but not their characteristics, so the user typed the
     * characteristic uuid by hand and every read/write/subscribe looked available until the
     * device refused it (REQ-A1198 / F-SH-487).
     *
     * One builder, called by the only path that crosses to Rust (`onServicesDiscovered`): a
     * second, hand-written copy of this shape is how two answers to one question drift apart.
     */
    private fun servicesJson(services: List<BluetoothGattService>): String {
        val array = JSONArray()
        for (svc in services) {
            val characteristics = JSONArray()
            for (chr in svc.characteristics) {
                characteristics.put(
                    JSONObject()
                        .put("uuid", chr.uuid.toString())
                        .put("properties", chr.properties),
                )
            }
            array.put(
                JSONObject()
                    .put("uuid", svc.uuid.toString())
                    .put("characteristics", characteristics),
            )
        }
        return array.toString()
    }

    // ── Read ─────────────────────────────────────────────────────────────────

    /**
     * Read a characteristic value asynchronously.
     * Calls `onCharacteristicRead` when the value arrives.
     */
    @JvmStatic
    fun readCharacteristic(serviceUuid: String, characteristicUuid: String): Boolean {
        val g = gatt ?: return false
        val svc = findService(UUID.fromString(serviceUuid)) ?: return false
        val chr = svc.getCharacteristic(UUID.fromString(characteristicUuid)) ?: return false
        return try {
            g.readCharacteristic(chr)
        } catch (e: SecurityException) {
            connectRefused("readCharacteristic", e)
            false
        }
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    /**
     * Write a value to a characteristic.
     * `withResponse` = `WRITE_TYPE_WITH_RESPONSE` vs `WRITE_TYPE_DEFAULT`.
     */
    @JvmStatic
    fun writeCharacteristic(
        serviceUuid: String,
        characteristicUuid: String,
        value: ByteArray,
        withResponse: Boolean,
    ): Boolean {
        val g = gatt ?: return false
        val svc = findService(UUID.fromString(serviceUuid)) ?: return false
        val chr = svc.getCharacteristic(UUID.fromString(characteristicUuid)) ?: return false
        chr.value = value
        // API 34+ removed WRITE_TYPE_DEFAULT / WRITE_TYPE_WITH_RESPONSE.
        // WRITE_TYPE_SIGNED (3) replaces the old "with response" behaviour.
        // WRITE_TYPE_NO_RESPONSE (2) is the no-response variant.
        chr.writeType = if (withResponse) {
            BluetoothGattCharacteristic.WRITE_TYPE_SIGNED
        } else {
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        }
        return try {
            g.writeCharacteristic(chr)
        } catch (e: SecurityException) {
            connectRefused("writeCharacteristic", e)
            false
        }
    }

    // ── Notify / Indicate ──────────────────────────────────────────────────────

    /**
     * Enable notifications or indications for a characteristic, reporting **which** of the three
     * outcomes happened rather than a bare boolean.
     *
     * Toggling notifications has two halves, and only the second is about the device: a *local*
     * registration (`setCharacteristicNotification`) and the CCC descriptor write, whose verdict
     * arrives later in `onDescriptorWrite` → [`onDescriptorWriteResult`]. This member used to
     * return the local half alone, so `ble_subscribe` reported 「已订阅」 for a device that never
     * acknowledged — or for a characteristic that carries no CCC at all, where the descriptor
     * write never even happened (REQ-A1158 / F-SH-459).
     *
     * Returns one of [`NOTIFY_NO_REQUEST`], [`NOTIFY_DESCRIPTOR_QUEUED`], [`NOTIFY_NO_DESCRIPTOR`].
     */
    @JvmStatic
    fun setCharacteristicNotification(
        serviceUuid: String,
        characteristicUuid: String,
        enable: Boolean
    ): Int {
        val g = gatt ?: return NOTIFY_NO_REQUEST
        // Bind (service, characteristic) together so two services sharing a
        // 16-bit UUID (e.g. 0x2A19 Battery Level appearing in both the
        // Battery Service and Environmental Sensor) don't silently match the
        // first one discovered.
        val svc = findService(UUID.fromString(serviceUuid)) ?: return NOTIFY_NO_REQUEST
        val chr = svc.getCharacteristic(UUID.fromString(characteristicUuid)) ?: return NOTIFY_NO_REQUEST
        return try {
            val accepted = g.setCharacteristicNotification(chr, enable)

            // Write the CCC descriptor (0x2902 for notifications).
            val descriptor = chr.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"))
            when {
                descriptor == null -> NOTIFY_NO_DESCRIPTOR
                !accepted -> NOTIFY_NO_REQUEST
                else -> {
                    val value = if (enable) {
                        if (chr.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) {
                            BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                        } else {
                            BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        }
                    } else {
                        BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
                    }
                    descriptor.value = value
                    // The verdict for this write arrives in onDescriptorWrite; answer whether the
                    // stack *queued* it, not whether the device agreed.
                    if (g.writeDescriptor(descriptor)) NOTIFY_DESCRIPTOR_QUEUED else NOTIFY_NO_REQUEST
                }
            }
        } catch (e: SecurityException) {
            connectRefused("setCharacteristicNotification", e)
            NOTIFY_NO_REQUEST
        }
    }

    /**
     * Log a GATT call the platform refused for want of the runtime Bluetooth permission.
     *
     * Android 12 (API 31) split the install-time `BLUETOOTH` permission into runtime ones
     * (`BLUETOOTH_CONNECT` / `BLUETOOTH_SCAN`), so without `BLUETOOTH_CONNECT` **every**
     * `BluetoothGatt` / `BluetoothDevice` call throws `SecurityException`. Android Lint refuses to
     * compile such a call unless **the call site itself** checks the permission or handles the
     * exception (`MissingPermission`; nine sites here, `android-glue-check` was red — REQ-A412).
     * A try/catch delegated to a wrapper function does *not* satisfy it, which is why every call
     * below carries its own `try { … } catch (e: SecurityException)` and reports the same shaped
     * answer the caller already handles (`false` / `0`) instead of letting an exception cross the
     * JNI boundary into Rust.
     */
    private fun connectRefused(what: String, e: SecurityException) {
        Log.w(TAG, "$what refused: BLUETOOTH_CONNECT not granted (${e.message})")
    }

    // ── Internal helpers ────────────────────────────────────────────────────────

    private fun findService(uuid: UUID): BluetoothGattService? {
        return discoveredServices.find { it.uuid == uuid }
            ?: gatt?.services?.find { it.uuid == uuid }
    }

    private fun findCharacteristic(uuid: UUID): BluetoothGattCharacteristic? {
        for (svc in discoveredServices) {
            svc.getCharacteristic(uuid)?.let { return it }
        }
        for (svc in (gatt?.services ?: emptyList())) {
            svc.getCharacteristic(uuid)?.let { return it }
        }
        return null
    }

    // ── GATT callbacks ────────────────────────────────────────────────────────

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            Log.i(TAG, "connection state: status=$status newState=$newState")
            val connected = newState == BluetoothProfile.STATE_CONNECTED
            try {
                // Forward the stack's own `status` (`0` == GATT_SUCCESS) so `ble_connect` can
                // tell a clean connection from a refusal (e.g. 133) instead of assuming the
                // rendezvous succeeded because `connectGatt` handed back a client object.
                onConnectionStateChange(connected, status)
            } catch (_: UnsatisfiedLinkError) {
                // JNI not loaded — no-op
            }
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    try {
                        gatt.discoverServices()
                    } catch (e: SecurityException) {
                        connectRefused("discoverServices (callback)", e)
                    }
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    teardownGatt()
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            Log.i(TAG, "services discovered: status=$status count=${gatt.services.size}")
            discoveredServices.clear()
            discoveredServices.addAll(gatt.services)
            try {
                onServicesDiscovered(servicesJson(discoveredServices))
            } catch (_: UnsatisfiedLinkError) {
                // JNI not loaded
            }
        }

        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            chr: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) {
            Log.i(TAG, "char read: ${chr.uuid} status=$status len=${value.size}")
            // Report **every** verdict, not only success: a failed read used to skip the
            // callback entirely, so the Rust waiter saw no answer at all and `ble_read` guessed
            // with its 5s timeout — the device's own status never reached the screen
            // (REQ-A1158 / F-SH-459). `value` is empty on failure and is not rendered as a value.
            try {
                onCharacteristicReadResult(chr.uuid.toString(), value, status)
            } catch (_: UnsatisfiedLinkError) {
                // JNI not loaded
            }
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            chr: BluetoothGattCharacteristic,
            status: Int,
        ) {
            Log.i(TAG, "char write: ${chr.uuid} status=$status")
            try {
                onCharacteristicWriteResult(chr.uuid.toString(), status)
            } catch (_: UnsatisfiedLinkError) {
                // JNI not loaded
            }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            chr: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            Log.v(TAG, "char changed: ${chr.uuid} len=${value.size}")
            try {
                onCharacteristicChanged(chr.uuid.toString(), value)
            } catch (_: UnsatisfiedLinkError) {
                // JNI not loaded
            }
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int,
        ) {
            Log.i(TAG, "descriptor write: ${descriptor.uuid} status=$status")
            // Forward the *device's* verdict for the CCC write so `ble_subscribe` /
            // `ble_unsubscribe` can resolve, instead of reporting the local registration as
            // success (REQ-A1158 / F-SH-459). Keyed by characteristic UUID — the descriptor
            // alone does not say which characteristic it configures.
            val chrUuid = descriptor.characteristic?.uuid?.toString() ?: return
            try {
                onDescriptorWriteResult(chrUuid, status)
            } catch (_: UnsatisfiedLinkError) {
                // JNI not loaded
            }
        }
    }

    // ── JNI stubs (called by Rust) ─────────────────────────────────────────────

    // Note: connect / disconnect / discoverServices / readCharacteristic /
    // writeCharacteristic / setCharacteristicNotification are called FROM Rust
    // via the JNI `call_static_method` invocation pattern, not declared as
    // external here. The `external fun` declarations below are for the REVERSE
    // direction (Kotlin callback → Rust upcall).

    /**
     * Returns whether a BLE device is currently connected.
     */
    @JvmStatic
    fun isConnected(): Boolean = gatt != null

    // ── JNI upcall stubs (Rust → Kotlin) ──────────────────────────────────────

    external fun onConnectionStateChange(connected: Boolean, status: Int)

    external fun onServicesDiscovered(servicesJson: String)

    external fun onCharacteristicReadResult(uuid: String, value: ByteArray, status: Int)

    external fun onCharacteristicWriteResult(uuid: String, status: Int)

    external fun onDescriptorWriteResult(uuid: String, status: Int)

    external fun onCharacteristicChanged(uuid: String, value: ByteArray)
}

// BluetoothGlue.kt — Kotlin half of the AmOS Bluetooth *discovery* (REQ-A200, LE added
// in REQ-A201).
//
// Why this cannot live in Rust (the same reason as `TetheringGlue` / `SmsGlue`):
// a Bluetooth scan is **asynchronous and callback-based**. `startDiscovery()` only
// starts the classic scan; results arrive as `BluetoothDevice.ACTION_FOUND` broadcasts
// and the end as `BluetoothAdapter.ACTION_DISCOVERY_FINISHED`, while a Bluetooth LE
// scan delivers `ScanResult`s to a `ScanCallback`. Raw JNI can issue the calls but
// cannot host a `BroadcastReceiver` or implement an interface, so the glue owns both
// and Rust polls the accumulated state (no event stream to lose).
//
// Rust (`crates/amos-radio/src/android.rs`, `android` feature) calls these statics:
//   * `startDiscovery(context): Boolean` — did the platform **accept** the scan?
//                                          (starts classic + LE search)
//   * `stopDiscovery(context): Boolean`  — did it cancel it? (stops both)
//   * `scanState(context): String`       — JSON: discovering / classic / le / capped /
//                                          scan (permission) /
//                                          devices[{address,name,rssi,bond,le}] /
//                                          bonds[{address,state}]
//   * `bond(context, address): Boolean`  — did `createBond()` accept the request?
//
// API reality (verified against this machine's `android-34`/`android-36`
// `android.jar` with `javap`, and against the device with `dumpsys`):
//   * `BluetoothAdapter#startDiscovery` / `cancelDiscovery` / `isDiscovering` and
//     `BluetoothDevice#createBond` are public SDK; from **API 31** they need the
//     `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT` **runtime** permissions (below 31 the
//     install-time `BLUETOOTH`/`BLUETOOTH_ADMIN` pair).
//   * `BluetoothLeScanner#startScan(ScanCallback)` / `#stopScan(ScanCallback)` are
//     public since API 21 and need the **same** `BLUETOOTH_SCAN` runtime permission —
//     so scanning LE costs **no extra permission** and, with `neverForLocation` in the
//     manifest, does not require location access either (verified on the S5).
//   * `BluetoothDevice#getBondState`/`BOND_NONE`(10)/`BOND_BONDING`(11)/`BOND_BONDED`(12)
//     are public; `ACTION_BOND_STATE_CHANGED` reports every transition.
//   * A scan must be **cancelled** — the platform stops classic discovery on its own
//     after ~12 s, but leaving either scan running costs battery, so the screen stops it.
//
// Honest boundaries:
//   * A result list is **bounded** ([MAX_DEVICES]); when the cap is hit we report
//     `capped: true` rather than handing back a silently-truncated list that reads
//     as complete (the rule `DevCareGlue` follows for its walk).
//   * `bond()` is a **request**: the platform then runs its own pairing flow, and
//     the user confirms on the peer device. `true` here means "accepted", never
//     "paired" — the paired state comes from the bonded list
//     (`BluetoothAdapter#getBondedDevices`, read by Rust) and from the raw bond states
//     this glue reports per device / per session.
//   * No permission ⇒ `false` + `scan: false` in the state, never an empty list
//     that would look like "no devices nearby".
//
// Structural delivery: the host has no Android VM, but the `android-glue-check`
// gate type-checks this file against the real SDK (docs/android-glue.md).

package com.amos.ai.glue

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import org.json.JSONArray
import org.json.JSONObject

object BluetoothGlue {

    private const val TAG = "BluetoothGlue"

    /** `BLUETOOTH_SCAN` (and friends) became runtime permissions in API 31. */
    private const val SCAN_PERMISSION_API = 31

    /**
     * How many devices one scan remembers. A crowded room (or a scan left running)
     * can produce far more; past this we stop growing the list **and say so**
     * (`capped: true`) instead of trimming silently.
     */
    private const val MAX_DEVICES = 64

    /**
     * How many bond-state records the session keeps. Same reasoning as [MAX_DEVICES]:
     * the map is a record of what happened, not an inventory, and an unbounded one in a
     * long-lived process is a leak. The oldest address is dropped first.
     */
    private const val MAX_BOND_RECORDS = 64

    /**
     * How long one LE search runs before it stops itself.
     *
     * Classic discovery ends on its own after ~12 s, but an LE scan does **not** — it
     * would keep the radio busy (and the screen polling every 1.5 s) until the user
     * leaves the page. Bounding it here keeps the battery rule the screen already
     * implements ("a scan is a request, not a mode") and makes the end of the search a
     * fact the state reports rather than something the user has to guess.
     */
    private const val LE_SCAN_WINDOW_MS = 30_000L

    private data class Found(
        val address: String,
        val name: String,
        val rssi: Int,
        /** The raw platform bond state (`BOND_NONE`/`BOND_BONDING`/`BOND_BONDED`). */
        val bond: Int,
        /** `true` when this device answered on the LE side (possibly as well as classic). */
        val le: Boolean,
    )

    private val found = LinkedHashMap<String, Found>()
    private var capped = false
    private var discovering = false
    private var receiver: BroadcastReceiver? = null

    /**
     * The LE scan's callback. Kept as a field because `stopScan` needs the **same**
     * instance that was started (the platform keys the scan by callback object).
     */
    private var leCallback: ScanCallback? = null
    private var leScanning = false

    /** The pending end-of-window callback for the LE scan (see [LE_SCAN_WINDOW_MS]). */
    private val main = Handler(Looper.getMainLooper())
    private var leWindow: Runnable? = null

    /**
     * Bond transitions seen since the process started, keyed by address.
     *
     * A transition is about the device the *user* asked to pair with, which need not be
     * in [found]: the scan may have been restarted (the list is cleared on every start),
     * the device may have stopped advertising, or the address may never have been seen
     * at all. The first version of this glue dropped those transitions silently, so a
     * pairing request the framework really ran left no trace the screen could read
     * (REQ-A201).
     */
    private val bonds = LinkedHashMap<String, Int>()

    /**
     * Start a scan — **classic discovery + a Bluetooth LE scan**, because they are two
     * different radios with two different result streams and a user asking for "nearby
     * devices" means both (a pair of earbuds that only advertises over LE is invisible
     * to `startDiscovery` alone).
     *
     * `true` = the classic discovery was accepted. The LE half is started best-effort:
     * its outcome is reported honestly in `scanState`'s `le` flag instead of failing the
     * whole scan, so the screen can say which transports were searched. `false` = the
     * platform refused everything (no `BLUETOOTH_SCAN` grant, no adapter) — Rust turns
     * that into a provider error, so the screen never shows an empty list as if nothing
     * were nearby.
     */
    /**
     * Ask the platform to search. `true` = **accepted** (the classic scan started; the LE half
     * is best-effort and reported in `scanState`).
     *
     * `@SuppressLint("MissingPermission")`: every Bluetooth call in this file is either
     * guarded by a `checkSelfPermission` helper (`canScan`/`hasConnect`) or wrapped in a
     * `try/catch (Throwable)` that turns the platform's refusal into an honest `false` /
     * logged reason — the repo's rule is "a refusal is a report, never a crash". Android
     * Lint's `MissingPermission` check cannot follow either guard, so each site carries this
     * suppression **with this reason** rather than a permission check that would only
     * duplicate it (REQ-A380). The same reason applies to the other eight sites in this file.
     * `InlinedApi` is suppressed for the same kind of reason: the `BLUETOOTH_SCAN` field below
     * is a compile-time-inlined String constant (the value, not an API-31 call).
     */
    @SuppressLint("MissingPermission", "InlinedApi")
    @JvmStatic
    fun startDiscovery(context: Context): Boolean {
        val app = context.applicationContext
        val adapter = adapter(app) ?: return false
        if (!canScan(app)) {
            Log.w(TAG, "startDiscovery refused: ${Manifest.permission.BLUETOOTH_SCAN} not granted")
            return false
        }
        ensureReceiver(app)
        synchronized(found) {
            found.clear()
            capped = false
        }
        val classic = try {
            val ok = adapter.startDiscovery()
            if (ok) {
                discovering = true
            } else {
                Log.w(TAG, "startDiscovery refused by the platform")
            }
            ok
        } catch (t: Throwable) {
            Log.w(TAG, "startDiscovery failed: ${t.javaClass.simpleName}: ${t.message}")
            false
        }
        startLeScan(adapter)
        // The classic scan is the one whose acceptance decides the call: if it failed but
        // LE started, the state still says `le: true` and the screen can keep polling.
        return classic || leScanning
    }

    /** Cancel a scan. `false` = the platform refused (or there was none to cancel). */
    @SuppressLint("MissingPermission") // the guard is in canScan/hasConnect or the try/catch below — see startDiscovery (REQ-A380)
    @JvmStatic
    fun stopDiscovery(context: Context): Boolean {
        val adapter = adapter(context.applicationContext) ?: return false
        stopLeScan(adapter)
        return try {
            val ok = adapter.cancelDiscovery()
            discovering = false
            ok
        } catch (t: Throwable) {
            Log.w(TAG, "cancelDiscovery failed: ${t.javaClass.simpleName}: ${t.message}")
            false
        }
    }

    /**
     * Start the LE scan (best-effort; see [startDiscovery]). Failures are logged with
     * their `ScanCallback.SCAN_FAILED_*` code — the state then reports `le: false`, which
     * is how the screen knows LE was **not** searched rather than finding nothing.
     */
    @SuppressLint("MissingPermission") // the guard is in canScan/hasConnect or the try/catch below — see startDiscovery (REQ-A380)
    private fun startLeScan(adapter: BluetoothAdapter) {
        stopLeScan(adapter)
        val scanner: BluetoothLeScanner = try {
            adapter.bluetoothLeScanner ?: run {
                Log.w(TAG, "no BluetoothLeScanner (adapter off?) — LE scan not started")
                return
            }
        } catch (t: Throwable) {
            Log.w(TAG, "BluetoothLeScanner unavailable: ${t.javaClass.simpleName}: ${t.message}")
            return
        }
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult?) {
                if (result != null) onLeFound(result)
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>?) {
                results?.forEach { onLeFound(it) }
            }

            /**
             * A refused LE scan is **not** silently ignored: the code is logged and the
             * flag cleared, so `le: false` in the state means "LE was not searched"
             * (never "LE found nothing").
             */
            override fun onScanFailed(errorCode: Int) {
                leScanning = false
                Log.w(TAG, "LE scan failed with code $errorCode — LE results will be missing")
            }
        }
        try {
            val settings = ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build()
            scanner.startScan(null, settings, callback)
            leCallback = callback
            leScanning = true
            // The window end is posted only after the platform accepted the scan, so a
            // refusal never leaves a timer that would "stop" a scan that never ran.
            val window = Runnable {
                Log.d(TAG, "LE scan window ($LE_SCAN_WINDOW_MS ms) elapsed — stopping")
                leWindow = null
                stopLeScan(adapter)
            }
            leWindow = window
            main.postDelayed(window, LE_SCAN_WINDOW_MS)
            Log.d(TAG, "LE scan started")
        } catch (t: Throwable) {
            leScanning = false
            Log.w(TAG, "LE scan not started: ${t.javaClass.simpleName}: ${t.message}")
        }
    }

    /** Stop the LE scan (idempotent; nothing running is not an error). */
    @SuppressLint("MissingPermission") // the guard is in canScan/hasConnect or the try/catch below — see startDiscovery (REQ-A380)
    private fun stopLeScan(adapter: BluetoothAdapter) {
        leWindow?.let { main.removeCallbacks(it) }
        leWindow = null
        val callback = leCallback ?: return
        try {
            adapter.bluetoothLeScanner?.stopScan(callback)
        } catch (t: Throwable) {
            Log.w(TAG, "LE stopScan failed: ${t.javaClass.simpleName}: ${t.message}")
        }
        leCallback = null
        leScanning = false
    }

    /**
     * Ask the platform to pair with [address]. `true` = the request was accepted
     * (the system then runs its pairing flow and the user confirms on the peer);
     * `false` = refused (no `BLUETOOTH_CONNECT`, unknown address, or the platform
     * declined).
     */
    @SuppressLint("MissingPermission") // the guard is in canScan/hasConnect or the try/catch below — see startDiscovery (REQ-A380)
    @JvmStatic
    fun bond(context: Context, address: String): Boolean {
        val adapter = adapter(context.applicationContext) ?: return false
        return try {
            val ok = adapter.getRemoteDevice(address).createBond()
            if (!ok) Log.w(TAG, "createBond refused for $address")
            ok
        } catch (t: Throwable) {
            Log.w(TAG, "createBond failed for $address: ${t.javaClass.simpleName}: ${t.message}")
            false
        }
    }

    /**
     * The scan's current state as JSON — the only read Rust makes.
     *
     * * `classic` — the platform's own `isDiscovering` (falling back to our
     *   receiver-tracked flag when the adapter cannot answer).
     * * `le` — our LE scan is active (and `false` means LE was **not** searched: either
     *   the platform refused the scan or the adapter has no LE scanner).
     * * `discovering` — *a search is running*: classic **or** LE. The screen polls while
     *   this is true, so results that keep arriving over LE after the ~12 s classic
     *   window are still rendered.
     * * `scan` — whether `BLUETOOTH_SCAN` is granted, so the caller can tell "cannot
     *   look" from "nothing there".
     */
    @SuppressLint("MissingPermission") // the guard is in canScan/hasConnect or the try/catch below — see startDiscovery (REQ-A380)
    @JvmStatic
    fun scanState(context: Context): String {
        val app = context.applicationContext
        val live = try {
            adapter(app)?.isDiscovering
        } catch (t: Throwable) {
            Log.w(TAG, "isDiscovering unavailable: ${t.javaClass.simpleName}")
            null
        }
        val classic = live ?: discovering
        val devices = JSONArray()
        synchronized(found) {
            for (d in found.values) {
                devices.put(
                    JSONObject()
                        .put("address", d.address)
                        .put("name", d.name)
                        .put("rssi", d.rssi)
                        .put("bond", d.bond)
                        .put("le", d.le),
                )
            }
        }
        val bondList = JSONArray()
        synchronized(bonds) {
            for ((address, state) in bonds) {
                bondList.put(JSONObject().put("address", address).put("state", state))
            }
        }
        return JSONObject()
            .put("discovering", classic || leScanning)
            .put("classic", classic)
            .put("le", leScanning)
            .put("capped", capped)
            .put("scan", canScan(app))
            .put("devices", devices)
            .put("bonds", bondList)
            .toString()
    }

    /**
     * The device's Bluetooth adapter (through `BluetoothManager`, the same route
     * Rust's provider takes), or `null` on a device without Bluetooth.
     */
    private fun adapter(context: Context): BluetoothAdapter? =
        try {
            context.getSystemService(BluetoothManager::class.java)?.adapter
        } catch (t: Throwable) {
            Log.w(TAG, "no Bluetooth adapter: ${t.javaClass.simpleName}")
            null
        }

    /** `true` when this app may scan: install-time below API 31, runtime from 31. */
    private fun canScan(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < SCAN_PERMISSION_API) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) ==
            PackageManager.PERMISSION_GRANTED
    }

    /**
     * Register the discovery receiver **once**, at the first scan (not at boot): a
     * receiver that is only needed while a scan is requested should not be alive for
     * the whole process.
     *
     * `RECEIVER_EXPORTED`, **verified on a device rather than assumed** (REQ-A200):
     * the first version registered with `RECEIVER_NOT_EXPORTED` on the theory that a
     * system-broadcast-only receiver qualifies — and on the S5 (Android 14) a scan that
     * the stack *did* complete (`btif_dm_search_devices_evt` for two devices,
     * `BTA_DM_DISCOVERY_RESULT_EVT` ×7 in logcat) delivered **zero** `ACTION_FOUND`
     * broadcasts, so the screen showed "no devices found" for a scan that found two.
     * That is exactly the silent-lie shape this repo gates against: the flag is now
     * EXPORTED and the delivery is verified by a real scan.
     *
     * The receiver is exported but the **filter is Bluetooth-only**, and Android's
     * `ACTION_FOUND` is a protected broadcast that only the system may send, so export
     * does not open it to other apps' intents.
     */
    private fun ensureReceiver(context: Context) {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                when (intent?.action) {
                    BluetoothDevice.ACTION_FOUND -> onFound(intent)
                    BluetoothAdapter.ACTION_DISCOVERY_STARTED -> discovering = true
                    BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> discovering = false
                    BluetoothDevice.ACTION_BOND_STATE_CHANGED -> onBondChanged(intent)
                    else -> {}
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(BluetoothDevice.ACTION_FOUND)
            addAction(BluetoothAdapter.ACTION_DISCOVERY_STARTED)
            addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
            addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
        }
        try {
            ContextCompat.registerReceiver(context, r, filter, ContextCompat.RECEIVER_EXPORTED)
            receiver = r
        } catch (t: Throwable) {
            Log.w(TAG, "discovery receiver not registered: ${t.javaClass.simpleName}: ${t.message}")
        }
    }

    /** One `ACTION_FOUND` (classic discovery): remember the device, or refresh it. */
    private fun onFound(intent: Intent) {
        val device = IntentCompat.getParcelableExtra(
            intent,
            BluetoothDevice.EXTRA_DEVICE,
            BluetoothDevice::class.java,
        )
        if (device == null) {
            // The broadcast arrived without a device: report it instead of dropping it
            // silently (a row would be missing with no trace of why).
            Log.w(TAG, "ACTION_FOUND without ${BluetoothDevice.EXTRA_DEVICE}")
            return
        }
        val address = device.address ?: return
        val rssi = intent.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE).toInt()
        // Name/bond-state reads need BLUETOOTH_CONNECT; the address is still a usable
        // row, so a refusal here degrades the row instead of dropping the device.
        val bond = bondStateOf(device)
        val name = nameOf(device)
        Log.d(TAG, "found(classic) $address name=\"$name\" rssi=$rssi bond=$bond")
        remember(address, name, rssi, bond, le = false)
    }

    /** One LE `ScanResult`: same list, tagged as seen over LE. */
    private fun onLeFound(result: ScanResult) {
        val device = result.device ?: return
        val address = device.address ?: return
        // The advert's own name avoids a `BLUETOOTH_CONNECT` round trip (and works when
        // that permission is missing); `device.name` is only the fallback.
        val advertised = try {
            result.scanRecord?.deviceName ?: ""
        } catch (t: Throwable) {
            ""
        }
        val name = if (advertised.isNotBlank()) advertised else nameOf(device)
        Log.d(TAG, "found(le) $address name=\"$name\" rssi=${result.rssi}")
        remember(address, name, result.rssi, bondStateOf(device), le = true)
    }

    /**
     * Add or refresh a device row. A device already known keeps the **better** of the
     * two readings (a name it had, and `le = true` once any LE advertisement saw it):
     * classic discovery and LE scanning are two channels for the same device, and the
     * row describes the device, not the last packet.
     */
    private fun remember(address: String, name: String, rssi: Int, bond: Int, le: Boolean) {
        synchronized(found) {
            val prev = found[address]
            if (prev == null && found.size >= MAX_DEVICES) {
                capped = true
                return
            }
            found[address] = Found(
                address = address,
                name = if (name.isNotBlank()) name else prev?.name ?: "",
                // Only a real reading displaces a previous one: `Short.MIN_VALUE` is what
                // `EXTRA_RSSI` yields when the platform sent none.
                rssi = if (rssi != Short.MIN_VALUE.toInt()) rssi else prev?.rssi ?: rssi,
                bond = bond,
                le = le || (prev?.le ?: false),
            )
        }
        // `getBondState` is the platform's *current* answer, so a fresh reading refreshes
        // an existing session record: without this, a device unpaired from the system
        // settings would keep its old `BOND_BONDED` record for the rest of the session
        // (the record outranks the row — see `amos_radio::BtScan::bond_state`). A device
        // merely *found* does **not** get a record: the map is the history of the pairing
        // the user asked for, not a second copy of the result list.
        refreshBondRecord(address, bond)
    }

    /** Refresh an existing session record for `address`; a new address is not recorded. */
    private fun refreshBondRecord(address: String, state: Int) {
        synchronized(bonds) {
            if (bonds.containsKey(address)) bonds[address] = state
        }
    }

    /** Keep the session's bond record for `address` (bounded; oldest record goes first). */
    private fun recordBond(address: String, state: Int) {
        synchronized(bonds) {
            bonds.remove(address)
            bonds[address] = state
            while (bonds.size > MAX_BOND_RECORDS) {
                val oldest = bonds.keys.firstOrNull() ?: break
                bonds.remove(oldest)
            }
        }
    }

    /** `BluetoothDevice#getBondState`, or `BOND_NONE` when the read is refused. */
    @SuppressLint("MissingPermission") // the guard is in canScan/hasConnect or the try/catch below — see startDiscovery (REQ-A380)
    private fun bondStateOf(device: BluetoothDevice): Int = try {
        device.bondState
    } catch (t: Throwable) {
        BluetoothDevice.BOND_NONE
    }

    /** `BluetoothDevice#getName`, or `""` when it has none / the read is refused. */
    @SuppressLint("MissingPermission") // the guard is in canScan/hasConnect or the try/catch below — see startDiscovery (REQ-A380)
    private fun nameOf(device: BluetoothDevice): String = try {
        device.name ?: ""
    } catch (t: Throwable) {
        ""
    }

    /**
     * A bond-state change: record it in the session list **and** refresh the row if the
     * device is in it.
     *
     * The session record is what makes pairing progress visible for a device that is not
     * (or no longer) in the result list — see [bonds]. Recording only rows we already had
     * is what made a `BOND_STATE_BONDING` → `BOND_STATE_NONE` sequence invisible.
     */
    private fun onBondChanged(intent: Intent) {
        val device = IntentCompat.getParcelableExtra(
            intent,
            BluetoothDevice.EXTRA_DEVICE,
            BluetoothDevice::class.java,
        ) ?: return
        val address = device.address ?: return
        val state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.BOND_NONE)
        val previous = intent.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, -1)
        Log.d(TAG, "bond $address $previous -> $state")
        recordBond(address, state)
        synchronized(found) {
            val prev = found[address] ?: return
            found[address] = prev.copy(bond = state)
        }
    }
}


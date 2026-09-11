// DevCareGlue.kt — Android device-care (手机管家) implementation for AmOS.
//
// Kotlin half of the device-care subsystem (crates/amos-tauri/src/devcare_device.rs,
// cargo feature `android`). The Rust side owns the *policy*; this glue owns the
// platform calls it cannot make: `PackageManager` (inventory + uninstall intent),
// `StatFs` (storage totals) and the app-private filesystem (junk scan + delete).
//
// String <-> String JSON contract with the Rust `AndroidDevCare`:
//   fun scanJunk(): String        -> JSON array of {uri,kind,size_bytes} | {"error":…}
//   fun installedApps(): String   -> JSON array of {id,name,system,size_bytes?} | {"error":…}
//   fun uninstallApp(id): String  -> {"launched":true,"id":…} | {"error":…}
//   fun storage(): String         -> {total_bytes,used_bytes,free_bytes} | {"error":…}
//   fun battery(): String         -> {level_pct,charging,thermal_throttled?} | {"error":…}
//   fun removeJunk(uri): String   -> {"removed":true} | {"error":…}
//
// `kind` tags must match amos-devocare's `JunkKind` wire tags exactly:
//   app_cache | apk_installer | log_file | temp_file | thumbnail | crash_dump |
//   empty_dir | stale_download
//
// # What a non-root retail app can honestly clean
//
// Android's sandbox means another app's `cache/` is NOT readable or deletable
// from here, so this scanner does **not** pretend to be a system-wide cleaner:
//   * the app's own `cacheDir` / `codeCacheDir` / `externalCacheDir` subtree
//     (cache files, thumbnails, tombstones, dmp/hprof, empty dirs);
//   * our own files dir for rotated logs / temp files / leftover APKs;
//   * leftover installers in the public `Download` collection (MediaStore), which
//     is best-effort and silently skipped when read access is not granted.
// "整机全盘清理" needs a privileged (system/root) build — this reports what it
// actually observed rather than inventing the rest.
//
// COMPILE / VERIFY PATH (no full APK needed): copy this file into the generated
// Tauri-Android project's package com.amos.ai.glue, then compile the Rust wire side
// headlessly with `cargo check -p amos-tauri --features android`, and type-check
// this file with `./gradlew :app:compileDebugKotlin`. Real behaviour needs a
// device (see docs/devcare.md § device bring-up).

package com.amos.ai.glue

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.provider.MediaStore
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference

/** System-UI-side device-care glue handed to Rust via `attach`. */
object DevCareGlue {

    private const val TAG = "DevCareGlue"

    /** Maximum directory depth the walk descends (mirrors hostfs MAX_SCAN_DEPTH). */
    private const val MAX_DEPTH = 12

    /** Cap on the number of reported items (mirrors hostfs MAX_JUNK_ITEMS). */
    private const val MAX_ITEMS = 10_000

    /** Directory names whose whole subtree is rebuildable cache. */
    private val CACHE_DIRS = setOf("cache", "code_cache", ".cache", "tmp", "temp")

    /** Directory names whose contents are regenerable thumbnails. */
    private val THUMB_DIRS = setOf(".thumbnails", "thumbnails")

    /** Extensions of leftover installer payloads. */
    private val APK_EXTS = setOf("apk", "apks", "xapk", "apkm")

    /** Extensions of temporary files. */
    private val TEMP_EXTS = setOf("tmp", "temp", "swp", "swo")

    /** Extensions of crash dumps / heap profiles. */
    private val CRASH_EXTS = setOf("dmp", "hprof")

    /**
     * Sentinel for "the `status` extra was not present at all".
     *
     * Every real `BatteryManager.BATTERY_STATUS_*` value is `>= 1`
     * (`BATTERY_STATUS_UNKNOWN = 1`), so `-1` cannot collide with a reading.
     */
    private const val BATTERY_STATUS_ABSENT = -1

    @Volatile
    private var app: Context? = null

    /** The foreground Activity, needed for the uninstall dialog on Android 10+. */
    @Volatile
    private var activityRef: WeakReference<Activity>? = null

    /** Rust JNI upcall: `Java_com_amos_ai_glue_DevCareGlue_attach`. */
    private external fun attach(glue: DevCareGlue)

    /** Rust JNI upcall: reports what the native half actually sees (diagnostic). */
    private external fun probeAttached(): String

    /**
     * Bind the application context and install the Rust backend.
     *
     * Idempotent and fails soft: a missing native symbol (an APK built without the
     * `android` feature) must not crash the System UI boot.
     */
    fun bind(context: Context) {
        app = context.applicationContext
        try {
            attach(this)
            Log.i(TAG, "DevCareGlue bound (Rust backend attached)")
        } catch (t: Throwable) {
            Log.w(TAG, "devcare attach upcall failed (missing android native feature?): $t")
        }
        // Verbose bring-up self-check — **opt-in only**. `installedApps()` walks
        // ~200 packages (~2 s device-verified) and this runs on the Activity's
        // main thread, so it must never be unconditional; a production launch
        // stays free of it. Create the marker to ask for a full read-out:
        //   adb shell run-as com.amos.ai touch files/devcare-selfcheck
        if (!selfcheckRequested()) return
        try {
            Log.i(TAG, "self-check storage => ${storage()}")
            Log.i(TAG, "self-check battery => ${battery()}")
            Log.i(TAG, "self-check installedApps => ${JSONArray(installedApps()).length()} apps")
        } catch (t: Throwable) {
            Log.w(TAG, "devcare self-check failed: $t")
        }
        // What the *Rust* half sees (AppHandle installed? backend attached? which
        // platform paths did it resolve?). A missing native half is exactly what
        // this exposes, and Kotlin is the only side that can log meaningfully.
        try {
            Log.i(TAG, "self-check rust => ${probeAttached()}")
        } catch (t: Throwable) {
            Log.w(TAG, "devcare rust probe failed: $t")
        }
    }

    /** Whether the operator asked for the verbose bring-up self-check. */
    private fun selfcheckRequested(): Boolean {
        val ctx = app ?: return false
        val names = listOf(ctx.filesDir.path, ctx.cacheDir.path, ctx.dataDir.path)
        return names.any { File(it, "devcare-selfcheck").exists() }
    }

    /** Remember the foreground Activity so `ACTION_DELETE` can be posted from it. */
    fun attachActivity(activity: Activity) {
        activityRef = WeakReference(activity)
    }

    // ------------------------------- scan -------------------------------

    /** Scan for reclaimable junk. Returns a JSON array, or `{"error":…}`. */
    fun scanJunk(): String {
        val ctx = app ?: return err("DevCareGlue not bound")
        return try {
            val roots = privateRoots(ctx)
            // Canonical prefixes, computed once: the walk stays confined to the
            // app's own directories and never follows a path outside them.
            val allowed = roots.mapNotNull { canonicalOrNull(it.first) }
            val out = JSONArray()
            var capped = false
            for ((root, isCache) in roots) {
                if (!root.isDirectory) continue
                // A cache root starts *inside* the cache subtree, so its files are
                // `app_cache` and its empty dirs are reclaimable.
                capped = walk(root, 0, isCache, false, allowed, out) || capped
                if (capped) break
            }
            if (!capped) {
                // Best-effort: public Download installers. Skipped (not failed)
                // when the read permission is absent.
                try {
                    capped = scanPublicDownloads(ctx, out)
                } catch (t: Throwable) {
                    Log.w(TAG, "public downloads scan skipped: ${t.message}")
                }
            }
            // An over-cap scan is PARTIAL. Refuse it instead of returning a
            // silently-truncated list that would look complete to the user and to
            // the Rust analyzer (`junk::analyze`'s "refuse, never trim" rule,
            // docs/devcare.md §5.3; the host-fs backend hard-errors on the cap too).
            if (capped) {
                return err("scan found more than $MAX_ITEMS items; refusing a partial scan")
            }
            out.toString()
        } catch (t: Throwable) {
            err(t.message ?: "scan failed")
        }
    }

    /**
     * Depth-first walk of the app's own subtree.
     *
     * Returns `true` when the subtree holds **more than** [MAX_ITEMS] modelable
     * items, i.e. the scan cannot be completed under the cap. The caller must then
     * refuse the whole scan rather than present a truncated list as a full one
     * (docs/devcare.md §5.3). The cap is checked *before* an insert, so a scan of
     * exactly [MAX_ITEMS] items is still complete and returns `false`.
     */
    private fun walk(
        dir: File,
        depth: Int,
        inCache: Boolean,
        inThumbs: Boolean,
        allowed: List<String>,
        out: JSONArray,
    ): Boolean {
        if (depth > MAX_DEPTH) return false
        val children = dir.listFiles() ?: return false

        // An empty directory is left-over junk — but never the root itself, and
        // only inside a cache subtree (an empty dir in the app's data files may be
        // structurally meaningful, so it is not modelled as junk).
        if (children.isEmpty()) {
            if (depth > 0 && inCache) {
                if (out.length() >= MAX_ITEMS) return true
                out.put(itemJson(dir.absolutePath, "empty_dir", 0L))
            }
            return false
        }

        for (child in children) {
            if (!isWithinAllowed(allowed, child)) continue
            if (child.isDirectory) {
                val name = child.name.lowercase()
                val childCache = inCache || CACHE_DIRS.contains(name)
                val childThumbs = inThumbs || THUMB_DIRS.contains(name)
                if (walk(child, depth + 1, childCache, childThumbs, allowed, out)) return true
            } else if (child.isFile) {
                val kind = when {
                    inThumbs -> "thumbnail"
                    inCache -> "app_cache"
                    else -> classifyFile(child.name)
                }
                if (kind != null) {
                    // Refuse rather than add item number MAX_ITEMS + 1: the scan is
                    // over the cap and must not masquerade as a complete one.
                    if (out.length() >= MAX_ITEMS) return true
                    out.put(itemJson(child.absolutePath, kind, child.length()))
                }
            }
        }
        return false
    }

    /** Classify a file by extension only (never by content sniffing). */
    private fun classifyFile(name: String): String? {
        val ext = name.substringAfterLast('.', "").lowercase()
        return when {
            APK_EXTS.contains(ext) -> "apk_installer"
            TEMP_EXTS.contains(ext) -> "temp_file"
            CRASH_EXTS.contains(ext) -> "crash_dump"
            ext == "log" -> "log_file"
            else -> null
        }
    }

    /**
     * Leftover installers in the public `Download` collection.
     *
     * MediaStore-only: a non-root app cannot `read_dir("/sdcard/Download")` under
     * scoped storage. Skipped entirely when the query is not permitted, and only
     * modelled installer payloads are reported — a user document is never junk.
     *
     * Returns `true` when appending would exceed [MAX_ITEMS], so the caller refuses
     * the scan instead of shipping a truncated list (never a silent trim).
     */
    private fun scanPublicDownloads(ctx: Context, out: JSONArray): Boolean {
        // `MediaStore.Downloads` only exists on API 29+; on anything older there is
        // nothing to query, so report "complete" explicitly rather than relying on
        // a `NoSuchFieldError` being caught by the caller (expected behaviour must
        // not be driven by exceptions). minSdk is 26, so this branch is reachable.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        val resolver = ctx.contentResolver
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
        )
        resolver.query(
            MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            projection,
            null,
            null,
            null,
        )?.use { cursor ->
            val idCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            val nameCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
            val sizeCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
            while (cursor.moveToNext()) {
                val name = cursor.getString(nameCol) ?: continue
                if (classifyFile(name) != "apk_installer") continue
                // Cap the *reported* items, exactly like `walk`: the collection is
                // examined to the end, so hitting the cap really does mean "more
                // installers than we may hand over" ⇒ refuse, never trim. (Bounding
                // the examined rows instead — the previous behaviour — would return
                // a short list as if it were complete; docs/devcare.md §5.3.)
                if (out.length() >= MAX_ITEMS) return true
                // A row whose SIZE cannot be read is NOT reported: the wire has no
                // "unknown size" for a junk item, and filling in `0` would hand the
                // analyzer a fabricated measurement (aerospace P0-3) that also
                // understates the bytes a clean would free. A null SIZE in the
                // Download collection normally means the file is already gone, so
                // there is nothing left to clean anyway.
                if (cursor.isNull(sizeCol)) continue
                val size = cursor.getLong(sizeCol)
                val uri = Uri.withAppendedPath(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    cursor.getLong(idCol).toString(),
                )
                out.put(itemJson(uri.toString(), "apk_installer", size))
            }
        }
        return false
    }

    // ------------------------------ inventory ------------------------------

    /** The installed-package inventory from `PackageManager`. */
    fun installedApps(): String {
        val ctx = app ?: return err("DevCareGlue not bound")
        return try {
            val pm = ctx.packageManager
            val arr = JSONArray()
            for (ai in pm.getInstalledApplications(0)) {
                val obj = JSONObject()
                    .put("id", ai.packageName)
                    .put("name", appLabel(pm, ai))
                    .put("system", (ai.flags and ApplicationInfo.FLAG_SYSTEM) != 0)
                // The installed APK's size — a real reading, or omitted (never a
                // fabricated 0) when it cannot be read.
                apkSize(ai)?.let { obj.put("size_bytes", it) }
                arr.put(obj)
            }
            arr.toString()
        } catch (t: Throwable) {
            err(t.message ?: "inventory failed")
        }
    }

    private fun appLabel(pm: PackageManager, ai: ApplicationInfo): String =
        try {
            pm.getApplicationLabel(ai).toString()
        } catch (t: Throwable) {
            ai.packageName
        }

    /** The base APK's size on disk, or `null` when unreadable. */
    private fun apkSize(ai: ApplicationInfo): Long? {
        val src = ai.sourceDir ?: return null
        val len = File(src).length()
        return if (len > 0) len else null
    }

    // ------------------------------ uninstall ------------------------------

    /**
     * Post the system uninstall dialog for `id` (`ACTION_DELETE`).
     *
     * This only **launches** the request: Android confirms the removal itself and
     * reports the result asynchronously, so the reply says `launched`, never
     * "removed". The Rust `UninstallGuard` policy has already run by this point.
     */
    fun uninstallApp(id: String): String {
        val ctx = app ?: return err("DevCareGlue not bound")
        if (id.isBlank()) return err("empty package id")
        return try {
            ctx.packageManager.getApplicationInfo(id, 0)
            val intent = Intent(Intent.ACTION_DELETE, Uri.parse("package:$id"))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            // Prefer the foreground Activity: Android 10+ drops an
            // application-context `startActivity` for a user-visible dialog
            // **silently** (no exception), so which context we used is the one
            // fact worth logging when a dialog fails to appear.
            val activity = activityRef?.get()
            val from: Context = activity ?: ctx
            from.startActivity(intent)
            val origin = if (activity != null) "activity" else "application-context"
            Log.i(TAG, "uninstallApp($id) launched via $origin")
            JSONObject()
                .put("launched", true)
                .put("id", id)
                .put("origin", origin)
                .toString()
        } catch (t: Throwable) {
            Log.w(TAG, "uninstallApp($id) failed: $t")
            err(t.message ?: "uninstall intent failed")
        }
    }

    // ------------------------------- storage -------------------------------

    /** Whole-device storage totals for the data partition (internal storage). */
    fun storage(): String {
        return try {
            val path = Environment.getDataDirectory()
            val fs = StatFs(path.path)
            val total = fs.totalBytes
            val free = fs.availableBytes
            if (total <= 0L) return err("no storage reading for ${path.path}")
            JSONObject()
                .put("total_bytes", total)
                .put("free_bytes", free)
                .put("used_bytes", (total - free).coerceAtLeast(0L))
                .put("volume", "data")
                .toString()
        } catch (t: Throwable) {
            err(t.message ?: "storage read failed")
        }
    }

    // ------------------------------- battery -------------------------------

    /**
     * The device battery / thermal state from `BatteryManager`.
     *
     * The **same** source `amos-power`'s energy governor reads on-device (the
     * sticky `ACTION_BATTERY_CHANGED` broadcast), so the care report and the
     * governor agree on the facts:
     *   * `level` / `scale` → `level_pct` (a real state of charge);
     *   * `status` → `charging` (`BATTERY_STATUS_CHARGING` / `BATTERY_STATUS_FULL`
     *     ⇒ `true`, `BATTERY_STATUS_DISCHARGING` / `BATTERY_STATUS_NOT_CHARGING`
     *     ⇒ `false`) — **omitted** for `BATTERY_STATUS_UNKNOWN` or an absent extra,
     *     because "we do not know the charger state" must not be reported as "not
     *     charging" (that would fabricate a low-battery finding);
     *   * `thermal_throttled` is the platform's **own** verdict
     *     (`PowerManager.currentThermalStatus`, API 29+), not a temperature
     *     threshold we invent — below API 29 it is omitted (unknown).
     *
     * An out-of-range `level` (`> scale`) is a self-contradictory broadcast, so it
     * is reported as a **read failure**, never clamped into a healthy-looking
     * percentage. A missing reading returns `{"error":…}`; the Rust side folds that
     * into an all-unknown reading (never a fabricated 0%), and the bridge then
     * reports the battery area as unobserved instead of healthy.
     */
    fun battery(): String {
        val ctx = app ?: return err("DevCareGlue not bound")
        return try {
            // `ACTION_BATTERY_CHANGED` is a protected system broadcast, so the
            // API 33+ receiver-flag requirement does not apply; a null receiver is
            // the documented way to read the sticky intent's extras.
            val intent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                ?: return err("no battery broadcast")
            val level = intent.getIntExtra("level", -1)
            val scale = intent.getIntExtra("scale", -1)
            // An out-of-range reading is NOT a reading: refuse it instead of
            // clamping a malformed broadcast into a healthy-looking percentage.
            if (level < 0 || scale <= 0 || level > scale) {
                return err("battery level $level out of range (scale $scale)")
            }
            val obj = JSONObject().put("level_pct", Math.round(100.0 * level / scale))
            // `charging` is emitted ONLY when the platform actually reported a
            // status: an absent / `BATTERY_STATUS_UNKNOWN` value stays OMITTED, so
            // the Rust side reports the battery as unobserved. Defaulting it to
            // `false` would turn a partial platform answer into a fabricated
            // `care.battery.low` / `care.battery.critical` finding.
            chargingFrom(intent.getIntExtra("status", BATTERY_STATUS_ABSENT))?.let {
                obj.put("charging", it)
            }
            thermalThrottled()?.let { obj.put("thermal_throttled", it) }
            obj.toString()
        } catch (t: Throwable) {
            err(t.message ?: "battery read failed")
        }
    }

    /**
     * Map a `BatteryManager.BATTERY_STATUS_*` value onto a charging flag.
     *
     * `null` (unknown) for anything the platform did not actually report — the
     * `BATTERY_STATUS_UNKNOWN` value itself and the absent-extra sentinel — so an
     * unobserved charger state is never rendered as "not charging".
     */
    private fun chargingFrom(status: Int): Boolean? = when (status) {
        BatteryManager.BATTERY_STATUS_CHARGING,
        BatteryManager.BATTERY_STATUS_FULL -> true
        BatteryManager.BATTERY_STATUS_DISCHARGING,
        BatteryManager.BATTERY_STATUS_NOT_CHARGING -> false
        else -> null
    }

    /**
     * The platform's own thermal-throttling verdict, or `null` when it cannot be
     * read (below API 29 there is no `getCurrentThermalStatus`) — an unknown
     * verdict must stay unknown, never be reported as "not throttled".
     */
    private fun thermalThrottled(): Boolean? {
        val ctx = app ?: return null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        return try {
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return null
            pm.currentThermalStatus >= PowerManager.THERMAL_STATUS_MODERATE
        } catch (t: Throwable) {
            null
        }
    }

    // ------------------------------- delete -------------------------------

    /**
     * Remove one scanned item: an app-private path, or a `content://` URI.
     *
     * # Safety
     * A path is refused unless it is inside one of the app's own directories, so
     * a crafted `uri` cannot reach the rest of the sandbox (the Rust side refuses
     * too — this is defence in depth). A directory is deleted with a plain
     * `delete()`, which only succeeds when empty (never a recursive delete).
     */
    fun removeJunk(uri: String): String {
        val ctx = app ?: return err("DevCareGlue not bound")
        return try {
            if (uri.startsWith("content://")) {
                val removed = ctx.contentResolver.delete(Uri.parse(uri), null, null)
                if (removed > 0) ok() else err("nothing deleted for $uri")
            } else {
                val f = File(uri)
                val allowed = privateRoots(ctx).mapNotNull { canonicalOrNull(it.first) }
                if (!isWithinAllowed(allowed, f)) {
                    return err("refusing a path outside the app's own directories")
                }
                if (f.delete()) ok() else err("delete failed for $uri")
            }
        } catch (t: Throwable) {
            err(t.message ?: "delete failed")
        }
    }

    // ------------------------------- helpers -------------------------------

    /**
     * The app's own scan roots, each with whether it is a **cache** root
     * (rebuildable by definition) rather than a data root.
     */
    private fun privateRoots(ctx: Context): List<Pair<File, Boolean>> {
        val roots = mutableListOf<Pair<File, Boolean>>()
        roots.add(ctx.cacheDir to true)
        roots.add(ctx.codeCacheDir to true)
        roots.add(ctx.filesDir to false)
        roots.add(ctx.noBackupFilesDir to false)
        ctx.externalCacheDir?.let { roots.add(it to true) }
        ctx.getExternalFilesDir(null)?.let { roots.add(it to false) }
        return roots.distinctBy { it.first.absolutePath }
    }

    /** Canonical path of `f`, or `null` when it cannot be resolved. */
    private fun canonicalOrNull(f: File): String? =
        try {
            f.canonicalFile.path
        } catch (t: Throwable) {
            null
        }

    /**
     * Whether `f` is inside one of the allowed canonical prefixes.
     *
     * Canonicalizing the target is what makes `..` and symlinks unable to escape:
     * resolution happens first, then a component-wise prefix check. A path that
     * cannot be canonicalized is **not** allowed (the safe default).
     */
    private fun isWithinAllowed(allowed: List<String>, f: File): Boolean {
        val target = canonicalOrNull(f) ?: return false
        for (root in allowed) {
            if (target == root || target.startsWith(root + File.separator)) return true
        }
        return false
    }

    private fun itemJson(uri: String, kind: String, size: Long): JSONObject =
        JSONObject().put("uri", uri).put("kind", kind).put("size_bytes", size)

    private fun ok(): String = JSONObject().put("removed", true).toString()

    private fun err(message: String): String =
        JSONObject().put("error", message.ifBlank { "device care error" }).toString()
}

// MediaStoreGlue.kt — Android external-storage implementation for AmOS.
//
// Kotlin half of the media subsystem (crates/amos-media/src/android.rs, feature
// `android`). Rust cannot touch ContentResolver, so this glue owns it and answers
// the String<->String JSON contract the Rust AndroidMediaProvider calls over JNI:
//   fun listCollection(dir: String): String      // JSON array of MediaItem
//   fun saveCollection(dir, name, kind, mime, dataB64): String  // MediaItem | {"error":…}
//   fun loadContent(uri: String): String         // {"base64":…} | {"error":…}
//
// Wire shapes must match the serde snake_case tags in crates/amos-media/src/spec.rs
// (kind: image|video|audio|file|download; collection: camera|screenshots|pictures|
// download|recordings|movies|music). Item fields: id,kind,collection,name,uri,mime,
// size_bytes,ts.
//
// COMPILE / VERIFY PATH (no full APK needed): copy this file into the generated
// Tauri-Android project's package com.amos.ai.glue, then compile just the Rust
// wire side headlessly with:
//     cargo check -p amos-media --features android      # verifies the JNI contract
// and compile the Android app (which type-checks this .kt) with a normal
//     cargo tauri android build --debug                 # or `./gradlew :app:compileDebugKotlin`
// Real behaviour needs a device: grant READ_MEDIA_* / READ_EXTERNAL_STORAGE first
// (MediaPermissions.request below), then exercise via the System UI media_* commands.
//
// Runtime API policy mirrors crates/amos-media/src/mapping.rs: read needs granular
// READ_MEDIA_* on API 33+ / READ_EXTERNAL_STORAGE on API <=32; writing our own
// MediaStore contributions needs no permission on API >= 29.

package com.amos.ai.glue

import android.app.Activity
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/** Media permissions for AmOS external-storage access (see crates/amos-media mapping.rs). */
object MediaPermissions {
    /** The runtime read-permission set for the current API level. */
    fun readPermissionSet(): Array<String> = if (Build.VERSION.SDK_INT >= 33) {
        arrayOf(
            "android.permission.READ_MEDIA_IMAGES",
            "android.permission.READ_MEDIA_VIDEO",
            "android.permission.READ_MEDIA_AUDIO",
        )
    } else {
        arrayOf("android.permission.READ_EXTERNAL_STORAGE")
    }

    /** Whether every read permission is currently granted. */
    fun hasReadAccess(context: Context): Boolean =
        readPermissionSet().all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    /** Ask the runtime read permission(s) — the REQ_MEDIA branch of the activity. */
    fun request(activity: Activity, requestCode: Int) {
        val missing = readPermissionSet()
            .filter { activity.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
            .toTypedArray()
        if (missing.isNotEmpty()) activity.requestPermissions(missing, requestCode)
    }
}

/** One instance created on the Android main thread holding the app Context. */
class MediaStoreGlue(private val context: Context) {

    private val resolver = context.contentResolver

    // ---- list ----

    /** List a collection. Returns a JSON array of MediaItem, or an error object. */
    fun listCollection(dir: String): String {
        return try {
            if (!MediaPermissions.hasReadAccess(context)) {
                return JSONObject().put("error", "media read permission not granted").toString()
            }
            val collection = collectionUri(dir)
                ?: return JSONObject().put("error", "unsupported collection $dir").toString()
            val out = JSONArray()
            val projection = arrayOf(
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.RELATIVE_PATH,
                MediaStore.MediaColumns.MIME_TYPE,
                MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_ADDED,
            )
            val order = MediaStore.MediaColumns.DATE_ADDED + " DESC"
            // Filter to the collection's own directory (RELATIVE_PATH), so
            // "camera" returns only DCIM/Camera images — not every image on the
            // device. Unknown dirs have no filter.
            val rel = relativePathFor(dir)
            val selection = if (rel != null) {
                MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?"
            } else {
                null
            }
            val selectionArgs = if (rel != null) arrayOf("$rel%") else null
            resolver.query(collection, projection, selection, selectionArgs, order)?.use { c ->
                val idCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                val nameCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
                val mimeCol = c.getColumnIndex(MediaStore.MediaColumns.MIME_TYPE)
                val sizeCol = c.getColumnIndex(MediaStore.MediaColumns.SIZE)
                val dateCol = c.getColumnIndex(MediaStore.MediaColumns.DATE_ADDED)
                while (c.moveToNext()) {
                    val id = c.getLong(idCol)
                    val uri = ContentUris.withAppendedId(collection, id).toString()
                    val name = c.getString(nameCol) ?: "item"
                    val obj = JSONObject()
                        .put("id", uri)
                        .put("kind", kindFor(dir))
                        .put("collection", dir)
                        .put("name", name)
                        .put("uri", uri)
                    if (mimeCol >= 0) c.getString(mimeCol)?.let { obj.put("mime", it) }
                    if (sizeCol >= 0 && !c.isNull(sizeCol)) obj.put("size_bytes", c.getLong(sizeCol))
                    if (dateCol >= 0) obj.put("ts", c.getLong(dateCol) * 1000L)
                    out.put(obj)
                }
            }
            out.toString()
        } catch (t: Throwable) {
            JSONObject().put("error", t.message ?: "media list failed").toString()
        }
    }
    // ---- save (own contribution via MediaStore insert; permission-free on API 29+) ----

    /** Persist our own payload into a shared collection. Returns MediaItem JSON or error. */
    fun saveCollection(dir: String, name: String, kind: String, mime: String, dataB64: String): String {
        return try {
            val collection = collectionUri(dir)
                ?: return JSONObject().put("error", "unsupported collection $dir").toString()
            val bytes = Base64.decode(dataB64, Base64.DEFAULT)
            val relPath = relativePathFor(dir)
            if (relPath == null) {
                // API <= 28 needs a legacy real-file write (WRITE_EXTERNAL_STORAGE) —
                // not wired yet; target is API 29+.
                return JSONObject().put("error", "legacy write path (API<29) not wired").toString()
            }
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, relPath)
                if (Build.VERSION.SDK_INT >= 29) {
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
            }
            val inserted = resolver.insert(collection, values)
                ?: return JSONObject().put("error", "MediaStore insert returned null").toString()
            resolver.openOutputStream(inserted, "w")?.use { it.write(bytes) }
                ?: return JSONObject().put("error", "no stream for $inserted").toString()
            if (Build.VERSION.SDK_INT >= 29) {
                val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
                resolver.update(inserted, done, null, null)
            }
            JSONObject()
                .put("id", inserted.toString())
                .put("kind", kind)
                .put("collection", dir)
                .put("name", name)
                .put("uri", inserted.toString())
                .put("mime", mime)
                .put("size_bytes", bytes.size.toLong())
                .put("ts", System.currentTimeMillis())
                .toString()
        } catch (t: Throwable) {
            JSONObject().put("error", t.message ?: "media save failed").toString()
        }
    }

    // ---- load (read bytes back for a thumbnail / open) ----

    /** Read back the bytes of a content URI as {"base64":…} or {"error":…}. */
    fun loadContent(uriStr: String): String {
        return try {
            if (!MediaPermissions.hasReadAccess(context)) {
                return JSONObject().put("error", "media read permission not granted").toString()
            }
            val bytes = resolver.openInputStream(Uri.parse(uriStr))?.use { it.readBytes() }
                ?: return JSONObject().put("error", "cannot open $uriStr").toString()
            JSONObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)).toString()
        } catch (t: Throwable) {
            JSONObject().put("error", t.message ?: "media load failed").toString()
        }
    }

    // ---- internal helpers: dir tag -> MediaStore collection / path ----

    private fun collectionUri(dir: String): Uri? = when (dir) {
        "camera", "screenshots", "pictures" ->
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        "recordings" ->
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        "music" ->
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        "movies" ->
            MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        "download" ->
            if (Build.VERSION.SDK_INT >= 29) {
                MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                null
            }
        else -> null
    }

    /** The MediaStore RELATIVE_PATH for a dir tag, or null when writes unsupported (API<29). */
    private fun relativePathFor(dir: String): String? = when (dir) {
        "camera" -> "DCIM/Camera/"
        "screenshots" -> "Pictures/Screenshots/"
        "pictures" -> "Pictures/"
        "download" -> "Download/"
        "recordings" -> "Recordings/"
        "movies" -> "Movies/"
        "music" -> "Music/"
        else -> null
    }

    /** The MediaKind tag a collection's entries map to. */
    private fun kindFor(dir: String): String = when (dir) {
        "recordings" -> "audio"
        "movies" -> "video"
        "download" -> "file"
        else -> "image"
    }

    // Native attach: hands this instance (its Context/ContentResolver) to Rust,
    // which wraps it in AndroidMediaProvider and switches the media bridge over.
    // JNI symbol: Java_com_amos_ai_glue_MediaStoreGlue_attach (crates/amos-tauri/src/media.rs).
    // Call once after MediaPermissions.hasReadAccess(context) is true (on the main thread).
    @Suppress("unused")
    external fun attach()
}

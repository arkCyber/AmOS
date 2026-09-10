// SmsGlue.kt — Android SMS implementation for AmOS.
//
// Kotlin half of the real-SMS subsystem (crates/amos-sms/src/android.rs, feature
// `android`). Rust cannot touch ContentResolver/SmsManager, so this glue owns
// them and answers the String<->String JSON contract the Rust
// AndroidSmsProvider calls over JNI:
//   fun snapshot(): String                 // {"threads":[…]} | {"error":…,"error_kind":…}
//   fun messages(threadId: String): String // {"thread_id":…,"messages":[…]}
//   fun send(address, text): String        // {"ok":true} | {"error":…,"error_kind":…}
//
// Hard rules (mirrored by crates/amos-sms/src/wire.rs and validate.rs):
//  * **Bounded.** Every query carries a LIMIT so a years-old inbox can never blow
//    up memory or stall the caller; the caps match the Rust protocol caps.
//  * **Honest.** A missing runtime permission is `{"error_kind":"permission"}` —
//    never an empty inbox. A malformed request is `{"error_kind":"invalid"}`, an
//    unexpected failure `{"error_kind":"failed"}`. Success is only ever reported
//    for a body actually handed to `SmsManager`.
//  * **Multipart.** Long bodies are split with `SmsManager.divideMessage` (which
//    knows GSM-7 vs UCS-2 segment sizing) and sent as one multipart message.

package com.amos.ai.glue

import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.telephony.SmsManager
import org.json.JSONArray
import org.json.JSONObject

/** Runtime SMS permissions (policy mirrored in crates/amos-sms/src/validate.rs). */
object SmsPermissions {
    const val READ = "android.permission.READ_SMS"
    const val SEND = "android.permission.SEND_SMS"

    /** Whether the SMS inbox may be read. */
    fun hasRead(context: Context): Boolean = granted(context, READ)

    /** Whether an SMS may be sent. */
    fun hasSend(context: Context): Boolean = granted(context, SEND)

    private fun granted(context: Context, perm: String): Boolean =
        context.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED
}

/** System-UI-side SMS glue handed to the Rust `AndroidSmsProvider` via `attach`. */
object SmsGlue {

    /** Caps mirroring crates/amos-sms/src/wire.rs (protocol contract). */
    private const val MAX_THREADS = 500
    private const val MAX_MESSAGES = 1000
    private const val MAX_TEXT_CHARS = 1600
    private const val MAX_ADDRESS_DIGITS = 20
    private const val MIN_ADDRESS_DIGITS = 3

    /**
     * How many newest inbox rows the snapshot scan reads (single bounded query).
     * Latest-message-per-thread and unread counts are derived from this window;
     * a thread whose *only* unread message is older than the window would show a
     * lower unread count. Documented, bounded trade-off (never an unbounded scan).
     */
    private const val SNAPSHOT_ROW_LIMIT = 4000

    private val URI: Uri = Uri.parse("content://sms")

    @Volatile
    private var app: Context? = null

    /** Rust JNI upcall: `Java_com_amos_ai_glue_SmsGlue_attach`. */
    private external fun attach(glue: SmsGlue)

    /** Bind the app context and install the real provider (idempotent). */
    fun bind(context: Context) {
        if (app != null) return
        app = context.applicationContext
        attach(this)
    }

    /** Latest message per thread + per-thread unread incoming count (bounded). */
    fun snapshot(): String {
        val ctx = app ?: return err("SmsGlue not bound", "unavailable")
        if (!SmsPermissions.hasRead(ctx)) return err("READ_SMS not granted", "permission")
        val last = LinkedHashMap<String, JSONObject>()
        val unread = HashMap<String, Int>()
        val cols = arrayOf("thread_id", "address", "body", "date", "read", "type")
        try {
            ctx.contentResolver
                .query(URI, cols, null, null, "date DESC LIMIT $SNAPSHOT_ROW_LIMIT")
                ?.use { c ->
                    val iTid = c.getColumnIndexOrThrow("thread_id")
                    val iAddr = c.getColumnIndexOrThrow("address")
                    val iBody = c.getColumnIndexOrThrow("body")
                    val iDate = c.getColumnIndexOrThrow("date")
                    val iRead = c.getColumnIndexOrThrow("read")
                    val iType = c.getColumnIndexOrThrow("type")
                    while (c.moveToNext()) {
                        val tid = c.getString(iTid) ?: continue
                        // Rows are newest-first: the first row per thread is its latest.
                        if (!last.containsKey(tid)) {
                            last[tid] = JSONObject()
                                .put("id", tid)
                                .put("address", c.getString(iAddr) ?: "")
                                .put("display_name", "")
                                .put("last_text", c.getString(iBody) ?: "")
                                .put("last_ts_ms", c.getLong(iDate))
                        }
                        // MESSAGE_TYPE_INBOX == 1; count unread incoming.
                        if (c.getInt(iType) == 1 && c.getInt(iRead) == 0) {
                            unread[tid] = (unread[tid] ?: 0) + 1
                        }
                    }
                }
        } catch (e: SecurityException) {
            return err(msg(e), "permission")
        } catch (e: Exception) {
            return err(msg(e), "failed")
        }
        val arr = JSONArray()
        for ((tid, o) in last) {
            if (arr.length() >= MAX_THREADS) break // protocol cap (wire.rs)
            arr.put(o.put("unread", unread[tid] ?: 0))
        }
        return JSONObject().put("threads", arr).toString()
    }

    /** All messages of one thread, chronological (bounded to the newest cap). */
    fun messages(threadId: String): String {
        val ctx = app ?: return err("SmsGlue not bound", "unavailable")
        if (!SmsPermissions.hasRead(ctx)) return err("READ_SMS not granted", "permission")
        // Thread ids are numeric in the Telephony provider; reject anything else
        // instead of querying with a surprise value.
        val tid = threadId.trim()
        if (tid.isEmpty() || tid.length > 20 || !tid.all { it.isDigit() }) {
            return err("invalid thread id", "invalid")
        }
        val rows = ArrayList<JSONObject>()
        val cols = arrayOf("_id", "body", "date", "read", "type")
        try {
            // Newest first + LIMIT, then reversed below → bounded, chronological.
            ctx.contentResolver
                .query(URI, cols, "thread_id = ?", arrayOf(tid), "date DESC LIMIT $MAX_MESSAGES")
                ?.use { c ->
                    val iId = c.getColumnIndexOrThrow("_id")
                    val iBody = c.getColumnIndexOrThrow("body")
                    val iDate = c.getColumnIndexOrThrow("date")
                    val iRead = c.getColumnIndexOrThrow("read")
                    val iType = c.getColumnIndexOrThrow("type")
                    while (c.moveToNext()) {
                        rows.add(
                            JSONObject()
                                .put("id", c.getString(iId))
                                .put("from_me", c.getInt(iType) == 2) // MESSAGE_TYPE_SENT
                                .put("text", c.getString(iBody) ?: "")
                                .put("ts_ms", c.getLong(iDate))
                                .put("read", c.getInt(iRead) == 1),
                        )
                    }
                }
        } catch (e: SecurityException) {
            return err(msg(e), "permission")
        } catch (e: Exception) {
            return err(msg(e), "failed")
        }
        val arr = JSONArray()
        for (i in rows.indices.reversed()) arr.put(rows[i]) // newest-first → chronological
        // The reply echoes the requested thread id; Rust cross-checks it.
        return JSONObject().put("thread_id", tid).put("messages", arr).toString()
    }

    /** Send a real SMS via SmsManager (multipart when the body needs it). */
    fun send(address: String, text: String): String {
        val ctx = app ?: return err("SmsGlue not bound", "unavailable")
        if (!SmsPermissions.hasSend(ctx)) return err("SEND_SMS not granted", "permission")
        val normalized = normalizeAddress(address)
            ?: return err("invalid destination address", "invalid")
        val body = text.trim()
        if (body.isEmpty()) return err("blank message text", "invalid")
        if (text.contains('\u0000')) return err("NUL byte in message text", "invalid")
        if (text.length > MAX_TEXT_CHARS) {
            return err("message text exceeds $MAX_TEXT_CHARS characters", "invalid")
        }
        return try {
            val sm = smsManager(ctx) ?: return err("no SmsManager service", "unavailable")
            val parts = sm.divideMessage(text)
            if (parts.size > 1) {
                sm.sendMultipartTextMessage(normalized, null, parts, null, null)
            } else {
                sm.sendTextMessage(normalized, null, text, null, null)
            }
            JSONObject().put("ok", true).toString()
        } catch (e: SecurityException) {
            err(msg(e), "permission")
        } catch (e: IllegalArgumentException) {
            err(msg(e), "invalid")
        } catch (e: Exception) {
            err(msg(e), "failed")
        }
    }

    /** SmsManager for this API level (null when the service is unavailable). */
    private fun smsManager(ctx: Context): SmsManager? = if (Build.VERSION.SDK_INT >= 31) {
        ctx.getSystemService(SmsManager::class.java)
    } else {
        @Suppress("DEPRECATION")
        SmsManager.getDefault()
    }

    /**
     * Normalize a user-typed address to digits with an optional leading `+`, or
     * null when it is not a legal SMS destination (mirrors validate.rs).
     */
    private fun normalizeAddress(address: String): String? {
        val trimmed = address.trim()
        if (trimmed.isEmpty()) return null
        val out = StringBuilder(trimmed.length)
        trimmed.forEachIndexed { i, ch ->
            when {
                ch == '+' && i == 0 -> out.append('+')
                ch.isDigit() -> out.append(ch)
                ch == '-' || ch == ' ' || ch == '(' || ch == ')' || ch == '.' -> Unit
                else -> return null
            }
        }
        val digits = out.count { it.isDigit() }
        return if (digits in MIN_ADDRESS_DIGITS..MAX_ADDRESS_DIGITS) out.toString() else null
    }

    /** Typed error reply (kind ∈ permission|invalid|unavailable|failed). */
    private fun err(message: String, kind: String): String =
        JSONObject().put("error", message.replace("\"", "'")).put("error_kind", kind).toString()

    private fun msg(e: Exception): String = e.message ?: e.javaClass.simpleName
}

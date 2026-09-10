// SmsGlue.kt — Android SMS implementation for AmOS.
//
// Kotlin half of the real-SMS subsystem (crates/amos-sms/src/android.rs, feature
// `android`). Rust cannot touch ContentResolver/SmsManager, so this glue owns
// them and answers the String<->String JSON contract the Rust
// AndroidSmsProvider calls over JNI:
//   fun snapshot(): String                 // {"threads":[{id,address,display_name,last_text,last_ts_ms,unread}]}
//   fun messages(threadId: String): String // {"thread_id","messages":[{id,from_me,text,ts_ms,read}]}
//   fun send(address, text): String        // {"ok":true} | {"error":"…"}
//
// Wire shapes MUST match crates/amos-sms/src/wire.rs (snake_case keys). Requires
// READ_SMS (list/read) and SEND_SMS (send); call bind() again after they're
// granted. On a device without the permission the resolver throws → the methods
// return an honest {"error":…}/empty result, never fabricated data.

package com.amos.ai.glue

import android.content.Context
import android.net.Uri
import android.os.Build
import android.telephony.SmsManager
import org.json.JSONArray
import org.json.JSONObject

/** System-UI-side SMS glue handed to the Rust `AndroidSmsProvider` via `attach`. */
object SmsGlue {

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

    /** Latest message per thread + per-thread unread incoming count. */
    fun snapshot(): String {
        val ctx = app ?: return "{\"threads\":[]}"
        val last = HashMap<String, JSONObject>()
        val unread = HashMap<String, Int>()
        val uri = Uri.parse("content://sms")
        val cols = arrayOf("thread_id", "address", "body", "date", "read", "type")
        try {
            ctx.contentResolver.query(uri, cols, null, null, "date DESC")?.use { c ->
                val iTid = c.getColumnIndexOrThrow("thread_id")
                val iAddr = c.getColumnIndexOrThrow("address")
                val iBody = c.getColumnIndexOrThrow("body")
                val iDate = c.getColumnIndexOrThrow("date")
                val iRead = c.getColumnIndexOrThrow("read")
                val iType = c.getColumnIndexOrThrow("type")
                while (c.moveToNext()) {
                    val tid = c.getString(iTid) ?: continue
                    // Rows are newest-first, so the first row per thread is the latest.
                    if (!last.containsKey(tid)) {
                        val o = JSONObject()
                        o.put("id", tid)
                        o.put("address", c.getString(iAddr) ?: "")
                        o.put("display_name", "")
                        o.put("last_text", c.getString(iBody) ?: "")
                        o.put("last_ts_ms", c.getLong(iDate))
                        last[tid] = o
                    }
                    // MESSAGE_TYPE_INBOX == 1; count every unread incoming.
                    if (c.getInt(iType) == 1 && c.getInt(iRead) == 0) {
                        unread[tid] = (unread[tid] ?: 0) + 1
                    }
                }
            }
        } catch (e: Exception) {
            // No permission / provider hiccup → honest empty (never fabricated).
            return "{\"threads\":[]}"
        }
        val arr = JSONArray()
        for ((tid, o) in last) {
            o.put("unread", unread[tid] ?: 0)
            arr.put(o)
        }
        return JSONObject().put("threads", arr).toString()
    }

    /** All messages of one thread, chronological. */
    fun messages(threadId: String): String {
        val ctx = app ?: return "{\"thread_id\":\"$threadId\",\"messages\":[]}"
        val arr = JSONArray()
        val uri = Uri.parse("content://sms")
        val cols = arrayOf("_id", "body", "date", "read", "type")
        try {
            ctx.contentResolver
                .query(uri, cols, "thread_id = ?", arrayOf(threadId), "date ASC")
                ?.use { c ->
                    val iId = c.getColumnIndexOrThrow("_id")
                    val iBody = c.getColumnIndexOrThrow("body")
                    val iDate = c.getColumnIndexOrThrow("date")
                    val iRead = c.getColumnIndexOrThrow("read")
                    val iType = c.getColumnIndexOrThrow("type")
                    while (c.moveToNext()) {
                        val o = JSONObject()
                        o.put("id", c.getString(iId))
                        o.put("from_me", c.getInt(iType) == 2) // MESSAGE_TYPE_SENT
                        o.put("text", c.getString(iBody) ?: "")
                        o.put("ts_ms", c.getLong(iDate))
                        o.put("read", c.getInt(iRead) == 1)
                        arr.put(o)
                    }
                }
        } catch (e: Exception) {
            return "{\"error\":\"${err(e)}\"}"
        }
        return JSONObject().put("thread_id", threadId).put("messages", arr).toString()
    }

    /** Send a real SMS via SmsManager. */
    fun send(address: String, text: String): String {
        val ctx = app ?: return "{\"error\":\"SmsGlue not bound\"}"
        return try {
            val sm: SmsManager? = if (Build.VERSION.SDK_INT >= 31) {
                ctx.getSystemService(SmsManager::class.java)
            } else {
                @Suppress("DEPRECATION")
                SmsManager.getDefault()
            }
            if (sm == null) return "{\"error\":\"no SmsManager service\"}"
            sm.sendTextMessage(address, null, text, null, null)
            "{\"ok\":true}"
        } catch (e: Exception) {
            "{\"error\":\"${err(e)}\"}"
        }
    }

    private fun err(e: Exception): String =
        (e.message ?: e.javaClass.simpleName).replace("\"", "'")
}

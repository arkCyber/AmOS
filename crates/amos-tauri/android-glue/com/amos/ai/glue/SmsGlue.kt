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

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Telephony
import android.telephony.SmsManager
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/** Runtime SMS permissions (policy mirrored in crates/amos-sms/src/validate.rs). */
object SmsPermissions {
    const val READ = "android.permission.READ_SMS"
    const val SEND = "android.permission.SEND_SMS"
    const val RECEIVE = "android.permission.RECEIVE_SMS"

    /** Whether the SMS inbox may be read. */
    fun hasRead(context: Context): Boolean = granted(context, READ)

    /** Whether an SMS may be sent. */
    fun hasSend(context: Context): Boolean = granted(context, SEND)

    /** Whether incoming SMS may be observed (live refresh). */
    fun hasReceive(context: Context): Boolean = granted(context, RECEIVE)

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

    /** `Telephony.Sms.MESSAGE_TYPE_*` — the folder tag on each `content://sms` row. */
    private const val TYPE_INBOX = 1
    private const val TYPE_SENT = 2
    private const val TYPE_DRAFT = 3

    /**
     * How many newest inbox rows the snapshot scan reads (single bounded query).
     * Latest-message-per-thread and unread counts are derived from this window;
     * a thread whose *only* unread message is older than the window would show a
     * lower unread count. Documented, bounded trade-off (never an unbounded scan).
     */
    private const val SNAPSHOT_ROW_LIMIT = 4000

    private val URI: Uri = Uri.parse("content://sms")

    /** Log tag (registration/delivery diagnostics must never be silent). */
    private const val TAG = "SmsGlue"

    @Volatile
    private var app: Context? = null

    /** Registered once in [bind]; delivers `SMS_RECEIVED` as a live refresh. */
    @Volatile
    private var receiver: BroadcastReceiver? = null

    /** Rust JNI upcall: `Java_com_amos_ai_glue_SmsGlue_attach`. */
    private external fun attach(glue: SmsGlue)

    /** Rust JNI upcall: an SMS arrived (`Java_..._SmsGlue_onIncoming`). */
    private external fun onIncoming(address: String)

    /** Bind the app context, register the receiver and install the provider. */
    fun bind(context: Context) {
        if (app != null) return
        val ctx = context.applicationContext
        app = ctx
        attach(this)
        registerIncomingReceiver(ctx)
        Log.i(TAG, "SmsGlue bound")
    }

    /**
     * Register a `SMS_RECEIVED` receiver so received messages push a refresh to
     * the UI instead of waiting for a manual pull. The receiver only signals
     * "inbox changed" (+ the sender when the platform provides it); the UI then
     * re-reads the provider through the normal, validated read path — we never
     * build UI state from the broadcast itself.
     *
     * API 33+ requires an export flag on context-registered receivers. For
     * `SMS_RECEIVED` we register **EXPORTED**: the telephony stack delivers the
     * broadcast as an external sender, and a `RECEIVER_NOT_EXPORTED` filter was
     * observed (on a real S25/S5-class device) to never receive it. This is safe
     * because `SMS_RECEIVED` is a **protected** broadcast — only a process holding
     * `BROADCAST_SMS` (i.e. the system/telephony) can send it, so no third-party
     * app can inject a fake "received SMS". `NOT_EXPORTED` is kept only as a
     * fallback for hosts that reject the exported registration.
     */
    private fun registerIncomingReceiver(ctx: Context) {
        if (receiver != null) return
        if (!SmsPermissions.hasReceive(ctx)) {
            Log.i(TAG, "SMS_RECEIVED receiver not registered: RECEIVE_SMS not granted")
            return
        }
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                if (intent?.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
                val sender = senderOf(intent)
                Log.i(TAG, "SMS_RECEIVED from '${if (sender.isEmpty()) "<unknown>" else sender}'")
                onIncoming(sender)
            }
        }
        val filter = IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION)
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                ctx.registerReceiver(r, filter, Context.RECEIVER_EXPORTED)
                receiver = r
                Log.i(TAG, "SMS_RECEIVED receiver registered (EXPORTED)")
                return
            } catch (e: Exception) {
                Log.w(TAG, "EXPORTED registration failed, trying NOT_EXPORTED", e)
            }
            try {
                ctx.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
                receiver = r
                Log.i(TAG, "SMS_RECEIVED receiver registered (NOT_EXPORTED)")
                return
            } catch (e: Exception) {
                Log.w(TAG, "SMS_RECEIVED receiver registration failed", e)
            }
        } else {
            try {
                ctx.registerReceiver(r, filter)
                receiver = r
                Log.i(TAG, "SMS_RECEIVED receiver registered (legacy)")
                return
            } catch (e: Exception) {
                Log.w(TAG, "SMS_RECEIVED receiver registration failed", e)
            }
        }
        receiver = null
    }

    /** Sender address of an incoming PDU set, or "" when the platform omits it. */
    private fun senderOf(intent: Intent): String = try {
        Telephony.Sms.Intents.getMessagesFromIntent(intent)
            ?.firstOrNull()
            ?.originatingAddress
            ?.trim()
            ?: ""
    } catch (e: Exception) {
        "" // never invent a sender
    }

    /**
     * Entry point for the manifest-registered [SmsReceiver] (works even when the
     * System UI process/activity was not running). Signals the same Rust upcall
     * as the dynamic receiver; the Rust side is a no-op until a UI is attached.
     */
    fun onSmsReceived(intent: Intent) {
        val sender = senderOf(intent)
        try {
            onIncoming(sender)
        } catch (t: Throwable) {
            Log.w(TAG, "incoming upcall failed (Rust not attached yet?)", t)
        }
    }

    /** Latest message per thread + per-thread unread incoming count (bounded). */
    fun snapshot(folder: String): String {
        val ctx = app ?: return err("SmsGlue not bound", "unavailable")
        if (!SmsPermissions.hasRead(ctx)) return err("READ_SMS not granted", "permission")
        val type = typeOf(folder) ?: return err("unknown SMS folder '$folder'", "invalid")
        val last = LinkedHashMap<String, JSONObject>()
        val unread = HashMap<String, Int>()
        val cols = arrayOf("thread_id", "address", "body", "date", "read", "type")
        try {
            ctx.contentResolver
                .query(URI, cols, "type = ?", arrayOf(type.toString()), "date DESC LIMIT $SNAPSHOT_ROW_LIMIT")
                ?.use { c ->
                    val iTid = c.getColumnIndexOrThrow("thread_id")
                    val iAddr = c.getColumnIndexOrThrow("address")
                    val iBody = c.getColumnIndexOrThrow("body")
                    val iDate = c.getColumnIndexOrThrow("date")
                    val iRead = c.getColumnIndexOrThrow("read")
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
                        // Unread only means something for received messages.
                        if (type == TYPE_INBOX && c.getInt(iRead) == 0) {
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

    /** Distinct thread counts per folder, for the folder tabs/badges. */
    fun counts(): String {
        val ctx = app ?: return err("SmsGlue not bound", "unavailable")
        if (!SmsPermissions.hasRead(ctx)) return err("READ_SMS not granted", "permission")
        return try {
            JSONObject()
                .put("inbox", distinctThreads(ctx, TYPE_INBOX))
                .put("sent", distinctThreads(ctx, TYPE_SENT))
                .put("draft", distinctThreads(ctx, TYPE_DRAFT))
                .toString()
        } catch (e: SecurityException) {
            err(msg(e), "permission")
        } catch (e: Exception) {
            err(msg(e), "failed")
        }
    }

    /** Android `Telephony.Sms.MESSAGE_TYPE_*` for a wire folder name, else null. */
    private fun typeOf(folder: String): Int? = when (folder.trim().lowercase()) {
        "inbox" -> TYPE_INBOX
        "sent" -> TYPE_SENT
        "draft", "drafts" -> TYPE_DRAFT
        else -> null
    }

    /**
     * Number of distinct threads holding at least one row of `type`, bounded by
     * the same window the snapshot uses (so the badges can never scan the whole
     * table or disagree with the list).
     */
    private fun distinctThreads(ctx: Context, type: Int): Int {
        val seen = HashSet<String>()
        ctx.contentResolver
            .query(URI, arrayOf("thread_id"), "type = ?", arrayOf(type.toString()), "date DESC LIMIT $SNAPSHOT_ROW_LIMIT")
            ?.use { c ->
                val iTid = c.getColumnIndexOrThrow("thread_id")
                while (c.moveToNext()) {
                    c.getString(iTid)?.let { seen.add(it) }
                    if (seen.size >= MAX_THREADS) break // protocol cap (wire.rs)
                }
            }
        return seen.size
    }

    /** All messages of one thread, chronological (bounded to the newest cap). */
    fun messages(threadId: String, folder: String): String {
        val ctx = app ?: return err("SmsGlue not bound", "unavailable")
        if (!SmsPermissions.hasRead(ctx)) return err("READ_SMS not granted", "permission")
        // Thread ids are numeric in the Telephony provider; reject anything else
        // instead of querying with a surprise value.
        val tid = threadId.trim()
        if (tid.isEmpty() || tid.length > 20 || !tid.all { it.isDigit() }) {
            return err("invalid thread id", "invalid")
        }
        // Empty folder = the whole conversation; otherwise scope to that folder.
        val selection: String
        val args: Array<String>
        if (folder.isBlank()) {
            selection = "thread_id = ?"
            args = arrayOf(tid)
        } else {
            val type = typeOf(folder) ?: return err("unknown SMS folder '$folder'", "invalid")
            selection = "thread_id = ? AND type = ?"
            args = arrayOf(tid, type.toString())
        }
        val rows = ArrayList<JSONObject>()
        val cols = arrayOf("_id", "body", "date", "read", "type")
        try {
            // Newest first + LIMIT, then reversed below → bounded, chronological.
            ctx.contentResolver
                .query(URI, cols, selection, args, "date DESC LIMIT $MAX_MESSAGES")
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
                                .put("from_me", c.getInt(iType) == TYPE_SENT) // MESSAGE_TYPE_SENT
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

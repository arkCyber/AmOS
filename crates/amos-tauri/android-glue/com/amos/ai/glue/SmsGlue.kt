// SmsGlue.kt — Android SMS implementation for AmOS.
//
// Kotlin half of the real-SMS subsystem (crates/amos-sms/src/android.rs, feature
// `android`). Rust cannot touch ContentResolver/SmsManager, so this glue owns
// them and answers the String<->String JSON contract the Rust
// AndroidSmsProvider calls over JNI:
//   fun snapshot(): String                 // {"threads":[…]} | {"error":…,"error_kind":…}
//   fun messages(threadId: String): String // {"thread_id":…,"messages":[…]}
//   fun send(address, text): String        // {"state":"sent"} |
//                                          // {"state":"unconfirmed","detail":…} |
//                                          // {"error":…,"error_kind":…}
//
// Hard rules (mirrored by crates/amos-sms/src/wire.rs and validate.rs):
//  * **Bounded.** Every query carries a LIMIT so a years-old inbox can never blow
//    up memory or stall the caller; the caps match the Rust protocol caps.
//  * **Honest.** A missing runtime permission is `{"error_kind":"permission"}` —
//    never an empty inbox. A malformed request is `{"error_kind":"invalid"}`, an
//    unexpected failure `{"error_kind":"failed"}`.
//  * **A send's verdict comes from the radio, not from "it did not throw".**
//    `SmsManager.sendTextMessage` returns normally even when there is no service
//    or the radio is off, so "no exception" is *not* success. `send` hands the
//    platform a `SMS_SENT` PendingIntent per part, waits a bounded
//    `SENT_WAIT_MS` for the verdicts, and reports `sent` only when every part
//    came back `RESULT_OK`; a specific failure is `error_kind:"rejected"`, and a
//    verdict that never arrived is `unconfirmed` — never folded into success.
//    (REQ-A1620 / F-TEL-040. `SMS_DELIVERED` — the *network's* report — is
//    deliberately not claimed: it can take minutes, so we report no more than
//    the platform told us.)
//  * **Multipart.** Long bodies are split with `SmsManager.divideMessage` (which
//    knows GSM-7 vs UCS-2 segment sizing) and sent as one multipart message.

package com.amos.ai.glue

import android.annotation.SuppressLint
import android.app.Activity
import android.app.PendingIntent
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
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

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
@SuppressLint("StaticFieldLeak") // an APPLICATION context is not a leak: the process and it share a lifetime (REQ-A380)
object SmsGlue {

    /**
     * Caps mirroring the Rust protocol contract — in **two** different files: the
     * thread/message counts bound a glue *reply* (crates/amos-sms/src/wire.rs), the
     * text/address bounds a *send* (crates/amos-sms/src/validate.rs). Both are bound
     * to their authority by scripts/sms-glue-const-scan.mjs. This is a **two-sided**
     * contract — the glue truncates to its cap while Rust *rejects* (never truncates)
     * a reply over its own — so keep the two sides equal: a one-sided change blanks
     * the on-device inbox instead of quietly returning fewer rows.
     */
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

    @SuppressLint("UseKtx") // Uri.parse is the platform API; androidx.core.net.toUri needs core-ktx, which the generated project does not depend on (REQ-A380)
    private val URI: Uri = Uri.parse("content://sms")

    /** Log tag (registration/delivery diagnostics must never be silent). */
    private const val TAG = "SmsGlue"

    /**
     * Package-scoped action the platform broadcasts back to our own SENT
     * PendingIntent. Custom (not the system's `SMS_SENT`) because the intent only
     * ever travels our app → system → our app, and a private name keeps another
     * app's broadcast out of our receiver by construction.
     */
    private const val ACTION_SMS_SENT = "com.amos.ai.glue.SMS_SENT"

    /** Extra carrying the probe token of the send a status broadcast belongs to. */
    private const val EXTRA_SEND_TOKEN = "com.amos.ai.glue.SEND_TOKEN"

    /**
     * How long [send] waits for the platform's `SMS_SENT` verdicts. Must stay
     * **under** the Rust caller's own `SMS_TIMEOUT` (8 s in
     * crates/amos-tauri/src/sms.rs) so a slow radio surfaces as this glue's
     * honest `unconfirmed`, not as a caller-side timeout that loses the reason.
     */
    private const val SENT_WAIT_MS = 6000L

    /** Next probe token / PendingIntent request code (unique across sends). */
    private val sendSeq = AtomicInteger(1)

    /**
     * In-flight sends by token. A status broadcast settles its probe; the probe
     * is removed once its send has stopped waiting, so a late or duplicated
     * broadcast finds nothing and is ignored rather than corrupting the next send.
     */
    private val sendProbes = ConcurrentHashMap<Int, SendProbe>()

    /** Whether the `SMS_SENT` receiver is registered (send falls back honestly if not). */
    @Volatile
    private var sendReceiverReady = false

    /**
     * One in-flight send: waits for **every** part's status and keeps the worst.
     * A multipart message is not "sent" because its first part was — one refused
     * part makes the whole send a refusal.
     */
    private class SendProbe(parts: Int) {
        private val latch = CountDownLatch(parts)
        private val codes = ConcurrentLinkedQueue<Int>()

        fun settle(code: Int) {
            codes.add(code)
            latch.countDown()
        }

        /** `null` = the platform gave no verdict within `timeoutMs`. */
        fun verdict(timeoutMs: Long): Int? {
            if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) return null
            return codes.firstOrNull { it != Activity.RESULT_OK } ?: Activity.RESULT_OK
        }
    }

    @Volatile
    @SuppressLint("StaticFieldLeak") // an APPLICATION context is not a leak: the process and it share a lifetime (REQ-A380)
    private var app: Context? = null

    /** Registered once in [bind]; delivers `SMS_RECEIVED` as a live refresh. */
    @Volatile
    private var receiver: BroadcastReceiver? = null

    /** Rust JNI upcall: `Java_com_amos_ai_glue_SmsGlue_attach`. */
    private external fun attach(glue: SmsGlue)

    /** Rust JNI upcall: an SMS arrived (`Java_..._SmsGlue_onIncoming`). */
    private external fun onIncoming(address: String)

    init {
        // The manifest `SmsReceiver` can cold-start this process to deliver one
        // `SMS_RECEIVED`, before any Activity has run the Tauri runtime's usual
        // library load. Touching this object triggers this block, so the JNI
        // upcalls above are bound for that delivery — otherwise `onSmsReceived`
        // swallows an `UnsatisfiedLinkError` and the live-refresh signal is lost
        // with no trace beyond a log line. (REQ-A1569 / F-TEL-036.)
        try {
            System.loadLibrary("amos_tauri_lib")
        } catch (_: UnsatisfiedLinkError) {
            Log.w(TAG, "amos_tauri_lib not loaded — SMS upcalls unavailable")
        }
    }

    /**
     * Bind the app context, register the receivers and install the provider.
     *
     * Idempotent, but **not** a no-op on later calls. The `SMS_RECEIVED` receiver is
     * permission-gated — [registerIncomingReceiver] returns without registering while
     * `RECEIVE_SMS` is missing — so the first `bind` (from `AmosGlue.onStart`, which
     * typically runs **before** the runtime grant) leaves it unregistered. An early
     * `if (app != null) return` here skipped it on every later call too, so the receiver
     * was never registered and live refresh never started — `docs/sms.md`'s
     * 「授权后即生效，无需重绑」was false for this half (PH-P2-06). The receiver is
     * therefore re-attempted on **every** bind; it is idempotent (`receiver != null`).
     */
    fun bind(context: Context) {
        val ctx = context.applicationContext
        if (app == null) {
            app = ctx
            attach(this)
            registerSendReceiver(ctx)
            Log.i(TAG, "SmsGlue bound")
        }
        registerIncomingReceiver(ctx)
    }

    /**
     * Register the receiver that takes `SMS_SENT` status broadcasts for our own
     * send PendingIntents. **`NOT_EXPORTED`**: the broadcast is fired by the
     * system *as this app* (that is what a PendingIntent grants), so a
     * non-exported in-package receiver gets it and no other app can forge one.
     * The intent also carries our package, so the API 26+ implicit-broadcast
     * restriction never applies. Idempotent; a failure is logged and leaves
     * [send] reporting `unconfirmed` rather than a fabricated success.
     *
     * `NOT_EXPORTED` (not the `EXPORTED` that `SMS_RECEIVED` needs) because the
     * direction is reversed here: `SMS_RECEIVED` is pushed at us from outside,
     * while the SENT status is our own PendingIntent coming back. If some host
     * still fails to deliver it, the failure mode is [send]'s honest
     * `unconfirmed` — never a fabricated `sent`.
     */
    private fun registerSendReceiver(ctx: Context) {
        if (sendReceiverReady) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                if (intent?.action != ACTION_SMS_SENT) return
                val token = intent.getIntExtra(EXTRA_SEND_TOKEN, -1)
                if (token < 0) return
                sendProbes[token]?.settle(resultCode)
            }
        }
        val filter = IntentFilter(ACTION_SMS_SENT)
        try {
            // `ContextCompat.registerReceiver` is the lint-clean form of the same call:
            // below API 33 the 3-arg overload (and `Context.RECEIVER_*`) does not exist,
            // so Lint cannot see that the two-arg call is the only option there. The
            // helper maps the flag to the platform overload on 33+ and to the legacy
            // (unexported-by-default) registration below it — the same behavior the
            // version branch spelled out (REQ-A1627).
            ContextCompat.registerReceiver(ctx, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
            sendReceiverReady = true
            Log.i(TAG, "SMS_SENT receiver registered")
        } catch (e: Exception) {
            Log.w(TAG, "SMS_SENT receiver registration failed", e)
        }
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
        try {
            ContextCompat.registerReceiver(ctx, r, filter, ContextCompat.RECEIVER_EXPORTED)
            receiver = r
            Log.i(TAG, "SMS_RECEIVED receiver registered (EXPORTED)")
            return
        } catch (e: Exception) {
            Log.w(TAG, "EXPORTED registration failed, trying NOT_EXPORTED", e)
        }
        try {
            ContextCompat.registerReceiver(ctx, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
            receiver = r
            Log.i(TAG, "SMS_RECEIVED receiver registered (NOT_EXPORTED)")
            return
        } catch (e: Exception) {
            Log.w(TAG, "SMS_RECEIVED receiver registration failed", e)
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
                                // `from_me` = "the user's own outgoing side", i.e. everything
                                // except an inbox row. Inbox (MESSAGE_TYPE_INBOX) is the only
                                // *received* type; sent, draft, outbox, failed and queued are all
                                // the user's own. `type == TYPE_SENT` was wrong for the rest —
                                // a draft read as a received message, contradicting the mock
                                // authority (`MockSms::seeded_rows` seeds its draft with
                                // `from_me: true`) and flipping the UI bubble side (PH-P2-07).
                                .put("from_me", c.getInt(iType) != TYPE_INBOX)
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

    /**
     * Send a real SMS via SmsManager (multipart when the body needs it) and
     * answer the radio's **actual** verdict.
     *
     * `sendTextMessage` returning normally means only "the platform accepted the
     * request" — it does not throw for a radio that is off or a network that is
     * gone. So we pass one `SMS_SENT` PendingIntent per part and wait a bounded
     * [SENT_WAIT_MS] for the verdicts: every part `RESULT_OK` → `sent`; a
     * specific failure → `error_kind:"rejected"` (an error, so the caller never
     * shows success); no verdict in time → `unconfirmed` with the reason. There
     * is deliberately **no** `{"ok":true}` shape any more — that fold *was* the
     * defect (REQ-A1620 / F-TEL-040).
     */
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
            // Lazy + idempotent: a bind-time registration failure is retried here,
            // so the verdict path is not silently missing for the whole session.
            registerSendReceiver(ctx)
            val parts = sm.divideMessage(text)
            val token = sendSeq.getAndIncrement()
            val probe = SendProbe(parts.size)
            sendProbes[token] = probe
            val verdict = try {
                val sentIntents = ArrayList<PendingIntent>(parts.size)
                for (i in parts.indices) {
                    sentIntents.add(sentIntent(ctx, token, sendSeq.getAndIncrement()))
                }
                if (parts.size > 1) {
                    sm.sendMultipartTextMessage(normalized, null, parts, sentIntents, null)
                } else {
                    sm.sendTextMessage(normalized, null, text, sentIntents[0], null)
                }
                probe.verdict(SENT_WAIT_MS)
            } finally {
                // Stop waiting *and* stop accepting status for this send; a late
                // broadcast then finds no probe instead of touching the next send.
                sendProbes.remove(token)
            }
            when {
                verdict == null -> JSONObject()
                    .put("state", "unconfirmed")
                    .put("detail", "no SMS_SENT verdict within ${SENT_WAIT_MS}ms")
                    .toString()
                verdict == Activity.RESULT_OK -> JSONObject().put("state", "sent").toString()
                else -> err("rejected by the radio: ${sendErrorName(verdict)}", "rejected")
            }
        } catch (e: SecurityException) {
            err(msg(e), "permission")
        } catch (e: IllegalArgumentException) {
            err(msg(e), "invalid")
        } catch (e: Exception) {
            err(msg(e), "failed")
        }
    }

    /** Broadcast PendingIntent the platform fires with one part's `SMS_SENT` status. */
    private fun sentIntent(ctx: Context, token: Int, requestCode: Int): PendingIntent {
        val intent = Intent(ACTION_SMS_SENT)
            .setPackage(ctx.packageName)
            .putExtra(EXTRA_SEND_TOKEN, token)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= 31) flags = flags or PendingIntent.FLAG_MUTABLE
        return PendingIntent.getBroadcast(ctx, requestCode, intent, flags)
    }

    /** `SmsManager.RESULT_ERROR_*` as a stable, greppable name for the refusal message. */
    private fun sendErrorName(code: Int): String = when (code) {
        SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "GENERIC_FAILURE"
        SmsManager.RESULT_ERROR_RADIO_OFF -> "RADIO_OFF"
        SmsManager.RESULT_ERROR_NULL_PDU -> "NULL_PDU"
        SmsManager.RESULT_ERROR_NO_SERVICE -> "NO_SERVICE"
        else -> "code $code"
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

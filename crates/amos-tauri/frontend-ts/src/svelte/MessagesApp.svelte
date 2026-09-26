<script lang="ts">
  // MessagesApp.svelte — Svelte 5 (runes) single-source messages screen.
  // Offline-first. When a real SMS provider is present (device: SmsGlue over JNI)
  // the screen shows the *device inbox* threads/messages and sends real SMS via
  // `sms_send`; otherwise it falls back to local conversations (host/offline).
  // Pure logic lives in lib/messages.ts; unread → notification sync via $effect.
  import {
    CONV_KEY,
    addConversation,
    appendMessage,
    appendQuote,
    clearMessages,
    findConversation,
    fmtBubbleTime,
    isNewDay,
    markAllRead,
    messageDayLabel,
    messageNotifKey,
    normalizeConversations,
    normalizeMessages,
    removeConversation,
    removeMessageAt,
    seedConversations,
    unreadCount,
  } from "../lib/messages";
  import type { Conversation, Msg } from "../lib/messages";
  import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { NOTIF_KEY, normalizeNotifs } from "../lib/settings";
  import { hasNotifsOfApp, replaceAppNotifs, withoutAppNotifs } from "../lib/notifApp";
  import { bgT } from "./bgText";
  import { iconSvg } from "../lib/sysIcons";
  import type { Notif } from "../lib/settings";
  import {
    SMS_FOLDERS,
    SMS_RECEIVED_EVENT,
    blocklistAdd,
    bridgeDiag,
    bridged,
    smsCounts,
    smsFolderSnapshot,
    smsMessages,
    smsPermissionRequest,
    smsSend,
    smsStatus,
    smsTrashAdd,
    smsTrashList,
    smsTrashPurge,
    smsTrashRestore,
    subscribe,
  } from "../lib/backend";
  import type {
    SmsFolder,
    SmsFolderCounts,
    SmsMessageOut,
    SmsThreadOut,
    SmsTrashEntryOut,
  } from "../lib/backend";
  import { amosWarn } from "../lib/debugLog";
  import { smsGrantRefusalKey } from "../lib/smsPermission";
  import {
    DRAFT_KEY,
    draftId,
    normalizeDrafts,
    removeDraft,
    saveDraft,
  } from "../lib/smsDrafts";
  import type { SmsDraft } from "../lib/smsDrafts";
  import { t, ALL_LABEL_DICTS } from "./locale.svelte";
  import { messagesChannel } from "./appLinks";
  import { emitDockBounce } from "../lib/dockConfig";
  import { surface } from "./shellState.svelte";

  // Demo seed — **only when the key is absent**: a user who deleted every thread keeps
  // an empty inbox (the seed is a first-run affordance, not a recurring fixture).
  const seeded = ((): Conversation[] => {
    const stored = readStoreValue<unknown>(CONV_KEY, undefined);
    if (stored !== undefined) return normalizeConversations(stored);
    const s = seedConversations(Date.now());
    writeStoreValue(CONV_KEY, s);
    return s;
  })();
  let conversations = $state<Conversation[]>(seeded);
  let activeId = $state<string>(seeded[0]?.id ?? "");
  let text = $state("");
  let replyTo = $state<string | null>(null);
  let newName = $state("");
  // The store refused a write (full/unavailable): say so and keep showing the truth.
  let storeErr = $state("");

  const active = $derived(findConversation(conversations, activeId));
  const msgs = $derived(active?.msgs ?? []);
  const saveConvs = (next: Conversation[]): boolean => {
    const norm = normalizeConversations(next);
    // Nothing is applied when the store refuses it: the thread list would otherwise
    // show conversations that vanish on reload.
    if (!writeStoreValueChecked(CONV_KEY, norm)) {
      storeErr = t("common.storeWriteFailed");
      return false;
    }
    storeErr = "";
    conversations = norm;
    if (!findConversation(norm, activeId)) activeId = norm[0]?.id ?? "";
    return true;
  };
  // Replace the active thread's message list (pure helper then store). Returns the
  // write's verdict so callers that also move view state can honour it — see `send`.
  const setMsgs = (l: Msg[]): boolean => {
    const list = normalizeMessages(l);
    return saveConvs(conversations.map((c) => (c.id === activeId ? { ...c, msgs: list } : c)));
  };

  // ---- Real SMS (device) --------------------------------------------------------
  // The real device store lives in its OWN state and never mixes with the local
  // conversations / notification machinery (that coupling caused a render loop on
  // device). `smsMode` is resolved from the backend status so the honest host
  // mock keeps the local conversations, while a device backend shows the real
  // folders (inbox / sent / drafts) — including their *empty* and *unreadable*
  // (permission) states, which must never be collapsed into "no messages".
  let smsMode = $state<"unknown" | "local" | "real">("unknown");
  let folder = $state<SmsFolder>("inbox");
  // `null` = the host never answered (`sms_counts` unbridged or `Err`ed), which is **not**
  // a measured zero: the badge renders 「—」, never a count the host did not give (REQ-A1788).
  let counts = $state<SmsFolderCounts | null>(null);
  let realThreads = $state<SmsThreadOut[]>([]);
  /**
   * The folder `realThreads` was read from — the list is only ever drawn for the folder
   * it describes (REQ-A1212).
   *
   * `setFolder` clears the open thread's messages but the thread *list* is a separate read
   * with its own round trip, so for the whole duration of that read the tab strip named the
   * new folder while the list still drew the folder just left — and in 草稿 those rows wore
   * the 「系统草稿（只读）」 heading, labelling inbox threads as system drafts. The sibling
   * guard drops a snapshot that lands *after* the switch; this covers the window *before* it
   * lands, which is the same disagreement the sibling guard exists to prevent.
   */
  let realThreadsFolder = $state<string>("");
  let realActiveId = $state("");
  let realMsgs = $state<SmsMessageOut[]>([]);
  /**
   * The newest device timestamp AmOS has *shown* per real thread — the real-mode half of
   * "reading a thread marks it read" (REQ-A1075).
   *
   * The device reports each thread's `unread`, but only the device's own SMS app may write
   * read-state back (the bridge exposes no `sms_mark_read`), so a thread opened here kept its
   * ●N for the rest of the day — the very "badge lingers on the conversation you are reading"
   * the *local* model already fixes at the `markAllRead` effect below, and the effect skips
   * real mode precisely because this model, not that one, is on screen. We cannot change the
   * device, and we must not fabricate a cleared count either; what is true is narrower — "AmOS
   * has shown this thread up to <ts>". So the badge is suppressed only while the device's own
   * `last_ts_ms` has not moved past what we displayed, and a *later* message advances it, so
   * the device's count comes straight back. Session-scoped on purpose: nothing here is durable
   * state (a restart re-reads the device, which is the source of truth), so it needs no store
   * key — and must not have one, since restoring a stale map onto another device would hide a
   * genuinely unread thread.
   */
  let seenRealTs = $state<Record<string, number>>({});
  let realText = $state("");
  let realErr = $state("");
  /**
   * The new-message composer's own refusal, kept separate from `realErr` (REQ-A1069).
   *
   * `sendNew` and `sendReal` are two different actions in two different views, and one
   * state for both let the composer's failure be *writable but unrenderable*: `realErr`
   * is drawn only inside the `folder !== "draft"` / thread branches, so a refusal on a
   * send made while the user sat in 草稿 set a value nothing on screen could read.
   */
  let newErr = $state("");
  /**
   * A send that got **no verdict** — neither a refusal nor a confirmation — and the text
   * it was issued for. Kept apart from `newErr`/`realErr` on purpose: a refusal is a fact
   * ("the radio would not take it"), a missing verdict is a question, and folding the two
   * is the defect this pair exists to avoid (REQ-A1620 / F-TEL-040). Tied to the text so
   * it retracts itself when the box no longer holds what was sent — no second clearing
   * site to keep in sync.
   */
  let newNote = $state<{ text: string; msg: string } | null>(null);
  let realNote = $state<{ text: string; msg: string } | null>(null);
  let smsErr = $state("");
  let smsDenied = $state(false);
  let smsBusy = $state(false);
  /**
   * Is **this window** the one the user is looking at? (F-SH-654.)
   *
   * Reading the inbox is foreground-gated on the host (`require_sms_foreground`, the same rule
   * `clipboard_read` follows), and the refusal is not idempotent in this screen: `refreshReal`'s
   * failure branch **blanks** the list (a failed read is honestly "no threads known"). So a read
   * this window is not entitled to must not be attempted at all — the live `sms-received` push
   * arrives while the user is in another window exactly as often as while they are in this one.
   *
   * A window is created focused (the shell focuses what it opens) and every later change is
   * observed by the listeners below, so this starts `true` and is corrected within a tick of a
   * blur. The DOM's own focus is the right unit here: it is *per WebView*, which is exactly what
   * the host compares (`wm`'s focused label against `window.label()`).
   */
  let winFocused = $state(true);
  /** A read was owed while this window was in the background — see `refreshReal`. */
  let readOwed = $state(false);
  /**
   * A `sms_send` is in flight — the composers' re-entrancy guard, kept apart from
   * `smsBusy` (REQ-A1243).
   *
   * `smsBusy` is the busy flag of a **read** (it gates the 刷新 and 重试 buttons);
   * `refreshReal` holds it for a whole snapshot round trip. The two composers used to
   * read `smsBusy` as their guard, which is as long as an incoming SMS takes — the live
   * `sms-received` refresh runs exactly while the user is typing an answer — so a read
   * in flight silently swallowed a send.
   */
  let sending = $state(false);
  // Block-sender feedback for the open real thread (see `blockSender`).
  let blockBusy = $state(false);
  let blockMsg = $state("");
  let blockOk = $state(false);
  // View-layer trash (REQ-A42): device messages are *hidden* here, not deleted —
  // the platform store is off-limits (default-SMS-app ownership), so the panel
  // says so instead of pretending the texts are gone from the phone.
  // `null` = the host never answered `sms_trash_list`; distinct from `[]` (a list the host
  // *did* send and that is empty), and the panel must not draw one as the other (REQ-A1788).
  let trash = $state<SmsTrashEntryOut[] | null>(null);
  let trashOpen = $state(false);
  let trashBusy = $state(false);
  let trashMsg = $state("");
  let trashOk = $state(false);
  // AmOS-local drafts (the platform only lets the *default* SMS app write
  // drafts, so ours are stored locally and labelled as such).
  let drafts = $state<SmsDraft[]>(normalizeDrafts(readStoreValue<unknown>(DRAFT_KEY, [])));
  const saveDrafts = (next: SmsDraft[]): boolean => {
    const norm = normalizeDrafts(next);
    if (!writeStoreValueChecked(DRAFT_KEY, norm)) {
      storeErr = t("common.storeWriteFailed");
      return false;
    }
    storeErr = "";
    drafts = norm;
    return true;
  };
  const activeReal = $derived(realThreads.find((th) => th.id === realActiveId) ?? null);
  /**
   * The newest folder read and the newest thread read — the identity of the one response that
   * may still apply (REQ-A1245). A read is superseded when a *newer one is issued*: the user
   * switched folders, or a second refresh of the same folder started while this one was out
   * (the live `sms-received` refresh races the user's own 刷新, and a send's post-write
   * refresh). Comparing folders sees only the first kind, so an older same-folder response
   * landing later used to overwrite the fresher list and erase the SMS the notification had
   * just named. The two counters stay apart because the folder read issues the thread read
   * from inside its own callback — one shared counter would make the thread read supersede
   * the folder read that spawned it.
   */
  let realReadSeq = 0;
  let realMsgReadSeq = 0;
  /** Advance the "shown up to" mark for one real thread; never move it backwards. */
  const markRealSeen = (id: string, ts: number) => {
    if (!id || !(ts > (seenRealTs[id] ?? 0))) return;
    seenRealTs = { ...seenRealTs, [id]: ts };
  };
  /** Does this thread carry unread messages the user has *not* been shown in AmOS? */
  const realUnread = (th: SmsThreadOut) => th.unread > 0 && th.last_ts_ms > (seenRealTs[th.id] ?? 0);
  const activeRealName = $derived(
    activeReal ? activeReal.display_name || activeReal.address : "",
  );
  const loadReal = (id: string, address?: string) => {
    realErr = "";
    // The read is asynchronous, so the user can switch threads (or folders) while it is
    // in flight: a **late success** then landed in whatever thread was open by the time
    // it resolved — the header said the new thread while the pane filled with the one
    // just left. That is `openReal`'s "identity and content move together" rule one step
    // later in time, and its opposite direction (a stale *hit*, not a stale miss). So a
    // response whose thread is no longer the open one is dropped, and so is one that a
    // newer read of that same thread has superseded (REQ-A1245 — see `realMsgReadSeq`).
    const seq = ++realMsgReadSeq;
    void smsMessages(id, folder, address).then((m) => {
      if (id !== realActiveId || seq !== realMsgReadSeq) return;
      if (m) {
        realMsgs = [...m].sort((a, b) => a.ts_ms - b.ts_ms);
        // These texts are on screen now, so the device's count for them is stale. Mark
        // by the newest message actually displayed (see `seenRealTs`).
        if (m.length > 0) markRealSeen(id, Math.max(...m.map((x) => x.ts_ms)));
      } else realErr = t("message.loadFailed");
    });
  };
  /**
   * Open a local conversation — the local-mode twin of `openReal`.
   *
   * The composer belongs to the thread. `send`, `clear`, `deleteThread` and `confirmAdd`
   * all say so (each moves composer state only once the thread's change really landed),
   * and `openReal` enforces it for the device pane; the thread strip alone did not
   * (REQ-A1219). So switching conversations carried two references to the thread just
   * left: the **reply target**, which is a pointer at one specific message of that
   * conversation (the bar kept rendering 小安's text, labelled 「回复」, while 小李 was
   * open), and the half-typed **text**. A reply bar naming another conversation's message
   * is not ambiguous — and pressing send appended that quote, and that text, to whichever
   * thread was now open (text addressed to 小安 delivered to 小李).
   */
  const openLocal = (id: string) => {
    if (id === activeId) return;
    activeId = id;
    replyTo = null;
    text = "";
    revealedRow = null;
  };

  const openReal = (id: string) => {
    // Tapping the thread already on screen is not a switch, and the local twin says so:
    // `openLocal` returns before it touches the composer. Without this the highlighted
    // pill re-ran the whole open path — it emptied `realMsgs` (an honest-empty flash
    // before the re-read landed) and, once REQ-A1219 gave it `realText = ""`, silently
    // discarded the half-typed message addressed to that very thread. A refresh is
    // `refreshReal` (the 刷新 button, a live receive), not a tap on the pill (REQ-A1221).
    if (id === realActiveId) return;
    realActiveId = id;
    // The pane's header switches to `id` immediately, so its body must too: the messages
    // held here belong to the thread that was open a moment ago. Keeping them meant a
    // failed read of the new thread drew the *previous* thread's texts under the new
    // name (the error line said "无法读取该会话" while the wrong conversation filled the
    // pane) — clearing first leaves the honest empty state, and also drops the stale
    // flash before the new read lands.
    realMsgs = [];
    // The composer is this thread's content too, and it was the one piece of it this rule
    // did not cover (REQ-A1219). Half-typed text addressed to the thread just left stayed
    // in the box under the new thread's name, and its send button — one tap away, with no
    // confirmation — delivered it to that other recipient. `refreshReal` reloads the *same*
    // thread through `loadReal` rather than here, so a live refresh still keeps the draft.
    realText = "";
    const th = realThreads.find((x) => x.id === id);
    loadReal(id, th?.address);
  };
  /**
   * Switch to another device thread — the thread strip's door.
   *
   * The block-sender note belongs to the thread it was made from: 「拦截该号码」is a button
   * drawn for the **open** thread, and its failure copy names no sender — left standing it
   * reads as a failure of a tap made in the thread now on screen. `setFolder` already clears
   * it when the folder changes; a thread switch is the same kind of change to the same
   * per-thread surface.
   *
   * Cleared **here** rather than inside `openReal` on purpose: `blockSender` writes the note
   * and then calls `refreshReal`, which opens the fallback thread when the blocked sender's
   * thread is filtered out of the inbox — a success note must survive that. Only a tap on a
   * different thread drops it (REQ-A1240).
   */
  const switchReal = (id: string) => {
    if (id === realActiveId) return;
    blockMsg = "";
    blockOk = false;
    openReal(id);
  };
  const refreshCounts = () => {
    void smsCounts().then((c) => {
      // A `null` is the host answering nothing — not a zero-count. It used to be dropped
      // (`if (c) counts = c`), so a failed read left the tab badges standing on whatever
      // they last said: an unread badge that outlived the read that produced it, and 「0」
      // for a count nobody gave. Store the unknown itself and let the badge say 「—」
      // (REQ-A1788 / audit PH-P2-09).
      counts = c;
      if (c === null) amosWarn("messages", "sms_counts answered nothing", bridgeDiag("sms_counts"));
    });
  };
  // Re-read the active folder: success (possibly empty) vs failure are distinct.
  const refreshReal = () => {
    // Only the window the user is looking at may read the inbox (F-SH-654). Attempting it from
    // the background would be refused by the host, and the refusal branch below would **blank
    // the list** — an in-flight arrival would erase the threads the user left on screen. The
    // read is not dropped, it is owed: the focus listener re-issues it the moment this window
    // is looked at again, which is also the first moment the user can see the answer.
    if (!winFocused) {
      readOwed = true;
      return;
    }
    smsBusy = true;
    refreshCounts();
    refreshTrash(); // keep the trash panel/badge in step with the reads
    // Same stale-response rule as `loadReal`, one level up: only the **newest read issued** may
    // apply. A snapshot that lands after the user switched folders describes the folder they
    // left — applying it would draw that folder's threads under the new tab (and auto-open one
    // of them), and the tab strip and the list would disagree about which folder is on screen.
    // A folder switch is not the only way a read is superseded, though: two reads of the *same*
    // folder are commonly in flight at once (the live `sms-received` refresh arrives while the
    // user's own 刷新, or a send's post-write refresh, is still out), and "the folder still
    // matches" says nothing about which of them was issued last — so an older snapshot landing
    // later overwrote the fresher list and erased the SMS the notification had just named
    // (REQ-A1245). A superseded read is dropped silently; the read that replaced it owns the
    // pane, the folder label and the busy flag.
    const reqFolder = folder;
    const seq = ++realReadSeq;
    void smsFolderSnapshot(folder).then((r) => {
      if (seq !== realReadSeq) return;
      smsBusy = false;
      // Whichever way it went, `realThreads` is now this folder's answer (an empty list
      // from a failed read is still *this* folder's answer — the failure branch below
      // says so).
      realThreadsFolder = reqFolder;
      if (r.ok) {
        smsErr = "";
        smsDenied = false;
        realThreads = r.threads;
        const first = r.threads[0];
        // The thread we were reading, looked up in the *fresh* list (so this never
        // depends on a derived value recomputing in the same tick).
        const current = r.threads.find((th) => th.id === realActiveId);
        if (!current) {
          // The open thread is gone (e.g. its sender was just blocked, so the filter
          // dropped it): fall back to the newest thread, or clear the pane entirely.
          // Reading a thread the list no longer shows — and that the blocklist would
          // refuse anyway — must never happen.
          if (first) {
            openReal(first.id);
          } else {
            realActiveId = "";
            realMsgs = [];
            realErr = "";
          }
        } else {
          // Same thread still open → reload its messages, so a message that just
          // arrived (live `sms-received` refresh) shows up without a manual pull.
          loadReal(realActiveId, current.address);
        }
      } else {
        realThreads = [];
        realMsgs = [];
        smsDenied = r.denied;
        smsErr = r.denied ? t("message.smsDenied") : t("message.smsUnavailable");
      }
    });
  };
  // Switching folders re-reads that folder's threads and messages.
  const setFolder = (f: SmsFolder) => {
    if (folder === f) return;
    folder = f;
    realActiveId = "";
    realMsgs = [];
    realErr = "";
    newErr = "";
    smsErr = "";
    blockMsg = "";
    blockOk = false;
    trashMsg = "";
    trashOk = false;
    refreshReal();
  };
  // Resolve the backend (mock → keep local conversations; device → real).
  // The Kotlin glue attaches in the Activity's `onStart`, which can land *after*
  // the WebView boots, so a single probe could see "mock" and wrongly stay local
  // forever. Bounded retries (no endless polling) close that race.
  const SMS_PROBE_ATTEMPTS = 4;
  const SMS_PROBE_DELAY_MS = 1500;
  const probeSms = async () => {
    for (let attempt = 0; attempt < SMS_PROBE_ATTEMPTS; attempt++) {
      const st = await smsStatus();
      if (st && st.device) {
        smsMode = "real";
        refreshReal();
        return;
      }
      if (attempt < SMS_PROBE_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, SMS_PROBE_DELAY_MS));
      }
    }
    smsMode = "local"; // honest: no device backend after the bounded retries
  };
  const retrySms = () => {
    if (smsMode === "real") refreshReal();
    else void probeSms();
  };
  /**
   * Ask the OS for the SMS permission set (REQ-A1577 / F-TEL-037).
   *
   * Before this, the screen could only *report* the refusal (`message.smsDeniedHint`
   * pointed at system settings) because nothing in the repo ever requested the grant —
   * a normal install left the inbox and `SmsReceiver` permanently dead with no way to
   * fix it from inside AmOS. Only the **granted** answer clears the error; every other
   * outcome says which answer the OS actually gave (`smsGrantRefusalKey`), because a
   * timeout / a failed read / no-grant-concept-here are not "the user said no".
   */
  let smsGrantBusy = $state(false);
  const grantSms = async () => {
    smsGrantBusy = true;
    const st = await smsPermissionRequest();
    smsGrantBusy = false;
    if (st?.granted) {
      smsDenied = false;
      smsErr = "";
      retrySms();
      return;
    }
    smsDenied = st?.state === "denied";
    smsErr = t(smsGrantRefusalKey(st?.state) ?? "message.smsUnavailable");
  };
  // Compose to an arbitrary number (device mode). The platform persists the send,
  // so the new thread shows up in the provider and `refreshReal` picks it up.
  let showNew = $state(false);
  let newTo = $state("");
  let newText = $state("");
  const startNew = () => {
    showNew = true;
    realErr = "";
    newErr = "";
    blockMsg = "";
    blockOk = false;
  };
  const cancelNew = () => {
    showNew = false;
    newTo = "";
    newText = "";
    realErr = "";
    newErr = "";
  };
  // Keep a draft instead of sending (local store; one draft per address).
  const saveDraftNow = () => {
    if (!newTo.trim() || !newText.trim()) return;
    // Same rule as `send`/`clear`/`deleteThread` on the conversation store, and the
    // very same defect shape: the composer is this sheet's content, so it may only
    // be emptied and the sheet closed once the draft really landed. A refused write
    // (`saveDrafts` false, banner already shown) used to close the sheet and drop
    // the typed message for a draft the store never accepted.
    if (!saveDrafts(saveDraft(drafts, newTo, newText, Date.now()))) return;
    newTo = "";
    newText = "";
    showNew = false;
  };
  const sendNew = () => {
    // Re-entrancy guard, not just the button's `disabled`: the composer's Enter
    // handler calls this directly, so a key repeat (or a fast double-tap before
    // Svelte flushes `disabled`) would otherwise send the same text twice. It asks
    // `sending` — a *send* in flight — and not `smsBusy`, which a **read** raises
    // (REQ-A1243).
    if (sending) return;
    const to = newTo.trim();
    const v = newText.trim();
    if (!to || !v) return;
    sending = true;
    // A `sms_send` may take the whole 8 s bridge timeout, and this composer can move under
    // the callback: 取消 closes it and 新建 ∕ 编辑草稿 reopens it, so by the time the answer
    // lands the sheet may hold a *different* message. Only the composer that still holds the
    // exact message this call sent is this call's to close — anything else would consume text
    // the user typed after the send, or pin a refusal on a message that never failed. The
    // draft removal and the re-read below are facts about the *send*, not about the composer,
    // so they happen either way (REQ-A1301).
    const isMine = () => showNew && newTo.trim() === to && newText.trim() === v;
    void smsSend(to, v).then((verdict) => {
      sending = false;
      if (verdict === "unconfirmed") {
        // No verdict is **neither** a failure nor a success: the message may still go
        // out, so the box and the draft keep the text and we say what we do not know.
        refreshReal();
        if (isMine()) newNote = { text: v, msg: t("message.sendUnconfirmed") };
        return;
      }
      if (verdict === "failed") {
        if (isMine()) newErr = t("message.sendFailed");
        return;
      }
      // Only the radio's own confirmation clears the composer; a sent draft is no
      // longer a draft.
      saveDrafts(removeDraft(drafts, draftId(to)));
      refreshReal();
      if (isMine()) {
        newTo = "";
        newText = "";
        showNew = false;
      }
    });
  };
  // Edit an existing draft: load it into the composer (send or re-save/delete).
  const editDraft = (d: SmsDraft) => {
    newTo = d.address;
    newText = d.text;
    showNew = true;
    realErr = "";
    newErr = "";
  };
  const deleteDraft = (d: SmsDraft) => {
    saveDrafts(removeDraft(drafts, d.id));
  };
  const sendReal = () => {
    // Same re-entrancy guard as `sendNew` (REQ-A1152): the thread composer used to
    // carry none, so a second Enter — or a double-tap on the send button — while
    // the first `sms_send` was still in flight issued a real duplicate SMS. The
    // guard lives in the function because the input's Enter handler bypasses the
    // button's `disabled`.
    //
    // It asks `sending`, not `smsBusy` (REQ-A1243). `smsBusy` is raised by
    // `refreshReal` for the whole duration of a device snapshot round trip — and the
    // live `sms-received` refresh fires *exactly* while the user sits in a thread
    // typing a reply — so reading it here let an incoming SMS silently swallow the
    // answer: Enter did nothing at all, and the button was greyed by a **read**, not
    // by a send. The two questions ("is a send in flight?" / "is a read in flight?")
    // have different answers and must not share one flag.
    if (sending) return;
    const v = realText.trim();
    if (!v || !activeReal) return;
    // The same rule as `sendNew`, on the thread composer: `sms_send` may take the whole 8 s
    // bridge timeout, and the thread on screen can change under the callback (tapping another
    // chip runs `openReal`, which empties this box for the thread being *opened*). An
    // unguarded success then wiped the half-typed reply the user had started in the new
    // thread, and an unguarded refusal drew 「发送失败」 under a thread that had sent nothing.
    // So the callback acts only while the composer is still the one this send was issued
    // from: same open thread, same text. `loadReal` guards a late *read* the same way
    // (REQ-A1245); this is its write-side twin (REQ-A1243 / REQ-A1301).
    const fromId = realActiveId;
    const isMine = () => realActiveId === fromId && realText.trim() === v;
    sending = true;
    void smsSend(activeReal.address, v).then((verdict) => {
      sending = false;
      if (verdict === "unconfirmed") {
        // Same three-way rule as `sendNew`: a message with no verdict keeps its text.
        refreshReal();
        if (isMine()) realNote = { text: v, msg: t("message.sendUnconfirmed") };
        return;
      }
      if (verdict === "failed") {
        if (isMine()) realErr = t("message.sendFailed");
        return;
      }
      if (isMine()) realText = "";
      refreshReal();
    });
  };
  // One-tap "block this sender": an exact/both rule in the SAME shared store the
  // phone's 拦截 tab and the SMS filter read, so the sender's texts stop appearing
  // (and their calls are rejected once the Call Screening role is held). Honest:
  // `blocklistAdd` returns null when the command was rejected — we say so instead
  // of pretending the number is now blocked.
  const blockSender = async () => {
    const addr = activeReal?.address;
    if (!addr || blockBusy) return;
    blockBusy = true;
    blockMsg = "";
    blockOk = false;
    try {
      const rule = await blocklistAdd(addr, "exact", "both");
      if (!rule) {
        blockOk = false;
        blockMsg = t("message.blockSenderFailed");
        amosWarn("messages", "blocklist_add failed", bridgeDiag("blocklist_add"));
        return;
      }
      blockOk = true;
      blockMsg = t("message.blockSenderDone", { addr });
      // A blocked sender is filtered out of the inbox, so the thread disappears
      // on the next read — the note above the list explains why.
      refreshReal();
    } finally {
      blockBusy = false;
    }
  };
  // ---- View-layer trash (REQ-A42) ------------------------------------------
  const refreshTrash = () => {
    void smsTrashList().then((l) => {
      // Same rule as `refreshCounts`: `null` is "the bridge never answered", which must not
      // be kept as the previous list — the panel would then name messages it no longer knows
      // are hidden. `[]` (an answer that is empty) still draws 「回收站为空」 (REQ-A1788).
      trash = l;
      if (l === null) amosWarn("messages", "sms_trash_list answered nothing", bridgeDiag("sms_trash_list"));
    });
  };
  const noteTrash = (ok: boolean, msg: string) => {
    trashOk = ok;
    trashMsg = msg;
  };
  // Hide one device message from the AmOS UI. Honest about every outcome:
  // hidden, refused (backend error), or stale (the row is no longer in the
  // folder being viewed). The message itself stays in the platform store.
  const trashOne = async (m: SmsMessageOut) => {
    if (trashBusy || !realActiveId) return;
    trashBusy = true;
    noteTrash(false, "");
    try {
      const r = await smsTrashAdd(realActiveId, m.id, folder);
      if (!r) {
        amosWarn("messages", "sms_trash_add failed", bridgeDiag("sms_trash_add"));
        noteTrash(false, t("message.trashFailed"));
        return;
      }
      if (!r.trashed) {
        noteTrash(false, "not_found" in r ? t("message.trashNotFound") : t("message.trashFailed"));
        return;
      }
      noteTrash(true, t("message.trashDone"));
      // Hidden rows vanish from the reads; previews/badges recompute backend-side.
      refreshReal();
    } finally {
      trashBusy = false;
    }
  };
  const restoreOne = async (e: SmsTrashEntryOut) => {
    if (trashBusy) return;
    trashBusy = true;
    try {
      const ok = await smsTrashRestore(e.thread_id, e.message_id);
      if (ok === null) {
        // The bridge never answered — the command `Err`ed (its handler runs on the
        // blocking pool, so a worker timeout/panic is reachable). That is a failure
        // to *restore*, and the not-in-trash sentence below would be a claim about
        // the trash's contents we cannot support.
        amosWarn("messages", "sms_trash_restore failed", bridgeDiag("sms_trash_restore"));
        noteTrash(false, t("message.trashRestoreFailed"));
      } else if (ok) {
        noteTrash(true, t("message.trashRestored"));
        refreshReal();
      } else {
        // `false` from the host is **not a failure**: `SmsTrashState::restore` answers
        // `false` exactly when no trash entry matched (the row was stale — already
        // restored from another surface — or the id was malformed; the host logs the
        // malformed case). Persisting is best-effort and never flips the answer, so a
        // false can never mean "we tried and the write failed". Saying
        // "移入回收站失败" here would name the *opposite* action and the wrong cause.
        amosWarn("messages", "sms_trash_restore matched nothing", bridgeDiag("sms_trash_restore"));
        noteTrash(false, t("message.trashNotInTrash"));
      }
    } finally {
      trashBusy = false;
    }
  };
  // "Purge" is an honest restore-all: nothing is destroyed (it can't be — the
  // system SMS app owns the store), every hidden message becomes visible again.
  const purgeTrash = async () => {
    if (trashBusy) return;
    trashBusy = true;
    try {
      const ok = await smsTrashPurge();
      // `smsTrashPurge` answers whether the *call* was answered (`0` purged is a
      // successful no-op — see lib/backend), so `false` here means the bridge did not
      // answer at all. That is a failure to empty the trash, not a failure to move one
      // message into it — the sentence has to name the action the user pressed.
      noteTrash(ok, ok ? t("message.trashPurged") : t("message.trashPurgeFailed"));
      if (ok) refreshReal();
    } finally {
      trashBusy = false;
    }
  };
  // Label for a trash entry: the thread's display name when the current folder
  // still lists it, else the raw thread id (honest, never invented).
  const trashThreadName = (threadId: string): string => {
    const th = realThreads.find((x) => x.id === threadId);
    return th ? th.display_name || th.address : threadId;
  };
  // Probe once (guarded so the effect can never re-enter).
  let probed = false;
  $effect(() => {
    if (probed || !bridged()) return;
    probed = true;
    void probeSms();
  });

  // This window's own focus (F-SH-654) — the signal the read gate needs, and the one that makes
  // the gate safe to have: a live arrival that lands while the user is elsewhere is *owed* a
  // read rather than refused (see `refreshReal`), and coming back is what pays it.
  $effect(() => {
    const onFocus = () => {
      winFocused = true;
      if (readOwed && smsMode === "real") {
        readOwed = false;
        refreshReal();
      }
    };
    const onBlur = () => {
      winFocused = false;
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  });

  // Live receive: the device pushes `sms-received` (SMS_RECEIVED broadcast →
  // Kotlin → JNI → here); we re-read the inbox through the validated read path
  // instead of polling. Only subscribed while the device backend is active.
  $effect(() => {
    if (smsMode !== "real") return;
    let un: (() => void) | null = null;
    let cancelled = false;
    void subscribe(SMS_RECEIVED_EVENT, () => {
      refreshReal();
      // P4: 收到新消息时触发 Dock 弹跳（仅在应用未激活时）
      const s = surface();
      if (s.kind !== "app" || s.id !== "messages") {
        emitDockBounce("messages");
      }
    }).then((u) => {
      // REQ-A838: a refused `sms-received` listen means the inbox never live-refreshes —
      // `un` stays `null` so the teardown below does not pretend to release a subscription
      // that was never made, and the verdict sits on `bridgeDiag(SMS_RECEIVED_EVENT)`.
      if (u === null) return;
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      if (un) un();
    };
  });

  // Reading a thread marks its incoming messages read (iOS behaviour). Without this
  // a conversation you are looking at keeps its ● badge (and the "N 未读" banner)
  // until you happen to send something — and the notification effect below would
  // publish a notification for a message that is already on screen.
  // Idempotent: once nothing is unread the guard returns, so it cannot loop.
  $effect(() => {
    if (smsMode === "real") return; // the local model is not the visible one
    const list = msgs;
    if (!activeId || unreadCount(list) === 0) return;
    setMsgs(markAllRead(list));
  });

  // Publish unread incoming messages across conversations as app notifications.
  //
  // Real device mode is the one model this effect must *not* speak for: the device
  // folders are what's on screen, and the local conversations are neither visible nor
  // on the phone. The earlier `shownActive = smsMode === "real" ? "" : activeId` was a
  // guard written as a value substitution rather than an early return — it dropped the
  // "don't notify about the thread being read" filter exactly in the mode where the
  // whole local model is off-screen, so it *widened* the set of threads it would speak
  // for. A notice published before the backend resolved (mode "unknown" for up to the
  // probe's four attempts at mount) would then linger and claim a message the user can
  // find nowhere, so real mode also retracts this app's own notices. (REQ-A1098 / F-SH-412)
  $effect(() => {
    const app = bgT("app.messages");
    const existing = normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, []));
    if (smsMode === "real") {
      if (hasNotifsOfApp(existing, "messages", ALL_LABEL_DICTS)) {
        writeStoreValue(NOTIF_KEY, withoutAppNotifs(existing, "messages", ALL_LABEL_DICTS));
      }
      return;
    }
    const hadAppNotifs = hasNotifsOfApp(existing, "messages", ALL_LABEL_DICTS);
    // A thread the user is actually reading is not a notification.
    const shownActive = activeId;
    const unread = conversations
      .filter((c) => c.id !== shownActive)
      .flatMap((c) => c.msgs.map((m) => ({ cid: c.id, m })))
      .filter(({ m }) => m.from === "them" && !m.read)
      .slice(0, 20);
    if (unread.length === 0 && !hadAppNotifs) return;
    const fresh: Notif[] = unread.map(({ cid, m }) => ({
      id: messageNotifKey(cid, m.ts),
      app,
      icon: "💬",
      title: m.text.length > 40 ? `${m.text.slice(0, 40)}…` : m.text,
      time: m.ts,
    }));
    writeStoreValue(NOTIF_KEY, replaceAppNotifs(existing, "messages", fresh, ALL_LABEL_DICTS));
  });

  const send = () => {
    const v = text.trim();
    if (!v || !active) return;
    const landed = setMsgs(
      replyTo
        ? appendQuote(markAllRead(msgs), v, replyTo, Date.now())
        : appendMessage(markAllRead(msgs), v, Date.now()),
    );
    // Same rule as `confirmAdd`: the composer is cleared only when the message really
    // landed. Emptying it on a refused write threw away what the user typed — the
    // banner named a storage fault, not a message they could retry by pressing send.
    if (!landed) return;
    replyTo = null;
    text = "";
  };
  const clear = () => {
    if (!active) return;
    // Same rule as `send`: the composer belongs to this thread, so it may only be
    // emptied once the thread's new (empty) message list really landed. Clearing it
    // first threw the typed message away for a write the store refused — and the
    // messages that stayed on screen then had nothing left to reply with.
    if (!setMsgs(clearMessages())) return;
    text = "";
    replyTo = null;
  };
  const confirmAdd = () => {
    const before = conversations;
    const next = addConversation(before, newName);
    if (next.length === before.length) return; // blank or duplicate → no-op
    const added = next[next.length - 1] as Conversation; // addConversation appended it
    // Open the new thread only if it was actually stored. `saveConvs` reports a refused
    // write (banner, `conversations` untouched) and returns false; moving `activeId` to a
    // thread that does not exist would switch the pane to it anyway, so the conversation
    // that WAS open vanished from the screen for a change that never happened — and the
    // name box was blanked, leaving nothing to retry with.
    if (!saveConvs(next)) return;
    // The composer belongs to the thread, and this is the *second* way the open thread
    // moves — so it goes through the same door as the thread strip (REQ-A1219): assigning
    // `activeId` by hand here left the conversation just left its reply target and its
    // half-typed text, one 发送 away from being appended to the brand-new thread (REQ-A1220).
    openLocal(added.id);
    newName = "";
  };
  const deleteThread = () => {
    const next = removeConversation(conversations, activeId);
    // The thread (and with it this composer) only disappears if the removal was
    // stored; a refused delete leaves the thread on screen, so its in-progress
    // message must stay in the box rather than vanish with a change that never was.
    if (!saveConvs(next)) return;
    replyTo = null;
    text = "";
  };

  // Per-message actions, iOS-style: a gesture only **reveals** the row's buttons; a
  // *tap* on one performs it. iOS never runs a destructive action off the gesture
  // itself — swiping a row left slides out the actions and waits.
  //
  // This is also the only reason these buttons are reachable on a touch class at all:
  // they are `opacity-0` + `pointer-events-none` until revealed (hover-scan rule 2
  // forbids invisible-but-hit-testable, and a finger cannot hover), so without a
  // gesture the whole action set — including 引用回复 — exists only as paint that no
  // finger can ever hit. Two ways in, both iOS's own: **press and hold** a bubble, or
  // **swipe it left**.
  let revealedRow = $state<string | null>(null);
  const LONG_PRESS_MS = 500;
  // A finger that drifts more than this is swiping/scrolling, not holding. The swipe
  // below needs ~50 px, so the press dies well before a swipe could be mistaken for one.
  const PRESS_SLOP_PX = 12;
  let pressTimer: number | null = null;
  let pressFired = false;
  let pressX = 0;
  let pressY = 0;

  function startRowPress(e: TouchEvent, key: string): void {
    cancelRowPress();
    const p = e.touches[0];
    if (p == null) return;
    pressFired = false;
    pressX = p.clientX;
    pressY = p.clientY;
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      pressFired = true;
      revealedRow = key;
    }, LONG_PRESS_MS);
  }
  function moveRowPress(e: TouchEvent): void {
    if (pressTimer === null) return;
    const p = e.touches[0];
    if (p == null || Math.abs(p.clientX - pressX) > PRESS_SLOP_PX || Math.abs(p.clientY - pressY) > PRESS_SLOP_PX) {
      cancelRowPress();
    }
  }
  function cancelRowPress(): void {
    if (pressTimer !== null) {
      window.clearTimeout(pressTimer);
      pressTimer = null;
    }
  }
  // Swipe left → reveal the same row. Leftward **and** horizontally dominant, so a
  // vertical scroll never pops a row open. This used to delete the message outright:
  // a diagonal scroll could destroy one, with no confirmation and no undo, and it was
  // the only touch path to a destructive action in the app.
  function onRowSwipeEnd(e: TouchEvent, key: string): void {
    if (pressFired) {
      // The hold already revealed this row; the lift must not immediately close it.
      pressFired = false;
      cancelRowPress();
      return;
    }
    cancelRowPress();
    const end = e.changedTouches[0];
    if (end == null) return;
    const dx = pressX - end.clientX;
    const dy = Math.abs(end.clientY - pressY);
    revealedRow = dx > 50 && dx > dy ? key : null;
  }

  /**
   * The class list of one per-message action button. A *revealed* row is tappable; every
   * other row stays invisible **and** un-hit-testable (`pointer-events-none` — hover-scan
   * rule 2), with hover / focus-within as the pointer and keyboard reveal. Both branches
   * are literal strings so Tailwind's static scan and hover-scan can see them.
   */
  const rowActionClass = (revealed: boolean): string =>
    "mt-1 shrink-0 rounded-full px-1 text-xs transition-opacity disabled:opacity-40 " +
    (revealed
      ? "opacity-60 pointer-events-auto"
      : "opacity-0 pointer-events-none group-hover:opacity-60 group-hover:pointer-events-auto group-focus-within:opacity-60 group-focus-within:pointer-events-auto");

  /**
   * The copy for an empty thread list, spoken by the folder that is empty.
   *
   * 「本机暂无短信」 is a claim about the **whole device**, and this branch is reached by
   * both 收件箱 and 发件箱 — so a phone whose inbox is full but from which the user has
   * never sent anything read 「本机暂无短信」 under 发件箱, contradicting the thread list
   * one tab away. 草稿 already has its own sentence (`message.draftsEmpty`), and the
   * thread pane has one (`message.empty`); only these two folders shared a single key,
   * and the key that names a folder is the one for the *other* folder (REQ-A1214).
   */
  const emptyListCopy = (f: SmsFolder): string =>
    f === "sent" ? t("message.sentEmpty") : t("message.inboxEmpty");

  const dayLabelOf = (ts: number): string => {
    const dl = messageDayLabel(ts, Date.now());
    return dl === "today" ? t("message.today") : dl === "yesterday" ? t("message.yesterday") : dl;
  };

  // ---- Deep link: "回短信" from the phone's call history -------------------------
  // The call-history page sets the `messages` channel and opens this app; we then
  // open the composer addressed to that number — the REAL SMS composer on a device
  // backend, or a local conversation in host/offline mode. The link is *consumed*
  // (channel cleared) so re-opening Messages from the dock never re-fires it.
  let pendingCompose: string | null = null;
  let composeNonce = 0;
  const openLocalThread = (name: string) => {
    const n = name.trim();
    if (n === "") return;
    const existing = conversations.find((c) => c.name.toLowerCase() === n.toLowerCase());
    if (existing) {
      openLocal(existing.id);
      newName = "";
      return;
    }
    newName = n;
    confirmAdd();
  };
  /** Returns false when the device-vs-local backend is not resolved yet. */
  const applyCompose = (to: string): boolean => {
    const n = to.trim();
    if (n === "") return true;
    if (smsMode === "real") {
      newTo = n;
      // Entering the composer changes what the screen is about, and the block note belongs to
      // the thread it was made from — so every other door onto this screen clears it:
      // `setFolder` on a folder switch, `switchReal` on a thread switch (REQ-A1240), and
      // `startNew` on the composer's own button. This door was not in that sweep. It is not a
      // cold entry either: the phone's 回短信 and a number dropped on the dock reach the screen
      // that is **already mounted** (that is what the channel is for), so the note from the
      // thread just left was still standing above the new composer — its failure copy names no
      // sender, so it read as a verdict on the hand-off that had just happened (REQ-A1282).
      blockMsg = "";
      blockOk = false;
      newText = "";
      showNew = true;
      realErr = "";
      newErr = "";
    } else if (smsMode === "local" || !bridged()) {
      openLocalThread(n);
    } else {
      return false; // device probe still running — retry when it settles
    }
    // Consume the link so a later remount starts clean.
    messagesChannel().set({ composeTo: "", nonce: composeNonce });
    return true;
  };
  $effect(() => {
    return messagesChannel().subscribe((v) => {
      if (!v || v.composeTo.trim() === "" || v.nonce === composeNonce) return;
      composeNonce = v.nonce;
      if (!applyCompose(v.composeTo)) pendingCompose = v.composeTo;
    });
  });
  $effect(() => {
    // A link that arrived while the backend probe was still running.
    if (pendingCompose && smsMode !== "unknown") {
      const p = pendingCompose;
      pendingCompose = null;
      applyCompose(p);
    }
  });
</script>

<div class="flex h-full flex-col p-3">
  <StoreErrorBar message={storeErr} />
  {#if smsMode === "real"}
    <!-- Folder tabs: inbox / sent / drafts (counts are distinct threads) -->
    <div class="mb-1.5 flex items-center gap-1 overflow-x-auto" data-testid="sms-folders">
      {#each SMS_FOLDERS as f (f)}
        {@const badge = counts ? counts[f] + (f === "draft" ? drafts.length : 0) : null}
        <button onclick={() => setFolder(f)} aria-pressed={folder === f} data-folder={f} class={"shrink-0 rounded-full px-3 py-1.5 text-xs " + (folder === f ? "bg-accent text-white" : "bg-black/5 text-neutral-700 dark:bg-white/10 dark:text-neutral-300")}>{t(`message.folder.${f}`)}{#if badge === null}<span class="ml-1 opacity-60" data-testid="counts-unknown" title={t("message.countsUnknown")}>—</span>{:else if badge > 0}<span class="ml-1 opacity-80">{badge}</span>{/if}</button>
      {/each}
    </div>
    <!-- Device inbox toolbar: compose a new message + trash panel + refresh -->
    <div class="mb-1.5 flex items-center justify-between gap-1.5">
      <button onclick={startNew} data-testid="new-sms" class="rounded-full bg-accent px-3 py-1.5 text-xs text-white active:scale-95">{t("message.newSms")}</button>
      <div class="flex items-center gap-1.5">
        <button onclick={() => (trashOpen = !trashOpen)} disabled={trashBusy} aria-pressed={trashOpen} data-testid="trash-toggle" title={t("message.trashPanel")}
          class="rounded-full bg-neutral-200 px-3 py-1.5 text-xs disabled:opacity-40 dark:bg-neutral-700">{t("message.trashPanel")}{#if trash === null}<span class="ml-1 opacity-60" data-testid="trash-unknown" title={t("message.trashUnknown")}>—</span>{:else if trash.length > 0}<span class="ml-1 opacity-80">{trash.length}</span>{/if}</button>
        <button onclick={retrySms} disabled={smsBusy} data-testid="refresh-sms" title={t("message.refresh")} class="rounded-full bg-neutral-200 px-3 py-1.5 text-xs disabled:opacity-40 dark:bg-neutral-700">{t("message.refresh")}</button>
      </div>
    </div>
    {#if trashMsg}
      <!-- Outcome of a trash action: what happened, said plainly (hidden vs
           refused vs stale) — never a silent no-op. -->
      <p class={"mb-1.5 rounded-xl px-3 py-1.5 text-xs " + (trashOk ? "bg-accent/10 text-accent" : "bg-red-500/10 text-red-500")}
        data-testid="trash-msg" data-ok={trashOk} role={trashOk ? "status" : "alert"}>{trashMsg}</p>
    {/if}
    {#if trashOpen}
      <!-- View-layer trash (REQ-A42): these messages are hidden from AmOS only —
           the platform store still holds them, and the hint below says so. -->
      <div class="mb-1.5 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/5" data-testid="trash-panel">
        <div class="mb-1 flex items-center justify-between gap-2">
          <span class="text-xs font-semibold">{t("message.trashPanel")}{#if trash === null} (—){:else if trash.length > 0} ({trash.length}){/if}</span>
          <button onclick={() => void purgeTrash()} disabled={trashBusy || !trash || trash.length === 0} data-testid="trash-purge"
            class="rounded-full bg-neutral-200 px-2.5 py-1 text-[11px] disabled:opacity-40 dark:bg-neutral-700">{t("message.trashPurge")}</button>
        </div>
        <p class="mb-1.5 text-[11px] leading-snug opacity-60">{t("message.trashHint")}</p>
        {#if trash === null}
          <p class="py-1 text-center text-xs opacity-60" data-testid="trash-unreadable">{t("message.trashUnknown")}</p>
        {:else if trash.length === 0}
          <p class="py-1 text-center text-xs opacity-60">{t("message.trashEmpty")}</p>
        {:else}
          <ul class="max-h-32 space-y-1 overflow-auto">
            {#each trash as e (e.thread_id + "/" + e.message_id)}
              <li class="flex items-center justify-between gap-2 text-xs" data-testid="trash-row">
                <span class="min-w-0 truncate opacity-80">{trashThreadName(e.thread_id)} · {fmtBubbleTime(e.trashed_ms)}</span>
                <button onclick={() => void restoreOne(e)} disabled={trashBusy} data-testid={`trash-restore-${e.message_id}`}
                  class="shrink-0 rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] text-accent disabled:opacity-40">{t("message.trashRestore")}</button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
    {#if blockMsg}
      <!-- Outcome of "block this sender": success explains the vanished thread,
           failure is an explicit error — never a silent no-op. -->
      <p class={"mb-1.5 rounded-xl px-3 py-1.5 text-xs " + (blockOk ? "bg-accent/10 text-accent" : "bg-red-500/10 text-red-500")}
        data-testid="block-sender-msg" data-ok={blockOk} role={blockOk ? "status" : "alert"}>{blockMsg}</p>
    {/if}
    {#if showNew}
      <!-- Compose to any number: the platform persists the send, so the thread
           appears in the provider and the list refreshes below. -->
      <div class="mb-1.5 flex items-center gap-1.5" data-testid="new-sms-form">
        <input bind:value={newTo} data-testid="new-sms-to" aria-label={t("message.toPlaceholder")} placeholder={t("message.toPlaceholder")} class="min-w-0 flex-1 rounded-full bg-black/5 px-3 py-1.5 text-sm outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:ring-white/10 dark:placeholder:text-white/30" />
        <input bind:value={newText} data-testid="new-sms-text" aria-label={t("message.newSmsHint")} placeholder={t("message.newSmsHint")} onkeydown={(e) => e.key === "Enter" && sendNew()} class="min-w-0 flex-1 rounded-full bg-black/5 px-3 py-1.5 text-sm outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:ring-white/10 dark:placeholder:text-white/30" />
        <button onclick={sendNew} disabled={sending} data-testid="new-sms-send" class="shrink-0 rounded-full bg-accent px-3 py-1.5 text-xs text-white active:scale-95 disabled:opacity-40">{t("message.send")}</button>
        <button onclick={saveDraftNow} data-testid="new-sms-draft" class="shrink-0 rounded-full bg-neutral-200 px-3 py-1.5 text-xs dark:bg-neutral-700">{t("message.saveDraft")}</button>
        <button onclick={cancelNew} data-testid="new-sms-cancel" class="shrink-0 rounded-full bg-neutral-200 px-2 py-1.5 text-xs dark:bg-neutral-700">{t("message.cancel")}</button>
      </div>
      {#if newErr}
        <!-- The refusal belongs to *this* composer, and it is drawn here rather than
             in the thread branches below: the composer is a sibling of the folder
             chain, so it is the one place reachable in every folder (REQ-A1069). -->
        <p class="mb-1.5 text-xs text-red-500" role="alert" data-testid="new-sms-error">{newErr}</p>
      {/if}
      {#if newNote && newNote.text === newText.trim()}
        <!-- Not an error and not a success: the platform never said. `role="status"` and
             an amber line, not the red alert above — a message that may have gone out
             must not be dressed as a failure (REQ-A1620 / F-TEL-040). -->
        <p class="mb-1.5 text-xs text-amber-600 dark:text-amber-400" role="status" data-testid="new-sms-note">{newNote.msg}</p>
      {/if}
    {/if}
    {#if folder === "draft"}
      <!-- Drafts: AmOS-local (only the default SMS app may write system drafts) -->
      <div class="flex-1 space-y-2 overflow-auto" data-testid="drafts-list">
        <p class="pb-1 text-xs opacity-60">{t("message.draftsLocalHint")}</p>
        {#if drafts.length === 0}
          <p class="py-10 text-center text-sm opacity-60">{t("message.draftsEmpty")}</p>
        {:else}
          {#each drafts as d (d.id)}
            <div class="flex items-start gap-2 rounded-xl bg-black/5 px-3 py-2 dark:bg-white/10">
              <button onclick={() => editDraft(d)} aria-label={t("message.openDraft")} data-testid={`draft-edit-${d.address}`} class="min-w-0 flex-1 text-left">
                <div class="text-xs opacity-60">{d.address}</div>
                <div class="truncate text-sm">{d.text}</div>
              </button>
              <button onclick={() => deleteDraft(d)} aria-label={t("message.delete")} data-testid={`draft-delete-${d.address}`} class="shrink-0 rounded-full bg-neutral-200 px-2 py-1 text-xs dark:bg-neutral-700">{t("message.delete")}</button>
            </div>
          {/each}
        {/if}
        {#if smsErr}
          <!-- Only the *system* drafts section is unknown when the read failed — the
               local drafts above are AmOS-local and always readable, so they stay. This
               is the one place in this folder that can say so: the `{:else if smsErr}`
               branch below owns that job for every other folder, but this branch comes
               first in the same chain, so without this line a refused read of the
               drafts folder read exactly like a device that has no drafts (REQ-A1070). -->
          <p class="pt-2 text-xs text-red-500" role="alert" data-testid="sms-error">{smsErr}</p>
          {#if smsDenied}
            <p class="pt-1 text-xs opacity-60">{t("message.smsDeniedHint")}</p>
            <button onclick={grantSms} disabled={smsGrantBusy} data-testid="sms-grant-drafts" class="mt-1 rounded-full bg-accent px-3 py-1 text-xs text-white active:scale-95 disabled:opacity-40">{t("message.smsGrant")}</button>
          {/if}
        {:else if realThreadsFolder === folder && realThreads.length > 0}
          <!-- Draft rows the platform itself holds (written by the default SMS
               app). Read-only for us: only the default SMS app may write them.
               Only when the list actually came from 草稿 — a thread list left over
               from another folder must not be labelled a system draft (REQ-A1212). -->
          <p class="pt-2 text-xs opacity-60">{t("message.draftsSystem")}</p>
          {#each realThreads as th (th.id)}
            <div class="rounded-xl bg-black/5 px-3 py-2 dark:bg-white/10" data-testid="system-draft">
              <div class="text-xs opacity-60">{th.display_name || th.address}</div>
              <div class="truncate text-sm">{th.last_text}</div>
            </div>
          {/each}
        {/if}
      </div>
    {:else if smsErr}
      <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="sms-error">
        <p class="text-sm text-red-500" role="alert">{smsErr}</p>
        {#if smsDenied}
          <p class="text-xs opacity-60">{t("message.smsDeniedHint")}</p>
          <button onclick={grantSms} disabled={smsGrantBusy} data-testid="sms-grant" class="rounded-full bg-accent px-4 py-1.5 text-xs text-white active:scale-95 disabled:opacity-40">{t("message.smsGrant")}</button>
        {/if}
        <button onclick={retrySms} disabled={smsBusy} data-testid="sms-retry" class="rounded-full bg-neutral-200 px-4 py-1.5 text-xs active:scale-95 disabled:opacity-40 dark:bg-neutral-700">{t("message.retry")}</button>
      </div>
    {:else if realThreadsFolder !== folder}
      <!-- The list we hold belongs to another folder, or we have not read this one yet:
           neither the previous folder's threads nor "this folder is empty" is known, so
           say the one thing that is true (REQ-A1212). -->
      <div class="flex flex-1 items-center justify-center p-6" data-testid="sms-reading">
        <p class="text-sm opacity-60" role="status">{t("message.reading")}</p>
      </div>
    {:else if realThreads.length === 0}
      <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="sms-empty">
        <p class="text-sm opacity-60">{emptyListCopy(folder)}</p>
        {#if realErr}
          <p class="text-xs text-red-500" role="alert">{realErr}</p>
        {/if}
      </div>
    {:else}
    <!-- Real device inbox (SmsGlue over JNI): read threads + send via SmsManager -->
    <div class="mb-1 flex items-center gap-1.5 overflow-x-auto">
      {#each realThreads as th (th.id)}
        <button onclick={() => switchReal(th.id)} aria-pressed={th.id === realActiveId} class={"shrink-0 rounded-full px-3 py-1.5 text-xs " + (th.id === realActiveId ? "bg-accent text-white" : "bg-black/5 text-neutral-700 dark:bg-white/10 dark:text-neutral-300")}>{th.display_name || th.address}{#if realUnread(th)}<span class="ml-1">●{th.unread}</span>{/if}</button>
      {/each}
    </div>
    <div class="flex items-center justify-between pb-2">
      <div class="flex min-w-0 items-center gap-2">
        <span class="text-sm font-semibold">{activeRealName}</span>
        <span data-testid="real-sms-badge" class="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] text-accent">📡 {t("message.realSms")}</span>
      </div>
      {#if activeReal}
        <button onclick={() => void blockSender()} disabled={blockBusy} aria-label={t("message.blockSender")} title={t("message.blockSender")} data-testid={`block-sender-${activeReal.address}`}
          class="shrink-0 rounded-full bg-danger/10 px-3 py-1 text-[11px] text-danger active:scale-95 disabled:opacity-40 dark:bg-danger/20">{t("message.blockSender")}</button>
      {/if}
    </div>
    <div class="flex-1 space-y-2 overflow-auto">
      {#if realMsgs.length === 0}
        <p class="py-10 text-center text-sm opacity-60">{t("message.empty")}</p>
      {:else}
        {#each realMsgs as m, i (m.id + "-" + i)}
          {@const rowKey = m.id + "-" + i}
          <div role="group" class={"group flex items-start gap-1.5 max-w-[80%] " + (m.from_me ? "ml-auto" : "")} ontouchstart={(e) => startRowPress(e, rowKey)} ontouchmove={moveRowPress} ontouchend={(e) => onRowSwipeEnd(e, rowKey)} ontouchcancel={cancelRowPress}>
            <div class={"rounded-ios-bubble px-4 py-2.5 text-ios-body leading-relaxed shadow-sm " + (m.from_me ? "bg-accent text-white" : "bg-ios-lightGray text-neutral-900 dark:bg-ios-darkGray dark:text-white")}>
              <div class="whitespace-pre-wrap">{m.text}</div>
              <div class="mt-1.5 text-right text-ios-caption1 tabular-nums opacity-70">{fmtBubbleTime(m.ts_ms)}</div>
            </div>
            <!-- Hide this message from AmOS (view-layer trash, REQ-A42): the
                 text stays in the platform store; the panel explains that. -->
            <button onclick={() => { void trashOne(m); revealedRow = null; }} disabled={trashBusy} aria-label={t("message.trash")} title={t("message.trash")} data-testid={`trash-msg-btn-${m.id}`}
              class={rowActionClass(revealedRow === rowKey)}>{@html iconSvg("trash", "h-3.5 w-3.5")}</button>
          </div>
        {/each}
      {/if}
    </div>
    {#if realErr}
      <p class="mt-1 text-xs text-red-500" role="alert">{realErr}</p>
    {/if}
    {#if realNote && realNote.text === realText.trim()}
      <!-- See `newNote`: no verdict is its own outcome, drawn on its own line. -->
      <p class="mt-1 text-xs text-amber-600 dark:text-amber-400" role="status" data-testid="real-sms-note">{realNote.msg}</p>
    {/if}
    <div class="mt-2 flex items-center gap-2 pb-1">
      <input bind:value={realText} onkeydown={(e) => e.key === "Enter" && sendReal()} placeholder={t("message.placeholder", { name: activeRealName })} data-testid="real-message-input" aria-label={t("message.placeholder", { name: activeRealName })} class="min-w-0 flex-1 rounded-ios-bubble bg-neutral-100 px-4 py-2.5 text-ios-body outline-none dark:bg-white/10" />
      <button onclick={sendReal} disabled={sending} title={t("message.placeholder", { name: activeRealName })} aria-label={t("message.send")} data-icon="send" class="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent text-white shadow-sm transition active:scale-90 disabled:opacity-40">{@html iconSvg("send", "h-[18px] w-[18px]")}</button>
    </div>
    {/if}
  {:else}
  <!-- Conversation bar: switch threads -->
  <div class="mb-1 flex items-center gap-1.5 overflow-x-auto">
    {#each conversations as c (c.id)}
      <button onclick={() => openLocal(c.id)} aria-pressed={c.id === activeId} class={"shrink-0 rounded-full px-3 py-1.5 text-xs " + (c.id === activeId ? "bg-accent text-white" : "bg-black/5 text-neutral-700 dark:bg-white/10 dark:text-neutral-300")}>{c.name}{#if unreadCount(c.msgs) > 0}<span class="ml-1">●</span>{/if}</button>
    {/each}
  </div>
  <!-- Always-visible row to start a new contact-thread (local conversations) -->
  <div class="mb-1.5 flex items-center gap-1.5">
    <input bind:value={newName} data-testid="new-contact" aria-label={t("message.contactPlaceholder")} onkeydown={(e) => e.key === "Enter" && confirmAdd()} placeholder={t("message.contactPlaceholder")} class="min-w-0 flex-1 rounded-full bg-black/5 px-3 py-1.5 text-sm text-neutral-900 outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:text-white dark:ring-white/10 dark:placeholder:text-white/30" />
    <button onclick={confirmAdd} data-testid="add-contact" title={t("message.addThread")} class="shrink-0 rounded-full bg-accent px-3 py-1.5 text-xs text-white active:scale-95">{t("message.confirm")}</button>
  </div>

  {#if active}
    <div class="flex items-center justify-between pb-2">
      <div class="flex min-w-0 items-center gap-2">
        <span class="text-sm font-semibold">{active.name}</span>
        {#if unreadCount(msgs) > 0}
          <button onclick={() => setMsgs(markAllRead(msgs))} title={t("message.markRead")} class="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">{unreadCount(msgs)} {t("message.unread")}</button>
        {/if}
      </div>
      <div class="flex items-center gap-1.5">
        {#if conversations.length > 1}
          <button onclick={deleteThread} data-testid="delete-thread" title={t("message.deleteThread")} class="rounded-full bg-neutral-200 px-3 py-1.5 text-xs dark:bg-neutral-700">{t("message.deleteThread")}</button>
        {/if}
        <button onclick={clear} disabled={msgs.length === 0} aria-label={t("message.clear")} class="rounded-full bg-neutral-200 px-3 py-1.5 text-xs disabled:opacity-40 dark:bg-neutral-700"><span data-icon="trash" class="inline-flex align-[-1px]">{@html iconSvg("trash", "h-3 w-3")}</span> {t("message.clear")}</button>
      </div>
    </div>
    <div class="flex-1 space-y-2 overflow-auto">
      {#if msgs.length === 0}
        <p class="py-10 text-center text-sm opacity-60">{t("message.empty")}</p>
      {:else}
        {#each msgs as m, i (m.ts + "-" + i)}
          {@const prev = msgs[i - 1]}
          {@const rowKey = m.ts + "-" + i}
          {#if !prev || isNewDay(prev.ts, m.ts)}
            <p class="py-2 text-center text-ios-caption1 font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">{dayLabelOf(m.ts)}</p>
          {/if}
          <div role="group" class={"group flex items-start gap-1.5 max-w-[75%] " + (m.from === "me" ? "ml-auto" : "")} ontouchstart={(e) => startRowPress(e, rowKey)} ontouchmove={moveRowPress} ontouchend={(e) => onRowSwipeEnd(e, rowKey)} ontouchcancel={cancelRowPress}>
            <div class={"rounded-ios-bubble px-3.5 py-2.5 text-ios-body shadow-sm " + (m.from === "me" ? "bg-accent text-white" : "bg-ios-lightGray text-neutral-900 dark:bg-ios-darkGray dark:text-white")}>
              {#if m.quote}
                <div class="mb-1.5 rounded-md bg-white/10 px-2 py-1 text-ios-footnote opacity-70"><span class="inline-flex">{@html iconSvg("reply", "h-3 w-3")}</span> {m.quote}</div>
              {/if}
              <div class="whitespace-pre-wrap leading-snug">{m.text}</div>
              <div class="mt-1 text-right text-ios-caption1 tabular-nums opacity-60">{fmtBubbleTime(m.ts)}</div>
            </div>
            <button onclick={() => { replyTo = m.text; revealedRow = null; }} aria-label={t("message.reply")} data-icon="reply" data-testid={`reply-msg-btn-${i}`} class={rowActionClass(revealedRow === rowKey)}>{@html iconSvg("reply", "h-4 w-4")}</button>
            <button onclick={() => { setMsgs(removeMessageAt(msgs, i)); revealedRow = null; }} aria-label={t("message.remove")} data-icon="x" data-testid={`remove-msg-btn-${i}`} class={rowActionClass(revealedRow === rowKey)}>{@html iconSvg("x", "h-3 w-3")}</button>
          </div>
        {/each}
      {/if}
    </div>
    {#if replyTo}
      <div class="mt-1 flex items-center justify-between gap-2 rounded-lg bg-accent/10 px-2 py-1 text-xs">
        <span class="truncate text-accent">{t("message.replying")}: {replyTo}</span>
        <button onclick={() => (replyTo = null)} aria-label={t("message.replyClear")} class="shrink-0 px-1 text-accent">{@html iconSvg("x", "h-3 w-3")}</button>
      </div>
    {/if}
    <div class="mt-2 flex items-center gap-2 pb-1">
      <input bind:value={text} onkeydown={(e) => e.key === "Enter" && send()} placeholder={t("message.placeholder", { name: active.name })} data-testid="message-input" aria-label={t("message.placeholder", { name: active.name })} class="min-w-0 flex-1 rounded-ios-bubble bg-neutral-100 px-4 py-2.5 text-ios-body outline-none dark:bg-white/10" />
      <button onclick={send} title={t("message.placeholder", { name: active.name })} aria-label={t("message.send")} data-icon="send" class="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent text-white shadow-sm transition active:scale-90">{@html iconSvg("send", "h-[18px] w-[18px]")}</button>
    </div>
  {:else}
    <p class="py-16 text-center text-sm opacity-60">{t("message.noThreads")}</p>
  {/if}
  {/if}
</div>


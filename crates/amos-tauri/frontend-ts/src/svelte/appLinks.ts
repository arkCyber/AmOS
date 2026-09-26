/**
 * appLinks.ts — cross-app deep links ("open app X addressed to Y").
 *
 * The Svelte shell mounts exactly one app screen at a time (`Shell.svelte`), so an
 * app that needs to hand work to another one (the phone's call-history page →
 * "回短信") sets the target screen's props channel **first** and then switches the
 * shell surface. The target then already has the payload when it mounts.
 *
 * Plain TS (no runes) so both the shell and any app screen can import it.
 */
import { propsChannel } from "./propsBus";
import { open } from "./shellState.svelte";
import { systemSetContext } from "../lib/backend";
import { FILES_REVEAL_KEY, FILES_VIEW_KEY } from "../lib/files";
import type { FilesView } from "../lib/files";
import { SETTINGS_PAGE_KEY, type SettingsPageId } from "../lib/settingsPages";
import { writeStoreValueChecked } from "../lib/amosStore";

/**
 * A "show me this item" link (Files / Contacts): the shell switches to the app and
 * the app navigates to where the item lives and **marks** it.
 *
 * Unlike Notes (which has a full-page editor, so `openNote` can really open one
 * note), the Files and Contacts screens have no single-item screen. Rather than
 * invent one, the link asks for what those screens can honestly do: put the item on
 * screen and highlight it. A payload whose id no longer exists is ignored by the
 * target — it never fabricates a file or a contact.
 */
export interface ShowLink {
  /** Id of the entry/record to reveal (`""` = nothing pending). */
  id: string;
  /** Changing marker so asking twice for the same id re-triggers the reveal. */
  nonce: number;
}

/** Payload the Messages screen reads to prefill its composer. */
export interface MessagesLink {
  /** Address to compose to (a phone number). */
  composeTo: string;
  /** Changing marker so asking twice for the same number re-triggers the prefill. */
  nonce: number;
}

/** Props-channel name of the Messages screen (shared contract with MessagesApp). */
export const MESSAGES_CHANNEL = "messages";

/** The Messages screen's link channel (for `subscribe` / `set`). */
export function messagesChannel() {
  return propsChannel<MessagesLink>(MESSAGES_CHANNEL);
}

/** Payload the Notes screen reads to open one note, or to start a draft. */
export interface NotesLink {
  /** Id of the note to open (`""` = nothing pending). */
  noteId: string;
  /** Changing marker so asking twice for the same note re-triggers the open. */
  nonce: number;
  /**
   * Text to **prefill the compose box** with (cross-app drop of a note's text). It is
   * a draft, not a note: nothing is created until the user presses add, so a drop can
   * never silently mint a second note.
   */
  draftText?: string;
}

/** Props-channel name of the Notes screen (shared contract with NotesApp). */
export const NOTES_CHANNEL = "notes";

/** The Notes screen's link channel (for `subscribe` / `set`). */
export function notesChannel() {
  return propsChannel<NotesLink>(NOTES_CHANNEL);
}

/**
 * Open the Notes app **on one note** (the Spotlight chooser uses this).
 *
 * The link is only a *request*: the Notes screen decides what it can do with it and
 * silently ignores an id that no longer exists — it never claims a note is there.
 */
export function openNote(noteId: string): void {
  const id = noteId.trim();
  if (id === "") return;
  notesChannel().set({ noteId: id, nonce: Date.now() });
  open("notes");
}

/**
 * Open the Notes app with `text` **prefilled in the compose box** — the target of a
 * cross-app drop of some text (REQ-A683).
 *
 * Prefill only, deliberately: a drop hands the text over, it does not author a note.
 * The user still presses add, so an accidental drop leaves a draft they can clear
 * rather than a note they did not write.
 *
 * Returns whether the draft was dispatched, exactly as {@link openMailDraft} does — an
 * empty body is refused rather than opening a composer with nothing in it, and the
 * caller has to be able to say so. The refusal is the same one either way; this side
 * used to drop it on the floor, so a caller that hard-coded `true` reported a hand-off
 * of nothing (REQ-A1557 ∕ F-SH-791).
 */
export function openNoteDraft(text: string): boolean {
  const body = text.trim();
  if (body === "") return false;
  notesChannel().set({ noteId: "", draftText: body, nonce: Date.now() });
  open("notes");
  return true;
}

/** Payload the Mail screen reads to prefill a new message's composer. */
export interface MailLink {
  /** Subject line to prefill (`""` = the user fills it in). */
  subject: string;
  /** Body text to prefill. */
  body: string;
  /** Changing marker so asking twice for the same draft re-triggers the prefill. */
  nonce: number;
}

/** Props-channel name of the Mail screen (shared contract with MailApp). */
export const MAIL_CHANNEL = "mail";

/** The Mail screen's link channel (for `subscribe` / `set`). */
export function mailChannel() {
  return propsChannel<MailLink>(MAIL_CHANNEL);
}

/**
 * Open the Mail app with a **draft** prefilled in its composer (the share sheet's
 * Mail target, REQ-A1458).
 *
 * Prefill only, deliberately: a hand-off writes a draft the user still has to send.
 * Nothing here reaches `mail_send`, so a share can never mail something the user did
 * not press send on — the same stance `openNoteDraft` takes for notes.
 *
 * Returns whether the draft was dispatched. An empty body is refused rather than
 * opening a composer with nothing in it (the caller can then say so); the reader
 * re-checks the marker, because a channel outlives the build that wrote to it.
 */
export function openMailDraft(draft: { subject: string; body: string }): boolean {
  const body = draft.body.trim();
  if (body === "") return false;
  mailChannel().set({ subject: draft.subject.trim(), body, nonce: Date.now() });
  open("mail");
  return true;
}

/**
 * Open the Messages app composing a new SMS to `number`.
 *
 * The prefill is only a *request*: on the host (no SMS backend) the Messages screen
 * stays in its local mode and opens a local conversation with that number instead —
 * it never claims a text was sent.
 *
 * Returns whether the compose window was dispatched, on the same rule {@link openNoteDraft}
 * and {@link openMailDraft} follow: an empty number is refused rather than opening a
 * composer addressed to nobody, and the caller has to be able to say so. This side used to
 * drop that verdict on the floor, so a caller whose own contract promises to report a
 * hand-off (it did: `performDrop`'s `compose-sms` arm) hard-coded success over a no-op
 * (REQ-A1650 ∕ F-SH-840).
 */
export function composeSmsTo(number: string): boolean {
  const to = number.trim();
  if (to === "") return false;
  messagesChannel().set({ composeTo: to, nonce: Date.now() });
  open("messages");
  return true;
}

/** Payload the Photos screen reads to open one item (the camera's "看一下刚拍的这张"). */
export interface PhotosLink {
  /** Id of the photo to reveal (`""` = nothing pending). */
  photoId: string;
  /** Changing marker so asking twice for the same photo re-triggers the reveal. */
  nonce: number;
}

/** Props-channel name of the Photos screen (shared contract with PhotosApp). */
export const PHOTOS_CHANNEL = "photos";

/** The Photos screen's link channel (for `subscribe` / `set`). */
export function photosChannel() {
  return propsChannel<PhotosLink>(PHOTOS_CHANNEL);
}

/**
 * Open the Photos app **on one item** — the camera's last-photo thumbnail uses this.
 *
 * The link is only a *request*: the Photos screen opens its viewer while it still holds
 * that photo and silently ignores an id it no longer does — it never fabricates one.
 * (The camera saves into the same `PHOTOS_KEY` album Photos reads, so the id is shared;
 * see `lib/photos.ts`.)
 */
export function openPhoto(photoId: string): void {
  const id = photoId.trim();
  if (id === "") return;
  photosChannel().set({ photoId: id, nonce: Date.now() });
  open("photos");
}

/** Props-channel name of the Settings screen (shared contract with SettingsApp). */
export const SETTINGS_CHANNEL = "settings";

/** Payload the Settings screen reads to prefill its index search. */
export interface SettingsLink {
  /** Search text to prefill (`""` = nothing pending). */
  query: string;
  /** Changing marker so asking twice for the same text re-triggers the prefill. */
  nonce: number;
}

/** The Settings screen's link channel (for `subscribe` / `set`). */
export function settingsChannel() {
  return propsChannel<SettingsLink>(SETTINGS_CHANNEL);
}

/**
 * Open Settings with `query` **prefilled in its index search**.
 *
 * Prefill only, and deliberately *no* page choice: Settings' own index search already
 * knows every page, its synonyms and its live values, so it — not the caller — decides
 * what the text matches. Nothing here flips a switch: a search link navigates, and
 * changing a setting stays a press the user makes on the page itself.
 */
export function openSettingsSearch(query: string): void {
  const q0 = query.trim();
  if (q0 === "") return;
  settingsChannel().set({ query: q0, nonce: Date.now() });
  open("settings");
}

/**
 * Ask the Settings window to land on **one page** — the Dock's 「打开偏好设置」 row (REQ-A790).
 *
 * Cross-window, so the in-window `settingsChannel` above cannot carry it: the Dock runs in the
 * launcher's `WebviewWindow` and Settings in its own, and `propsBus` reaches nobody across that
 * gap. Same route as `openFilesAt` (REQ-A783): this records the *destination* and the caller opens
 * the window (`wmOpen("settings")`, create-or-focus). Write-then-open is the required order — a
 * Settings window that does not exist yet seeds its `createStoreValue` from what is already
 * stored, so the intent must be in place *before* the window appears.
 *
 * The caller gets back whether the intent landed. A refused write would otherwise open Settings at
 * its index while the user asked for the Dock pane — the app opened but not where they asked to be
 * — and that must not pass silently.
 *
 * No "trim"-style validation: a page is a closed set (`SETTINGS_PAGES`), not free text, and the
 * type makes an unknown one unrepresentable at the call site. The *reader* still re-validates what
 * comes off the store, because a store outlives the build that wrote to it.
 */
export function openSettingsAt(page: SettingsPageId): boolean {
  return writeStoreValueChecked(SETTINGS_PAGE_KEY, { page, nonce: Date.now() });
}

/** Props-channel name of the Phone screen (shared contract with PhoneApp). */
export const PHONE_CHANNEL = "phone";

/** Payload the Phone screen reads to prefill its dialler. */
export interface DialLink {
  /** Number to prefill (`""` = nothing pending). */
  number: string;
  /** Changing marker so asking twice for the same number re-triggers the prefill. */
  nonce: number;
}

/** The Phone screen's link channel (for `subscribe` / `set`). */
export function phoneChannel() {
  return propsChannel<DialLink>(PHONE_CHANNEL);
}

/**
 * Open the Phone app with `number` **prefilled in the dialler**.
 *
 * Prefill only — placing a call is the user's decision, so this never starts one (the
 * same rule the SMS prefill follows: a link is a *request*, not an action the user did
 * not press). An empty value is refused, and the target consumes the link once.
 *
 * Returns whether the dialler was dispatched — the same verdict {@link composeSmsTo} and
 * {@link openNoteDraft} answer, and for the same reason: a caller that promises to report
 * a hand-off must not have to invent one (REQ-A1650 ∕ F-SH-840).
 */
export function dialNumber(number: string): boolean {
  const n = number.trim();
  if (n === "") return false;
  phoneChannel().set({ number: n, nonce: Date.now() });
  open("phone");
  return true;
}

/** Props-channel name of the Files screen (shared contract with FilesApp). */
export const FILES_CHANNEL = "files";

/** The Files screen's link channel (for `subscribe` / `set`). */
export function filesChannel() {
  return propsChannel<ShowLink>(FILES_CHANNEL);
}

/**
 * Open the Files app **on one entry** (the Spotlight chooser uses this).
 *
 * The Files screen navigates to the folder holding the entry and marks the row;
 * an entry that no longer exists is ignored (no phantom row).
 */
export function openFile(fileId: string): void {
  const id = fileId.trim();
  if (id === "") return;
  filesChannel().set({ id, nonce: Date.now() });
  open("files");
}

/**
 * Ask the Files screen to show one entry **from another window** (REQ-A458).
 *
 * `openFile` above is the same-window route (`propsBus`); on the desktop the Spotlight runs in the
 * launcher window while Files runs in its own `WebviewWindow`, so the bus reaches nobody. This
 * writes the shared store instead — the one channel that crosses windows — and the caller opens the
 * window itself (`wmOpen("files")`, create-or-focus).
 *
 * The write is **checked**: a refused store write would leave the user in a Files window at the
 * root, i.e. the app opened but not on the thing they picked, and that must not pass silently.
 * Returns whether the intent was recorded — the caller decides what to say.
 */
export function revealFileAcrossWindows(fileId: string): boolean {
  const id = fileId.trim();
  if (id === "") return false;
  return writeStoreValueChecked(FILES_REVEAL_KEY, { id, nonce: Date.now() });
}

/**
 * Ask the Files window to land on one of its views — the desktop Dock's trash tile (REQ-A783).
 *
 * Same cross-window route as `revealFileAcrossWindows` above, and the same division of labour: this
 * records the *destination*, and the caller opens the window (`wmOpen("files")`, create-or-focus).
 * Write-then-open is the required order and the reason this is a separate call rather than a
 * fire-and-forget: a Files window that does not exist yet seeds its `createStoreValue` from what is
 * already stored, so the intent has to be in place *before* the window appears.
 *
 * There is no "trim"-style validation here as in `revealFileAcrossWindows`: a view is a closed set,
 * not free text, and the type makes an unknown one unrepresentable at the call site.
 */
export function openFilesAt(view: FilesView): boolean {
  return writeStoreValueChecked(FILES_VIEW_KEY, { view, nonce: Date.now() });
}

/** Props-channel name of the Contacts screen (shared contract with ContactsApp). */
export const CONTACTS_CHANNEL = "contacts";

/** The Contacts screen's link channel (for `subscribe` / `set`). */
export function contactsChannel() {
  return propsChannel<ShowLink>(CONTACTS_CHANNEL);
}

/**
 * Open the Contacts app **on one contact** (the Spotlight chooser uses this).
 *
 * The Contacts screen clears any active filter so the contact is actually visible
 * and marks the row; a contact that no longer exists is ignored.
 */
export function openContact(contactId: string): void {
  const id = contactId.trim();
  if (id === "") return;
  contactsChannel().set({ id, nonce: Date.now() });
  open("contacts");
}

/**
 * The window label the AI request context is addressed to. `lib/backend.sendChat`
 * sends `targetWindow: "ai"` (Rust: `chat_agent`), and that command merges the
 * entry attached to **exactly that label** — so the target must be one constant,
 * not two literals that can drift.
 */
export const AI_TARGET_WINDOW = "ai";

/**
 * Hand `text` (from the app `source`) to the AI app as **attached system context**
 * and open it.
 *
 * The attach is only a *request*: offline (no bridge) nothing is attached, and the
 * AI screen then shows no "context attached" hint — it never claims a context it
 * does not have. `chat_agent` merges the entry into the next AI request and
 * consumes it (see `docs/multi-window.md` §3).
 *
 * Returns whether the request was dispatched, the same rule {@link composeSmsTo},
 * {@link dialNumber} and {@link openNoteDraft} follow: an empty body is refused rather
 * than opening the AI screen with a context that was never attached, and the caller must
 * be able to say which happened. The write itself stays fire-and-forget — a context the
 * host did not take is not a hand-off of *text*, and `chat_agent` is the one that reports
 * whether the entry was merged (REQ-A1650 ∕ F-SH-840).
 */
export function sendToAi(source: string, text: string): boolean {
  const body = text.trim();
  if (body === "") return false;
  void systemSetContext(AI_TARGET_WINDOW, source, body);
  open("ai");
  return true;
}

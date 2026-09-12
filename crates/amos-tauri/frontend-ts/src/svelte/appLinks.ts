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

/** Payload the Notes screen reads to open one note. */
export interface NotesLink {
  /** Id of the note to open (`""` = nothing pending). */
  noteId: string;
  /** Changing marker so asking twice for the same note re-triggers the open. */
  nonce: number;
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
 * Open the Messages app composing a new SMS to `number`.
 *
 * The prefill is only a *request*: on the host (no SMS backend) the Messages screen
 * stays in its local mode and opens a local conversation with that number instead —
 * it never claims a text was sent.
 */
export function composeSmsTo(number: string): void {
  const to = number.trim();
  if (to === "") return;
  messagesChannel().set({ composeTo: to, nonce: Date.now() });
  open("messages");
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
 * not press). An empty value is ignored, and the target consumes the link once.
 */
export function dialNumber(number: string): void {
  const n = number.trim();
  if (n === "") return;
  phoneChannel().set({ number: n, nonce: Date.now() });
  open("phone");
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
 */
export function sendToAi(source: string, text: string): void {
  const body = text.trim();
  if (body === "") return;
  void systemSetContext(AI_TARGET_WINDOW, source, body);
  open("ai");
}

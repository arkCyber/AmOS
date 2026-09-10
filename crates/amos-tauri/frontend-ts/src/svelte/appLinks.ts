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

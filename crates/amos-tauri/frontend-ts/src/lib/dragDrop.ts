/**
 * dragDrop.ts — cross-app drag & drop: the payload vocabulary and the **capability
 * kernel** (REQ-A683).
 *
 * On a tablet the canonical cross-app gesture is: hold an item in one app, drag it
 * across the divider, drop it on the app in the other pane — and that app either
 * *takes it* (prefilling its composer, attaching context, opening a draft) or
 * honestly *refuses*. This file owns the two halves that must never drift:
 *
 *   1. **What can be dragged** — {@link DragPayload}: a tagged union. Two kinds
 *      ship, and only because each has a **real** consumer below: `text` (a note's
 *      body) and `phone` (a contact's number). A kind with no consumer would be a
 *      drag that can only ever be refused — a gesture that lies.
 *   2. **Who can take what** — {@link DROP_CAPABILITIES}, the single source of truth
 *      mapping (payload kind, target app) → {@link DropVerb}. Every row is backed by
 *      a real handler in `svelte/dropActions.ts`; a row with no handler would open the
 *      target app at its root with nothing handed over, which the user reads as
 *      "it worked". `dragDrop.test.ts` binds both ends (the app id to `APP_META`, the
 *      verb to the adapter) so a row cannot be added without its handler.
 *
 * Pure and transport-free: no DOM, no runes, no imports from `svelte/`. The live
 * session (pointer position, hovered pane) and the imperative hand-off live in
 * `svelte/dragSession.svelte.ts` and `svelte/dropActions.ts`.
 */
import type { MessageKey } from "../i18n/locales/zh";

/** The draggable kinds that have a real consumer (see {@link DROP_CAPABILITIES}). */
export const DRAG_KINDS = ["text", "phone"] as const;
export type DragKind = (typeof DRAG_KINDS)[number];

/** A note's body (or any free text) being dragged to another app. */
export interface TextPayload {
  kind: "text";
  /** The text itself (already trimmed; at most {@link MAX_DRAG_TEXT} chars). */
  text: string;
  /** Optional human title (a note's first line), for the drag chip and a11y. */
  title?: string;
}

/** A phone number being dragged to another app (Messages / Phone). */
export interface PhonePayload {
  kind: "phone";
  /** The number, already trimmed. */
  number: string;
  /** Optional peer label (a contact's name) shown on the drag chip. */
  label?: string;
}

export type DragPayload = TextPayload | PhonePayload;

/**
 * Cap on carried text. A drag is a *hand-off of an item*, not a bulk copy: an
 * enormous body would be parsed into a message/composer anyway, so the cap keeps the
 * session bounded (and the chip readable). It is a real truncation, not a silent one
 * — the payload only ever reaches composers/drafts the user can still edit.
 */
export const MAX_DRAG_TEXT = 2000;

/** Cap on the chip's detail string (never the payload itself). */
export const MAX_DRAG_DETAIL = 48;

/** Build a `text` payload, or `null` when there is nothing to carry. */
export function makeTextPayload(text: string, title?: string): DragPayload | null {
  const body = text.trim();
  if (body === "") return null;
  const out: TextPayload = {
    kind: "text",
    text: body.length > MAX_DRAG_TEXT ? body.slice(0, MAX_DRAG_TEXT) : body,
  };
  const t = title?.trim();
  if (t) out.title = t;
  return out;
}

/** Build a `phone` payload, or `null` when there is nothing to carry. */
export function makePhonePayload(number: string, label?: string): DragPayload | null {
  const n = number.trim();
  if (n === "") return null;
  const out: PhonePayload = { kind: "phone", number: n };
  const l = label?.trim();
  if (l) out.label = l;
  return out;
}

/** One-line detail for the drag chip (the number, or the title/body). */
export function payloadDetail(p: DragPayload): string {
  const raw = (p.kind === "text" ? (p.title ?? p.text) : p.number).replace(/\s+/g, " ").trim();
  return raw.length > MAX_DRAG_DETAIL ? `${raw.slice(0, MAX_DRAG_DETAIL - 1)}…` : raw;
}

/** i18n key naming the payload kind (the chip's noun). */
export function payloadLabelKey(p: DragPayload): MessageKey {
  return p.kind === "text" ? "drag.text" : "drag.phone";
}

/**
 * What a drop *does*. The verb names the hand-off, not the app: two verbs can target
 * the same app (a number dials in Phone but composes an SMS in Messages) and the
 * adapter that performs them is the only place an app's API is named.
 */
export type DropVerb = "ai-context" | "new-note" | "compose-sms" | "dial";

export interface DropCapability {
  kind: DragKind;
  /** Target app id (must be a real `APP_META` id — bound by test). */
  app: string;
  verb: DropVerb;
}

/**
 * The capability table: **the** answer to "can app X take payload P, and as what?".
 * Read top-to-bottom as the feature's promise:
 *   • drop a note's text on the AI app → attach it as context;
 *   • drop a note's text on the Notes app → open a prefilled new-note draft;
 *   • drop a phone number on Messages → prefill a composer to that number;
 *   • drop a phone number on Phone → prefill the dialler.
 * Nothing else is accepted, and {@link resolveDrop} says so honestly.
 */
export const DROP_CAPABILITIES: readonly DropCapability[] = [
  { kind: "text", app: "ai", verb: "ai-context" },
  { kind: "text", app: "notes", verb: "new-note" },
  { kind: "phone", app: "messages", verb: "compose-sms" },
  { kind: "phone", app: "phone", verb: "dial" },
];

/** The verb this app would use for this payload, or `null` if it cannot take it. */
export function dropVerb(payload: DragPayload, appId: string): DropVerb | null {
  const hit = DROP_CAPABILITIES.find((c) => c.kind === payload.kind && c.app === appId);
  return hit ? hit.verb : null;
}

/** Why a drop did nothing. Every reason is reachable and shown to the user. */
export type DropRejection =
  /** Released over nothing (the gap between panes, the backdrop). */
  | "no-target"
  /** Released back on the app it came from. */
  | "same-app"
  /** The target app is real but cannot take this kind of payload. */
  | "unsupported";

export type DropResolution =
  | { kind: "accept"; app: string; verb: DropVerb }
  | { kind: "reject"; reason: DropRejection };

/**
 * Decide what a drop does — the one rule the shell consults on pointer-up.
 *
 * `same-app` is a **rejection** even when the app could take the payload: a release
 * back onto the pane it came from is almost always an aborted drag, and the one
 * thing that must not happen is a silent duplicate (a second note, a second draft)
 * minted from a gesture the user meant to cancel. Refusing visibly is the honest
 * answer; the user can re-drag to another pane.
 */
export function resolveDrop(
  payload: DragPayload,
  targetAppId: string | null,
  sourceAppId: string | null,
): DropResolution {
  const target = (targetAppId ?? "").trim();
  if (target === "") return { kind: "reject", reason: "no-target" };
  if (target === (sourceAppId ?? "").trim()) return { kind: "reject", reason: "same-app" };
  const verb = dropVerb(payload, target);
  if (!verb) return { kind: "reject", reason: "unsupported" };
  return { kind: "accept", app: target, verb };
}

/** i18n key explaining a rejection to the user. */
export function rejectionKey(reason: DropRejection): MessageKey {
  switch (reason) {
    case "same-app":
      return "drag.rejectSameApp";
    case "unsupported":
      return "drag.rejectUnsupported";
    case "no-target":
      return "drag.dropHint";
  }
}

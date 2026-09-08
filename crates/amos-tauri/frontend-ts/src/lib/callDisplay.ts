/**
 * Caller-ID display helpers for the incoming-call surface (pure, testable).
 *
 * Resolution order: a matching contact name first, then the raw peer number,
 * then an "unknown" fallback (blocked / hidden / empty caller id). This keeps the
 * big headline label meaningful even when the carrier sends no caller id.
 */

/** The headline label to show for a caller. `contactName` is pre-resolved (e.g. via
 * `contactNameFor(contacts, peer)`); pass a caller-localized "unknown" text. */
export function callerDisplayLabel(
  peer: string | undefined | null,
  contactName: string | null | undefined,
  unknownText: string,
): string {
  if (contactName && contactName.trim()) return contactName;
  const p = peer?.trim();
  return p ? p : unknownText;
}

/** Whether a real peer number is available to show under the headline. */
export function hasPeerNumber(peer: string | undefined | null): boolean {
  const p = peer?.trim();
  return !!p;
}

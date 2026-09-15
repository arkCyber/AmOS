/**
 * phoneApps.ts — utility to identify phone/cellular-specific apps.
 *
 * These apps require real hardware (SIM / cellular modem) that a desktop PC does not have.
 * They are excluded from the desktop shell's app grid, dock, and launcher.
 *
 * Honest boundary: "phone" is the only app that needs a SIM. The others (Messages,
 * Contacts) can exist without a phone plan (iMessage / VOIP, local contacts). They
 * stay in the desktop shell as long as they degrade gracefully.
 */

/** Apps that require a real cellular modem (SIM). */
export const PHONE_APP_IDS = ["phone"] as const;

/** True when `id` is a phone-app id. */
export function isPhoneApp(id: string): boolean {
  return (PHONE_APP_IDS as unknown as string[]).includes(id);
}

/**
 * Filter out phone apps from a list of app ids.
 * Use this whenever rendering a list of apps in a desktop shell context.
 */
export function withoutPhone<T extends string>(ids: readonly T[]): T[] {
  return ids.filter((id) => !isPhoneApp(id)) as T[];
}

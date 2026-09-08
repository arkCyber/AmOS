/**
 * OS-level "due reminder" alerts — re-export of the React-free core.
 *
 * All logic lives in `lib/reminderCore.ts`. The former React hook
 * (`useDueReminderAlerts`) is gone: hosts start `svelte/osReminderWatcher`
 * instead, so this module is fully React-free.
 */
export * from "./reminderCore";


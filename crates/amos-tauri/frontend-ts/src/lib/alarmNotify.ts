/**
 * OS-level "due alarm" alerts — re-export of the React-free core.
 *
 * All logic lives in `lib/alarmCore.ts`. The former React hook (`useDueAlarmAlerts`)
 * is gone: hosts start `svelte/osAlarmWatcher` instead (React now, Shell.svelte
 * later), so this module is fully React-free.
 */
export * from "./alarmCore";

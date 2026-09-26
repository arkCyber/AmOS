/**
 * The commands a stubbed shell host answers **at mount** — one list, for every test file that needs it.
 *
 * Both DesktopShell test files (`desktop-shell.svelte.test.ts` and `orig-test.test.ts`) install a fake
 * host whose `invoke` records `window.__lastCall`, and both have cases asserting
 * `__lastCall === undefined` to mean "this gesture reached no host command". That rule only holds if
 * the calls the shell makes *because it mounted* stay out of the probe, so which calls those are is
 * part of the contract, not a detail of either file:
 *
 *   * `wm_windows` / `wm_layout_snapshot` — the boot reads.
 *   * `desktop_features_disabled` (REQ-A287) — the production path for the two capability switches.
 *   * `menu_set_shortcuts` (REQ-A485) — the boot-time *push* of the shell's key bindings to the native
 *     menu bar. It is not a response to a gesture either.
 *   * `system_health` / `system_host_battery` (REQ-A519) — the battery poll the top bar's
 *     `BatteryWidget` starts at mount (`lib/batterySources.svelte.ts`), and re-runs on its timer. The
 *     reading is not a response to a gesture, so it must stay out of the probe like any other poll.
 *   * `stage_snapshot` (REQ-A1546) — the Stage Manager rail's boot read, and its re-read on every
 *     `wm-changed` / `layout-changed` push (`svelte/StageRail.svelte`). A **read** the rail makes
 *     because the window list moved is not a gesture either; its writers (`stage_park` / `stage_bring`
 *     / `stage_arrange`) are what a case must observe, and those stay in the probe.
 *   * `screen_record_status` (REQ-A1581) — the top bar's recording marker polls it to learn whether a
 *     session is live (`svelte/modules/ScreenRecordIndicator.svelte`, and it re-arms itself, so the
 *     poll is periodic, not one-shot). Same rule as the battery poll: a read the bar makes on its own
 *     timer is not a response to a gesture. Its writers (`screen_record_start` / `screen_record_stop`)
 *     stay in the probe.
 *
 * Why this is one exported function and not a list per file (REQ-A487): the list **was** copied, and
 * REQ-A485 added its push to only one copy. Four cases in the other file then stayed red from that
 * round until the next one, while the round's own file was green — a duplicated list of "what counts
 * as boot" cannot be kept in step by care. Pinned by the cases themselves: remove an entry and the
 * file it belongs to fails.
 */
export const BOOT_FACTS = [
  "wm_windows",
  "wm_layout_snapshot",
  "desktop_features_disabled",
  "menu_set_shortcuts",
  "system_health",
  "system_host_battery",
  "stage_snapshot",
  "screen_record_status",
] as const;

/** Is `cmd` one of the calls the shell makes at mount (see [`BOOT_FACTS`])? */
export function isBootFact(cmd: string): boolean {
  return (BOOT_FACTS as readonly string[]).includes(cmd);
}

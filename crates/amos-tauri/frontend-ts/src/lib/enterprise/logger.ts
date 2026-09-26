/**
 * enterprise/logger.ts — 企业功能日志工具
 *
 * **The enterprise family's one log channel, wired to the one ledger the app renders** (REQ-A807).
 *
 * **What this file used to be, and why it was a defect.** It was a 25-line `console.*` wrapper
 * with **no reader anywhere in the app** — imported by four modules, consumed by none. That is
 * not a style question: `webhooks.ts`, `templates.ts` and `audit.ts` used it as their **only**
 * channel for the disclosures that matter most, and every one of those sentences was written for
 * a human:
 *
 *   • `templates.ts` — 「模板写入被存储拒绝 —— N 个模板重启后会丢失」 ×3
 *   • `audit.ts`    — 「审计配置写入被存储拒绝」／「审计日志写入被存储拒绝 —— N 条重启后会丢失」
 *                     ／「审计同步队列写入被存储拒绝 —— N 条将不再同步」 ×3
 *   • `webhooks.ts` — 「Webhook failed after N attempts」／「Event queue full, dropping oldest
 *                     event」 ×6
 *
 * A `console.warn` in a packaged Tauri WebView is not a disclosure. So those 30-odd sentences —
 * *your audit log will be gone after a restart*, *this delivery failed* — were written, sent, and
 * read by nobody. The repo was already carrying the right ledger (`lib/debugLog`, the ring
 * `settings/AiPage.svelte:::diagEntries` renders), and REQ-A806 had to hand-add a *second* channel
 * to `api.ts` for exactly the same sentence 「写入被存储拒绝 —— 重启后会回落到默认配置」, because this
 * module structurally could not reach the screen. That second channel is what made the drift
 * visible: two spellings of one rule inside one family. This file is the root-cause fix, and
 * REQ-A807 reverts `api.ts`／`webhooks.ts` back to `logger.*` so there is one again.
 *
 * **Not a behaviour loss.** `debugLog::diag` already console-logs at the matching level, so every
 * line that used to reach the console still does — the ledger is strictly additive. Three
 * differences worth naming:
 *   • the ledger is a **bounded ring** (`RING_CAP`) with eviction counted, so a long session
 *     cannot grow memory;
 *   • `debug` honours the ledger's own threshold (`amos.debug.level`, default `info`) **and** is
 *     counted as `suppressed` when dropped — so "not shown" can never be mistaken for "did not
 *     happen";
 *   • the gate that used to guard `debug` — `window.DEBUG_MODE` — was **dead**: this file read it
 *     and nothing in the repo ever set it, so `logger.debug` was unreachable by construction.
 *     The ledger's threshold is a real, settable knob, which is why the dead one is not being
 *     preserved.
 */

import { diag } from "../debugLog";

/**
 * One channel for the enterprise modules. Each level is the ledger's own level — this is an
 * **adapter**, not a second implementation, so a future change to how the app records
 * diagnostics reaches these 36 call sites without touching them.
 */
export const logger = {
  debug(area: string, msg: string, data?: unknown): void {
    diag("debug", area, msg, data);
  },

  info(area: string, msg: string, data?: unknown): void {
    diag("info", area, msg, data);
  },

  warn(area: string, msg: string, data?: unknown): void {
    diag("warn", area, msg, data);
  },

  error(area: string, msg: string, data?: unknown): void {
    diag("error", area, msg, data);
  },
};

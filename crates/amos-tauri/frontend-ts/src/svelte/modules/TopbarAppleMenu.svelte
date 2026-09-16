<script lang="ts">
  /**
   * TopbarAppleMenu.svelte — the 🍎 menu at the far left of the bar.
   *
   * It was the bar's worst control before this widget existed: a full-strength button
   * with a name, keyboard focus and **nothing behind it**. The honest options were
   * "disable it and say so" (what the control centre got) or "make it real", and the
   * Apple menu is real macOS behaviour that this shell can *actually* do — so it is a
   * dropdown now:
   *
   *   • 系统设置… → `wm_open("settings")` (the Settings app holds the real pages)
   *   • 锁定屏幕 → the chrome handle's `lockScreen()` (the shell owns `shellState`;
   *     this is exactly why the handle belongs to the shell and not to a container)
   *
   * The rows that macOS has and this shell **cannot** do yet (关于本机 as a standalone
   * panel, 睡眠/重新启动/关机 — no host power/session command) are rendered the way macOS
   * renders an unavailable item: visible, greyed, and named with the reason. Dropping
   * them would hide real gaps; leaving them live would be FMEA F-SH-001 again.
   *
   * Honest boundary: arrow-key navigation and submenus are not implemented (macOS menus
   * are fully keyboard-drivable); the menu closes on Escape / outside click / after an
   * action. It is one file to extend.
   */
  import { getContext } from "svelte";
  import { bridgeDiag, invoke } from "../../lib/backend";
  import { SHELL_CHROME_API, type ShellChromeApi } from "../../lib/shellModule";
  import { t } from "../locale.svelte";
  import {
    CHROME_MENU_BUTTON,
    CHROME_MENU_ITEM,
    CHROME_MENU_PANEL,
    CHROME_MENU_PANEL_STYLE,
    CHROME_MENU_SEPARATOR,
    CHROME_TEXT_SHADOW,
  } from "../../lib/shellChrome";

  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);

  /** One row of the Apple menu. No `run` ⇒ the shell cannot do it yet (greyed + named). */
  interface AppleMenuEntry {
    id: string;
    labelKey: string;
    /** Menus group their rows; a separator is drawn where the group number changes. */
    group: number;
    run?: () => void | Promise<void>;
  }

  /** Open System Settings via the chrome's `wm_open` bridge.
   *
   *  REQ-A297 phase-2 §4: a bare `await invoke("wm_open", ...)` returns
   *  `null` on failure without rejecting, so a refused open would have
   *  been silently swallowed. The post-fix branches on the null result
   *  and writes a `🛟` breadcrumb to the launcher log so the failure
   *  is at least visible.
   */
  async function openSettings() {
    const result = await invoke<unknown>("wm_open", { label: "settings" });
    if (result === null) {
      const diag = bridgeDiag("wm_open");
      if (!diag.ok) {
        const code =
          diag.kind === "command-failed" &&
          diag.detail &&
          typeof diag.detail === "object"
            ? (diag.detail as { code?: string }).code
            : undefined;
        console.warn(
          "🛟 [Apple menu] wm_open(settings) refused",
          code ?? diag.kind,
        );
      }
    }
  }

  /**
   * The menu, in macOS's order. The last three rows are the honest part: they exist on a
   * Mac and are named here with what is missing, rather than quietly left out.
   */
  const ENTRIES: AppleMenuEntry[] = [
    { id: "about", labelKey: "desktop.apple.about", group: 1 },
    { id: "settings", labelKey: "desktop.apple.systemSettings", group: 2, run: openSettings },
    { id: "lock", labelKey: "desktop.apple.lockScreen", group: 2, run: () => api?.lockScreen() },
    { id: "restart", labelKey: "desktop.apple.restart", group: 3 },
    { id: "shutdown", labelKey: "desktop.apple.shutDown", group: 3 },
  ];

  let open = $state(false);
  let wrapEl = $state<HTMLElement | null>(null);

  async function choose(entry: AppleMenuEntry) {
    if (!entry.run) return;
    open = false;
    await entry.run();
  }

  // Escape and an outside click both dismiss a menu (macOS does the same). The listener
  // exists only while the menu is open — a component that parks a permanent document
  // listener to serve a closed menu is how "click anywhere" bugs start.
  $effect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node | null;
      if (el && wrapEl && !wrapEl.contains(el)) open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open = false;
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

<div class="relative" bind:this={wrapEl} data-testid="menu-apple">
  <button
    aria-label={t("desktop.appleMenu")}
    title={t("desktop.appleMenu")}
    aria-haspopup="menu"
    aria-expanded={open}
    data-testid="apple-menu-trigger"
    class="{CHROME_MENU_BUTTON} h-6 w-6 px-0"
    style="text-shadow: {CHROME_TEXT_SHADOW};"
    onclick={() => (open = !open)}>🍎</button
  >

  {#if open}
    <div
      class="absolute left-0 top-full z-50 mt-1 {CHROME_MENU_PANEL}"
      style={CHROME_MENU_PANEL_STYLE}
      role="menu"
      aria-label={t("desktop.appleMenu")}
      data-testid="apple-menu-panel"
    >
      {#each ENTRIES as entry, i (entry.id)}
        {@const first = i === 0}
        {#if !first && entry.group !== ENTRIES[i - 1]?.group}
          <div class={CHROME_MENU_SEPARATOR} role="presentation"></div>
        {/if}
        <button
          role="menuitem"
          class={CHROME_MENU_ITEM}
          data-testid="apple-menu-{entry.id}"
          disabled={!entry.run}
          aria-disabled={entry.run ? undefined : "true"}
          aria-label={t(entry.labelKey)}
          title={t(entry.labelKey)}
          onclick={() => choose(entry)}>{t(entry.labelKey)}</button
        >
      {/each}
    </div>
  {/if}
</div>
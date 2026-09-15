<script lang="ts">
  /**
   * TopbarMainMenu.svelte — macOS's app menus (File / Edit / View / Window / Help).
   *
   * **These five are disabled on purpose**, and it is the same rule the control centre
   * got in REQ-A261 (`docs/FMEA.md` F-SH-001): a title with a readable name, keyboard
   * focus and no behaviour is not "almost finished", it is a control that lies about
   * being available. macOS fills these menus from a **per-app menu model** — the app
   * on screen declares its own menus — and this shell has no such model (registered as
   * a G6 item); until it does, the titles say so in their tooltip instead of soaking up
   * a click.
   *
   * Stated honestly because it is a **visible** change: the five titles now render
   * dimmed (they used to be full-strength buttons that did nothing). When the per-app
   * menu model lands, this one file becomes a real menu bar — that is what the module
   * boundary is for.
   */
  import { t } from "../locale.svelte";
  import { CHROME_MENU_BUTTON, CHROME_TEXT_SHADOW } from "../../lib/shellChrome";

  /** 顶栏主菜单的**唯一**真源：key 顺序即显示顺序（`t()` 负责语言）。 */
  const MENU_KEYS = [
    "desktop.menu.file",
    "desktop.menu.edit",
    "desktop.menu.view",
    "desktop.menu.window",
    "desktop.menu.help",
  ] as const;

  /**
   * The accessible name: the title a sighted user sees **plus** why it cannot be
   * opened — a disabled control whose name is just "文件" tells a screen-reader user
   * nothing about the reason (and the reason is the only useful information here).
   */
  function unavailableName(menuKey: string): string {
    return `${t(menuKey)} — ${t("desktop.menuUnavailable")}`;
  }
</script>

<nav class="ml-1 flex gap-1" aria-label={t("desktop.mainMenu")} data-testid="menu-main">
  {#each MENU_KEYS as menuKey (menuKey)}
    <button
      class={CHROME_MENU_BUTTON}
      style="text-shadow: {CHROME_TEXT_SHADOW};"
      disabled
      aria-disabled="true"
      title={t("desktop.menuUnavailable")}
      aria-label={unavailableName(menuKey)}
      >{t(menuKey)}</button
    >
  {/each}
</nav>
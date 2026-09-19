<script lang="ts">
  /**
   * DockOverflowMenu.svelte — the macOS "full list" for the Dock items that did not fit.
   *
   * REQ-A415: the `+N` chip used to be a **`<span title="…">`** — the Dock's own
   * overflow affordance, rendered as a tooltip. It looked pressable, was announced as a
   * label, and could not be clicked or reached by keyboard, so the only way to a hidden
   * app was to open Launchpad and hunt for it (the FMEA F-SH-001 shape: a control that
   * *looks* usable). On a Mac the chip opens a menu listing exactly those apps; this is
   * that menu, and its entries open through the same `wm_open` path as a Dock tile.
   *
   * Data contract (all of it comes from the Dock, which owns the capacity decision):
   *   • `items` — the apps that did **not** fit, in the Dock's own order;
   *   • `x` / `y` — viewport coordinates of the click;
   *   • `onpick` — open one of them;
   *   • `onclose` — the parent hides this panel.
   *
   * `onclose` is a prop (not an event dispatcher), so the panel mounts and tests
   * standalone — the same rule `DockContextMenu` / `Launchpad` follow.
   *
   * **Prop-read ordering**: `onclose()` unmounts this component, and reading a `$props`
   * getter afterwards throws in Svelte 5 — so both callbacks are captured into locals
   * before the close, exactly as `DockContextMenu`'s async actions do.
   */
  import {
    CHROME_MENU_ITEM,
    CHROME_MENU_PANEL,
    CHROME_MENU_PANEL_STYLE,
  } from "../../lib/shellChrome";
  import { t } from "../locale.svelte";
  import { installMenuKeyboard } from "../../lib/menuKeys";

  let {
    items,
    x,
    y,
    onpick,
    onclose,
  }: {
    items: ReadonlyArray<{ id: string; icon: string; label: string }>;
    x: number;
    y: number;
    onpick: (id: string) => void;
    onclose?: () => void;
  } = $props();

  /** REQ-A436: the shared keyboard layer (arrows / Home / End / Escape) — see `lib/menuKeys`. */
  let menuEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!menuEl) return;
    return installMenuKeyboard(menuEl, { onClose: () => onclose?.() });
  });

  /** Open `id` and close — capturing both callbacks *before* the unmount. */
  function pick(id: string): void {
    const open = onpick;
    const close = onclose;
    close?.();
    open(id);
  }
</script>

<div
  bind:this={menuEl}
  class="fixed z-[200] {CHROME_MENU_PANEL}"
  style="
    left:{x}px;
    top:{y}px;
    {CHROME_MENU_PANEL_STYLE}
    max-height: 320px;
    overflow-y: auto;
  "
  role="menu"
  aria-label={t("desktop.dockOverflowList")}
  data-testid="dock-overflow-menu"
>
  {#each items as item (item.id)}
    <button
      type="button"
      role="menuitem"
      class={CHROME_MENU_ITEM}
      data-testid="dock-overflow-item-{item.id}"
      onclick={() => pick(item.id)}
    >
      <!-- The glyph is decorative: the entry already carries the app's name. -->
      <span class="mr-2" aria-hidden="true">{item.icon}</span>{item.label}
    </button>
  {/each}
</div>

<script lang="ts">
  /**
   * DockTileButton.svelte — one icon tile in the dock: the **one** implementation the
   * dock's items share (the dock's counterpart of `ChromeIconButton`).
   *
   * Before this, `Dock.svelte` spelled the tile's classes and inline size for every
   * item, so the app items and the system items were one edit away from drifting apart
   * (the bar had exactly that defect: three hover greys and two icon sizes). A dock
   * widget now supplies *what it says* and *what it does*, and `lib/shellChrome.ts`
   * owns how it looks.
   *
   * The magnification `transform` is not here on purpose: the container applies it to a
   * wrapper **around** the widget, so a scaled tile never feeds back into the geometry
   * the container measures for the next frame (see `Dock.svelte`).
   */
  import { DOCK_ITEM_TILE } from "../../lib/shellChrome";
  import { DOCK_ICON_SIZE } from "../../lib/desktopLayout";
  import type { ShortcutHint } from "../../lib/shellModule";
  import type { Component } from "svelte";

  let {
    /** Accessible name + tooltip — always `t(...)`, never a literal. */
    label,
    testId,
    glyph = undefined,
    icon = undefined,
    onclick,
    /** `true` for a dock item the shell cannot deliver yet (the Trash): greyed and
     * named with the reason, never a tile that soaks up a click (FMEA F-SH-001). */
    disabled = false,
    /** The key that does the same thing, when the item has one (`⌘Space` on the
     * Launchpad tile? — no: F4). `null` ⇒ no hint is rendered. */
    shortcut = null,
    /** Unread badge text (`"3"`, `"99+"`), or `null`/absent for no badge. The text is
     * computed by the caller (`lib/dockBadge.ts::badgeText`) so the tile never re-derives
     * the cap and cannot disagree with the touch dock's badge. */
    badge = null,
    /** The badge spelled out for assistive tech (e.g. `"3 条未读"`), folded into the
     * button's accessible name. The visual badge itself is `aria-hidden`: a bare number in
     * its own element reads as noise out of context. */
    badgeAria = null,
  }: {
    label: string;
    testId: string;
    glyph?: string;
    icon?: Component;
    onclick: () => void;
    disabled?: boolean;
    shortcut?: ShortcutHint | null;
    badge?: string | null;
    badgeAria?: string | null;
  } = $props();

  /** The button's accessible name: the item, plus *what the badge means* when there is
   * one (a screen reader gets "邮件, 3 条未读" — not "邮件" beside an unannounced number). */
  const accessibleName = $derived(badgeAria ? `${label}, ${badgeAria}` : label);
</script>

<button
  type="button"
  class="{DOCK_ITEM_TILE} {disabled ? 'opacity-40 active:scale-100' : ''}"
  style="
    width:var(--dock-icon-size, {DOCK_ICON_SIZE}px);
    height:var(--dock-icon-size, {DOCK_ICON_SIZE}px);
    font-size:32px;
    border: 1px solid rgba(255,255,255,0.1);
  "
  aria-label={accessibleName}
  title={shortcut ? `${label} (${shortcut.label})` : label}
  aria-keyshortcuts={shortcut?.aria}
  data-testid={testId}
  {disabled}
  aria-disabled={disabled ? "true" : undefined}
  {onclick}
>
  {#if icon}
    {@const Icon = icon}
    <div class="w-full h-full p-1">
      <Icon />
    </div>
  {:else if glyph}{glyph}{/if}{#if badge}<span
      class="absolute -right-1 -top-1 grid min-w-[18px] place-items-center rounded-full bg-danger-solid px-1 text-[11px] font-bold text-white ring-2 ring-white dark:ring-neutral-900"
      data-testid={`${testId}-badge`}
      aria-hidden="true"
    >{badge}</span>{/if}
</button>
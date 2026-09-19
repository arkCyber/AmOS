<script lang="ts">
  /**
   * DockAppItem.svelte — one **app** tile in the dock.
   *
   * Not a registry module, and that is deliberate: the dock's app tiles are the user's
   * `home.layout.dock` (data the user edits), not chrome the app ships. What the
   * container passes is exactly the three things it already knows from `appMeta`
   * (id / icon / translated name) — the widget owns the rendering and the action.
   *
   * The action is `wm_open`, which the host defines as **create + focus**: the previous
   * implementation polled `wm_windows` before every click to decide between `wm_open` and
   * `wm_focus`, duplicating a decision the host already makes (and getting it wrong for
   * a window that was open but hidden). The container still polls the window list, but
   * only for the running dot.
   *
   * No `scale` prop: the container applies the magnification transform to a wrapper
   * around this widget (see `Dock.svelte`), so the tile stays a plain tile and the
   * geometry the container measures cannot feed back on itself.
   */
  import { wmOpen } from "../../lib/wm";
  import DockTileButton from "./DockTileButton.svelte";

  let {
    id,
    icon,
    label,
  }: {
    id: string;
    icon: string;
    label: string;
  } = $props();

  function open() {
    void wmOpen(id);
  }
</script>

<DockTileButton {label} testId="dock-app-{id}" glyph={icon} onclick={open} />
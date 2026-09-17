<script lang="ts">
  /**
   * DockLaunchpadItem.svelte — the 🚀 tile in the dock.
   *
   * Owns its own label, its own tooltip and its own intent: the tile asks the **shell**
   * for the Launchpad through the chrome handle (the same handle the bar's 🚀 uses), and
   * reads its shortcut hint from the registry row that binds it (`F4`) — so the tooltip,
   * the ARIA hint and the key handler cannot disagree, because there is one row.
   */
  import { getContext } from "svelte";
  import { SHELL_CHROME_API, type ShellChromeApi } from "../../lib/shellModule";
  import { t } from "../locale.svelte";
  import DockTileButton from "./DockTileButton.svelte";
  import IconLaunchpad from "../../assets/icons/IconLaunchpad.svelte";

  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);
</script>

<DockTileButton
  label={t("desktop.launchpad")}
  testId="dock-launchpad"
  icon={IconLaunchpad}
  shortcut={api?.overlayShortcut("launchpad") ?? null}
  onclick={() => api?.openLaunchpad()}
/>
<script lang="ts">
  /**
   * SpotlightTrigger.svelte — the 🔍 widget in the top bar.
   *
   * Same contract as `LaunchpadTrigger`: own rendering, ask the container (via the
   * chrome handle) for the overlay. `⌘Space` reaches the same intent from the
   * keyboard, which the container binds — one action, two ways in.
   */
  import { getContext } from "svelte";
  import { SHELL_CHROME_API, type ShellChromeApi } from "../../lib/shellModule";
  import { t } from "../locale.svelte";
  import ChromeIconButton from "./ChromeIconButton.svelte";

  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);
</script>

<ChromeIconButton
  label={t("desktop.spotlight")}
  testId="chrome-spotlight"
  glyph="🔍"
  onclick={() => api?.openSpotlight()}
/>
